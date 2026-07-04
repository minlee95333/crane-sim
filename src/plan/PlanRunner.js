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
import { AutoPilot, checkLiftFeasible, checkCarryFeasible } from './AutoPilot.js';
import { shortestPath, pointInZone } from './PathPlanner.js';

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

export const bodyRadiusOf = (crane) => {
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

  /** 주행 경로 계획용 평면 금지영역: 금지구역 + 장애물 + 트럭 베이 + 다른 크레인 현재 위치 */
  #travelZones(ci) {
    const zones = [];
    for (const z of this.sim.world.noFlyZones) zones.push({ id: z.id, min: z.min, max: z.max });
    for (const tr of this.sim.world.trucks) {
      if (tr.phase !== 'gone') zones.push(tr.dockZone(0.5)); // 출차 전까지 베이 회피
    }
    for (const ob of this.sim.world.obstacles) {
      zones.push({
        id: `obstacle:${ob.id}`,
        min: [ob.pos[0] - ob.size[0] / 2, ob.pos[2] - ob.size[2] / 2],
        max: [ob.pos[0] + ob.size[0] / 2, ob.pos[2] + ob.size[2] / 2],
      });
    }
    this.sim.world.cranes.forEach((other, cj) => {
      if (cj === ci) return;
      // 회피 반경은 주행 차단(#travelBlocked) 임계값 이상이어야 함 —
      // 아니면 "합법 경로"가 차단 반경 안을 지나 상대가 서 있는 동안 영구 정지한다.
      const r = bodyRadiusOf(other) + this.opts.bodyClearance + 0.2;
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
      travelAccel: Math.max(0.01, planning.travelAccel ?? 0.3), // 종방향 가감속 (트럭과 동일 원칙)
      travelVel: 0, // 현재 주행 속도 (램프 적분)
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
      // 재배치(빈 이동): 픽앤캐리 액션도 픽업 셋업(setupPos)이 붙어 있으면 먼저 빈 이동한다
      // (직전 캐리로 크레인이 멀어졌을 때 픽업 근처로 복귀 → 이후 carryTo 분기가 캐리 실행).
      const need = this.#needsRelocation(ci, action);
      if (need.needsMove || need.needsBoom) {
        if (this.#beginRelocation(ci, action, need)) return; // 헤드 유지 — 재배치 후 기동
        q.shift(); // 재배치 불가 → 영구 실패 스킵
        this.stats[ci].failed += 1;
        continue;
      }
      // 픽앤캐리 액션: 현 위치에서 픽업 → 하중 매단 채 carryTo로 주행 → 안착.
      // 재배치(빈 이동)와 달리 크레인이 하중을 들고 이동한다 (감격 정격·주행 전도 적용).
      if (action.carryTo) {
        const cz = checkCarryFeasible(this.sim, ci, action.loadId, action.carryTo, this.opts.autopilot ?? {});
        if (cz.feasible) {
          q.shift();
          this.active[ci] = new AutoPilot(this.sim, ci, action.loadId, {
            ...(this.opts.autopilot ?? {}), carryTo: action.carryTo,
          });
          this.#event('carryStart', ci, action.loadId, { to: [...action.carryTo] });
          this.blockedReason[ci] = null;
          return;
        }
        if (cz.blocked) {
          if (this.blockedReason[ci] !== cz.reason) {
            this.blockedReason[ci] = cz.reason;
            this.#event('liftBlocked', ci, action.loadId, { reason: cz.reason });
          }
          return;
        }
        q.shift();
        this.stats[ci].failed += 1;
        this.#event('liftFailed', ci, action.loadId, { reason: cz.reason, infeasible: true });
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
  /**
   * 주행 접근 차단 판정: 제안 위치(nx,nz)가 타 크레인 차단 반경 안이면서
   * 현재보다 가까워지는 경우만 차단한다 — 이탈(멀어지는) 이동은 허용.
   * 위치 기준으로 전부 막으면 경계에 걸친 크레인이 빠져나오지도 못하고 영구 동결된다.
   */
  #travelStepBlocked(ci, nx, nz) {
    const me = this.sim.world.cranes[ci];
    const rMe = bodyRadiusOf(me);
    for (let cj = 0; cj < this.sim.world.cranes.length; cj++) {
      if (cj === ci) continue;
      const other = this.sim.world.cranes[cj];
      const th = rMe + bodyRadiusOf(other) + this.opts.bodyClearance;
      const dNew = Math.hypot(nx - other.basePos[0], nz - other.basePos[2]);
      if (dNew >= th) continue;
      const dCur = Math.hypot(
        me.basePos[0] - other.basePos[0],
        me.basePos[2] - other.basePos[2],
      );
      if (dNew < dCur - 1e-9) return true;
    }
    return false;
  }

  /**
   * 이탈 방향: 차단 반경+여유 안의 가장 가까운 크레인 반대 방향 단위벡터.
   * 충분히 멀면 null (재계획 가능 상태).
   */
  #escapeDir(ci) {
    const me = this.sim.world.cranes[ci];
    const rMe = bodyRadiusOf(me);
    let worst = null;
    let worstGap = Infinity;
    for (let cj = 0; cj < this.sim.world.cranes.length; cj++) {
      if (cj === ci) continue;
      const other = this.sim.world.cranes[cj];
      const th = rMe + bodyRadiusOf(other) + this.opts.bodyClearance + 0.5;
      const d = Math.hypot(me.basePos[0] - other.basePos[0], me.basePos[2] - other.basePos[2]);
      if (d < th && d - th < worstGap) {
        worstGap = d - th;
        worst = other;
      }
    }
    if (!worst) return null;
    const dx = me.basePos[0] - worst.basePos[0];
    const dz = me.basePos[2] - worst.basePos[2];
    const d = Math.hypot(dx, dz) || 1;
    return [dx / d, dz / d];
  }

  /**
   * 클리핑된 이동: 목표 지점이 금지구역·장애물·트럭·현장 경계를 침범하지 않을 때만
   * 이동을 적용한다 (이탈·후퇴 이동이 경로계획을 거치지 않으므로 여기서 검사).
   * @returns {boolean} 이동 적용 여부
   */
  #moveClear(ci, dir, dist) {
    const crane = this.sim.world.cranes[ci];
    const nx = crane.basePos[0] + dir[0] * dist;
    const nz = crane.basePos[2] + dir[1] * dist;
    const rMe = bodyRadiusOf(crane);
    const zones = [];
    for (const z of this.sim.world.noFlyZones) zones.push(z);
    for (const ob of this.sim.world.obstacles) {
      zones.push({
        min: [ob.pos[0] - ob.size[0] / 2, ob.pos[2] - ob.size[2] / 2],
        max: [ob.pos[0] + ob.size[0] / 2, ob.pos[2] + ob.size[2] / 2],
      });
    }
    for (const tr of this.sim.world.trucks) {
      if (tr.phase !== 'gone') zones.push(tr.dockZone(0.5));
    }
    if (zones.some((z) => pointInZone([nx, nz], z, rMe))) return false;
    const site = this.sim.scenario?.site;
    if (site) {
      const minX = site.minX ?? -((site.width ?? 1e9) / 2);
      const maxX = site.maxX ?? minX + (site.width ?? 1e9);
      const minZ = site.minZ ?? -((site.depth ?? 1e9) / 2);
      const maxZ = site.maxZ ?? minZ + (site.depth ?? 1e9);
      if (nx < minX + rMe || nx > maxX - rMe || nz < minZ + rMe || nz > maxZ - rMe) return false;
    }
    crane.basePos[0] = nx;
    crane.basePos[2] = nz;
    this.stats[ci].travelDist += dist;
    return true;
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
        if (this.waiting[ci]) {
          // 간섭 양보 중에도 주행 크레인은 서 있지 않고 상대에서 물러난다.
          // 작업 크레인 옆 최근접점에서 정지하면 근접이 영구화되어 상호 동결(라이브락).
          r.travelVel = 0;
          const from = this._waitFrom?.[ci] ?? -1;
          if (from >= 0) {
            const other = this.sim.world.cranes[from];
            const dx = crane.basePos[0] - other.basePos[0];
            const dz = crane.basePos[2] - other.basePos[2];
            const d = Math.hypot(dx, dz) || 1;
            if (this.#moveClear(ci, [dx / d, dz / d], r.travelSpeed * FIXED_DT)) {
              this.stats[ci].travelSteps += 1;
            } else {
              this.stats[ci].waitSteps += 1; // 후퇴 방향이 막힘 — 제자리 대기
            }
          } else {
            this.stats[ci].waitSteps += 1;
          }
          return ZERO;
        }
        // 가감속 램프: 정지→가속, 잔여 경로 기준 감속 (트럭과 동일 원칙 — 결정론)
        let remDist = 0;
        let prevPt = [crane.basePos[0], crane.basePos[2]];
        for (let s = r.seg; s < r.path.length; s++) {
          remDist += Math.hypot(r.path[s][0] - prevPt[0], r.path[s][1] - prevPt[1]);
          prevPt = r.path[s];
        }
        const vAllow = Math.min(r.travelSpeed, Math.sqrt(2 * r.travelAccel * Math.max(0, remDist)));
        r.travelVel = Math.min(r.travelVel + r.travelAccel * FIXED_DT, vAllow);
        let remain = r.travelVel * FIXED_DT;
        this.stats[ci].travelSteps += 1;
        while (remain > 1e-9 && r.seg < r.path.length) {
          const [tx, tz] = r.path[r.seg];
          const dx = tx - crane.basePos[0];
          const dz = tz - crane.basePos[2];
          const d = Math.hypot(dx, dz);
          const step = Math.min(d, remain);
          const nx = crane.basePos[0] + (dx / d) * step;
          const nz = crane.basePos[2] + (dz / d) * step;
          if (d > 1e-9 && this.#travelStepBlocked(ci, nx, nz)) {
            // 경로가 타 크레인에 접근 차단됨 (출발 시점 경로가 낡았거나 경계에 걸림).
            // 1) 위협에서 물러나 여유 확보 → 2) 현재 위치에서 경로 재계획.
            r.travelVel = 0;
            const esc = this.#escapeDir(ci);
            if (esc) {
              this.#moveClear(ci, esc, r.travelSpeed * FIXED_DT);
            } else {
              const dest = r.action.moveTo ?? r.action.setupPos;
              const path = shortestPath(
                [crane.basePos[0], crane.basePos[2]],
                dest,
                this.#travelZones(ci),
                { clearance: bodyRadiusOf(crane) },
              );
              if (path.ok) {
                r.path = path.path;
                r.seg = 1;
                this.#event('travelReplan', ci, r.action.loadId, { distance: path.distance });
              } else {
                this.stats[ci].waitSteps += 1; // 재계획 불가 — 상대가 비킬 때까지 대기
              }
            }
            remain = 0;
            break;
          }
          crane.basePos[0] = nx;
          crane.basePos[2] = nz;
          this.stats[ci].travelDist += step;
          remain -= step;
          if (step === d) r.seg += 1;
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

  /**
   * 능동 퇴피 명령: 정지 대신 붐 올림 + 선회로 이격 확보.
   *  - 붐 이격: 붐을 상대 반대 방위로 (away 선회)
   *  - 테일 접촉: 테일은 붐 반대편에 있으므로 away 선회는 역효과 —
   *    테일↔위협점 거리의 기울기(∂dist/∂θ) 방향으로 선회해 테일을 빼낸다.
   */
  #evadeCommand(ci) {
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
    return { slew, luff: -1, hoist: 0 };
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
    this._waitFrom = new Array(n).fill(-1); // 양보 유발 상대 (주행 크레인의 후퇴 방향)
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
      // 간섭 판정: 붐은 파킹 후에도 물리적으로 존재 — 모든 쌍을 검사한다.
      // (유휴 크레인을 제외하면 작업 붐이 유휴 붐 옆을 무경고로 스쳐 clash가 난다)
      // 양보 가능 대상: 조종 중(퇴피 가능) 또는 주행 중(일시정지 가능)
      const yieldable = (ci) =>
        this.active[ci] !== null || this.reloc[ci]?.phase === 'travel';
      // 유휴 크레인은 자유로우므로 최우선 양보 대상 — 붐을 상대 반대편으로 돌려 비켜준다
      const idleFree = (ci) =>
        !this.active[ci] && !this.reloc[ci] && !this.stopped[ci];
      const warn = this.opts.warnClearance;
      const near = warn * this.opts.approachFactor;
      for (const p of state.safety?.cranePairs ?? []) {
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
        // 유휴 크레인 우선 양보 (작업을 멈추지 않고 유휴 붐이 비켜준다)
        const target = idleFree(p.b) ? p.b : idleFree(p.a) ? p.a
          : yieldable(p.b) ? p.b : yieldable(p.a) ? p.a : null;
        if (target !== null) {
          this._pairWait.add(key);
          nextWaiting[target] = true;
          waitCause[target] ??= p.tailContact ? 'tailSwing' : 'boomClearance';
          this._waitFrom[target] = target === p.b ? p.a : p.b;
          // 능동 퇴피: 경고 이격 미만이면 양보 크레인이 공간을 낸다
          // (붐 올림 + 상대 반대편으로 선회 — 테일스윙은 선회로만 풀린다)
          // 유휴 크레인은 위험 판정 즉시 조기 퇴피 — 잃을 작업이 없고,
          // 늦게 시작하면 접근 중인 작업 붐과 한 번 스치고(clash) 나서야 풀린다
          if (p.boomDist < warn || p.tailContact || idleFree(target)) {
            this._evade[target] = true;
            this._evadeFrom[target] = target === p.b ? p.a : p.b;
            this._evadeTail[target] = p.tailContact;
          }
          // 초근접 + 접근 중: 진행 크레인도 정지 (퇴피가 이격을 회복할 때까지).
          // 이격이 회복 중이면 진행을 허용 — 양쪽 동결로 인한 라이브락 방지.
          // 양보 대상이 유휴 크레인이면 동결 생략: 유휴 퇴피가 곧 해소하며,
          // 매 스텝 동결/해제 thrash가 작업을 절반 속도로 만들어 양중 타임아웃을 유발한다.
          if ((p.boomDist < this.opts.holdClearance && closing && !idleFree(target)) || p.tailContact) {
            const other = target === p.b ? p.a : p.b;
            if (yieldable(other)) {
              nextWaiting[other] = true;
              waitCause[other] ??= 'holdClearance';
              this._waitFrom[other] = target;
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
        // 유휴 크레인이 간섭 양보 대상이면 붐을 상대 반대편으로 돌려 비켜준다
        // (실제 현장 관행 — 작업 크레인은 멈추지 않는다)
        if (this._evade[ci] && this._evadeFrom[ci] >= 0) cmds[ci] = this.#evadeCommand(ci);
        else if (parkCmds[ci]) cmds[ci] = parkCmds[ci]; // 유휴 파킹
        continue;
      }
      if (this.waiting[ci]) {
        this.stats[ci].waitSteps += 1;
        if (this._evade[ci] && this._evadeFrom[ci] >= 0) {
          cmds[ci] = this.#evadeCommand(ci);
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
        // 비상 안착: 매달린 부재를 현 위치 지면에 내려놓는다 — 영구 hooked(좀비)로 남으면
        // 어떤 크레인도 재인양할 수 없어 에피소드 전체가 막힌다
        const held = this.sim.world.loads.find(
          (l) => l.hookedBy === ci &&
            (l.state === 'hooked' || l.state === 'rigging' || l.state === 'derigging'),
        );
        if (held) {
          held.state = 'ground';
          held.hookedBy = null;
          held.timer = 0;
          held.pos[1] = held.size[1] / 2;
          const crane = this.sim.world.cranes[ci];
          crane.loadMass = 0;
          crane.minHookY = 0;
          this.#event('emergencySetDown', ci, held.id, { pos: [held.pos[0], held.pos[2]] });
        }
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
