// 1층: 코어 — 반입 트럭.
// 렌더 전용 장식이었던 트럭을 물리 세계의 엔티티로 승격 (T2-⑤ 완전화):
//   - 결정론적 시간 기반 운동 (TruckMotion 닫힌식 재사용) — 진입 → 도킹 → 후진 출차
//   - 적재 부재(pending)는 진입 중 트럭과 동반 이동하고, 도킹 시각(arriveTime)에 하역 가능
//   - 도킹/이동 중 차체 AABB는 충돌체 (자기 적재 부재의 하역 권상은 예외)
//   - departAt(전량 하역 시각)은 World가 한 번만 설정 — 건립 등 이후 공정과 무관 (재진입 금지)
//
// 데이터 주도: scenario.trucks 명시 스펙 우선, 없으면 arriveTime 그룹으로 자동 유도.

import { truckMotionAt } from './TruckMotion.js';

const DEFAULTS = {
  entryDistance: 26, // 진입 주행 거리 (m)
  entryDuration: 30, // 진입 소요 (s)
  exitDuration: 30, // 출차 소요 (s)
  maxAcceleration: 0.3, // 종방향 가속 한계 (m/s²)
  bedHeight: 1.35, // 적재함 높이 (m)
  bodyWidth: 3.2,
  bodyHeight: 2.9, // 캡 상단 기준 차체 AABB 높이
};

export class Truck {
  /**
   * @param {Object} spec {
   *   id, dockPos: [x, z](도킹 시 트레일러 중심), heading: [hx, hz](차량 전면 단위벡터),
   *   size?: [w, h, len], bedHeight?, arriveTime(도킹 완료 시각 = 하역 가능 시점),
   *   entryDistance?, entryDuration?, exitDuration?, maxAcceleration?,
   *   loads: [loadId, ...] (적재 부재 — 전량 하역이 출차 조건)
   * }
   */
  constructor(spec) {
    this.id = spec.id;
    this.dockPos = [...spec.dockPos];
    const h = spec.heading ?? [0, 1];
    const hLen = Math.hypot(h[0], h[1]) || 1;
    this.heading = [h[0] / hLen, h[1] / hLen];
    this.size = spec.size ? [...spec.size] : [DEFAULTS.bodyWidth, DEFAULTS.bodyHeight, 12];
    this.bedHeight = spec.bedHeight ?? DEFAULTS.bedHeight;
    this.arriveTime = spec.arriveTime ?? 0;
    this.entryDistance = spec.entryDistance ?? DEFAULTS.entryDistance;
    this.entryDuration = spec.entryDuration ?? DEFAULTS.entryDuration;
    this.exitDuration = spec.exitDuration ?? DEFAULTS.exitDuration;
    this.maxAcceleration = spec.maxAcceleration ?? DEFAULTS.maxAcceleration;
    this.loadIds = [...(spec.loads ?? [])];

    this.departAt = null; // 전량 하역 시각 — World가 한 번만 설정
    this.cargoDock = new Map(); // loadId → 도킹 시 부재 [x, z] (동반 이동 기준)

    // 현재 상태 (World.step이 갱신)
    this.phase = 'scheduled';
    this.pos = this.#posAt(-this.entryDistance);
  }

  /** 도킹점 기준 heading 축 오프셋(후방 음수) → 차체 중심 [x, z] */
  #posAt(offset) {
    return [
      this.dockPos[0] + this.heading[0] * offset,
      this.dockPos[1] + this.heading[1] * offset,
    ];
  }

  /**
   * 시각 t의 결정론적 운동 상태 (닫힌식 — 시뮬 스텝과 무관하게 재생에서도 동일).
   * @param {number} time
   * @param {number|null} [departAt] 전량 하역 시각 (기본: this.departAt)
   */
  motionAt(time, departAt = this.departAt) {
    const entryStart = this.arriveTime - this.entryDuration;
    if (time < entryStart) {
      return this.#snap('scheduled', -this.entryDistance, 0, 0, 0, false);
    }
    if (time < this.arriveTime) {
      const m = truckMotionAt(time - entryStart, {
        distance: this.entryDistance,
        duration: this.entryDuration,
        maxAcceleration: this.maxAcceleration,
      });
      return this.#snap('entering', -(this.entryDistance - m.position), m.velocity, m.acceleration, m.position, true);
    }
    if (departAt == null || time < departAt) {
      return this.#snap('docked', 0, 0, 0, this.entryDistance, true);
    }
    if (time < departAt + this.exitDuration) {
      const m = truckMotionAt(time - departAt, {
        distance: this.entryDistance,
        duration: this.exitDuration,
        maxAcceleration: this.maxAcceleration,
      });
      // 후진 출차: 진입 경로를 역방향으로, 바퀴도 역회전
      return this.#snap('departing', -m.position, -m.velocity, -m.acceleration, this.entryDistance - m.position, true);
    }
    return this.#snap('gone', -this.entryDistance, 0, 0, 0, false);
  }

  #snap(phase, offset, velocity, vehicleAccel, wheelDistance, visible) {
    return { phase, offset, velocity, vehicleAccel, wheelDistance, visible, pos: this.#posAt(offset) };
  }

  /** 차체 AABB 장애물 (충돌·경로 회피용). 현장에 없으면 null */
  obstacle() {
    if (this.phase === 'scheduled' || this.phase === 'gone') return null;
    // size[2](길이)는 heading 축 — AABB는 축 정렬 근사 (heading이 축 평행일 때 정확)
    const alongZ = Math.abs(this.heading[1]) >= Math.abs(this.heading[0]);
    const [w, h, len] = this.size;
    return {
      id: `truck:${this.id}`,
      pos: [this.pos[0], 0, this.pos[1]],
      size: alongZ ? [w, h, len] : [len, h, w],
    };
  }

  /** 도킹 풋프린트 평면 존 (셋업·주행 회피용, 시간 무관) */
  dockZone(margin = 0) {
    const alongZ = Math.abs(this.heading[1]) >= Math.abs(this.heading[0]);
    const [w, , len] = this.size;
    const ex = (alongZ ? w : len) / 2 + margin;
    const ez = (alongZ ? len : w) / 2 + margin;
    return {
      id: `truck:${this.id}`,
      min: [this.dockPos[0] - ex, this.dockPos[1] - ez],
      max: [this.dockPos[0] + ex, this.dockPos[1] + ez],
    };
  }

  /**
   * 적재 부재 상태 목록에서 출차 시각을 유도 (전량 하역 완료 시).
   * World·렌더·재생이 같은 규칙을 쓴다 — 이후 공정(stageChangedAt 갱신)과 무관.
   * @param {Array<{id,stage,state,yardedAt,stageChangedAt}>} loadStates
   * @returns {number|null}
   */
  departAtFrom(loadStates) {
    const ls = this.loadIds
      .map((id) => loadStates.find((l) => l.id === id))
      .filter(Boolean);
    if (ls.length === 0 || !ls.every((l) => l.stage > 0 || l.state === 'placed')) return null;
    return Math.max(...ls.map((l) => l.yardedAt ?? l.stageChangedAt ?? 0));
  }

  /** getState용 스냅샷 */
  snapshot(time, departAt = this.departAt) {
    const m = this.motionAt(time, departAt);
    return {
      id: this.id,
      phase: m.phase,
      visible: m.visible,
      pos: [...m.pos],
      dockPos: [...this.dockPos],
      heading: [...this.heading],
      size: [...this.size],
      bedHeight: this.bedHeight,
      offset: m.offset,
      velocity: m.velocity,
      vehicleAccel: m.vehicleAccel,
      wheelDistance: m.wheelDistance,
      arriveTime: this.arriveTime,
      departAt,
      loadIds: [...this.loadIds],
    };
  }
}

/**
 * scenario.trucks 미지정 시 자동 유도: arriveTime이 같은 부재를 한 트럭으로 묶는다
 * (기존 렌더 전용 로직의 코어 이관 — 다단계 여정(route) 시나리오에만 적용).
 */
export function deriveTrucks(scenario) {
  if (!scenario.loads?.some((l) => (l.route?.length ?? 0) > 1)) return [];
  const groups = new Map();
  for (const load of scenario.loads) {
    const at = load.arriveTime ?? 0;
    if (!groups.has(at)) groups.set(at, []);
    groups.get(at).push(load);
  }
  const specs = [];
  for (const [arriveTime, loads] of groups) {
    const xs = loads.map((l) => l.pos[0]);
    const zMin = Math.min(...loads.map((l) => l.pos[2] - l.size[2] / 2));
    const zMax = Math.max(...loads.map((l) => l.pos[2] + l.size[2] / 2));
    const z = (zMin + zMax) / 2;
    const trailerLength = Math.max(7, zMax - zMin + 1);
    specs.push({
      id: `truck-${arriveTime}`,
      dockPos: [xs.reduce((s, v) => s + v, 0) / xs.length, z],
      heading: [0, z >= 0 ? -1 : 1], // 전면이 현장 중심 쪽
      size: [DEFAULTS.bodyWidth, DEFAULTS.bodyHeight, trailerLength],
      arriveTime,
      loads: loads.map((l) => l.id),
    });
  }
  return specs;
}
