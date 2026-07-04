// 3층: 렌더 — 상태→오디오 "뷰". 상태를 절대 변경하지 않는다.
// 전부 Web Audio 합성 (외부 에셋 0): 엔진 아이들·선회 모터·윈치·경고 비프·픽업/안착 원샷.
// AudioContext는 브라우저 자동재생 정책상 첫 사용자 제스처에서 unlock()으로 생성한다.
// Node(테스트) 환경에서는 전체 no-op — 구성 가능성만 보장.
export class SoundView {
  constructor() {
    this.supported =
      typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);
    this.muted = false;
    this.ctx = null;
    this._prevLoadState = new Map();
  }

  /** 첫 사용자 제스처에서 호출 — AudioContext 생성 + 지속음 그래프 구성 */
  unlock() {
    if (!this.supported || this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const gain = (v) => {
      const n = this.ctx.createGain();
      n.gain.value = v;
      return n;
    };
    this.master = gain(this.muted ? 0 : 0.9);
    this.master.connect(this.ctx.destination);

    // 엔진: 톱니 저음 + 로우패스 (디젤 아이들)
    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 36;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 240;
    this.engineGain = gain(0);
    this.engineOsc.connect(lp);
    lp.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.engineOsc.start();

    // 선회 모터 (고음 whine) / 윈치 (중음)
    this.slewOsc = this.ctx.createOscillator();
    this.slewOsc.type = 'triangle';
    this.slewOsc.frequency.value = 85;
    this.slewGain = gain(0);
    this.slewOsc.connect(this.slewGain);
    this.slewGain.connect(this.master);
    this.slewOsc.start();

    this.winchOsc = this.ctx.createOscillator();
    this.winchOsc.type = 'triangle';
    this.winchOsc.frequency.value = 130;
    this.winchGain = gain(0);
    this.winchOsc.connect(this.winchGain);
    this.winchGain.connect(this.master);
    this.winchOsc.start();

    // 경고 비프 (리미터·크레인 간섭)
    this.alarmOsc = this.ctx.createOscillator();
    this.alarmOsc.type = 'square';
    this.alarmOsc.frequency.value = 920;
    this.alarmGain = gain(0);
    this.alarmOsc.connect(this.alarmGain);
    this.alarmGain.connect(this.master);
    this.alarmOsc.start();

    // 원샷용 노이즈 버퍼 (시드 고정 — 전역 난수 금지 규약)
    const len = Math.floor(this.ctx.sampleRate * 0.4);
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    let seed = 987654321;
    for (let i = 0; i < len; i++) {
      seed = (seed * 16807) % 2147483647;
      data[i] = (seed / 2147483647) * 2 - 1;
    }
  }

  /** @returns {boolean} 음소거 상태 */
  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.9;
    return this.muted;
  }

  #ramp(param, v) {
    param.cancelScheduledValues(this.ctx.currentTime);
    param.linearRampToValueAtTime(v, this.ctx.currentTime + 0.09);
  }

  /** 짧은 필터 노이즈 원샷 (픽업 클링크·안착 썸) */
  #burst({ freq, type, dur, vol }) {
    if (!this.ctx || this.muted) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    src.start();
    src.stop(this.ctx.currentTime + dur + 0.02);
  }

  /**
   * @param {Object} state world.getState()
   * @param {Object} opts { live: 라이브 조작 중인가 (계획 재생·리플레이·정지 시 기계음 억제),
   *                        activeCrane: 조종 중 크레인 인덱스 }
   */
  update(state, { live = true, activeCrane = 0 } = {}) {
    if (!this.ctx) return;
    const crane = state.cranes?.[activeCrane];
    if (!crane || !live) {
      for (const n of [this.engineGain, this.slewGain, this.winchGain, this.alarmGain]) {
        this.#ramp(n.gain, 0);
      }
      return;
    }
    const vel = crane.extra?.vel ?? {};
    const drive = Math.abs(crane.extra?.driveVel ?? 0);
    const slewV = Math.abs(vel.slew ?? 0);
    const hoistV = Math.abs(vel.hoist ?? 0);
    const luffV = Math.abs(vel.luff ?? vel.trolley ?? 0);
    const working = slewV > 1e-3 || hoistV > 0.01 || luffV > 1e-3 || drive > 0.02;

    // 엔진 (이동식): 아이들 + 작업/주행 부하로 회전수 상승
    if (crane.type === 'mobile') {
      this.#ramp(this.engineGain.gain, 0.05 + (working ? 0.02 : 0) + Math.min(drive * 0.06, 0.08));
      this.#ramp(this.engineOsc.frequency, 34 + drive * 16 + (working ? 5 : 0));
    } else {
      this.#ramp(this.engineGain.gain, 0);
    }
    this.#ramp(this.slewGain.gain, slewV > 1e-3 ? 0.035 : 0);
    this.#ramp(this.slewOsc.frequency, 70 + slewV * 2600);
    this.#ramp(this.winchGain.gain, hoistV > 0.01 ? 0.05 : 0);
    this.#ramp(this.winchOsc.frequency, 110 + hoistV * 190);

    // 경고: 리미터·크레인 물리 간섭 — 시뮬 시간 기반 비프 패턴 (결정론)
    const clash = (state.safety?.cranePairs ?? []).some((p) => p.clash);
    const alarmOn = (crane.extra?.limiterActive || clash) && state.time % 0.5 < 0.22;
    this.#ramp(this.alarmGain.gain, alarmOn ? 0.09 : 0);

    // 원샷: 부재 상태 전이 (픽업 클링크 / 안착 썸)
    for (const l of state.loads ?? []) {
      const prev = this._prevLoadState.get(l.id);
      if (prev && prev !== l.state) {
        if (l.state === 'hooked' && (prev === 'ground' || prev === 'rigging')) {
          this.#burst({ freq: 2400, type: 'highpass', dur: 0.07, vol: 0.12 });
        } else if (
          (prev === 'hooked' || prev === 'derigging') &&
          (l.state === 'ground' || l.state === 'placed')
        ) {
          this.#burst({ freq: 240, type: 'lowpass', dur: 0.22, vol: 0.3 });
        }
      }
      this._prevLoadState.set(l.id, l.state);
    }
  }
}
