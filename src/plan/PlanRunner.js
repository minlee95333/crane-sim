// 계획 계층 2단: PlanRunner — 다중 양중 계획 실행기 (SIM_DESIGN P2, 재배치·3D간섭 통합).
//
// LiftPlan = [{ craneId, loadId, setupPos?, boomLength? } | { craneId, moveTo }
//             | { craneId, awaitStage }, ...]
// (순서 = 크레인별 실행 순서)을 받아 여러 크레인이 물리 시뮬 위에서 **병렬로**
// 양중을 진행하고, 타임라인·makespan·비용·안전 지표를 산출한다.
// { moveTo }는 양중 없는 이동 전용 액션 — 유휴 크레인 퇴피(다른 크레인 작업권 밖으로).
// { awaitStage: s }는 공정 배리어 — 모든 다단계 부재의 여정이 s단계 이상 진행될 때까지
// 대기 (예: awaitStage 1 = "전 부재 하역·야적 완료 후 건립 개시").
//
// 크레인 재배치 (setupPos가 현재 베이스와 다르면):
//   park(붐 파킹) → teardown(해체) → travel(주행 — basePos가 실제로 이동) → setup(재조립)
//   상태기계를 거친 뒤 양중을 기동한다. 이동 경로는 PathPlanner(금지구역·장애물·타 크레인 우회),
//   주행 중 다른 크레인과 근접하면 일시정지(양보). boomLength가 지정되면 setup에서 붐 재구성.
//
// 간섭 양보 규칙 (3D 물리 — World가 매 스텝 계산한 checkPair 결과 사용):
//   붐/지브 3D 최소거리 < warnClearance, 테일스윙 접촉, 또는 접근 중(approachFactor 배수 이내)이면
//   우선순위 낮은 쪽(craneId 큰 쪽)이 양보. 양보는 정지가 아니라 **능동 퇴피** —
//   이격이 warnClearance 미만이면 붐을 올려(반경 축소) 공간을 내준다 (현장의 '붐 들고 대기').
//   이격이 hard 충돌 직전(holdClearance)까지 좁혀지면 진행 크레인도 일시 정지.
//   히스테리시스로 진동 방지. (구) 후크 수평거리 프록시는 opts.minSeparation 지정 시에만.
//
// 비용 모델 (V2 crane_core/cost.py 이식):
//   rentalCost = Σ busyMin × rentalPerMin   (양중·재배치 작업 시간)
//   idleCost   = Σ (makespan − busy)Min × idlePerMin  (대기·유휴 — 간섭 대기 포함)
//   laborCost  = Σ rigMin × laborPerMin    (줄걸이·해체 리깅 크루 노무)
//   fuelCost   = Σ travelDist(m) × fuelPerMeter  (크레인 주행 연료)

import { FIXED_DT } from '../sim/Simulation.js';
import { AutoPilot, checkLiftFeasible } from './AutoPilot.js';
import { shortestPath } from './PathPlanner.js';

const ZERO = { slew: 0, luff: 0, hoist: 0 };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrapAngle = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

const DEFAULTS = {
  minSeparation: null, // (레거시) 활성 후크 간 최소 이격 (m). null = 비활성 — 3D 간섭이 기본
  warnClearance: 5, // 붐/지브 3D 이격 경고 — 이보다 좁아지면 양보·퇴피 (m)
  approachFactor: 1.6, // 접근 중(이격 감소)일 때 warnClearance × 이 배수부터 조기 양보
  holdClearance: 3.2, // 이보다 좁아지면 진행 크레인도 정지 (hard 1.5m + 감속거리 방어선)
  bodyClearance: 1.0, // 주행 중 타 크레인 본체와 추가 이격 (m)
  yield: true, // false면 양보 규칙 전체 비활성 (대조 실험용)
  maxTotalSteps: 200000, // 전체 타임아웃 (~55분 시뮬시간)
  rates: {
    currency: 'KRW',
    rentalPerMin: 3000, // ≈ ₩180,000/시간 (V2 DEFAULT_RATES와 동일)
    idlePerMin: null, // null이면 rentalPerMin과 동일 (현장 상주 임대)
    laborPerMin: 1200, // 리깅 크루 노무비 (V2 DEFAULT_RATES와 동일)
    fuelPerMeter: 200, // 크레인 주행 연료·유도 인력 (₩/m)
  },
};

const bodyRadiusOf = (crane) => {
  const g = crane.spec.geometry;
  return g.bodyRadius ?? Math.max(g.bodyWidth ?? 2, g.bodyLength ?? 2) / 2;
};

export class PlanRunner {
  /**
   * @param {import('../sim/Simulation.js').Simulation} sim
   * @param {Array<{craneId:number, loadId:string, setupPos?:[number,number], boomLength?:number}>} plan
   * @param {Object} [opts]
   */
  constructor(sim, plan, opts = {}) {
    this.sim = sim;
    this.opts = { ...DEFAULTS, ...opts, rates: { ...DEFAULTS.rates, ...(opts.rates ?? {}) } };
    this.plan = plan;

    const n = sim.world.cranes.length;
    // 크레인별 실행 큐 (plan 순서 유지 — 액션 객체 전체 보관)
    this.queues = Array.from({ length: n }, () => []);
    for (const a of plan) {
      if (a.craneId < 0 || a.craneId >= n) throw new Error(`plan: 잘못된 craneId ${a.craneId}`);
      this.queues[a.craneId].push(a);
    }

    this.active = new Array(n).fill(null); // craneId → AutoPilot | null
    this.reloc = new Array(n).fill(null); // craneId → 재배치 상태기계 | null
    this.stopped = new Array(n).fill(false); // 실행 중 실패 → 해당 크레인 정지
    this.waiting = new Array(n).fill(false);
    this.blockedReason = new Array(n).fill(null); // 큐 헤드 일시 차단 사유 (반입/선행/풍속)
    this.stats = Array.from({ length: n }, () => ({
      busySteps: 0,
      waitSteps: 0,
      rigSteps: 0, // 줄걸이·해체 작업 시간 (노무비 대상)
      travelSteps: 0, // 주행 시간
      relocSteps: 0, // 재배치 전체(파킹·해체·주행·조립) 시간
      travelDist: 0, // 주행 거리 (m, 연료비 대상)
      completed: 0,
      failed: 0,
    }));
    this.events = [];
    this.steps = 0;
    this.done = false;
    this._pairWait = new Set(); // 히스테리시스: 현재 양보를 유발 중인 크레인 쌍
    this._prevPairDist = new Map(); // 쌍별 직전 붐 이격 (접근 감지)

    const s0 = sim.getState().safety;
    this._safety0 = { col: s0.collisionCount, vio: s0.violationCount, clash: s0.craneClashCount };
  }

  #event(type, craneId, loadId, extra = {}) {
    this.events.push({ t: this.steps * FIXED_DT, type, craneId, loadId, ...extra });
  }

  /** 재배치 필요 여부: setupPos/moveTo가 현재 베이스와 0.5m 이상 차이 or 붐길이 변경 */
  #needsRelocation(ci, action) {
    const crane = this.sim.world.cranes[ci];
    const dest = action.moveTo ?? action.setupPos;
    const moveDist = dest
      ? Math.hypot(dest[0] - crane.basePos[0], dest[1] - crane.basePos[2])
      : 0;
    const needsMove = moveDist > 0.5;
    const needsBoom =
      action.boomLength != null &&
      crane.spec.type === 'mobile' &&
      Math.abs(action.boomLength - crane.boomLength) > 1e-6;
    return { needsMove, needsBoom, moveDist };
  }

  /** 주행 경로 계획용 평면 금지영역: 금지구역 + 장애물 + 다른 크레인 현재 위치 */
  #travelZones(ci) {
    const zones = [];
    for (const z of this.sim.world.noFlyZones) zones.push({ id: z.id, min: z.min, max: z.max });
    for (const ob of this.sim.world.obstacles) {
      zones.push({
        id: `obstacle:${ob.id}`,
        min: [ob.pos[0] - ob.size[0] / 2, ob.pos[2] - ob.size[2] / 2],
        max: [ob.pos[0] + ob.size[0] / 2, ob.pos[2] + ob.size[2] / 2],
      });
    }
    this.sim.world.cranes.forEach((other, cj) => {
      if (cj === ci) return;
      const r = bodyRadiusOf(other) + 0.5;
      zones.push({
        id: `crane:${cj}`,
        min: [other.basePos[0] - r, other.basePos[2] - r],
        max: [other.basePos[0] + r, other.basePos[2] + r],
      });
    });
    return zones;
  }

  /** 재배치 상태기계 개시. 성공 시 true, 영구 불가면 false(사유 이벤트 포함) */
  #beginRelocation(ci, action, need) {
    const crane = this.sim.world.cranes[ci];
    const planning = crane.spec.planning ?? {};
    const movable = planning.movable ?? crane.spec.type !== 'tower';
    if (need.needsMove && !movable) {
      this.#event('liftFailed', ci, action.loadId, {
        reason: '고정식 크레인은 셋업 위치를 변경할 수 없음', infeasible: true,
      });
      return false;
    }
    if (need.needsBoom && !crane.chart2d) {
      this.#event('liftFailed', ci, action.loadId, {
        reason: '붐길이 변경은 capacityChart(2D 정격표) 필요', infeasible: true,
      });
      return false;
    }

    const dest = action.moveTo ?? action.setupPos;
    let path = { path: [], distance: 0 };
    if (need.needsMove) {
      path = shortestPath(
        [crane.basePos[0], crane.basePos[2]],
        dest,
        this.#travelZones(ci),
        { clearance: bodyRadiusOf(crane) },
      );
      if (!path.ok) {
        this.#event('liftFailed', ci, action.loadId, {
          reason: '셋업 위치까지 이동 경로 없음', infeasible: true,
        });
        return false;
      }
    }

    // 첫 재배치(아직 작업 이력 없음)는 미조립 상태로 간주 → 해체 생략 (MacroPlanner와 동일 규약)
    const worked = this.stats[ci].completed > 0 || this.stats[ci].relocSteps > 0;
    this.reloc[ci] = {
      action,
      moveOnly: !action.loadId, // 이동 전용(퇴피) 액션 — 완료 시 큐에서 제거
      phase: 'park',
      timer: 0,
      path: path.path,
      seg: 1, // 다음 웨이포인트 인덱스
      teardownTime: worked ? (planning.teardownTime ?? 300) : 0,
      // 퇴피 이동은 재조립 불필요 (작업 위치가 아님)
      setupTime: action.loadId ? (planning.setupTime ?? (crane.spec.type === 'tower' ? 0 : 600)) : 0,
      travelSpeed: Math.max(0.01, planning.travelSpeed ?? 1.5),
    };
    this.#event('relocateStart', ci, action.loadId, {
      from: [crane.basePos[0], crane.basePos[2]],
      to: dest ?? [crane.basePos[0], crane.basePos[2]],
      distance: path.distance,
      boomLength: action.boomLength ?? null,
      moveOnly: !action.loadId,
    });
    return true;
  }

  /**
   * 큐 헤드 양중 기동 시도 (엄격한 순서 유지 — 계획 = 순서열):
   *  - 재배치 필요 → 상태기계 개시(헤드 유지) / feasible → 기동
   *  - blocked(반입·선행·풍속) → 헤드 유지하고 대기 / 영구 불가 → failed 처리 후 다음 헤드로
   */
  #startNext(ci) {
    const q = this.queues[ci];
    while (q.length > 0) {
      const action = q[0];
      // 공정 배리어: 모든 다단계 부재가 awaitStage 단계 이상 진행될 때까지 대기
      if (action.awaitStage != null) {
        const s = action.awaitStage;
        const ready = this.sim.world.loads.every(
          (l) => l.route.length <= s || l.stage >= s,
        );
        if (ready) {
          q.shift();
          continue;
        }
        if (this.blockedReason[ci] !== `awaitStage:${s}`) {
          this.blockedReason[ci] = `awaitStage:${s}`;
          this.#event('liftBlocked', ci, null, { reason: `공정 배리어: ${s}단계 완료 대기` });
        }
        return;
      }
      const need = this.#needsRelocation(ci, action);
      if (need.needsMove || need.needsBoom) {
        if (this.#beginRelocation(ci, action, need)) return; // 헤드 유지 — 재배치 후 기동
        q.shift(); // 재배치 불가 → 영구 실패 스킵
        this.stats[ci].failed += 1;
        continue;
      }
      if (!action.loadId) {
        q.shift(); // 이동 전용 액션인데 이미 목적지 — 완료 처리
        continue;
      }
      const fz = checkLiftFeasible(this.sim, ci, action.loadId, this.opts.autopilot ?? {});
      if (fz.feasible) {
        q.shift();
        this.active[ci] = new AutoPilot(this.sim, ci, action.loadId, this.opts.autopilot ?? {});
        this.#event('liftStart', ci, action.loadId);
        this.blockedReason[ci] = null;
        return;
      }
      if (fz.blocked) {
        // 일시 차단 — 헤드 유지, 사유 변경 시에만 이벤트
        if (this.blockedReason[ci] !== fz.reason) {
          this.blockedReason[ci] = fz.reason;
          this.#event('liftBlocked', ci, action.loadId, { reason: fz.reason });
        }
        return;
      }
      // 영구 불가 → 스킵
      q.shift();
      this.stats[ci].failed += 1;
      this.#event('liftFailed', ci, action.loadId, { reason: fz.reason, infeasible: true });
    }
    this.blockedReason[ci] = null;
  }

  /** 주행 일시정지 판정: 다른 크레인 본체와 근접 */
  #travelBlocked(ci) {
    const me = this.sim.world.cranes[ci];
    const rMe = bodyRadiusOf(me);
    for (let cj = 0; cj < this.sim.world.cranes.length; cj++) {
      if (cj === ci) continue;
      const other = this.sim.world.cranes[cj];
      const d = Math.hypot(me.basePos[0] - other.basePos[0], me.basePos[2] - other.basePos[2]);
      if (d < rMe + bodyRadiusOf(other) + this.opts.bodyClearance) return true;
    }
    return false;
  }

  /** 재배치 상태기계 1스텝. 명령이 필요한 phase(park)는 명령을 반환 */
  #stepRelocation(ci) {
    const r = this.reloc[ci];
    const crane = this.sim.world.cranes[ci];
    this.stats[ci].relocSteps += 1;

    switch (r.phase) {
      case 'park': {
        // 붐 파킹(최소 반경) + 후크 올림 — 주행 자세
        const [rMin] = crane.getRadiusRange();
        if (crane.getRadius() <= rMin + 0.35) {
          r.phase = 'teardown';
          r.timer = r.teardownTime;
          if (r.teardownTime > 0) this.#event('teardownStart', ci, r.action.loadId);
          return ZERO;
        }
        return { slew: 0, luff: -1, hoist: 0.5 };
      }
      case 'teardown': {
        r.timer -= FIXED_DT;
        if (r.timer <= 0) {
          r.phase = 'travel';
          this.#event('travelStart', ci, r.action.loadId, {
            distance: r.path.length ? undefined : 0,
          });
        }
        return ZERO;
      }
      case 'travel': {
        if (r.seg >= r.path.length) {
          // 이동 없음(붐 교체만) 또는 도착
          r.phase = 'setup';
          r.timer = r.setupTime;
          if (r.setupTime > 0) this.#event('setupStart', ci, r.action.loadId);
          return ZERO;
        }
        if (this.waiting[ci] || this.#travelBlocked(ci)) {
          this.stats[ci].waitSteps += 1;
          return ZERO;
        }
        let remain = r.travelSpeed * FIXED_DT;
        this.stats[ci].travelSteps += 1;
        while (remain > 1e-9 && r.seg < r.path.length) {
          const [tx, tz] = r.path[r.seg];
          const dx = tx - crane.basePos[0];
          const dz = tz - crane.basePos[2];
          const d = Math.hypot(dx, dz);
          if (d <= remain) {
            crane.basePos[0] = tx;
            crane.basePos[2] = tz;
            this.stats[ci].travelDist += d;
            remain -= d;
            r.seg += 1;
          } else {
            crane.basePos[0] += (dx / d) * remain;
            crane.basePos[2] += (dz / d) * remain;
            this.stats[ci].travelDist += remain;
            remain = 0;
          }
        }
        if (r.seg >= r.path.length) {
          r.phase = 'setup';
          r.timer = r.setupTime;
          if (r.setupTime > 0) this.#event('setupStart', ci, r.action.loadId);
        }
        return ZERO;
      }
      case 'setup': {
        r.timer -= FIXED_DT;
        if (r.timer <= 0) {
          // 붐 재구성 (조립 자세: 최소 반경으로 파킹)
          if (r.action.boomLength != null && crane.spec.type === 'mobile') {
            crane.boomLength = r.action.boomLength;
            crane.boomAngle = crane.limits.boomAngleMax;
            crane.ropeLength = Math.min(
              Math.max(crane.limits.ropeMin, crane.ropeLength),
              crane.maxRopeLength(),
            );
          }
          this.#event('relocateEnd', ci, r.action.loadId, {
            pos: [crane.basePos[0], crane.basePos[2]],
            boomLength: crane.spec.type === 'mobile' ? crane.boomLength : null,
          });
          // 이동 전용(퇴피) 액션은 여기서 완료 — 큐에서 제거
          if (r.moveOnly) this.queues[ci].shift();
          this.reloc[ci] = null;
        }
        return ZERO;
      }
      default:
        this.reloc[ci] = null;
        return ZERO;
    }
  }

  /** 고정스텝 1회 진행 */
  step() {
    if (this.done) return;
    const n = this.active.length;

    // 1) 빈 크레인에 다음 양중 기동 (재배치 중이면 건너뜀)
    for (let ci = 0; ci < n; ci++) {
      if (!this.active[ci] && !this.reloc[ci] && !this.stopped[ci]) this.#startNext(ci);
    }

    // 1.5) 유휴 크레인 파킹: 붐 올림/트롤리 인으로 최소 반경까지 후퇴.
    //      완료된 크레인의 붐이 다른 크레인 경로를 막는 것을 방지 (실제 현장 관행).
    const parkCmds = new Array(n).fill(null);
    const parking = new Array(n).fill(false);
    for (let ci = 0; ci < n; ci++) {
      if (this.active[ci] || this.reloc[ci]) continue;
      const crane = this.sim.world.cranes[ci];
      const [rMin] = crane.getRadiusRange();
      if (crane.getRadius() > rMin + 0.3) {
        parking[ci] = true;
        parkCmds[ci] = { slew: 0, luff: -1, hoist: 0 };
      }
    }

    // 2) 간섭 판정 → 낮은 우선순위(큰 craneId)가 양보. 3D 물리(checkPair) 기반:
    //    - 붐/지브 3D 이격 < warnClearance, 테일스윙 접촉 → 즉시 양보
    //    - 이격이 줄어드는 중(접근)이면 warnClearance × approachFactor부터 조기 양보
    //    - 히스테리시스: 일단 양보를 유발한 쌍은 approachFactor 범위를 벗어나야 해제
    //    - (레거시) opts.minSeparation 지정 시 후크 수평거리 프록시 추가 적용
    const state = this.sim.getState();
    const nextWaiting = new Array(n).fill(false);
    const waitCause = new Array(n).fill(null);
    this._evade = new Array(n).fill(false);
    this._evadeFrom = new Array(n).fill(-1);
    this._evadeTail = new Array(n).fill(false);
    if (this.opts.yield) {
      if (this.opts.minSeparation != null) {
        for (let a = 0; a < n; a++) {
          if (!this.active[a]) continue;
          for (let b = a + 1; b < n; b++) {
            if (!this.active[b]) continue;
            const ha = state.cranes[a].hookPos;
            const hb = state.cranes[b].hookPos;
            if (Math.hypot(ha[0] - hb[0], ha[2] - hb[2]) < this.opts.minSeparation) {
              nextWaiting[b] = true;
              waitCause[b] = 'separation';
            }
          }
        }
      }
      // 간섭 판정 대상: 활성 조종 중 · 파킹 중(붐이 아직 지나가는 중) · 재배치 중(본체 이동 중)
      const involved = (ci) => this.active[ci] !== null || parking[ci] || this.reloc[ci] !== null;
      // 양보 가능 대상: 조종 중(퇴피 가능) 또는 주행 중(일시정지 가능)
      const yieldable = (ci) =>
        this.active[ci] !== null || this.reloc[ci]?.phase === 'travel';
      const warn = this.opts.warnClearance;
      const near = warn * this.opts.approachFactor;
      for (const p of state.safety?.cranePairs ?? []) {
        if (!involved(p.a) || !involved(p.b)) continue;
        const key = p.a * 1000 + p.b;
        const prev = this._prevPairDist.get(key);
        this._prevPairDist.set(key, p.boomDist);
        const closing = prev !== undefined && p.boomDist < prev - 1e-9;
        const wasWaiting = this._pairWait.has(key);
        const danger =
          p.tailContact ||
          p.boomDist < warn ||
          (closing && p.boomDist < near) ||
          (wasWaiting && p.boomDist < near); // 히스테리시스
        if (!danger) {
          this._pairWait.delete(key);
          continue;
        }
        const target = yieldable(p.b) ? p.b : yieldable(p.a) ? p.a : null;
        if (target !== null) {
          this._pairWait.add(key);
          nextWaiting[target] = true;
          waitCause[target] ??= p.tailContact ? 'tailSwing' : 'boomClearance';
          // 능동 퇴피: 경고 이격 미만이면 양보 크레인이 공간을 낸다
          // (붐 올림 + 상대 반대편으로 선회 — 테일스윙은 선회로만 풀린다)
          if (p.boomDist < warn || p.tailContact) {
            this._evade[target] = true;
            this._evadeFrom[target] = target === p.b ? p.a : p.b;
            this._evadeTail[target] = p.tailContact;
          }
          // 초근접 + 접근 중: 진행 크레인도 정지 (퇴피가 이격을 회복할 때까지).
          // 이격이 회복 중이면 진행을 허용 — 양쪽 동결로 인한 라이브락 방지.
          if ((p.boomDist < this.opts.holdClearance && closing) || p.tailContact) {
            const other = target === p.b ? p.a : p.b;
            if (yieldable(other)) {
              nextWaiting[other] = true;
              waitCause[other] ??= 'holdClearance';
            }
          }
        }
      }
    }
    for (let ci = 0; ci < n; ci++) {
      const loadId = this.active[ci]?.loadId ?? this.reloc[ci]?.action.loadId;
      if (nextWaiting[ci] && !this.waiting[ci])
        this.#event('waitStart', ci, loadId, { cause: waitCause[ci] });
      if (!nextWaiting[ci] && this.waiting[ci]) this.#event('waitEnd', ci, loadId);
      this.waiting[ci] = nextWaiting[ci];
    }

    // 3) 명령 수집 (대기 크레인은 정지 — 파일럿 내부 스텝도 진행 안 함)
    const cmds = new Array(n).fill(ZERO);
    for (let ci = 0; ci < n; ci++) {
      if (this.reloc[ci]) {
        // 재배치 상태기계 (임대시간 = busy로 계상)
        cmds[ci] = this.#stepRelocation(ci);
        this.stats[ci].busySteps += 1;
        continue;
      }
      const pilot = this.active[ci];
      if (!pilot) {
        if (parkCmds[ci]) cmds[ci] = parkCmds[ci]; // 유휴 파킹
        continue;
      }
      if (this.waiting[ci]) {
        this.stats[ci].waitSteps += 1;
        // 능동 퇴피: 정지 대신 붐 올림 + 선회로 이격 확보.
        //  - 붐 이격: 붐을 상대 반대 방위로 (away 선회)
        //  - 테일 접촉: 테일은 붐 반대편에 있으므로 away 선회는 역효과 —
        //    테일↔위협점 거리의 기울기(∂dist/∂θ) 방향으로 선회해 테일을 빼낸다.
        if (this._evade[ci] && this._evadeFrom[ci] >= 0) {
          const me = this.sim.world.cranes[ci];
          const other = this.sim.world.cranes[this._evadeFrom[ci]];
          let slew;
          if (this._evadeTail[ci]) {
            const R = me.spec.geometry.tailSwingRadius ?? 4.5;
            const Ro = other.spec.geometry.tailSwingRadius ??
              (other.spec.geometry.counterJibLength ?? 4.5);
            const th = me.slewAngle;
            const tail = [me.basePos[0] - R * Math.cos(th), me.basePos[2] - R * Math.sin(th)];
            const oTail = [
              other.basePos[0] - Ro * Math.cos(other.slewAngle),
              other.basePos[2] - Ro * Math.sin(other.slewAngle),
            ];
            const oBody = [other.basePos[0], other.basePos[2]];
            const d2 = (p) => (tail[0] - p[0]) ** 2 + (tail[1] - p[1]) ** 2;
            const P = d2(oTail) < d2(oBody) ? oTail : oBody; // 가까운 위협점
            // ∂tail/∂θ = R(sinθ, -cosθ) → 거리 증가 방향으로 선회
            const grad =
              (tail[0] - P[0]) * R * Math.sin(th) - (tail[1] - P[1]) * R * Math.cos(th);
            slew = grad >= 0 ? 1 : -1;
          } else {
            const away = Math.atan2(
              me.basePos[2] - other.basePos[2],
              me.basePos[0] - other.basePos[0],
            );
            slew = clamp(wrapAngle(away - me.slewAngle) * 3, -1, 1);
          }
          cmds[ci] = { slew, luff: -1, hoist: 0 };
        }
        continue;
      }
      const d = pilot.decide();
      if (d.attach) this.sim.toggleAttach(ci);
      cmds[ci] = d.command;
      this.stats[ci].busySteps += 1;
    }

    // 4) 물리 1스텝
    this.sim.stepFixed(cmds, 1);
    this.steps += 1;

    // 4.5) 리깅/해체 작업 시간 집계 (노무비)
    for (let ci = 0; ci < n; ci++) {
      const rigging = this.sim.world.loads.some(
        (l) => l.hookedBy === ci && (l.state === 'rigging' || l.state === 'derigging'),
      );
      if (rigging) this.stats[ci].rigSteps += 1;
    }

    // 5) 완료/실패 정리
    for (let ci = 0; ci < n; ci++) {
      const pilot = this.active[ci];
      if (!pilot || !pilot.done) continue;
      if (pilot.ok) {
        this.stats[ci].completed += 1;
        this.#event('liftEnd', ci, pilot.loadId, {
          cycleTime: pilot.steps * FIXED_DT,
          placeError: pilot.finalErr,
        });
      } else {
        // 실행 중 실패(타임아웃·줄걸이 실패 등) — 상태가 어정쩡할 수 있어 해당 크레인 정지
        this.stats[ci].failed += 1;
        this.stopped[ci] = true;
        this.#event('liftFailed', ci, pilot.loadId, { reason: pilot.reason, infeasible: false });
      }
      this.active[ci] = null;
    }

    // 6) 종료 판정 (재배치 중이면 아직 활성)
    const anyActive =
      this.active.some((p) => p !== null) || this.reloc.some((r) => r !== null);
    const anyQueued = this.queues.some((q, ci) => q.length > 0 && !this.stopped[ci]);
    if (!anyActive && !anyQueued) this.done = true;

    // 데드락 감지: 모두 유휴 + 큐는 남았는데(전부 blocked)
    // 미래에 상황을 바꿀 이벤트(반입·바람 변화·리깅 진행)가 전혀 없으면 진행 불가
    if (!this.done && !anyActive && anyQueued) {
      // 이번 스텝에서 차단이 풀렸을 수 있음 (예: 방금 반입) → 먼저 기동 재시도
      for (let ci = 0; ci < n; ci++) {
        if (!this.active[ci] && !this.reloc[ci] && !this.stopped[ci]) this.#startNext(ci);
      }
      if (this.active.some((p) => p !== null) || this.reloc.some((r) => r !== null)) return;
      const t = this.steps * FIXED_DT;
      // pending 부재는 arriveTime 도달 시 반드시 반입됨 → 존재 자체가 미래 이벤트
      const futureDelivery = this.sim.world.loads.some((l) => l.state === 'pending');
      // 경계 포함(>= t-dt): 방금 도달한 타임라인 항목이 다음 스텝에 적용되는 경합 방지
      const futureWind =
        this.sim.world.windDef?.timeline?.some(([tt]) => tt >= t - FIXED_DT) ?? false;
      const riggingActive = this.sim.world.loads.some(
        (l) => l.state === 'rigging' || l.state === 'derigging',
      );
      if (!futureDelivery && !futureWind && !riggingActive) {
        for (let ci = 0; ci < n; ci++) {
          if (this.queues[ci].length > 0 && !this.stopped[ci]) {
            this.#event('deadlock', ci, this.queues[ci][0].loadId, {
              reason: this.blockedReason[ci],
            });
          }
        }
        this.done = true;
      }
    }

    if (this.steps >= this.opts.maxTotalSteps) {
      this.done = true;
      this.#event('timeout', -1, null);
    }
  }

  /** 완주 실행 → 결과 리포트 */
  runAll() {
    while (!this.done) this.step();
    return this.result();
  }

  result() {
    const n = this.active.length;
    const makespan = this.steps * FIXED_DT;
    const makespanMin = makespan / 60;
    const rates = this.opts.rates;
    const idleRate = rates.idlePerMin ?? rates.rentalPerMin;

    const cranes = [];
    let rentalCost = 0;
    let idleCost = 0;
    let laborCost = 0;
    let fuelCost = 0;
    for (let ci = 0; ci < n; ci++) {
      const st = this.stats[ci];
      const busyMin = (st.busySteps * FIXED_DT) / 60;
      const idleMin = Math.max(0, makespanMin - busyMin); // 간섭 대기 포함
      const rigMin = (st.rigSteps * FIXED_DT) / 60;
      const rental = busyMin * rates.rentalPerMin;
      const idle = idleMin * idleRate;
      const labor = rigMin * rates.laborPerMin;
      const fuel = st.travelDist * rates.fuelPerMeter;
      rentalCost += rental;
      idleCost += idle;
      laborCost += labor;
      fuelCost += fuel;
      cranes.push({
        craneId: ci,
        completed: st.completed,
        failed: st.failed,
        stopped: this.stopped[ci],
        busyTime: st.busySteps * FIXED_DT,
        waitTime: st.waitSteps * FIXED_DT,
        rigTime: st.rigSteps * FIXED_DT,
        travelTime: st.travelSteps * FIXED_DT,
        relocTime: st.relocSteps * FIXED_DT,
        travelDistance: st.travelDist,
        idleTime: Math.max(0, makespan - st.busySteps * FIXED_DT),
        cost: { rental, idle, labor, fuel },
      });
    }

    const s1 = this.sim.getState().safety;
    const planned = new Set(this.plan.filter((a) => a.loadId).map((a) => a.loadId));
    const placedAll = this.sim.world.loads
      .filter((l) => planned.has(l.id))
      .every((l) => l.state === 'placed');

    return {
      success: placedAll,
      makespan,
      steps: this.steps,
      completed: cranes.reduce((s, c) => s + c.completed, 0),
      failed: cranes.reduce((s, c) => s + c.failed, 0),
      events: this.events,
      cranes,
      cost: {
        currency: rates.currency,
        rental: rentalCost,
        idle: idleCost,
        labor: laborCost,
        fuel: fuelCost,
        total: rentalCost + idleCost + laborCost + fuelCost,
      },
      safety: {
        collisions: s1.collisionCount - this._safety0.col,
        violations: s1.violationCount - this._safety0.vio,
        craneClashes: s1.craneClashCount - this._safety0.clash,
      },
    };
  }
}

/** 계획을 일괄 실행하는 편의 함수 */
export function runPlan(sim, plan, opts = {}) {
  return new PlanRunner(sim, plan, opts).runAll();
}

/**
 * MacroPlanner 결과(assignments)를 PlanRunner 실행 계획으로 변환.
 * 규칙 기반 계획을 물리로 검증하는 다리 — craneId는 scenario.cranes 순서 인덱스로 매핑.
 */
export function macroToPlan(scenario, macroResult) {
  const idx = new Map(scenario.cranes.map((c, i) => [c.id, i]));
  return [...macroResult.assignments]
    .sort((a, b) => a.liftStart - b.liftStart)
    .map((a) => ({
      craneId: idx.get(a.craneId),
      loadId: a.loadId,
      setupPos: [...a.setupPos],
      boomLength: a.boomLength ?? null,
    }));
}

/**
 * 베이스라인 계획 생성기(greedy):
 *  1) 시공순서(dependsOn) 위상 정렬 — 선행 부재가 큐에서 먼저 오도록
 *  2) 각 양중물을 "타당한 크레인 중 배정 건수가 적고, 같으면 베이스가 가까운" 크레인에 배정
 * 일시 차단(blocked: 반입 전·선행 미완·풍속)은 배정에 포함 — 실행 시 PlanRunner가 대기.
 * RL·탐색 계획의 비교 기준선. (재배치 없음 — 초기 셋업 위치 기준)
 */
export function autoPlan(sim) {
  // 위상 정렬 (targeted 부재 간 의존만 고려; 순환은 잔여를 그대로 이어붙임 → 실행 시 데드락 감지)
  const targeted = sim.world.loads.filter((l) => l.target && l.state !== 'placed');
  const ids = new Set(targeted.map((l) => l.id));
  const ordered = [];
  const done = new Set();
  let remaining = [...targeted];
  while (remaining.length > 0) {
    const ready = remaining.filter((l) =>
      l.dependsOn.every((d) => !ids.has(d) || done.has(d)),
    );
    if (ready.length === 0) {
      ordered.push(...remaining); // 순환 의존 — 그대로 배정 (런타임 데드락으로 표면화)
      break;
    }
    for (const l of ready) {
      ordered.push(l);
      done.add(l.id);
    }
    remaining = remaining.filter((l) => !done.has(l.id));
  }

  const plan = [];
  const counts = new Map();
  for (const l of ordered) {
    let best = null;
    for (let ci = 0; ci < sim.world.cranes.length; ci++) {
      const fz = checkLiftFeasible(sim, ci, l.id);
      if (!fz.feasible && !fz.blocked) continue; // 영구 불가만 제외
      const assigned = counts.get(ci) ?? 0;
      const [bx, , bz] = sim.world.cranes[ci].basePos;
      const d = Math.hypot(l.pos[0] - bx, l.pos[2] - bz);
      if (!best || assigned < best.assigned || (assigned === best.assigned && d < best.d)) {
        best = { ci, assigned, d };
      }
    }
    if (best) {
      plan.push({ craneId: best.ci, loadId: l.id });
      counts.set(best.ci, (counts.get(best.ci) ?? 0) + 1);
    }
  }
  return plan;
}
