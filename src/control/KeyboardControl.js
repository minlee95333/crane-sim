// 사람 입력 → CraneCommand 변환.
// 나중에 RL 에이전트가 이 자리(getCommand 반환값)를 대체한다.
//
// 조작:
//   ← / →  선회 (반시계/시계)
//   ↑ / ↓  기복 (붐 올림=반경 축소 / 붐 내림=반경 확대)
//   W / S  권상 / 권하

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
      slew: (k.has('ArrowRight') ? 1 : 0) + (k.has('ArrowLeft') ? -1 : 0),
      // ↑ = 붐 올림 = 반경 축소 = luff -1
      luff: (k.has('ArrowDown') ? 1 : 0) + (k.has('ArrowUp') ? -1 : 0),
      hoist: (k.has('KeyW') ? 1 : 0) + (k.has('KeyS') ? -1 : 0),
    };
  }
}
