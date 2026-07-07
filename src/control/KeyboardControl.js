// 사람 입력 → CraneCommand 변환.
// 나중에 RL 에이전트가 이 자리(getCommand 반환값)를 대체한다.
//
// 게임형 배치 (탱크식: WASD로 차체 주행 + 화살표로 팔 조준):
//   [주행]  W/S  전진·후진 (트랙 헤딩 방향)   A/D  좌·우회전 (조향)
//   [선회]  ← / →   상부체 선회 (반시계/시계)
//   [기복]  ↑ / ↓   붐 올림(반경↓) / 내림(반경↑)
//   [권상]  Q / E   후크 올림 / 내림
//   [태그]  Z / X   부재 요 반시계 / 시계
//   [픽업]  Space   줄걸이/해제

export class KeyboardControl {
  constructor(target = window) {
    this.keys = new Set();
    this.attachPressed = false; // Space 엣지 트리거 (1회성)
    target.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      // 화살표·스페이스의 페이지 스크롤 방지
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      if (e.code === 'Space' && !e.repeat) this.attachPressed = true;
    });
    target.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Space가 눌렸으면 true를 반환하고 플래그를 소비한다 */
  consumeAttach() {
    const v = this.attachPressed;
    this.attachPressed = false;
    return v;
  }

  /** @returns {import('../core/Crane.js').CraneCommand} */
  getCommand() {
    const k = this.keys;
    return {
      // 팔 조준: 화살표 + Q/E
      slew: (k.has('ArrowRight') ? 1 : 0) + (k.has('ArrowLeft') ? -1 : 0),
      // ↑ = 붐 올림 = 반경 축소 = luff -1
      luff: (k.has('ArrowDown') ? 1 : 0) + (k.has('ArrowUp') ? -1 : 0),
      hoist: (k.has('KeyQ') ? 1 : 0) + (k.has('KeyE') ? -1 : 0),
      // 차체 주행: WASD (W 전진 / S 후진, A 좌회전 / D 우회전)
      drive: (k.has('KeyW') ? 1 : 0) + (k.has('KeyS') ? -1 : 0),
      steer: (k.has('KeyD') ? 1 : 0) + (k.has('KeyA') ? -1 : 0),
      tag: (k.has('KeyX') ? 1 : 0) + (k.has('KeyZ') ? -1 : 0),
    };
  }
}
