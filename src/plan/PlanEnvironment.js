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

import { Simulation, FIXED_DT } from '../sim/Simulation.js';
import { PlanRunner } from './PlanRunner.js';
import { checkLiftFeasible, estimateCycleTime } from './AutoPilot.js';

const DEFAULTS = {
  timeCostPerMin: 1, // 분당 시간 비용
  placeBonus: 5, // 안착 1건당
  collisionCost: 5,
  zoneCost: 5,
  clashCost: 10, // 크레인 간 물리 충돌
  successBonus: 20, // 전건 완료
  failCost: 20, // stuck/timeout 종결
  maxTotalSteps: 400000, // 물리 스텝 한도 (~111분 시뮬)
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
    this.assigned = new Set(); // 배정된 loadId (재배정 없음)
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
    this.runner.queues[c.craneId].push({ craneId: c.craneId, loadId: c.loadId });
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
    }
  }

  /** 실행 가능 후보: (유휴 크레인) × (미배정·지금 feasible한 양중물) */
  #candidates() {
    const out = [];
    const n = this.runner.active.length;
    for (let ci = 0; ci < n; ci++) {
      if (this.runner.active[ci] !== null || this.runner.stopped[ci]) continue;
      if (this.runner.queues[ci].length > 0) continue;
      for (const l of this.sim.world.loads) {
        if (!l.target || l.state === 'placed' || this.assigned.has(`${l.id}:${l.stage}`)) continue;
        const fz = checkLiftFeasible(this.sim, ci, l.id);
        if (!fz.feasible) continue;
        const est = estimateCycleTime(this.sim, ci, l.id) ?? 999;
        const crane = this.sim.world.cranes[ci];
        const [bx, , bz] = crane.basePos;
        const [rMin, rMax] = crane.getRadiusRange();
        out.push({
          craneId: ci,
          loadId: l.id,
          stage: l.stage,
          est, // 분석 근사 사이클타임 (s)
          features: [
            Math.hypot(l.pos[0] - bx, l.pos[2] - bz) / rMax, // 픽업 반경비
            Math.hypot(l.target[0] - bx, l.target[1] - bz) / rMax, // 목표 반경비
            l.mass / Math.max(crane.capacityAtRadius(fz.rLoad ?? rMin), 0.1), // 하중률
            est / 300, // 예상 소요 (정규화)
          ],
        });
      }
    }
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
