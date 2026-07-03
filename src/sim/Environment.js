// 3층: RL 환경 — Simulation을 감싸 표준 강화학습 인터페이스로 노출한다.
// reset() → observation
// step(action) → { observation, reward, done, info }
//
// 코어(World/Crane)는 렌더·RL을 전혀 모르고, 이 파일이 그 위에 관측·보상·종료를 얹는다.
// 사람이 키보드로 넣던 것과 동일한 정규화 명령({slew,luff,hoist})을 에이전트가 낸다.
// 픽업/해제는 이산 액션 attach(rising edge에서 토글).
//
// 보상 설계(포텐셜 기반 shaping): 목표까지 남은 거리를 포텐셜 Φ로 두고
//   reward += (Φ_prev - Φ_now)  → 목표로 다가가면 +, 멀어지면 -
// 여기에 이벤트 보너스/페널티(안착 성공, 충돌, 금지구역, 과하중, 시간)를 더한다.

import { Simulation, FIXED_DT } from './Simulation.js';

const MAX_RADIUS = 40; // 관측 정규화 스케일 (m)
const MAX_HEIGHT = 45;

const DEFAULT_OPTS = {
  maxSteps: 9000, // 에피소드 최대 스텝 (약 150s @ 60Hz — 저속 크레인 1사이클 여유)
  placeBonus: 20, // 목표 안착 성공 1건당
  timeCost: 0.002, // 스텝당 시간 페널티
  overloadCost: 0.5, // 모멘트 리미터 작동 중 스텝당
  collisionCost: 5, // 신규 충돌 진입 1회당
  zoneCost: 5, // 신규 금지구역 침범 1회당
  dropCost: 2, // 목표 밖에 잘못 내려놓기 1회당
  observeSafety: false, // true면 관측에 [최근접 장애물 상대위치, 금지구역 위 여부] 추가
};

export class Environment {
  /**
   * @param {Object} scenario data/cranes.js의 시나리오
   * @param {Object} [opts] 보상·종료 파라미터 오버라이드
   */
  constructor(scenario, opts = {}) {
    this.sim = new Simulation(scenario);
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this.dt = FIXED_DT;
    this.reset();
  }

  /** @returns {number[]} 초기 관측 */
  reset() {
    this.sim.reset();
    this.steps = 0;
    this._prevAttach = false;
    this._prevPotential = this.#potential();
    this._prevCollisions = 0;
    this._prevViolations = 0;
    return this.#observation();
  }

  /**
   * @param {Object} action { slew, luff, hoist: -1..1, attach: boolean }
   * @returns {{observation:number[], reward:number, done:boolean, info:Object}}
   */
  step(action = {}) {
    const o = this.opts;

    // 이산 액션: attach는 상승 에지에서만 토글 (누르고 있어도 1회)
    const attach = !!action.attach;
    let attachResult = null;
    if (attach && !this._prevAttach) attachResult = this.sim.toggleAttach(0);
    this._prevAttach = attach;

    // 연속 액션 → 고정스텝 1회 진행 (결정론)
    const cmd = {
      slew: clampCmd(action.slew),
      luff: clampCmd(action.luff),
      hoist: clampCmd(action.hoist),
    };
    const state = this.sim.stepFixed([cmd], 1);
    this.steps += 1;

    // --- 보상 ---
    const potential = this.#potential();
    let reward = this._prevPotential - potential; // 포텐셜 shaping
    this._prevPotential = potential;

    reward -= o.timeCost;
    if (state.cranes[0].extra.limiterActive) reward -= o.overloadCost;

    // 신규 안전 위반 (에지 카운트 증분)
    const s = state.safety;
    const newCollisions = s.collisionCount - this._prevCollisions;
    const newViolations = s.violationCount - this._prevViolations;
    if (newCollisions > 0) reward -= o.collisionCost * newCollisions;
    if (newViolations > 0) reward -= o.zoneCost * newViolations;
    this._prevCollisions = s.collisionCount;
    this._prevViolations = s.violationCount;

    // 안착 이벤트 (attach 액션의 결과)
    let placedThisStep = false;
    if (attachResult?.placed === true) {
      reward += o.placeBonus;
      placedThisStep = true;
    } else if (attachResult && attachResult.placed === false && attachResult.error != null) {
      reward -= o.dropCost; // 목표 밖 내려놓기
    }

    // --- 종료 ---
    const success = this.sim.world.allPlaced();
    const timeout = this.steps >= o.maxSteps;
    const done = success || timeout;
    if (success) reward += o.placeBonus; // 완주 보너스

    const info = {
      success,
      timeout,
      steps: this.steps,
      collisions: s.collisionCount,
      violations: s.violationCount,
      placedThisStep,
      attach: attachResult,
      event: state.lastEvent,
    };
    return { observation: this.#observation(), reward, done, info };
  }

  /** 목표까지 남은 거리 합을 음의 포텐셜로 (작을수록 좋음) */
  #potential() {
    const state = this.sim.getState();
    const hook = state.cranes[0].hookPos;
    let total = 0;
    for (const l of state.loads) {
      if (!l.target) continue;
      if (l.state === 'placed') continue; // 남은 거리 0
      const [tx, tz] = l.target;
      const loadToTarget = Math.hypot(l.pos[0] - tx, l.pos[2] - tz);
      if (l.state === 'hooked') {
        total += loadToTarget;
      } else {
        // 아직 지상: 후크→부재 + 부재→목표 (픽업까지 유도)
        const hookToLoad = Math.hypot(hook[0] - l.pos[0], hook[2] - l.pos[2]);
        total += hookToLoad + loadToTarget;
      }
    }
    return total;
  }

  /** 관측 벡터: 크레인 자세 + 활성 부재/목표 상대위치 (대략 정규화) */
  #observation() {
    const state = this.sim.getState();
    const c = state.cranes[0];
    const hook = c.hookPos;
    const active = state.loads.find((l) => l.target && l.state !== 'placed');

    let hooked = 0;
    let dLoadX = 0, dLoadZ = 0, dTargetX = 0, dTargetZ = 0;
    if (active) {
      hooked = active.state === 'hooked' ? 1 : 0;
      dLoadX = (active.pos[0] - hook[0]) / MAX_RADIUS;
      dLoadZ = (active.pos[2] - hook[2]) / MAX_RADIUS;
      dTargetX = (active.target[0] - active.pos[0]) / MAX_RADIUS;
      dTargetZ = (active.target[1] - active.pos[2]) / MAX_RADIUS;
    }

    const obs = [
      Math.sin(c.slewAngle),
      Math.cos(c.slewAngle),
      c.radius / MAX_RADIUS,
      c.hookHeight / MAX_HEIGHT,
      Math.min(c.loadRatio, 2), // 하중률 (과하중은 2로 캡)
      c.extra.limiterActive ? 1 : 0,
      hooked,
      dLoadX, dLoadZ, // 후크→부재
      dTargetX, dTargetZ, // 부재→목표
    ];

    // 옵션: 안전 관측 — 최근접 장애물 상대위치 + 금지구역 위 여부
    if (this.opts.observeSafety) {
      let obX = 0, obZ = 0, obBest = Infinity;
      for (const ob of state.obstacles ?? []) {
        const dx = ob.pos[0] - hook[0];
        const dz = ob.pos[2] - hook[2];
        const d = Math.hypot(dx, dz);
        if (d < obBest) {
          obBest = d;
          obX = dx / MAX_RADIUS;
          obZ = dz / MAX_RADIUS;
        }
      }
      const inNfz = (state.noFlyZones ?? []).some(
        (z) =>
          hook[0] >= z.min[0] && hook[0] <= z.max[0] &&
          hook[2] >= z.min[1] && hook[2] <= z.max[1],
      );
      obs.push(obX, obZ, inNfz ? 1 : 0);
    }
    return obs;
  }

  /** 관측 차원 (에이전트 네트워크 입력 크기) */
  get observationSize() {
    return this.#observation().length;
  }
}

function clampCmd(v) {
  const n = Number(v) || 0;
  return n < -1 ? -1 : n > 1 ? 1 : n;
}
