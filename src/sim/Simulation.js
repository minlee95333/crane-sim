// 2층: 제어 인터페이스 — reset() / step(command) / getState().
// 지금은 사람(키보드)·스크립트가 명령을 넣고, 나중에 RL 에이전트가 같은 자리에 붙는다.
// 이 파일의 시그니처가 안정적이면 RL 전환 시 코어는 손대지 않는다.
//
// 물리 스텝은 고정 dt(FIXED_DT)로 돌리고, 렌더 프레임과 분리한다.
// (가변 프레임 dt를 그대로 적분하면 재현성이 깨져 RL 학습에 불리)

import { World } from '../core/World.js';
import { MobileCrane } from '../core/MobileCrane.js';
import { TowerCrane } from '../core/TowerCrane.js';
import { Truck, deriveTrucks } from '../core/Truck.js';
import { buildAgents } from '../core/Agent.js';

const FIXED_DT = 1 / 60; // 물리 스텝 (s)

export class Simulation {
  /** @param {Object} scenario { cranes: [craneSpec, ...] } */
  constructor(scenario) {
    this.scenario = scenario;
    this.accumulator = 0;
    this.timeScale = 1; // 배속 (물리값은 그대로, 시간만 빠르게 흐름)
    this.reset();
  }

  setTimeScale(s) {
    this.timeScale = s;
  }

  /** 시나리오 초기 상태로 재구성. @returns 초기 상태 */
  reset() {
    this.world = new World();
    for (const spec of this.scenario.cranes) {
      this.world.addCrane(createCrane(spec));
    }
    // 시나리오 수준 리깅 기본값 (scenario.rigging = { rigTime, derigTime }) — 부재별 값이 우선
    const rig = this.scenario.rigging;
    for (const def of this.scenario.loads ?? []) {
      this.world.addLoad({
        ...def,
        rigTime: def.rigTime ?? rig?.rigTime,
        derigTime: def.derigTime ?? rig?.derigTime,
      });
    }
    for (const def of this.scenario.obstacles ?? []) {
      this.world.addObstacle(def);
    }
    // 반입 트럭: 명시 스펙(scenario.trucks) 우선, 없으면 arriveTime 그룹 자동 유도
    for (const def of this.scenario.trucks ?? deriveTrucks(this.scenario)) {
      this.world.addTruck(new Truck(def));
    }
    for (const def of this.scenario.noFlyZones ?? []) {
      this.world.addNoFlyZone(def);
    }
    this.world.setWind(this.scenario.wind ?? null);
    this.world.siteBounds = this.scenario.site ?? null; // 주행 이탈 방지 경계
    this.world.setOperationalRules(this.scenario);
    // 지상 인원·장비 (scenario.agents 정의된 시나리오만 — 시드 결정론 이동)
    const built = buildAgents(this.scenario);
    for (const agent of built.agents) this.world.addAgent(agent);
    this.world.setAgentRules(built.rules);
    this.world.scoringDef = this.scenario.scoring ?? {};
    this.accumulator = 0;
    return this.getState();
  }

  /**
   * 픽업/해제 토글 (이산 액션 — RL에서도 같은 엔트리 사용)
   * @returns {{ok: boolean, msg: string}}
   */
  toggleAttach(craneId = 0) {
    return this.world.toggleAttach(craneId);
  }

  /**
   * 실시간 진행: 렌더 프레임 dt를 받아 고정스텝으로 나눠 적분.
   * @param {number} frameDt 렌더 프레임 경과 시간 (s)
   * @param {Array<Object>} commands 크레인별 정규화 명령
   * @returns 최신 상태
   */
  step(frameDt, commands) {
    this.accumulator += Math.min(frameDt, 0.25) * this.timeScale;
    while (this.accumulator >= FIXED_DT) {
      this.world.step(FIXED_DT, commands);
      this.accumulator -= FIXED_DT;
    }
    return this.getState();
  }

  /**
   * 고정스텝 1회 진행 (RL·헤드리스용): 렌더 없이 결정론적으로 n스텝.
   * @param {Array<Object>} commands
   * @param {number} n 스텝 수
   */
  stepFixed(commands, n = 1) {
    for (let i = 0; i < n; i++) this.world.step(FIXED_DT, commands);
    return this.getState();
  }

  getState() {
    return this.world.getState();
  }

  completionScore() {
    return this.world.completionScore(this.scenario.scoring ?? {});
  }
}

/** 크레인 스펙의 type 필드로 구현체를 고르는 팩토리 */
export function createCrane(spec) {
  switch (spec.type) {
    case 'mobile':
      return new MobileCrane(spec);
    case 'tower':
      return new TowerCrane(spec);
    default:
      throw new Error(`unknown crane type: ${spec.type}`);
  }
}

export { FIXED_DT };
