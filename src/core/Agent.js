// 1층: 코어 — 지상 에이전트(작업 인원·소형 장비). 렌더·RL 무관.
//
// 현실 근거 (T3-⑪ 계열): 현장에는 크레인과 무관하게 움직이는 인원·장비가 있고,
// 매달린 하중 근처(위험 반경)에 들어오면 신호수가 작업을 중지시킨다 → 사이클 타임이
// 계획 추정보다 늘어진다. 이 지연이 스케줄의 실측 makespan을 바꾸는 것이 이 모듈의 목적.
//
// 결정론: 이동은 "랜덤"이지만 시나리오 시드의 mulberry32 스트림(에이전트별 독립)에서만
// 샘플링한다 — 같은 시드·같은 스텝 = 같은 궤적. 전역 난수 호출 없음.
import { mulberry32 } from './rng.js';

const REACH = 0.5; // 웨이포인트 도달 판정 (m)
const VEHICLE_LOOKAHEAD = 3.0; // 차량 전방 정지 판정 거리 (m)

export class Agent {
  /**
   * @param {Object} def worker: { id, kind:'worker', area:{min:[x,z],max:[x,z]},
   *                               speed:[min,max]?, idle:[min,max]? }
   *                 vehicle: { id, kind:'vehicle', route:[[x,z],...](순환),
   *                            speed?, size:[w,h,d]?, startIndex? }
   * @param {number} seed 에이전트 전용 시드
   */
  constructor(def, seed) {
    this.id = def.id;
    this.kind = def.kind ?? 'worker';
    this.rng = mulberry32(seed);
    this.heading = [1, 0];
    this.waiting = false; // 차량: 전방 점유로 정지 중

    if (this.kind === 'vehicle') {
      this.route = def.route.map((p) => [...p]);
      this.speed = def.speed ?? 2.2;
      this.size = def.size ? [...def.size] : [2.2, 2.2, 4.5]; // [폭, 높이, 길이(진행축)]
      if (def.startFraction != null) {
        const start = routePointAt(this.route, def.startFraction);
        this.pos = start.pos;
        this.wpIndex = start.wpIndex;
      } else {
        const start = def.startIndex ?? 0;
        this.pos = [...this.route[start % this.route.length]];
        this.wpIndex = (start + 1) % this.route.length;
      }
    } else {
      this.area = { min: [...def.area.min], max: [...def.area.max] };
      const [spMin, spMax] = def.speed ?? [0.8, 1.4];
      this.speed = spMin + this.rng() * (spMax - spMin); // 개인차 (시드 결정)
      this.idleRange = def.idle ?? [2, 6];
      this.radius = 0.5;
      this.pos = this.#samplePoint(null); // 초기 위치도 시드에서
      this.target = null;
      this.idleTimer = this.rng() * this.idleRange[1]; // 개시 시점 분산
    }
  }

  /** @param {number} dt @param {import('./World.js').World} world */
  step(dt, world) {
    if (this.kind === 'vehicle') this.#stepVehicle(dt, world);
    else this.#stepWorker(dt, world);
  }

  // ── 작업 인원: 대기 → 목적지 샘플 → 보행 반복 (장애물 발밑 회피) ──
  #stepWorker(dt, world) {
    if (this.idleTimer > 0) {
      this.idleTimer -= dt;
      return;
    }
    if (!this.target) this.target = this.#samplePoint(world);
    const dx = this.target[0] - this.pos[0];
    const dz = this.target[1] - this.pos[1];
    const dist = Math.hypot(dx, dz);
    if (dist < REACH) {
      this.target = null;
      const [iMin, iMax] = this.idleRange;
      this.idleTimer = iMin + this.rng() * (iMax - iMin);
      return;
    }
    const stepLen = Math.min(this.speed * dt, dist);
    const nx = this.pos[0] + (dx / dist) * stepLen;
    const nz = this.pos[1] + (dz / dist) * stepLen;
    // 다음 걸음이 구조물 발밑이면 목적지를 버리고 잠깐 멈춤 (다음 스텝에 재샘플 — 결정론)
    if (world && insideObstacle(world, nx, nz, 0.6)) {
      this.target = null;
      this.idleTimer = 0.5;
      return;
    }
    this.heading = [dx / dist, dz / dist];
    this.pos[0] = nx;
    this.pos[1] = nz;
  }

  /** 활동 영역 안에서 장애물 발밑을 피해 목적지 샘플 (최대 10회 재시도) */
  #samplePoint(world) {
    const { min, max } = this.area;
    let p = [min[0], min[1]];
    for (let i = 0; i < 10; i++) {
      p = [min[0] + this.rng() * (max[0] - min[0]), min[1] + this.rng() * (max[1] - min[1])];
      if (!world || !insideObstacle(world, p[0], p[1], 1.0)) return p;
    }
    return p; // 전부 실패 시 마지막 후보 (보행 중 회피가 재차 걸러냄)
  }

  // ── 차량: 순환 루트 추종, 전방에 크레인·트럭이 있으면 정지 대기 ──
  #stepVehicle(dt, world) {
    const wp = this.route[this.wpIndex];
    const dx = wp[0] - this.pos[0];
    const dz = wp[1] - this.pos[1];
    const dist = Math.hypot(dx, dz);
    if (dist < REACH * 1.6) {
      this.wpIndex = (this.wpIndex + 1) % this.route.length;
      return;
    }
    this.heading = [dx / dist, dz / dist];
    // 전방 정지 판정 (신호수·안전거리): 크레인 본체·현장 트럭 앞에서 대기
    const ax = this.pos[0] + this.heading[0] * VEHICLE_LOOKAHEAD;
    const az = this.pos[1] + this.heading[1] * VEHICLE_LOOKAHEAD;
    this.waiting = world ? this.#aheadBlocked(world, ax, az) : false;
    if (this.waiting) return;
    const stepLen = Math.min(this.speed * dt, dist);
    this.pos[0] += this.heading[0] * stepLen;
    this.pos[1] += this.heading[1] * stepLen;
  }

  #aheadBlocked(world, ax, az) {
    for (const crane of world.cranes) {
      const g = crane.spec.geometry ?? {};
      const r = g.bodyRadius ?? 3;
      if (Math.hypot(ax - crane.basePos[0], az - crane.basePos[2]) < r + 1.2) return true;
    }
    for (const tr of world.trucks) {
      const ob = tr.obstacle?.();
      if (
        ob &&
        Math.abs(ax - ob.pos[0]) < ob.size[0] / 2 + 1 &&
        Math.abs(az - ob.pos[2]) < ob.size[2] / 2 + 1
      ) {
        return true;
      }
    }
    return insideObstacle(world, ax, az, 0.8);
  }

  /** 차량의 충돌체 AABB (헤딩 회전 외접) — 매달린 부재·크레인 base 판정용 */
  obstacle() {
    if (this.kind !== 'vehicle') return null;
    const [w, h, len] = this.size;
    const c = Math.abs(this.heading[0]);
    const s = Math.abs(this.heading[1]);
    return {
      id: this.id,
      pos: [this.pos[0], 0, this.pos[1]],
      size: [len * c + w * s, h, len * s + w * c],
    };
  }

  snapshot() {
    return {
      id: this.id,
      kind: this.kind,
      pos: [...this.pos],
      heading: [...this.heading],
      moving:
        this.kind === 'vehicle' ? !this.waiting : this.idleTimer <= 0 && this.target !== null,
      waiting: this.waiting,
    };
  }
}

function insideObstacle(world, x, z, margin) {
  for (const o of world.obstacles) {
    if (
      Math.abs(x - o.pos[0]) <= o.size[0] / 2 + margin &&
      Math.abs(z - o.pos[2]) <= o.size[2] / 2 + margin
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 시나리오 데이터 → 에이전트 인스턴스 (데이터 주도, 결정론).
 * scenario.agents = {
 *   seed?, dangerRadius?,
 *   workers: [{ count, area?(기본: site 3m 안쪽), speed?, idle? }, ...],
 *   vehicles: [{ route, speed?, size?, count? }, ...],
 * }
 * @returns {{ agents: Agent[], rules: { dangerRadius: number } }}
 */
export function buildAgents(scenario) {
  const def = scenario?.agents;
  if (!def) return { agents: [], rules: { dangerRadius: 5 } };
  const baseSeed = (def.seed ?? 1) >>> 0;
  const agents = [];
  let n = 0;
  const siteArea = siteFallbackArea(scenario.site);

  for (const w of def.workers ?? []) {
    const count = w.count ?? 1;
    for (let i = 0; i < count; i++) {
      agents.push(
        new Agent(
          {
            id: w.id ? `${w.id}-${i + 1}` : `W-${agents.length + 1}`,
            kind: 'worker',
            area: w.area ?? siteArea,
            speed: w.speed,
            idle: w.idle,
          },
          baseSeed + (n += 1) * 104729,
        ),
      );
    }
  }
  for (const v of def.vehicles ?? []) {
    const count = v.count ?? 1;
    for (let i = 0; i < count; i++) {
      agents.push(
        new Agent(
          {
            id: v.id ? `${v.id}-${i + 1}` : `V-${agents.length + 1}`,
            kind: 'vehicle',
            route: v.route,
            speed: v.speed,
            size: v.size,
            startIndex: i * Math.max(1, Math.floor(v.route.length / count)),
            startFraction: i / count,
          },
          baseSeed + (n += 1) * 104729,
        ),
      );
    }
  }
  return { agents, rules: { dangerRadius: def.dangerRadius ?? 5 } };
}

/** 닫힌 순환 경로의 전체 길이 비율에 해당하는 점과 다음 웨이포인트. */
function routePointAt(route, fraction) {
  const lengths = route.map((point, i) => {
    const next = route[(i + 1) % route.length];
    return Math.hypot(next[0] - point[0], next[1] - point[1]);
  });
  const total = lengths.reduce((sum, length) => sum + length, 0);
  let distance = ((fraction % 1) + 1) % 1 * total;
  for (let i = 0; i < route.length; i++) {
    if (distance <= lengths[i] || i === route.length - 1) {
      const nextIndex = (i + 1) % route.length;
      const t = lengths[i] > 0 ? distance / lengths[i] : 0;
      return {
        pos: [
          route[i][0] + (route[nextIndex][0] - route[i][0]) * t,
          route[i][1] + (route[nextIndex][1] - route[i][1]) * t,
        ],
        wpIndex: nextIndex,
      };
    }
    distance -= lengths[i];
  }
  return { pos: [...route[0]], wpIndex: 1 % route.length };
}

function siteFallbackArea(site) {
  if (!site) return { min: [-40, -40], max: [40, 40] };
  const minX = site.minX ?? -(site.width ?? 80) / 2;
  const minZ = site.minZ ?? -(site.depth ?? 80) / 2;
  return {
    min: [minX + 3, minZ + 3],
    max: [minX + (site.width ?? 80) - 3, minZ + (site.depth ?? 80) - 3],
  };
}
