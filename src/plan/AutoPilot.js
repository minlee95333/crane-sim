// 계획 계층 1단: AutoPilot — 양중 1건 자동 완주 (SIM_DESIGN P1).
//
// (크레인, 양중물)을 지정하면 물리 시뮬 위에서 아래 단계를 자동 수행한다:
//   goto-load(접근·권하) → attach(줄걸이) → lift(권상) → goto-target(선회·기복)
//   → lower(미세정렬 하강) → release(안착) → clear(후크 이격) → done
//
// 역할: 계획 계층(PlanRunner)의 실행 엔진이자 "현실 기반 사이클 타임 오라클".
// V2의 규칙 기반 duration 추정을 대체하는 cycleTime이 여기서 나온다.
//
// 설계:
//  - decide()는 고정스텝 1회분의 명령만 산출(P-제어 + 위상 상태기계). 시뮬을 직접
//    진행하지 않으므로, PlanRunner가 여러 크레인의 AutoPilot을 병렬로 합성할 수 있다.
//  - 결정론: 상태→명령이 순수 함수적. 난수 없음.
//  - 장애물 회피는 P1 범위 아님(P4) — 대신 이동 고도(travelY)를 장애물 최고높이
//    위로 자동 설정해 대부분의 충돌을 예방한다. 충돌·침범은 카운트되어 보고된다.

import { FIXED_DT } from '../sim/Simulation.js';
import { HOOK_GAP } from '../core/World.js';
import { checkStability, checkTravelStability, pickCarryCapacity } from '../core/Stability.js';

const DEFAULTS = {
  maxSteps: 40000, // 안전 타임아웃 (약 666s 시뮬시간)
  slewGain: 20, // cmd = clamp(각도오차 × gain) — 2.9° 이상이면 전속
  luffGain: 1.25, // 반경 오차 0.8m 이상이면 전속
  hoistGain: 1.25,
  alignTol: 0.5, // 목표 위 수평 정렬 허용 (m) < World PLACE_TOL(1.5)
  approachTol: 1.0, // 픽업 접근 수평 허용 (m) < World ATTACH_MAX_HORIZ(2.0)
  releaseSwayMax: 0.2, // 흔들림이 이보다 크면 안착 대기 (m)
  clearance: 1.5, // 이동 고도: 장애물 위 여유 (m)
  creepSpeed: 0.3, // 미세정렬: 지면 근처 하강 명령 상한 (실제 인칭 조작)
  creepZone: 2.0, // 크리프 적용 시작 높이 — 부재 바닥~지면 (m)
  trialLiftTime: null, // 시험인양 유지 시간 (s). null → scenario.rigging.trialLiftTime ?? 0
};

const ZERO = { slew: 0, luff: 0, hoist: 0 };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrap = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

/**
 * 시간적 차단 사유 (대기하면 풀림): 반입 전 · 시공순서 선행 미완 · 풍속 초과.
 * @returns {string|null} 차단 사유. 없으면 null
 */
export function liftBlockedReason(sim, load) {
  if (load.state === 'pending') return `반입 전 (t=${load.arriveTime}s 도착 예정)`;
  // 시공순서는 최종 안착(건립) 단계에만 — 하역·야적 이동은 선행 무관
  if (load.finalLeg) {
    const unmet = load.dependsOn.filter(
      (id) => sim.world.loads.find((l) => l.id === id)?.state !== 'placed',
    );
    if (unmet.length > 0) return `선행 부재 미완: ${unmet.join(', ')}`;
  }
  if (sim.world.windDef && sim.world.windSpeed > sim.world.windLimitFor(load))
    return `풍속 초과: ${sim.world.windSpeed.toFixed(1)} > 한계 ${sim.world.windLimitFor(load)} m/s`;
  return null;
}

/**
 * 필요 이동고도: 장애물·기시공 구조물 위 + 고소 안착 여유 (크레인 권상능력 캡 미적용).
 */
function requiredTravelY(sim, load, clearance) {
  const maxObH = Math.max(
    0,
    ...sim.world.obstacles.map((o) => o.size[1]),
    ...sim.world.loads.filter((l) => l.state === 'placed').map((l) => l.topY),
  );
  return Math.max(
    8,
    maxObH + load.size[1] + HOOK_GAP + clearance,
    load.targetElev + load.size[1] + HOOK_GAP + clearance,
  );
}

/**
 * 타당성 사전검사: 반경 도달범위·정격하중·목표 유무 + 시간 제약.
 * 시뮬을 돌리지 않고 "이 크레인이 이 양중을 할 수 있는가"를 준정적으로 판정.
 * 계획 탐색(PlanRunner/autoPlan)의 후보 필터로 단독 사용 가능.
 *
 * 반환 구분:
 *  - { feasible: true }                          — 지금 바로 가능
 *  - { feasible: false, blocked: true, reason }  — 일시 차단 (반입 전·선행 미완·풍속) → 대기하면 풀림
 *  - { feasible: false, reason }                 — 영구 불가 (도달·정격·안정성) → 스킵 대상
 */
export function checkLiftFeasible(sim, craneId, loadId, opts = {}) {
  const clearance = opts.clearance ?? DEFAULTS.clearance;
  const crane = sim.world.cranes[craneId];
  const load = sim.world.loads.find((l) => l.id === loadId);
  if (!crane) return { feasible: false, reason: `크레인 없음: ${craneId}` };
  if (!load) return { feasible: false, reason: `부재 없음: ${loadId}` };
  if (!load.target) return { feasible: false, reason: `목표(target) 미정의: ${loadId}` };
  if (load.state === 'placed') return { feasible: false, reason: '이미 안착됨' };
  if (load.state === 'hooked' && load.hookedBy !== craneId)
    return { feasible: false, reason: '다른 크레인이 인양 중' };

  const [bx, , bz] = crane.basePos;
  const rLoad = Math.hypot(load.pos[0] - bx, load.pos[2] - bz);
  const rTarget = Math.hypot(load.target[0] - bx, load.target[1] - bz);
  const [rMin, rMax] = crane.getRadiusRange();
  const TOL = 0.05;
  if (rLoad < rMin - TOL || rLoad > rMax + TOL)
    return { feasible: false, reason: `픽업 반경 ${rLoad.toFixed(1)}m가 도달범위 [${rMin.toFixed(1)}, ${rMax.toFixed(1)}] 밖` };
  if (rTarget < rMin - TOL || rTarget > rMax + TOL)
    return { feasible: false, reason: `목표 반경 ${rTarget.toFixed(1)}m가 도달범위 [${rMin.toFixed(1)}, ${rMax.toFixed(1)}] 밖` };

  // 정격: 픽업·목표 반경 모두에서 (경로가 반경 단조라 양끝이 최솟값 근사)
  // 계획 여유: 동하중계수 × 하중 ≤ 정격 − 후크블록 공제 (spec.rating, 기본 1.0/0)
  const rating = crane.spec.rating ?? {};
  const need = load.mass * (rating.dynamicFactor ?? 1.0);
  const deduct = rating.hookBlockMass ?? 0;
  const capLoad = crane.capacityAtRadius(rLoad) - deduct;
  const capTarget = crane.capacityAtRadius(rTarget) - deduct;
  if (need > capLoad)
    return { feasible: false, reason: `정격 초과: 필요 ${need.toFixed(1)}t(동하중 포함) > 가용 ${capLoad.toFixed(1)}t @픽업 r=${rLoad.toFixed(1)}m` };
  if (need > capTarget)
    return { feasible: false, reason: `정격 초과: 필요 ${need.toFixed(1)}t(동하중 포함) > 가용 ${capTarget.toFixed(1)}t @목표 r=${rTarget.toFixed(1)}m` };

  // 셋업 안정성: 시나리오에 지반 조건이 정의된 경우 전도·접지압 검사 (worst = 큰 반경, over-side)
  const ground = sim.scenario?.ground ?? null;
  if (ground && crane.spec.masses) {
    const st = checkStability({
      spec: crane.spec,
      boomLength: crane.boomLength,
      radius: Math.max(rLoad, rTarget),
      loadMass: load.mass,
      ground,
    });
    if (!st.tipOK)
      return { feasible: false, reason: `전도 여유 부족: 안전율 ${st.tippingMargin.toFixed(2)} < 1.33 @r=${Math.max(rLoad, rTarget).toFixed(1)}m` };
    if (!st.groundOK)
      return { feasible: false, reason: `지반 지지력 부족: 접지압 ${st.groundPressure.toFixed(1)} > 허용 ${ground.bearingCapacity}t/m²` };
  }

  // --- 시간 제약 (일시 차단 — 대기하면 풀림) ---
  const blockedReason = liftBlockedReason(sim, load);
  if (blockedReason) return { feasible: false, blocked: true, reason: blockedReason };

  // 이동 고도: 장애물·기시공 구조물(placed) 최고높이 위로 부재 바닥이 지나가도록.
  // 고소 안착(기둥 위 거더 등)은 목표 바닥고 + 부재높이도 넘어야 함.
  const needY = requiredTravelY(sim, load, clearance);
  const capY = Math.min(crane.maxHookHeightAt(rLoad), crane.maxHookHeightAt(rTarget)) - 0.5;
  const travelY = Math.min(needY, capY);

  return { feasible: true, travelY, target: [...load.target], rLoad, rTarget };
}

/**
 * 픽앤캐리(주행 인양) 타당성 (SIM_DESIGN T2-⑧).
 * 픽업은 현 셋업에서, 목표는 캐리 목적지(carryTo)에서 도달하되, 그 사이를 하중을 매단 채
 * 주행한다. 세 지점의 정격 규칙이 다르다:
 *   - 픽업/안착: 크레인 정지 → 정적 정격 × 동하중계수
 *   - 캐리 주행: 감격 정격(pickCarryFactor) + 주행 중 전도 안정성
 * @param {[number,number]} carryTo 캐리 목적지 베이스 [x, z]
 * @returns {{feasible, reason?, carryRadius?, carryHeight?, target?, travelY?, rPick?, rPlace?}}
 */
export function checkCarryFeasible(sim, craneId, loadId, carryTo, opts = {}) {
  const crane = sim.world.cranes[craneId];
  const load = sim.world.loads.find((l) => l.id === loadId);
  if (!crane || crane.spec.type !== 'mobile')
    return { feasible: false, reason: '픽앤캐리는 이동식 크레인만 가능' };
  if (!load) return { feasible: false, reason: `부재 없음: ${loadId}` };
  if (!load.target) return { feasible: false, reason: `목표 미정의: ${loadId}` };

  const planning = crane.spec.planning ?? {};
  if (!(planning.movable ?? true)) return { feasible: false, reason: '고정식 크레인' };
  const rating = crane.spec.rating ?? {};
  const dyn = rating.dynamicFactor ?? 1.0;
  const deduct = rating.hookBlockMass ?? 0;

  // opts.fromBase: 가상 픽업 셋업 평가 (재배치 후 캐리 후보용). 기본은 현 베이스.
  const [bx, bz] = opts.fromBase ?? [crane.basePos[0], crane.basePos[2]];
  const [rMin, rMax] = crane.getRadiusRange();

  // 픽업: 픽업 셋업에서 도달 + 정적 정격 (크레인 정지)
  const rPick = Math.hypot(load.pos[0] - bx, load.pos[2] - bz);
  if (rPick < rMin - 0.05 || rPick > rMax + 0.05)
    return { feasible: false, reason: `픽업 반경 ${rPick.toFixed(1)}m 도달범위 밖 [${rMin.toFixed(1)}, ${rMax.toFixed(1)}]` };
  if (load.mass * dyn > crane.capacityAtRadius(rPick) - deduct)
    return { feasible: false, reason: `픽업 정격 초과 @r=${rPick.toFixed(1)}m` };

  // 안착: 캐리 목적지에서 도달 + 정적 정격
  const rPlace = Math.hypot(load.target[0] - carryTo[0], load.target[1] - carryTo[1]);
  if (rPlace < rMin - 0.05 || rPlace > rMax + 0.05)
    return { feasible: false, reason: `안착 반경 ${rPlace.toFixed(1)}m 도달범위 밖 (캐리 목적지 기준)` };
  if (load.mass * dyn > crane.capacityAtRadius(rPlace) - deduct)
    return { feasible: false, reason: `안착 정격 초과 @r=${rPlace.toFixed(1)}m` };

  // 캐리: 하중을 몸체 가까이(캐리 반경) 낮게 매달고 주행 → 감격 정격 + 주행 전도
  const carryRadius = Math.min(rMax, Math.max(rMin, planning.carryRadius ?? rMin + 2));
  const carryHeight = load.size[1] / 2 + (planning.carryClearance ?? 0.8); // 하중 무게중심 높이
  const deratedCap = pickCarryCapacity(crane.capacityAtRadius(carryRadius), rating) - deduct;
  if (load.mass > deratedCap)
    return { feasible: false, reason: `픽앤캐리 감격 정격 초과: ${load.mass}t > 감격 ${deratedCap.toFixed(1)}t @r=${carryRadius.toFixed(1)}m` };

  const ground = sim.scenario?.ground ?? null;
  if (crane.spec.masses) {
    const accel = planning.carryAccel ?? 0.3;
    const ts = checkTravelStability({
      spec: crane.spec, boomLength: crane.boomLength,
      carryRadius, carryHeight, loadMass: load.mass, accel,
    });
    if (!ts.tipOK)
      return { feasible: false, reason: `주행 중 전도 여유 부족: 안전율 ${ts.tippingMargin.toFixed(2)} < 1.33` };
    // 지반: 캐리 반경 기준 접지압 (정지 검사 재사용)
    if (ground) {
      const gs = checkStability({ spec: crane.spec, boomLength: crane.boomLength, radius: carryRadius, loadMass: load.mass, ground });
      if (!gs.groundOK)
        return { feasible: false, reason: `지반 지지력 부족(캐리): 접지압 ${gs.groundPressure.toFixed(1)} > ${ground.bearingCapacity}` };
    }
  }

  const blockedReason = liftBlockedReason(sim, load);
  if (blockedReason) return { feasible: false, blocked: true, reason: blockedReason };

  const travelY = requiredTravelY(sim, load, opts.clearance ?? DEFAULTS.clearance);
  return {
    feasible: true, carryRadius, carryHeight,
    target: [...load.target], travelY, rPick, rPlace,
  };
}

/**
 * 사이클 타임 분석적 근사 (SIM_DESIGN 2.5절의 "근사 모드").
 * 물리 시뮬 없이 속도 한계·거리로 닫힌식 추정 — 계획 탐색의 후보 특징량,
 * V2 duration 추정 대체용. 가속 램프·P-제어 감속을 무시하므로 보정계수 1.15를 곱한다.
 *
 * 가상 셋업 평가(재배치 후보용): opts.basePos([x,z])·opts.boomLength를 주면
 * "크레인이 그 셋업에 있다면"의 사이클 타임을 추정한다. 이때 타당성은 호출자가
 * 셋업 탐색(evaluateSetup)으로 이미 보장했으므로 opts.assumeFeasible로 검사를 생략한다.
 * @returns {number|null} 추정 사이클 타임 (s). infeasible이면 null
 */
export function estimateCycleTime(sim, craneId, loadId, opts = {}) {
  const crane = sim.world.cranes[craneId];
  const load = sim.world.loads.find((l) => l.id === loadId);

  let fz;
  if (opts.assumeFeasible) {
    fz = { feasible: true, travelY: requiredTravelY(sim, load, opts.clearance ?? DEFAULTS.clearance) };
  } else {
    fz = checkLiftFeasible(sim, craneId, loadId, opts);
    if (!fz.feasible && !fz.blocked) return null;
  }

  const [bx, bz] = opts.basePos ?? [crane.basePos[0], crane.basePos[2]];
  const boomLen = opts.boomLength ?? crane.boomLength;
  const L = crane.limits;

  const th0 = crane.slewAngle;
  const r0 = crane.getRadius();
  const hook0 = crane.getHookPos()[1];
  const thL = Math.atan2(load.pos[2] - bz, load.pos[0] - bx);
  const rL = Math.hypot(load.pos[0] - bx, load.pos[2] - bz);
  const thT = Math.atan2(load.target[1] - bz, load.target[0] - bx);
  const rT = Math.hypot(load.target[0] - bx, load.target[1] - bz);

  // 반경 변경 속도: 타워=트롤리 직결, 이동식=붐끝 수평속도 근사 (L·sinθ·ω, θ~53°)
  const radial = crane.spec.type === 'tower' ? L.trolleySpeed : boomLen * 0.8 * L.luffRate;
  const hoist = L.hoistSpeed;
  const travelY = fz.travelY ?? 10;
  const topY = load.topY;
  const elevT = load.targetElev ?? 0; // 목표 바닥고 (고소 안착)
  const trial = opts.trialLiftTime ?? sim.scenario?.rigging?.trialLiftTime ?? 0;

  const t =
    Math.abs(wrap(thL - th0)) / L.slewRate + Math.abs(rL - r0) / radial + // 접근
    Math.abs(hook0 - (topY + 2.5)) / hoist + // 부재 위로 하강
    load.rigTime + trial + // 줄걸이·시험인양
    Math.max(0, travelY - (topY + 1.2)) / hoist + // 이동고도 권상
    Math.abs(wrap(thT - thL)) / L.slewRate + Math.abs(rT - rL) / radial + // 이송
    Math.max(0, travelY - (elevT + load.size[1])) / hoist + 2 / (0.3 * hoist) + // 하강+크리프
    load.derigTime + 3.5 / hoist + 8; // 해체·후크 이격·정렬 여유

  return t * 1.15;
}

export class AutoPilot {
  /**
   * @param {import('../sim/Simulation.js').Simulation} sim
   * @param {number} craneId
   * @param {string} loadId 목표(target)가 정의된 부재
   * @param {Object} [opts]
   */
  constructor(sim, craneId, loadId, opts = {}) {
    this.sim = sim;
    this.craneId = craneId;
    this.loadId = loadId;
    this.opts = { ...DEFAULTS, ...opts };

    this.phase = 'init';
    this.done = false;
    this.ok = false;
    this.reason = null;
    this.steps = 0;
    this.phaseLog = [];
    this.finalErr = null; // 안착 직전 수평 오차 (m)
    this._toggleRequested = false;

    // 시험인양: opts 우선, 없으면 시나리오 리깅 설정
    this.trialTime = this.opts.trialLiftTime ?? sim.scenario?.rigging?.trialLiftTime ?? 0;
    this._trialSteps = 0;
    // 픽업 지지면 높이 (트럭 적재함 1.35m 등 — 시험인양 기준면)
    const l0 = sim.world.loads.find((l) => l.id === loadId);
    this._pickupElev = l0 ? l0.bottomY : 0;
    // 시작 시점의 여정 단계 — 중간 단계(하역) 안착은 stage 전진으로 성공 판정
    this._startStage = l0?.stage ?? 0;

    // 픽앤캐리: opts.carryTo([x,z]) 지정 시 하중을 매단 채 목적지로 주행하는 양중.
    this.carryTo = opts.carryTo ?? null;
    this.carrying = false;
    this._carryVel = 0;

    const fz = this.carryTo
      ? checkCarryFeasible(sim, craneId, loadId, this.carryTo, this.opts)
      : checkLiftFeasible(sim, craneId, loadId, this.opts);
    if (!fz.feasible) {
      this.#finish(false, fz.reason, 'infeasible');
    } else {
      this.travelY = fz.travelY;
      this.target = fz.target;
      if (this.carryTo) {
        this.carrying = true;
        this.carryRadius = fz.carryRadius;
        this.carryHeight = fz.carryHeight;
      }
      this.#setPhase('goto-load');
    }
  }

  /**
   * 고정스텝 1회분의 결정.
   * @returns {{command:Object, attach:boolean, done:boolean, phase:string}}
   *   attach=true인 스텝에는 호출측이 sim.toggleAttach(craneId) 후 step해야 한다.
   */
  decide() {
    if (this.done) return { command: ZERO, attach: false, done: true, phase: this.phase };
    this.steps += 1;
    if (this.steps > this.opts.maxSteps) {
      this.#finish(false, `타임아웃 (phase=${this.phase})`);
      return { command: ZERO, attach: false, done: true, phase: this.phase };
    }

    const o = this.opts;
    const state = this.sim.getState();
    const c = state.cranes[this.craneId];
    const l = state.loads.find((x) => x.id === this.loadId);
    if (!l) {
      this.#finish(false, '부재 소실');
      return { command: ZERO, attach: false, done: true, phase: this.phase };
    }
    const hook = c.hookPos;
    const topY = l.pos[1] + l.size[1] / 2;
    // 지지면 기준 바닥 간격: 픽업 전엔 지면/적재면, 목표 접근 시엔 목표 바닥고(기둥 위 등)
    const support = l.state === 'hooked' ? (l.targetElev ?? 0) : 0;
    const bottomGap = l.pos[1] - l.size[1] / 2 - support;

    let command = ZERO;
    let attach = false;

    switch (this.phase) {
      case 'goto-load': {
        // 부재 위로 접근하며 후크를 상면 근처(+2.5m)로
        command = this.#polarCmd(c, l.pos[0], l.pos[2], topY + 2.5);
        const horiz = Math.hypot(hook[0] - l.pos[0], hook[2] - l.pos[2]);
        if (horiz <= o.approachTol && Math.abs(hook[1] - topY) <= 3.5) {
          this.#setPhase('attach');
        }
        break;
      }

      case 'attach': {
        if (!this._toggleRequested) {
          this._toggleRequested = true;
          attach = true; // 호출측이 toggleAttach 실행
        } else if (l.state === 'rigging') {
          // 줄걸이 작업 대기 (크레인은 World가 동결)
        } else if (l.state === 'hooked' && l.hookedBy === this.craneId) {
          this._toggleRequested = false;
          this.#setPhase(this.trialTime > 0 ? 'trial' : this.carrying ? 'lift-carry' : 'lift');
        } else {
          this._toggleRequested = false;
          this.#finish(false, '줄걸이 실패 (후크가 부재 범위 밖)');
        }
        break;
      }

      case 'trial': {
        // 시험인양: 지지면에서 살짝 들어 올려 유지 (수평·정격 확인 절차)
        const liftBase = l.pos[1] - l.size[1] / 2 - (this._pickupElev ?? 0);
        const holdY = (this._pickupElev ?? 0) + HOOK_GAP + l.size[1] + 0.4;
        if (liftBase < 0.25) {
          command = { slew: 0, luff: 0, hoist: clamp((holdY - hook[1]) * o.hoistGain, -1, 0.4) };
        } else {
          this._trialSteps += 1; // 유지 시간 카운트 (정지 상태)
          if (this._trialSteps * FIXED_DT >= this.trialTime)
            this.#setPhase(this.carrying ? 'lift-carry' : 'lift');
        }
        break;
      }

      case 'lift-carry': {
        // 픽앤캐리 준비: 하중을 캐리 반경으로 당기고 캐리 높이(낮게)까지만 권상
        const hookCarryY = this.carryHeight + l.size[1] / 2 + HOOK_GAP;
        command = {
          slew: 0,
          luff: clamp((this.carryRadius - c.radius) * o.luffGain, -1, 1),
          hoist: clamp((hookCarryY - hook[1]) * o.hoistGain, -1, 1),
        };
        if (Math.abs(c.radius - this.carryRadius) < 0.5 && Math.abs(hook[1] - hookCarryY) < 0.4) {
          this.#setPhase('carry');
        }
        break;
      }

      case 'carry': {
        // 하중을 매단 채 베이스를 목적지(carryTo)로 주행 — 가감속 램프.
        // 베이스 이동은 이 페이즈의 고유 부작용 (AutoPilot이 곧 실행 엔진).
        const crane = this.sim.world.cranes[this.craneId];
        const planning = crane.spec.planning ?? {};
        const speed = Math.max(0.01, planning.carrySpeed ?? 0.4); // 캐리는 느리게 (안전)
        const accel = Math.max(0.01, planning.carryAccel ?? 0.3);
        const dx = this.carryTo[0] - crane.basePos[0];
        const dz = this.carryTo[1] - crane.basePos[2];
        const remD = Math.hypot(dx, dz);
        // 팔은 캐리 자세 유지 (반경·높이 고정, 선회 없음)
        const hookCarryY = this.carryHeight + l.size[1] / 2 + HOOK_GAP;
        command = {
          slew: 0,
          luff: clamp((this.carryRadius - c.radius) * o.luffGain, -1, 1),
          hoist: clamp((hookCarryY - hook[1]) * o.hoistGain, -1, 1),
        };
        if (remD < 0.15) {
          this._carryVel = 0;
          this.carrying = false; // 이후 'lift'는 정상 경로(→ goto-target)
          this.#setPhase('lift');
        } else {
          const vAllow = Math.min(speed, Math.sqrt(2 * accel * remD));
          this._carryVel = Math.min(this._carryVel + accel * FIXED_DT, vAllow);
          const stepD = Math.min(remD, this._carryVel * FIXED_DT);
          crane.basePos[0] += (dx / remD) * stepD;
          crane.basePos[2] += (dz / remD) * stepD;
        }
        break;
      }

      case 'lift': {
        // 이동 고도까지 수직 권상 (선회는 아직 — 낮은 높이 선회로 인한 충돌 방지)
        command = { slew: 0, luff: 0, hoist: clamp((this.travelY - hook[1]) * o.hoistGain, -1, 1) };
        if (Math.abs(hook[1] - this.travelY) < 0.4) this.#setPhase('goto-target');
        break;
      }

      case 'goto-target': {
        command = this.#polarCmd(c, this.target[0], this.target[1], this.travelY);
        const err = Math.hypot(l.pos[0] - this.target[0], l.pos[2] - this.target[1]);
        if (err <= o.alignTol) this.#setPhase('lower');
        break;
      }

      case 'lower': {
        // 정렬 유지하며 하강 (목표 바닥고 위로 — 기둥 위 거더 등 고소 안착 포함).
        // 오차가 벌어지면 하강 일시정지(정렬 우선)
        const err = Math.hypot(l.pos[0] - this.target[0], l.pos[2] - this.target[1]);
        const cmd = this.#polarCmd(
          c, this.target[0], this.target[1],
          (l.targetElev ?? 0) + HOOK_GAP + l.size[1] + 0.3,
        );
        if (err > o.alignTol * 2) cmd.hoist = 0; // 정렬 우선
        // 미세정렬 크리프: 지면 근처에서는 인칭(저속) 하강 — 실제 안착 조작
        if (bottomGap < o.creepZone) cmd.hoist = Math.max(cmd.hoist, -o.creepSpeed);
        command = cmd;
        const swayOK = (c.extra.swayMag ?? 0) <= o.releaseSwayMax;
        if (bottomGap <= 0.45 && err <= o.alignTol && swayOK) {
          this.finalErr = err;
          this.#setPhase('release');
        }
        break;
      }

      case 'release': {
        if (!this._toggleRequested) {
          this._toggleRequested = true;
          attach = true;
        } else if (l.state === 'derigging') {
          // 해체 작업 대기 (크레인은 World가 동결)
        } else {
          this._toggleRequested = false;
          // 성공: 최종 안착(placed) 또는 중간 단계 안착(stage 전진 — 하역·야적)
          if (l.state === 'placed' || (l.stage ?? 0) > this._startStage) this.#setPhase('clear');
          else if (l.state === 'hooked') this.#setPhase('lower'); // 해제 거부(공중) → 더 하강
          else this.#finish(false, `목표 밖 안착 (오차 ${this.finalErr?.toFixed(2)}m)`);
        }
        break;
      }

      case 'clear': {
        // 후크를 부재 위로 이격 → 다음 양중 준비 상태로 종료
        command = { slew: 0, luff: 0, hoist: clamp((topY + 3.5 - hook[1]) * o.hoistGain, -1, 1) };
        if (hook[1] >= topY + 3) this.#finish(true, null);
        break;
      }

      default:
        this.#finish(false, `알 수 없는 phase: ${this.phase}`);
    }

    return { command, attach, done: this.done, phase: this.phase };
  }

  /** 극좌표 P-제어: 목표점(gx, gz)·후크높이(hy)로 향하는 정규화 명령 */
  #polarCmd(c, gx, gz, hy) {
    const o = this.opts;
    const [bx, , bz] = c.basePos;
    const thTarget = Math.atan2(gz - bz, gx - bx);
    const rTarget = Math.hypot(gx - bx, gz - bz);
    return {
      slew: clamp(wrap(thTarget - c.slewAngle) * o.slewGain, -1, 1),
      luff: clamp((rTarget - c.radius) * o.luffGain, -1, 1),
      hoist: clamp((hy - c.hookPos[1]) * o.hoistGain, -1, 1),
    };
  }

  #setPhase(p) {
    this.phase = p;
    this.phaseLog.push({ phase: p, t: this.steps * FIXED_DT });
  }

  #finish(ok, reason, phase = 'done') {
    this.done = true;
    this.ok = ok;
    this.reason = reason;
    this.#setPhase(phase);
  }
}

/**
 * 양중 1건을 일괄 실행 (헤드리스). 다른 크레인은 정지 상태로 둔다.
 * @returns {{ok, reason, steps, cycleTime, placeError, collisions, violations, phases}}
 */
export function runLift(sim, craneId, loadId, opts = {}) {
  const pilot = new AutoPilot(sim, craneId, loadId, opts);
  const n = sim.getState().cranes.length;
  const s0 = sim.getState().safety;
  const before = { col: s0.collisionCount, vio: s0.violationCount };

  while (!pilot.done) {
    const d = pilot.decide();
    if (d.done) break;
    if (d.attach) sim.toggleAttach(craneId);
    const cmds = Array.from({ length: n }, (_, i) => (i === craneId ? d.command : ZERO));
    sim.stepFixed(cmds, 1);
  }

  const s1 = sim.getState().safety;
  return {
    ok: pilot.ok,
    reason: pilot.reason,
    steps: pilot.steps,
    cycleTime: pilot.steps * FIXED_DT,
    placeError: pilot.finalErr,
    collisions: s1.collisionCount - before.col,
    violations: s1.violationCount - before.vio,
    phases: pilot.phaseLog,
  };
}
