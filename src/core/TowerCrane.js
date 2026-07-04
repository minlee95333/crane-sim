// 1층: 코어 — 타워크레인 기구학.
//
// 자유도:
//  - slew    : 지브 선회각
//  - luff    : 트롤리 주행 (반경 변경 — CraneCommand의 luff 채널 재사용, +1 = 반경 확대)
//  - hoist   : 권상 로프 길이
//
// 기구학 (이동식과 달리 매달림점 높이가 고정):
//  radius     = trolleyPos
//  suspY      = mastHeight (지브 하단 높이)
//  hookHeight = mastHeight - ropeLength

import { Crane, clamp, rampVelocity } from './Crane.js';
import { LoadChart } from './LoadChart.js';
import { Sway } from './Sway.js';

export class TowerCrane extends Crane {
  constructor(spec) {
    super(spec);
    const g = spec.geometry;
    this.mastHeight = g.mastHeight;
    this.jibLength = g.jibLength;
    this.trolleyMin = g.trolleyMin ?? 2.5;

    // 상태
    this.trolleyPos = spec.initial?.trolleyPos ?? this.jibLength / 2;
    this.slewAngle = spec.initial?.slewAngle ?? 0;
    this.ropeLength = spec.initial?.ropeLength ?? 10;

    this.vel = { slew: 0, trolley: 0, hoist: 0 };
    this.minHookY = 0;

    this.limits = spec.limits;
    this.loadChart = new LoadChart(spec.loadChart);
    this.sway = spec.physics?.sway ? new Sway(spec.physics) : null;
  }

  step(dt, cmd) {
    const L = this.limits;
    const c = {
      slew: clamp(cmd?.slew ?? 0, -1, 1),
      luff: clamp(cmd?.luff ?? 0, -1, 1), // 트롤리: +1 = 바깥(반경 확대)
      hoist: clamp(cmd?.hoist ?? 0, -1, 1),
    };

    // 모멘트 리미터 — 이동식과 동일 정책 (과하중 악화 동작 차단)
    const capacity = this.getCapacity();
    const overloaded = this.loadMass > 0 && capacity > 0 && this.loadMass >= capacity;
    this.limiterActive = overloaded || (this.loadMass > 0 && capacity <= 0);
    if (this.limiterActive) {
      if (c.hoist > 0) c.hoist = 0; // 인양 차단
      if (c.luff > 0) c.luff = 0; // 트롤리 아웃(반경 확대) 차단
    }

    this.vel.slew = rampVelocity(this.vel.slew, c.slew * L.slewRate, L.slewAccel, dt);
    this.vel.trolley = rampVelocity(this.vel.trolley, c.luff * L.trolleySpeed, L.trolleyAccel, dt);
    this.vel.hoist = rampVelocity(this.vel.hoist, c.hoist * L.hoistSpeed, L.hoistAccel, dt);

    this.slewAngle += this.vel.slew * dt;
    this.trolleyPos = clamp(this.trolleyPos + this.vel.trolley * dt, this.trolleyMin, this.jibLength);
    // hoist +1 = 후크 상승 = 로프 짧아짐
    this.ropeLength = clamp(
      this.ropeLength - this.vel.hoist * dt,
      L.ropeMin,
      this.maxRopeLength(),
    );

    // 흔들림 (옵션): 매달림점 = 트롤리 월드 위치. 바람 외력은 World가 windAccel로 주입
    if (this.sway) {
      const [sx, , sz] = this.#suspensionPos();
      this.sway.update(dt, sx, sz, this.ropeLength, this.windAccel[0], this.windAccel[1]);
    }
  }

  maxRopeLength() {
    return this.mastHeight - this.minHookY;
  }

  setHookHeight(y) {
    this.ropeLength = clamp(this.mastHeight - y, this.limits.ropeMin, this.maxRopeLength());
  }

  getRadius() {
    return this.trolleyPos;
  }

  /** 매달림점(트롤리) 월드 위치 */
  #suspensionPos() {
    const [bx, by, bz] = this.basePos;
    return [
      bx + this.trolleyPos * Math.cos(this.slewAngle),
      by + this.mastHeight,
      bz + this.trolleyPos * Math.sin(this.slewAngle),
    ];
  }

  getHookPos() {
    const [sx, sy, sz] = this.#suspensionPos();
    const [ox, oz] = this.sway ? this.sway.offset : [0, 0];
    return [sx + ox, sy - this.ropeLength, sz + oz];
  }

  getCapacity() {
    return this.capacityAtRadius(this.getRadius());
  }

  /** 도달 가능한 작업반경 [min, max] (트롤리 주행 한계) */
  getRadiusRange() {
    return [this.trolleyMin, this.jibLength];
  }

  /** 반경 r에서 후크가 오를 수 있는 최대 높이 (지브 하단 - 최소로프) */
  maxHookHeightAt() {
    return this.mastHeight - this.limits.ropeMin;
  }

  getExtraState() {
    return {
      trolleyPos: this.trolleyPos,
      ropeLength: this.ropeLength,
      mastHeight: this.mastHeight,
      jibLength: this.jibLength,
      vel: { ...this.vel },
      limiterActive: this.limiterActive ?? false,
      swayMag: this.sway ? this.sway.magnitude : 0,
    };
  }
}
