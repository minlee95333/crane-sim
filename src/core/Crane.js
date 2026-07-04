// 1층: 코어 — 크레인 추상 인터페이스.
// 렌더(three.js)와 RL을 전혀 모른다. 순수 상태·계산만 담당.
//
// 모든 크레인 타입(이동식/타워)은 이 인터페이스를 구현한다.
// 좌표계: 오른손 좌표계, y-up (three.js와 동일 규약. 단, 코어는 three.js에 의존하지 않음)
// 각도 단위: 라디안 / 길이: m / 하중: t / 시간: s

/**
 * @typedef {Object} CraneCommand  크레인 1대에 대한 속도 명령 (정규화 -1..+1)
 * @property {number} slew   선회 (-1: 반시계, +1: 시계)
 * @property {number} luff   기복/트롤리 (-1: 반경 축소, +1: 반경 확대)
 * @property {number} hoist  권상 (-1: 내림, +1: 올림)
 * @property {number} [drive] 주행 (-1: 후진, +1: 전진) — 이동식만, 언더캐리지 헤딩 방향
 * @property {number} [steer] 조향 (-1: 좌회전, +1: 우회전) — 이동식만, 언더캐리지 헤딩 회전
 */

/**
 * @typedef {Object} CraneState  렌더·RL 관측 공용 상태 스냅샷
 * @property {string} type          'mobile' | 'tower'
 * @property {number[]} basePos     [x, y, z] 베이스 위치
 * @property {number} slewAngle     선회각 (rad)
 * @property {number} radius        작업반경 (m) — 선회중심~후크 수평거리
 * @property {number} hookHeight    후크 높이 (m, 지면 기준)
 * @property {number[]} hookPos     [x, y, z] 후크 월드 위치
 * @property {number} capacity      현재 구성에서의 정격하중 (t)
 * @property {number} loadMass      매달린 하중 (t, 없으면 0)
 * @property {number} loadRatio     하중률 = loadMass / capacity (0..1+)
 * @property {Object} extra         타입별 추가 상태 (붐각·붐길이·트롤리 위치 등)
 */

export class Crane {
  /** @param {Object} spec 크레인 제원 (data/*.json) */
  constructor(spec) {
    if (new.target === Crane) throw new Error('Crane is abstract');
    this.spec = spec;
    // 복사 필수: 주행(재배치)이 basePos를 변경하므로 spec 원본이 오염되면 안 됨
    this.basePos = [...(spec.basePos ?? [0, 0, 0])];
    this.slewAngle = 0;
    this.loadMass = 0; // 매달린 하중 (t)
    this.windAccel = [0, 0]; // 바람 외력 가속 [x, z] (m/s²) — World가 매 스텝 주입 (T2-⑦)
  }

  /**
   * 명령을 속도·가속 한계 내에서 적용해 상태를 dt만큼 진행.
   * @param {number} dt 초
   * @param {CraneCommand} cmd
   */
  step(dt, cmd) {
    throw new Error('not implemented');
  }

  /** 현재 작업반경 (m) */
  getRadius() {
    throw new Error('not implemented');
  }

  /** 현재 후크 월드 위치 [x, y, z] */
  getHookPos() {
    throw new Error('not implemented');
  }

  /** 현재 구성(반경 등)에서의 정격하중 (t) */
  getCapacity() {
    throw new Error('not implemented');
  }

  /** 임의 반경에서의 정격하중 (t) — 계획 타당성 검사용 */
  capacityAtRadius(r) {
    return this.loadChart.capacityAt(r);
  }

  /** @returns {CraneState} */
  getState() {
    const radius = this.getRadius();
    const capacity = this.getCapacity();
    return {
      type: this.spec.type,
      basePos: [...this.basePos],
      slewAngle: this.slewAngle,
      radius,
      hookHeight: this.getHookPos()[1],
      hookPos: this.getHookPos(),
      capacity,
      loadMass: this.loadMass,
      loadRatio: capacity > 0 ? this.loadMass / capacity : Infinity,
      extra: this.getExtraState(),
    };
  }

  /** 타입별 추가 상태 (하위 클래스에서 오버라이드) */
  getExtraState() {
    return {};
  }
}

/** 값을 [lo, hi]로 자름 */
export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 속도 램프: 현재 속도를 목표 속도로 최대가속 한도 내에서 접근.
 * 실제 크레인의 가감속 특성(급출발·급정지 불가) 반영.
 */
export function rampVelocity(current, target, maxAccel, dt) {
  const dv = clamp(target - current, -maxAccel * dt, maxAccel * dt);
  return current + dv;
}
