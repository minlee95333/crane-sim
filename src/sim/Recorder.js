// 2층: 에피소드 기록·리플레이.
// 프레임 단위로 (dt, 배속, 명령, 픽업토글)을 기록하면, 같은 시나리오에서
// 동일 순서로 다시 먹여 결정론적으로 재현할 수 있다 (고정스텝 적분이라 dt만 같으면 동일).
//
// 용도: 사람 플레이 데이터 수집(추후 IRL/선호학습), 버그 재현, 데모 리플레이.

export class Recorder {
  constructor() {
    this.active = false;
    this.data = null;
  }

  /** 기록 시작 — reset 직후 호출해야 재현 가능 */
  start(scenarioId) {
    this.active = true;
    this.data = {
      version: 1,
      scenarioId,
      createdAt: new Date().toISOString(),
      frames: [],
    };
  }

  /**
   * 프레임 1개 기록 (라이브 루프에서 sim.step 호출과 같은 순서로).
   * @param {number} dt 렌더 프레임 dt (s)
   * @param {number} ts 당시 배속
   * @param {Array<Object>} cmds 크레인별 명령
   * @param {number} attachCraneId 이 프레임에 픽업 토글된 크레인 (-1 = 없음)
   */
  frame(dt, ts, cmds, attachCraneId = -1) {
    if (!this.active) return;
    this.data.frames.push({
      dt,
      ts,
      cmds: cmds.map((c) => ({ slew: c.slew ?? 0, luff: c.luff ?? 0, hoist: c.hoist ?? 0 })),
      at: attachCraneId,
    });
  }

  /** 기록 종료 → 기록 객체 반환 */
  stop() {
    this.active = false;
    const d = this.data;
    return d;
  }

  get frameCount() {
    return this.data?.frames.length ?? 0;
  }
}

/**
 * 기록을 시뮬레이션에 일괄 재생 (헤드리스 검증용).
 * 브라우저 재생은 main.js가 프레임 단위로 나눠 돌린다.
 * @param {import('./Simulation.js').Simulation} sim 기록과 같은 시나리오여야 함
 * @param {Object} recording Recorder.stop() 결과
 * @returns 재생 후 최종 상태
 */
export function replay(sim, recording) {
  sim.reset();
  const prevTs = sim.timeScale;
  for (const f of recording.frames) {
    if (f.at != null && f.at >= 0) sim.toggleAttach(f.at);
    sim.setTimeScale(f.ts ?? 1);
    sim.step(f.dt, f.cmds);
  }
  sim.setTimeScale(prevTs);
  return sim.getState();
}
