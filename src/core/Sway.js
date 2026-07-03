// 1층: 코어 — 후크 흔들림(수평 펜듈럼) 물리. 옵션 기능(spec.physics.sway).
//
// 소각 근사: 매달림점(붐끝/트롤리) 아래 로프 길이 L의 진자.
//   s'' = -(g/L)·s - c·s' - a_susp
// 매달림점 가속도(a_susp)는 고정스텝 유한차분으로 추정 → 결정론 유지.
// y(수직)는 근사상 불변으로 두고 수평 오프셋 [ox, oz]만 계산한다.

const G = 9.81;

export class Sway {
  /** @param {Object} [opts] { damping } */
  constructor(opts = {}) {
    this.damping = opts.damping ?? 0.25; // 감쇠 계수 (1/s)
    this.ox = 0; // 수평 오프셋 (m)
    this.oz = 0;
    this.vx = 0; // 오프셋 속도 (m/s)
    this.vz = 0;
    this._prevSx = null; // 직전 매달림점 위치·속도 (가속도 추정용)
    this._prevSz = null;
    this._prevVx = 0;
    this._prevVz = 0;
  }

  /**
   * @param {number} dt 고정스텝 (s)
   * @param {number} sx 매달림점 월드 x
   * @param {number} sz 매달림점 월드 z
   * @param {number} ropeLength 진자 길이 (m)
   */
  update(dt, sx, sz, ropeLength) {
    // 매달림점 가속도 (첫 스텝은 0)
    let ax = 0;
    let az = 0;
    if (this._prevSx !== null) {
      const vx = (sx - this._prevSx) / dt;
      const vz = (sz - this._prevSz) / dt;
      ax = (vx - this._prevVx) / dt;
      az = (vz - this._prevVz) / dt;
      this._prevVx = vx;
      this._prevVz = vz;
    }
    this._prevSx = sx;
    this._prevSz = sz;

    // 반정밀 오일러 (속도 먼저 → 위치)
    const w2 = G / Math.max(ropeLength, 2);
    this.vx += (-w2 * this.ox - this.damping * this.vx - ax) * dt;
    this.vz += (-w2 * this.oz - this.damping * this.vz - az) * dt;
    this.ox += this.vx * dt;
    this.oz += this.vz * dt;
  }

  /** 수평 오프셋 [x, z] (m) */
  get offset() {
    return [this.ox, this.oz];
  }

  /** 흔들림 크기 (m) */
  get magnitude() {
    return Math.hypot(this.ox, this.oz);
  }
}
