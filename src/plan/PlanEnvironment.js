// 계획 계층 3단: PlanEnvironment — 계획 수준 RL 인터페이스 (SIM_DESIGN P7).
//
// semi-MDP 구조: 에이전트는 "의사결정 시점"(유휴 크레인 + 실행 가능 후보 존재)마다
// 후보 (크레인 × 양중물) 중 하나를 고른다. 환경은 다음 의사결정 시점까지
// 물리 시뮬(PlanRunner)을 자동 진행한다 — V2 MAPPO의 candidate 구조와 동형.
//
//   env.reset()            → { observation, candidates, done }
//   env.step(candidateIdx) → { observation, candidates, reward, done, info }
//
// 보상: -경과시간(분) + 안착 보너스 - 안전 페널티(충돌·금지구역·크레인간섭) + 종결 보너스.
// 후보 특징량에 estimateCycleTime(분석 근사)을 포함 — 에이전트가 소요시간을 근거로 선택 가능.
//
// 재배치 후보 (SIM_DESIGN §2.5 "행동: (크레인, 양중물[, 셋업 위치])"):
// 현 셋업에서 공간적으로 불가한 (크레인×양중물)도 setupCandidates(거시 계획과 동일 탐색)로
// 최적 셋업 1개를 찾아 setupPos/boomLength가 붙은 후보로 노출한다. est에는 재배치
// 시간(해체+주행+조립)이 포함되고, step()이 액션으로 전달하면 PlanRunner의 재배치
// 상태기계(park→teardown→travel→setup)가 실행한다. 일시 차단(반입·선행·풍속)은 대기.

import { Simulation, FIXED_DT } from '../sim/Simulation.js';
import { PlanRunner, bodyRadiusOf } from './PlanRunner.js';
import { checkLiftFeasible, estimateCycleTime, liftBlockedReason } from './AutoPilot.js';
import { setupCandidates, planningZones } from './MacroPlanner.js';
import { radiusRangeOf } from './SetupPlanner.js';
import { pointInZone } from './PathPlanner.js';

const DEFAULTS = {
  timeCostPerMin: 1, // 분당 시간 비용
  placeBonus: 5, // 안착 1건당
  collisionCost: 5,
  zoneCost: 5,
  clashCost: 10, // 크레인 간 물리 충돌
  successBonus: 20, // 전건 완료
  failCost: 20, // stuck/timeout 종결
  maxTotalSteps: 1200000, // 물리 스텝 한도 (~333분 시뮬 — 재배치 포함 대형 시나리오 여유)
};

export class PlanEnvironment {
  /** @param {Object} scenario @param {Object} [opts] 보상·runner 옵션 */
  constructor(scenario, opts = {}) {
    this.scenario = scenario;
    this.opts = { ...DEFAULTS, ...opts };
  }

  reset() {
    this.sim = new Simulation(this.scenario);
    this.runner = new PlanRunner(this.sim, [], this.opts.runner ?? {});
    this.assigned = new Set(); // 배정된 loadId (실패 시 해제 — 다른 크레인이 회수 가능)
    this._setupCache = new Map(); // (크레인 위치·붐, 부재@단계) → 셋업 탐색 결과
    this._evCursor = 0; // runner 이벤트 처리 커서 (liftFailed → 배정 해제)
    this._prevSteps = 0;
    this._prevPlaced = 0;
    this._prevSafety = this.#safetyNow();
    this.status = this.#advance();
    return {
      observation: this.#observation(),
      candidates: this.candidates,
      done: this.status !== 'decision',
      info: { status: this.status },
    };
  }

  /**
   * @param {number} candidateIdx 직전 candidates 배열의 인덱스
   */
  step(candidateIdx) {
    if (this.status !== 'decision') throw new Error('episode done — reset() 필요');
    const c = this.candidates[candidateIdx];
    if (!c) throw new Error(`잘못된 후보 인덱스: ${candidateIdx} (후보 ${this.candidates.length}개)`);

    // 배정 → 다음 의사결정 시점까지 진행 (큐는 액션 객체를 담는다)
    // 배정 키는 (부재, 여정 단계) — 다단계 부재(하역→건립)는 단계마다 재배정 가능
    const action = { craneId: c.craneId, loadId: c.loadId };
    if (c.setupPos) action.setupPos = c.setupPos; // 재배치 후 양중
    if (c.boomLength != null) action.boomLength = c.boomLength;
    this.runner.queues[c.craneId].push(action);
    this.#evacuateIdleCranes(c); // 작업원 안의 유휴 크레인은 반경 밖으로 퇴피 이동
    this.assigned.add(`${c.loadId}:${c.stage}`);
    this.runner.done = false;
    this.status = this.#advance();

    // --- 보상 (구간 델타) ---
    const o = this.opts;
    const dt = ((this.runner.steps - this._prevSteps) * FIXED_DT) / 60; // 분
    const placed = this.#placedCount();
    const s = this.#safetyNow();
    let reward = -dt * o.timeCostPerMin;
    reward += o.placeBonus * (placed - this._prevPlaced);
    reward -= o.collisionCost * (s.col - this._prevSafety.col);
    reward -= o.zoneCost * (s.vio - this._prevSafety.vio);
    reward -= o.clashCost * (s.clash - this._prevSafety.clash);
    if (this.status === 'success') reward += o.successBonus;
    if (this.status === 'stuck' || this.status === 'timeout') reward -= o.failCost;
    this._prevSteps = this.runner.steps;
    this._prevPlaced = placed;
    this._prevSafety = s;

    const done = this.status !== 'decision';
    return {
      observation: this.#observation(),
      candidates: this.candidates,
      reward,
      done,
      info: {
        status: this.status,
        makespan: this.runner.steps * FIXED_DT,
        placed,
        result: done ? this.runner.result() : null,
      },
    };
  }

  /** 다음 의사결정 시점 또는 종결까지 시뮬 진행 */
  #advance() {
    for (;;) {
      this.candidates = this.#candidates();
      const idle = this.runner.active.some(
        (p, ci) => p === null && !this.runner.stopped[ci] && this.runner.queues[ci].length === 0,
      );
      if (idle && this.candidates.length > 0) return 'decision';

      if (this.#unplaced().length === 0) return 'success';
      if (this.runner.steps >= this.opts.maxTotalSteps) return 'timeout';

      // 진행 가능성: 작업 중 크레인 / 대기 큐 / 리깅 / 미래 이벤트(반입·바람 변화)
      const anyActive = this.runner.active.some((p) => p !== null);
      const anyQueued = this.runner.queues.some(
        (q, ci) => q.length > 0 && !this.runner.stopped[ci],
      );
      if (!anyActive && !anyQueued && this.candidates.length === 0) {
        const t = this.runner.steps * FIXED_DT;
        const future =
          this.sim.world.loads.some((l) => l.state === 'pending') ||
          (this.sim.world.windDef?.timeline?.some(([tt]) => tt >= t - FIXED_DT) ?? false) ||
          this.sim.world.loads.some((l) => l.state === 'rigging' || l.state === 'derigging');
        if (!future) return 'stuck';
      }

      this.runner.done = false;
      this.runner.step();

      // 실패한 배정은 해제 — 비상 안착된 부재를 다른 크레인이 다시 후보로 받는다
      while (this._evCursor < this.runner.events.length) {
        const e = this.runner.events[this._evCursor++];
        if (e.type === 'liftFailed') {
          const l = this.sim.world.loads.find((x) => x.id === e.loadId);
          if (l) this.assigned.delete(`${l.id}:${l.stage}`);
        }
      }
    }
  }

  /**
   * 실행 가능 후보: (유휴 크레인) × (미배정 양중물).
   * 현 셋업에서 가능하면 직접 후보, 공간적으로 불가하면 재배치 후보(셋업 탐색 1위 동반).
   * 일시 차단(반입·선행·풍속)은 후보에서 제외 — 시간이 해결한다 (#advance가 자동 진행).
   */
  #candidates() {
    const out = [];
    const n = this.runner.active.length;
    for (let ci = 0; ci < n; ci++) {
      if (this.runner.active[ci] !== null || this.runner.stopped[ci]) continue;
      if (this.runner.queues[ci].length > 0) continue;
      const crane = this.sim.world.cranes[ci];
      const [bx, , bz] = crane.basePos;
      const circles = this.#activeWorkCircles(ci);
      for (const l of this.sim.world.loads) {
        if (!l.target || l.state === 'placed' || this.assigned.has(`${l.id}:${l.stage}`)) continue;
        const fz = checkLiftFeasible(this.sim, ci, l.id);
        if (fz.feasible) {
          if (this.#workConflict([bx, bz], Math.max(fz.rLoad, fz.rTarget), circles)) continue;
          const est = estimateCycleTime(this.sim, ci, l.id) ?? 999;
          const [rMin, rMax] = crane.getRadiusRange();
          out.push({
            craneId: ci,
            loadId: l.id,
            stage: l.stage,
            est, // 분석 근사 사이클타임 (s)
            reloc: 0,
            workBase: [bx, bz], // 작업원 (유휴 크레인 퇴피 판정용)
            workRadius: Math.max(fz.rLoad, fz.rTarget),
            features: [
              Math.hypot(l.pos[0] - bx, l.pos[2] - bz) / rMax, // 픽업 반경비
              Math.hypot(l.target[0] - bx, l.target[1] - bz) / rMax, // 목표 반경비
              l.mass / Math.max(crane.capacityAtRadius(fz.rLoad ?? rMin), 0.1), // 하중률
              est / 300, // 예상 소요 (정규화)
              0, // 재배치 시간 (직접 후보는 0)
            ],
          });
        } else if (!fz.blocked) {
          const c = this.#relocCandidate(ci, l, circles);
          if (c) out.push(c);
        }
      }
    }
    return out;
  }

  /**
   * 재배치 후보: 현 셋업에서 공간적으로 불가한 (크레인, 양중물)에 대해
   * 거시 계획과 동일한 셋업 탐색(setupCandidates)으로 최선 셋업 1개를 찾는다.
   * @returns {Object|null} setupPos/boomLength가 붙은 후보. 불가하면 null
   */
  #relocCandidate(ci, l, circles) {
    // 시간적 차단이 겹쳐 있으면 대기 (공간 검사가 먼저라 blocked로 안 잡힌 경우)
    if (liftBlockedReason(this.sim, l)) return null;

    const crane = this.sim.world.cranes[ci];
    const spec = crane.spec;
    const planning = spec.planning ?? {};
    const movable = planning.movable ?? spec.type !== 'tower';
    const canBoom = spec.type === 'mobile' && !!spec.capacityChart; // 붐 교체는 2D 정격표 필요
    if (!movable && !canBoom) return null;

    const [bx, , bz] = crane.basePos;
    const key = `${ci}|${bx.toFixed(1)},${bz.toFixed(1)},${crane.boomLength}|${l.id}@${l.stage}`;
    let list = this._setupCache.get(key);
    if (list === undefined) {
      const lift = { id: l.id, pos: l.pos, target: l.target, targetHeight: l.targetElev ?? 0, mass: l.mass };
      list = setupCandidates(spec, lift, this.scenario, [bx, bz], { topK: 8 });
      this._setupCache.set(key, list);
    }
    // 다른 크레인의 확정 위치(현재·재배치 목적지·큐 예약 셋업)와 겹치는 셋업 제외.
    // 없으면 주행이 상대 차체에 영구 차단(#travelBlocked)되는 상호 대기 livelock 발생 —
    // 거시 계획의 배정 간 셋업 충돌 검사에 대응하는 실행 계층 안전장치.
    const occupied = this.#occupiedPositions(ci);
    const myR = Math.max(bodyRadiusOf(crane), spec.geometry.tailSwingRadius ?? 0);
    const gap = this.opts.runner?.bodyClearance ?? 1.0;
    const s = list.find(
      (cand) =>
        (cand.sameSetup ||
          occupied.every((o) => Math.hypot(cand.pos[0] - o.pos[0], cand.pos[1] - o.pos[1]) >= myR + o.r + gap)) &&
        !this.#workConflict(cand.pos, cand.actualRadius, circles),
    ) ?? null;
    if (!s) return null;
    const needsMove = !s.sameSetup;
    const needsBoom = Math.abs(s.boomLength - crane.boomLength) > 1e-6;
    if ((needsMove && !movable) || (needsBoom && !canBoom)) return null;
    if (!needsMove && !needsBoom) return null; // 현 셋업 그대로면 checkLiftFeasible이 이미 판정

    // 재배치 시간 추정 — PlanRunner #beginRelocation과 동일 규약
    // (첫 재배치는 해체 생략, 이후는 teardown 포함)
    const worked = this.runner.stats[ci].completed > 0 || this.runner.stats[ci].relocSteps > 0;
    const travelSpeed = Math.max(0.01, planning.travelSpeed ?? 1.5);
    const relocTime =
      (worked ? (planning.teardownTime ?? 300) : 0) +
      s.path.distance / travelSpeed +
      (planning.setupTime ?? (spec.type === 'tower' ? 0 : 600));
    const liftEst =
      estimateCycleTime(this.sim, ci, l.id, {
        assumeFeasible: true, // 타당성은 setupCandidates(evaluateSetup)가 이미 보장
        basePos: s.pos,
        boomLength: s.boomLength,
      }) ?? 999;
    const est = relocTime + liftEst;
    const [, rMax] = radiusRangeOf(spec, s.boomLength);
    const need = l.mass * (spec.rating?.dynamicFactor ?? 1.0);
    return {
      craneId: ci,
      loadId: l.id,
      stage: l.stage,
      est,
      reloc: relocTime,
      setupPos: needsMove ? s.pos : undefined,
      boomLength: needsBoom ? s.boomLength : undefined,
      workBase: [...s.pos],
      workRadius: s.actualRadius,
      features: [
        s.pickupRadius / rMax, // 픽업 반경비 (셋업 기준)
        s.targetRadius / rMax, // 목표 반경비 (셋업 기준)
        need / Math.max(need + s.capacityMargin, 0.1), // 하중률 (여유 역산)
        est / 300, // 예상 소요 (재배치 포함)
        relocTime / 600, // 재배치 시간 (정규화)
      ],
    };
  }

  /**
   * 활성·예약 작업원: 각 크레인이 지금 하고 있거나 큐에 예약한 양중의
   * (기준 위치, 실제 작업 반경) 원. 후보의 작업원이 이와 겹치면(hard 간섭)
   * 후보에서 제외 — 거시 계획의 hard 간섭 순차화에 대응. 동시 투입하면
   * 양보 규칙이 수습 못 하고 thrash → 양중 타임아웃 → 크레인 정지로 이어진다.
   */
  #activeWorkCircles(exceptCi) {
    const out = [];
    this.sim.world.cranes.forEach((crane, cj) => {
      if (cj === exceptCi) return;
      // 진행 중 조종(현 위치) > 재배치 중(목적지) > 큐 예약(예약 셋업 또는 현 위치)
      let loadId = null;
      let base = [crane.basePos[0], crane.basePos[2]];
      if (this.runner.active[cj]) {
        loadId = this.runner.active[cj].loadId;
      } else {
        const a = this.runner.reloc[cj]?.action ?? this.runner.queues[cj][0];
        if (a?.loadId) {
          loadId = a.loadId;
          base = a.moveTo ?? a.setupPos ?? base;
        }
      }
      if (!loadId) return;
      const load = this.sim.world.loads.find((x) => x.id === loadId);
      if (!load?.target) return;
      const rL = Math.hypot(load.pos[0] - base[0], load.pos[2] - base[1]);
      const rT = Math.hypot(load.target[0] - base[0], load.target[1] - base[1]);
      out.push({ pos: base, r: Math.max(rL, rT) });
    });
    return out;
  }

  /** 후보 작업원이 활성 작업원과 겹치는가 (hard 간섭) */
  #workConflict(base, radius, circles) {
    return circles.some(
      (o) => Math.hypot(base[0] - o.pos[0], base[1] - o.pos[1]) < radius + o.r,
    );
  }

  /**
   * 배정된 작업원 안에 서 있는 유휴 크레인에게 퇴피 이동(moveTo)을 발행한다.
   * 파킹 붐은 거의 수직이라 선회 퇴피로는 작업 붐 스윕을 피할 수 없다 —
   * 실제 현장처럼 유휴 크레인을 작업 반경 밖으로 이동시킨다 (clash 근본 차단).
   */
  #evacuateIdleCranes(c) {
    if (!c.workBase) return;
    const warn = this.opts.runner?.warnClearance ?? 5;
    this.sim.world.cranes.forEach((other, cj) => {
      if (cj === c.craneId || this.runner.stopped[cj]) return;
      if (this.runner.active[cj] || this.runner.reloc[cj] || this.runner.queues[cj].length > 0) return;
      const planning = other.spec.planning ?? {};
      if (!(planning.movable ?? other.spec.type !== 'tower')) return; // 고정식은 이동 불가
      const oR = Math.max(bodyRadiusOf(other), other.spec.geometry.tailSwingRadius ?? 0);
      const clear = c.workRadius + oR + warn;
      const d = Math.hypot(other.basePos[0] - c.workBase[0], other.basePos[2] - c.workBase[1]);
      if (d >= clear) return;
      const dest = this.#clearSpotFor(cj, c.workBase, clear + 1);
      if (dest) this.runner.queues[cj].push({ craneId: cj, moveTo: dest });
    });
  }

  /** 작업원 밖 퇴피 지점 탐색: 현 방위부터 좌우로 각도를 벌려가며 첫 유효 지점 */
  #clearSpotFor(cj, workBase, dist) {
    const crane = this.sim.world.cranes[cj];
    const zones = planningZones(this.scenario, crane.spec);
    const myR = Math.max(bodyRadiusOf(crane), crane.spec.geometry.tailSwingRadius ?? 0);
    const occupied = this.#occupiedPositions(cj);
    const site = this.scenario.site;
    const th0 = Math.atan2(crane.basePos[2] - workBase[1], crane.basePos[0] - workBase[0]);
    for (const dth of [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]) {
      const th = th0 + (dth * Math.PI) / 180;
      const p = [workBase[0] + dist * Math.cos(th), workBase[1] + dist * Math.sin(th)];
      if (site) {
        const minX = site.minX ?? -((site.width ?? 1e9) / 2);
        const maxX = site.maxX ?? minX + (site.width ?? 1e9);
        const minZ = site.minZ ?? -((site.depth ?? 1e9) / 2);
        const maxZ = site.maxZ ?? minZ + (site.depth ?? 1e9);
        if (p[0] < minX + myR || p[0] > maxX - myR || p[1] < minZ + myR || p[1] > maxZ - myR) continue;
      }
      if (zones.some((z) => pointInZone(p, z, myR))) continue;
      if (occupied.some((o) => Math.hypot(p[0] - o.pos[0], p[1] - o.pos[1]) < myR + o.r + 1)) continue;
      return p;
    }
    return null;
  }

  /** 다른 크레인이 점유 중이거나 예약한 지상 위치 (차체·테일 반경 포함) */
  #occupiedPositions(ci) {
    const out = [];
    this.sim.world.cranes.forEach((other, cj) => {
      if (cj === ci) return;
      const r = Math.max(bodyRadiusOf(other), other.spec.geometry.tailSwingRadius ?? 0);
      out.push({ pos: [other.basePos[0], other.basePos[2]], r });
      // 재배치 진행 중 목적지 + 큐에 예약된 셋업
      const dests = [this.runner.reloc[cj]?.action, this.runner.queues[cj][0]];
      for (const a of dests) {
        const p = a?.moveTo ?? a?.setupPos;
        if (p) out.push({ pos: p, r });
      }
    });
    return out;
  }

  #unplaced() {
    return this.sim.world.loads.filter((l) => l.target && l.state !== 'placed');
  }

  #placedCount() {
    return this.sim.world.loads.filter((l) => l.target && l.state === 'placed').length;
  }

  #safetyNow() {
    const w = this.sim.world;
    return { col: w.collisionCount, vio: w.violationCount, clash: w.craneClashCount };
  }

  /** 전역 관측: 진행률·시간·바람·크레인 가용성 */
  #observation() {
    const targeted = this.sim.world.loads.filter((l) => l.target);
    const placed = this.#placedCount();
    const n = this.runner.active.length;
    const idle = this.runner.active.filter((p) => p === null).length;
    return [
      targeted.length > 0 ? placed / targeted.length : 1, // 진행률
      (this.runner.steps * FIXED_DT) / 600, // 경과 (10분 스케일)
      this.sim.world.windSpeed / 25,
      idle / n, // 유휴 크레인 비율
      this.candidates.length / 8, // 후보 수 (캡)
    ];
  }
}
