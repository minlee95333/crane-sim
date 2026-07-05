// 1층: 코어 — 이동식 크레인(크롤러/러프테레인) 기구학.
//
// 자유도(M1 기준):
//  - slew  : 상부체 선회각
//  - luff  : 붐 기복각 (반경 변경)
//  - hoist : 권상 로프 길이
// 붐 텔레스코핑은 M3+에서 추가 예정 (붐길이 고정).
//
// 기구학:
//  radius     = boomLength * cos(boomAngle)  (+ 선회중심 오프셋)
//  boomTipY   = pivotHeight + boomLength * sin(boomAngle)
//  hookHeight = boomTipY - ropeLength

import { Crane, clamp, rampVelocity } from './Crane.js';
import { LoadChart } from './LoadChart.js';
import { LoadChart2D } from './LoadChart2D.js';
import { Sway } from './Sway.js';

export class MobileCrane extends Crane {
  constructor(spec) {
    super(spec);
    const g = spec.geometry;
    this.boomLength = g.boomLength; // m (M1: 고정)
    this.pivotHeight = g.pivotHeight; // 붐 힌지 높이 (m)
    this.pivotOffset = g.pivotOffset ?? 0; // 선회중심→붐힌지 수평 오프셋 (m)

    // 상태
    this.boomAngle = spec.initial?.boomAngle ?? (60 * Math.PI) / 180;
    this.slewAngle = spec.initial?.slewAngle ?? 0;
    this.ropeLength = spec.initial?.ropeLength ?? 10; // 붐끝→후크 (m)

    // 주행: 언더캐리지(트랙) 헤딩 — 상부체 선회(slewAngle)와 독립. 실시간 수동 주행용.
    this.driveYaw = spec.initial?.driveYaw ?? 0; // 트랙이 향한 방위 (rad, 0 = +x)
    this.driveVel = 0; // 현재 주행 속도 (m/s, 램프 대상)

    // 현재 속도 (램프 대상)
    this.vel = { slew: 0, luff: 0, hoist: 0 };

    // 후크 최저 높이 (부재 매달림 시 World가 설정 — 부재 지면 관통 방지)
    this.minHookY = 0;

    // 한계
    this.limits = spec.limits;
    this.loadChart = new LoadChart(spec.loadChart);
    // 2D 정격표(붐길이×반경)가 있으면 현재 붐길이 기준으로 사용
    this.chart2d = spec.capacityChart ? new LoadChart2D(spec.capacityChart) : null;

    // 후크 흔들림 (옵션: spec.physics.sway)
    this.sway = spec.physics?.sway ? new Sway(spec.physics) : null;
  }

  step(dt, cmd) {
    const L = this.limits;
    const c = {
      slew: clamp(cmd?.slew ?? 0, -1, 1),
      luff: clamp(cmd?.luff ?? 0, -1, 1),
      hoist: clamp(cmd?.hoist ?? 0, -1, 1),
    };

    // --- 주행 (언더캐리지) — 실시간 수동 조작. 계획 명령엔 drive/steer 없어 무영향 ---
    this.#drive(dt, clamp(cmd?.drive ?? 0, -1, 1), clamp(cmd?.steer ?? 0, -1, 1));

    // --- 모멘트 리미터 (과부하방지장치) ---
    // 하중률 ≥ 100%: 상황을 악화시키는 동작만 차단.
    //   차단: 권상(들어올림), 기복 내림(반경 확대)
    //   허용: 권하(내림), 기복 올림(반경 축소), 선회
    const capacity = this.getCapacity();
    const overloaded = this.loadMass > 0 && capacity > 0 && this.loadMass >= capacity;
    this.limiterActive = overloaded || (this.loadMass > 0 && capacity <= 0);
    if (this.limiterActive) {
      if (c.hoist > 0) c.hoist = 0; // 인양 차단
      if (c.luff > 0) c.luff = 0; // 반경 확대 차단
    }

    // 목표속도 = 정규화 명령 × 최대속도 → 가속 램프로 접근
    this.vel.slew = rampVelocity(this.vel.slew, c.slew * L.slewRate, L.slewAccel, dt);
    this.vel.luff = rampVelocity(this.vel.luff, c.luff * L.luffRate, L.luffAccel, dt);
    this.vel.hoist = rampVelocity(this.vel.hoist, c.hoist * L.hoistSpeed, L.hoistAccel, dt);

    // 적분
    this.slewAngle += this.vel.slew * dt;
    // luff +1 = 반경 확대 = 붐각 감소
    this.boomAngle = clamp(
      this.boomAngle - this.vel.luff * dt,
      L.boomAngleMin,
      L.boomAngleMax,
    );
    // hoist +1 = 후크 상승 = 로프 짧아짐
    this.ropeLength = clamp(
      this.ropeLength - this.vel.hoist * dt,
      L.ropeMin,
      this.maxRopeLength(),
    );

    // 흔들림 (옵션): 매달림점 = 붐끝 월드 위치. 바람 외력은 World가 windAccel로 주입
    if (this.sway) {
      const r = this.getRadius();
      const [bx, , bz] = this.basePos;
      this.sway.update(
        dt,
        bx + r * Math.cos(this.slewAngle),
        bz + r * Math.sin(this.slewAngle),
        this.ropeLength,
        this.windAccel[0],
        this.windAccel[1],
      );
    }
  }

  /**
   * 언더캐리지 주행: steer로 트랙 헤딩을 돌리고, drive로 헤딩 방향으로 이동.
   * 가감속 램프 + 최고속도 (트럭·재배치와 동일 준정적 원칙). 명령 0이면 관성 감속 후 정지.
   * 고정식(planning.movable === false)은 주행하지 않는다. World가 충돌 시 되돌린다.
   */
  #drive(dt, drive, steer) {
    const planning = this.spec.planning ?? {};
    if ((planning.movable ?? true) === false) return;
    const steerRate = planning.steerRate ?? 0.14; // ~8°/s
    const maxSpeed = planning.driveSpeed ?? planning.travelSpeed ?? 1.0;
    const accel = planning.driveAccel ?? planning.travelAccel ?? 0.3;

    if (steer !== 0) this.driveYaw += steer * steerRate * dt;
    // 목표 속도로 램프 (명령 0 → 0으로 감속). 하중 매달고 주행하면 수동 픽앤캐리.
    this.driveVel = rampVelocity(this.driveVel, drive * maxSpeed, accel, dt);
    if (Math.abs(this.driveVel) > 1e-5) {
      this.basePos[0] += Math.cos(this.driveYaw) * this.driveVel * dt;
      this.basePos[2] += Math.sin(this.driveYaw) * this.driveVel * dt;
    }
  }

  /** 후크(또는 매달린 부재 바닥)가 지면 아래로 못 가게 하는 로프 최대 길이 */
  maxRopeLength() {
    return this.boomTipY() - this.minHookY;
  }

  /** 후크를 특정 높이로 스냅 (줄걸이 시 슬링이 팽팽해지는 것) */
  setHookHeight(y) {
    this.ropeLength = clamp(this.boomTipY() - y, this.limits.ropeMin, this.maxRopeLength());
  }

  boomTipY() {
    return this.pivotHeight + this.boomLength * Math.sin(this.boomAngle);
  }

  getRadius() {
    return this.pivotOffset + this.boomLength * Math.cos(this.boomAngle);
  }

  getHookPos() {
    const r = this.getRadius();
    const [bx, by, bz] = this.basePos;
    const [ox, oz] = this.sway ? this.sway.offset : [0, 0];
    return [
      bx + r * Math.cos(this.slewAngle) + ox,
      by + this.boomTipY() - this.ropeLength,
      bz + r * Math.sin(this.slewAngle) + oz,
    ];
  }

  getCapacity() {
    const cap = this.capacityAtRadius(this.getRadius());
    // 픽앤캐리 감격 (T2-⑧ 런타임 정합): 하중을 매단 채 주행 중이면 정격이 준다.
    // 계획 실행은 drive 명령을 쓰지 않아(#drive 주석) 계획·오라클 결과는 불변이고,
    // 계획된 캐리는 checkCarryFeasible이 이미 감격 이내만 허용하므로 리미터 미발동.
    if (this.#carrying()) return cap * (this.spec.rating?.pickCarryFactor ?? 0.66);
    return cap;
  }

  /** 주행 인양(픽앤캐리) 중인가 — 하중 매달림 + 유의미한 주행 속도 */
  #carrying() {
    return this.loadMass > 0 && Math.abs(this.driveVel) > 0.05;
  }

  capacityAtRadius(r) {
    return this.chart2d
      ? this.chart2d.capacityAt(this.boomLength, r)
      : this.loadChart.capacityAt(r);
  }

  /** 도달 가능한 작업반경 [min, max] (붐각 한계 기준) */
  getRadiusRange() {
    const L = this.limits;
    return [
      this.pivotOffset + this.boomLength * Math.cos(L.boomAngleMax),
      this.pivotOffset + this.boomLength * Math.cos(L.boomAngleMin),
    ];
  }

  /** 반경 r에서 후크가 오를 수 있는 최대 높이 (붐끝 - 최소로프) */
  maxHookHeightAt(r) {
    const horiz = Math.max(0, Math.min(r - this.pivotOffset, this.boomLength));
    const tipY = this.pivotHeight + Math.sqrt(Math.max(0, this.boomLength ** 2 - horiz ** 2));
    return tipY - this.limits.ropeMin;
  }

  getExtraState() {
    return {
      boomAngle: this.boomAngle,
      boomLength: this.boomLength,
      ropeLength: this.ropeLength,
      boomTipY: this.boomTipY(),
      vel: { ...this.vel },
      limiterActive: this.limiterActive ?? false,
      swayMag: this.sway ? this.sway.magnitude : 0,
      driveYaw: this.driveYaw,
      driveVel: this.driveVel,
      carryDerated: this.#carrying(), // 감격 정격 적용 중 (게이지·HUD 표시용)
      pickCarryFactor: this.spec.rating?.pickCarryFactor ?? 0.66,
    };
  }
}
