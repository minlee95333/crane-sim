// 1층: 코어 — 월드. 크레인·부재를 담고 시간을 진행시킨다.
// 렌더·RL 무관. world.step(dt, commands) 하나로 전체가 돌아간다.

import { Load } from './Load.js';
import { Sway } from './Sway.js';
import { craneGeometry, checkPair } from './Interference.js';

// 픽업 판정 여유 (m) — export: 보조 UI가 허용 범위를 그릴 때 동일 값 사용 (P7.11)
export const ATTACH_MAX_HORIZ = 2.0; // 후크~부재 상면 중심 수평거리
export const ATTACH_MAX_VERT = 4.0; // 후크~부재 상면 수직거리 (슬링이 흡수)
export const RELEASE_MAX_GAP = 0.5; // 내려놓기 허용: 부재 바닥~지면 간격
export const HOOK_GAP = 1.2; // 후크 블록 길이 (후크점~부재 상면)
export const PLACE_TOL = 1.5; // 목표 안착 허용 오차 (수평, m)
const PREVIEW_NEAR_HORIZ = 12; // 조준 보조가 '근접 후보'를 보여주는 탐색 반경 (판정 아님)

// 바람 외력 (T2-⑦, sway 켠 크레인만): F[N] ≈ WIND_ACCEL_COEF · v² · A  (≈ ½·ρ·Cd)
export const WIND_ACCEL_COEF = 0.75;
export const HOOK_WIND_AREA = 0.4; // 빈 후크블록 수풍면적 (m²)

// 부재 요(yaw) 추종 (physics.loadYaw): 비틀림 스프링-감쇠로 선회각을 지연 추종
const YAW_SPRING = 0.15; // (1/s²)
const YAW_DAMP = 0.4; // (1/s)
const LOAD_SWAY_DAMPING = 0.35; // 이중진자 2단(슬링) 감쇠 — 로프보다 짧아 빨리 잦아듦

export class World {
  constructor() {
    /** @type {import('./Crane.js').Crane[]} */
    this.cranes = [];
    /** @type {Load[]} */
    this.loads = [];
    /** 장애물: { id, pos:[x,z](바닥 중심), size:[w,h,d] } → AABB */
    this.obstacles = [];
    /** 인양 금지 구역: { id, min:[x,z], max:[x,z] } */
    this.noFlyZones = [];
    /** @type {import('./Truck.js').Truck[]} 반입 트럭 (코어 엔티티) */
    this.trucks = [];
    /** @type {import('./Agent.js').Agent[]} 지상 인원·소형 장비 (시드 결정론 이동) */
    this.agents = [];
    this.agentRules = { dangerRadius: 5 }; // 매달린 하중 기준 접근 금지 반경 (m)
    this.agentHolds = new Set(); // 이번 스텝에 홀드(작업 일시정지)된 craneId
    this.agentHoldCount = 0; // 홀드 진입 누적 (에지)
    this.agentHoldTime = 0; // 홀드 누적 시간 (s) — makespan 영향의 직접 측정치
    this._prevHolds = new Set();
    this.time = 0; // 시뮬레이션 경과 시간 (s)
    /** 직전 스텝의 이벤트 메시지 (HUD·로그용) */
    this.lastEvent = null;

    // 안전 위반 상태 (매 스텝 갱신)
    this.collisionIds = []; // 현재 접촉 중인 장애물 id
    this.zoneViolation = false; // 매달린 부재가 금지구역 위에 있음
    this.collisionCount = 0; // 누적 진입 횟수 (RL 페널티용)
    this.violationCount = 0;
    this._prevColliding = false;
    this._prevViolating = false;

    // 크레인 간 간섭 (2대 이상일 때 매 스텝 갱신)
    this.cranePairs = []; // [{a, b, boomDist, tailContact, clash}]
    this.craneMinClearance = Infinity; // 전체 쌍 최소 붐 이격
    this.craneClashCount = 0; // 물리 충돌(clash) 진입 누적
    this._prevClashing = false;

    // 바람 (setWind로 설정 — 없으면 바람 제약 비활성)
    this.windDef = null; // { speed?|timeline?: [[t, m/s]...], maxOperating? }
    this.windSpeed = 0;

    // 현장 경계 (Simulation이 scenario.site로 설정 — 주행 이탈 방지). null이면 무제한.
    this.siteBounds = null;
  }

  /**
   * 바람 조건 설정. { speed: 상수 } 또는 { timeline: [[t, 풍속]...], maxOperating }
   * 확장(옵션): dir(부는 방향 rad, 기본 0=+x), gust: { amp, period } — 결정론 거스트 변조.
   */
  setWind(def) {
    this.windDef = def ?? null;
    this.windSpeed = this.#windAt(0) * this.#gustFactor(0);
  }

  #windAt(t) {
    if (!this.windDef) return 0;
    if (this.windDef.timeline) {
      let v = this.windDef.timeline[0]?.[1] ?? 0;
      for (const [tt, vv] of this.windDef.timeline) {
        if (tt <= t) v = vv;
        else break;
      }
      return v;
    }
    return this.windDef.speed ?? 0;
  }

  /** 거스트 변조 계수 — 시간의 순수 함수(난수 없음)라 결정론 유지. gust 미정의면 1. */
  #gustFactor(t) {
    const g = this.windDef?.gust;
    if (!g?.amp) return 1;
    const T = g.period ?? 10;
    // 비가약 주기 2개의 곱 — 단조 반복 없이 [1-amp, 1+amp] 안에서 요동
    const s = Math.sin((2 * Math.PI * t) / T) * Math.sin((2 * Math.PI * t) / (T * 0.377));
    return Math.max(0, 1 + g.amp * s);
  }

  /**
   * 크레인별 바람 외력 가속 주입 (sway 켠 크레인만 소비).
   * 크기 ∝ v²·수풍면적/질량 — 매달린 부재가 있으면 그 면적·질량, 없으면 빈 후크블록.
   */
  #applyWind() {
    for (let i = 0; i < this.cranes.length; i++) {
      const crane = this.cranes[i];
      if (!this.windDef || this.windSpeed <= 0 || !crane.sway) {
        crane.windAccel[0] = 0;
        crane.windAccel[1] = 0;
        continue;
      }
      const held = this.loads.find((l) => l.state === 'hooked' && l.hookedBy === i);
      const area = held
        ? held.windArea ?? Math.max(held.size[0], held.size[2]) * held.size[1]
        : HOOK_WIND_AREA;
      const hookMass = crane.spec.rating?.hookBlockMass ?? 0.35;
      const massT = (held ? held.mass : 0) + hookMass;
      const a = (WIND_ACCEL_COEF * this.windSpeed ** 2 * area) / (massT * 1000);
      const dir = this.windDef.dir ?? 0;
      crane.windAccel[0] = a * Math.cos(dir);
      crane.windAccel[1] = a * Math.sin(dir);
    }
  }

  /** 부재의 작업한계풍속 (부재별 > 현장 기본 > 무제한) */
  windLimitFor(load) {
    return load.maxWind ?? this.windDef?.maxOperating ?? Infinity;
  }

  addCrane(crane) {
    this.cranes.push(crane);
    return this.cranes.length - 1; // craneId
  }

  addLoad(def) {
    this.loads.push(new Load(def));
  }

  addObstacle(def) {
    this.obstacles.push({ id: def.id, pos: [...def.pos], size: [...def.size] });
  }

  addNoFlyZone(def) {
    this.noFlyZones.push({ id: def.id, min: [...def.min], max: [...def.max] });
  }

  /** 지상 에이전트 등록 (buildAgents 산출물) */
  addAgent(agent) {
    this.agents.push(agent);
  }

  setAgentRules(rules) {
    this.agentRules = { ...this.agentRules, ...rules };
  }

  /**
   * 홀드 판정: 매달린 하중의 수평 위험 반경 안에 인원·장비가 있으면 해당 크레인은
   * 작업 일시정지 (신호수 규칙). 에이전트는 계속 움직이므로 홀드는 스스로 풀린다.
   */
  #computeAgentHolds(dt) {
    this.agentHolds.clear();
    if (this.agents.length > 0) {
      const R = this.agentRules.dangerRadius;
      for (const load of this.loads) {
        if (load.state !== 'hooked') continue;
        for (const agent of this.agents) {
          if (Math.hypot(load.pos[0] - agent.pos[0], load.pos[2] - agent.pos[1]) < R) {
            this.agentHolds.add(load.hookedBy);
            break;
          }
        }
      }
    }
    for (const ci of this.agentHolds) {
      if (!this._prevHolds.has(ci)) {
        this.agentHoldCount += 1;
        this.lastEvent = `⛔ 지상 인원·장비 접근: 작업 일시정지 (crane ${ci})`;
      }
    }
    this.agentHoldTime += dt * this.agentHolds.size;
    this._prevHolds = new Set(this.agentHolds);
  }

  /** 트럭 등록 — 적재 부재의 도킹 시 위치를 스냅샷 (부재를 먼저 등록할 것) */
  addTruck(truck) {
    for (const id of truck.loadIds) {
      const l = this.loads.find((x) => x.id === id);
      if (l) truck.cargoDock.set(id, [l.pos[0], l.pos[2]]);
    }
    this.trucks.push(truck);
  }

  /** 트럭 상태 진행: 출차 시각 확정(한 번만) + 위치/단계 + 진입 중 적재 동반 이동 */
  #stepTrucks() {
    for (const tr of this.trucks) {
      // 전량 하역(1단계 완료) 시각 — 이후 건립 등으로 갱신되지 않는다 (재진입 결함 방지)
      if (tr.departAt == null && tr.loadIds.length > 0) {
        tr.departAt = tr.departAtFrom(this.loads);
      }
      const m = tr.motionAt(this.time);
      tr.phase = m.phase;
      tr.pos = m.pos;
      // 진입 중: 적재(pending) 부재가 트럭과 함께 들어온다 — 도킹 시 원위치(점프 없음)
      if (m.phase === 'entering') {
        for (const id of tr.loadIds) {
          const l = this.loads.find((x) => x.id === id);
          const dock = tr.cargoDock.get(id);
          if (l && dock && l.state === 'pending') {
            l.pos[0] = dock[0] + tr.heading[0] * m.offset;
            l.pos[2] = dock[1] + tr.heading[1] * m.offset;
          }
        }
      }
    }
  }

  /** 해당 크레인이 리깅/해체 작업에 묶여 있는가 (작업 중 크레인 조작 동결) */
  #riggingBusy(craneId) {
    return this.loads.some(
      (l) => l.hookedBy === craneId && (l.state === 'rigging' || l.state === 'derigging'),
    );
  }

  /**
   * @param {number} dt 초
   * @param {Array<import('./Crane.js').CraneCommand>} commands 크레인별 명령
   */
  step(dt, commands = []) {
    // 바람 갱신 (거스트는 시간의 결정론 함수) + 크레인별 외력 주입
    this.windSpeed = this.#windAt(this.time) * this.#gustFactor(this.time);
    this.#applyWind();

    // 트럭: 출차 확정·위치·적재 동반 이동
    this.#stepTrucks();

    // 반입: 도착 시각이 지난 부재를 현장에 등장시킴
    for (const load of this.loads) {
      if (load.state === 'pending' && this.time >= load.arriveTime) {
        load.state = 'ground';
        this.lastEvent = `🚚 반입: ${load.name}`;
      }
    }

    // 리깅/해체 타이머 진행 → 완료 시 전이
    for (const load of this.loads) {
      if (load.state !== 'rigging' && load.state !== 'derigging') continue;
      load.timer -= dt;
      if (load.timer <= 0) {
        const crane = this.cranes[load.hookedBy];
        if (load.state === 'rigging') this.#finalizeAttach(load.hookedBy, crane, load);
        else this.#finalizePlace(crane, load);
      }
    }

    // 지상 에이전트 이동 (시드 결정론) → 매달린 하중 접근 시 해당 크레인 홀드
    for (const agent of this.agents) agent.step(dt, this);
    this.#computeAgentHolds(dt);

    // 리깅 작업 중·지상 접근 홀드 크레인은 조작 동결 (실제: 신호수 정지 신호)
    // 주행(drive/steer)으로 base가 움직이면 충돌·경계 침범 시 되돌린다.
    this.cranes.forEach((crane, i) => {
      const px = crane.basePos[0];
      const pz = crane.basePos[2];
      const frozen = this.#riggingBusy(i) || this.agentHolds.has(i);
      crane.step(dt, frozen ? {} : (commands[i] ?? {}));
      if ((crane.basePos[0] !== px || crane.basePos[2] !== pz) && this.#baseBlocked(i)) {
        crane.basePos[0] = px;
        crane.basePos[2] = pz;
        if (crane.driveVel !== undefined) crane.driveVel = 0; // 충돌 정지
      }
    });
    // 매달린 부재는 후크를 따라간다 (+옵션: 이중진자 2단 오프셋, 요 회전 추종)
    for (const load of this.loads) {
      if (load.state !== 'hooked') continue;
      const crane = this.cranes[load.hookedBy];
      const hook = crane.getHookPos();
      let ox = 0;
      let oz = 0;
      if (load.sway) {
        // 이중진자 2단: 매달림점 = 후크, 진자 길이 = 슬링(후크갭)+부재 반높이
        const penLen = Math.max(HOOK_GAP + load.size[1] / 2, 1);
        load.sway.update(dt, hook[0], hook[2], penLen, crane.windAccel[0], crane.windAccel[1]);
        [ox, oz] = load.sway.offset;
      }
      load.pos = [hook[0] + ox, hook[1] - HOOK_GAP - load.size[1] / 2, hook[2] + oz];
      if (crane.spec.physics?.loadYaw) {
        // 요 회전: 픽업 시 상대 자세를 유지하며 선회각을 스프링-감쇠로 지연 추종
        const target = crane.slewAngle + load._yawOffset;
        load.yawVel += (-YAW_SPRING * (load.yaw - target) - YAW_DAMP * load.yawVel) * dt;
        load.yaw += load.yawVel * dt;
      }
    }
    this.#checkSafety();
    this.#checkCraneInterference();
    this.time += dt;
  }

  /**
   * 주행 중 base 충돌 판정: 크레인 본체 원이 장애물·금지구역·트럭·타 크레인·현장경계를
   * 침범하는가. 침범이면 호출측이 이동을 되돌린다 (실시간 주행 안전).
   */
  #baseBlocked(ci) {
    const me = this.cranes[ci];
    const g = me.spec.geometry;
    const r = g.bodyRadius ?? Math.max(g.bodyWidth ?? 2, g.bodyLength ?? 2) / 2;
    const [x, , z] = me.basePos;

    // 현장 경계
    const s = this.siteBounds;
    if (s) {
      const minX = s.minX ?? -((s.width ?? Infinity) / 2);
      const maxX = s.maxX ?? minX + (s.width ?? Infinity);
      const minZ = s.minZ ?? -((s.depth ?? Infinity) / 2);
      const maxZ = s.maxZ ?? minZ + (s.depth ?? Infinity);
      if (x < minX + r || x > maxX - r || z < minZ + r || z > maxZ - r) return true;
    }
    // 장애물 (AABB + 본체 반경)
    for (const o of this.obstacles) {
      if (Math.abs(x - o.pos[0]) <= o.size[0] / 2 + r && Math.abs(z - o.pos[2]) <= o.size[2] / 2 + r) return true;
    }
    // 금지구역
    for (const zn of this.noFlyZones) {
      if (x >= zn.min[0] - r && x <= zn.max[0] + r && z >= zn.min[1] - r && z <= zn.max[1] + r) return true;
    }
    // 트럭 (현장에 있을 때)
    for (const tr of this.trucks) {
      const ob = tr.obstacle?.();
      if (ob && Math.abs(x - ob.pos[0]) <= ob.size[0] / 2 + r && Math.abs(z - ob.pos[2]) <= ob.size[2] / 2 + r) return true;
    }
    // 타 크레인 본체
    for (let cj = 0; cj < this.cranes.length; cj++) {
      if (cj === ci) continue;
      const og = this.cranes[cj].spec.geometry;
      const or = og.bodyRadius ?? Math.max(og.bodyWidth ?? 2, og.bodyLength ?? 2) / 2;
      const ob = this.cranes[cj].basePos;
      if (Math.hypot(x - ob[0], z - ob[2]) < r + or) return true;
    }
    // 지상 인원·장비 (스포터 정지 규칙 — 에이전트가 움직이면 곧 풀린다)
    for (const agent of this.agents) {
      if (agent.kind === 'vehicle') {
        const ob = agent.obstacle();
        if (Math.abs(x - ob.pos[0]) <= ob.size[0] / 2 + r && Math.abs(z - ob.pos[2]) <= ob.size[2] / 2 + r) return true;
      } else if (Math.hypot(x - agent.pos[0], z - agent.pos[1]) < r + 1.0) {
        return true;
      }
    }
    return false;
  }

  /** 크레인 간 붐 이격·테일스윙 접촉 판정 (2대 이상) */
  #checkCraneInterference() {
    this.cranePairs = [];
    this.craneMinClearance = Infinity;
    if (this.cranes.length < 2) {
      this._prevClashing = false;
      return;
    }
    const geos = this.cranes.map((c) => craneGeometry(c));
    let clashing = false;
    for (let a = 0; a < geos.length; a++) {
      for (let b = a + 1; b < geos.length; b++) {
        const res = checkPair(geos[a], geos[b]);
        this.cranePairs.push({ a, b, ...res });
        this.craneMinClearance = Math.min(this.craneMinClearance, res.boomDist);
        if (res.clash) clashing = true;
      }
    }
    if (clashing && !this._prevClashing) {
      this.craneClashCount += 1;
      const p = this.cranePairs.find((x) => x.clash);
      this.lastEvent = p.tailContact
        ? `⚠ 크레인 충돌: 테일스윙 접촉 (crane ${p.a}↔${p.b})`
        : `⚠ 크레인 충돌: 붐 간섭 ${p.boomDist.toFixed(1)}m (crane ${p.a}↔${p.b})`;
    }
    this._prevClashing = clashing;
  }

  /** 매달린 부재의 장애물·기시공 구조물 충돌 · 금지구역 침범 검사 */
  #checkSafety() {
    // yaw 회전 부재는 회전 박스의 외접 AABB로 판정 — 시각 회전과 점유 영역을 일치시킨다
    const hooked = this.loads
      .filter((l) => l.state === 'hooked')
      .map((l) => ({ l, size: yawExtents(l) }));

    this.collisionIds = [];
    for (const ob of this.obstacles) {
      for (const { l, size } of hooked) {
        if (aabbOverlap(l.pos, size, ob)) {
          this.collisionIds.push(ob.id);
          break;
        }
      }
    }
    // 현장의 트럭 차체 = 충돌체. 단 자기 트럭 적재 부재의 하역(1단계) 권상은 예외 —
    // 적재함에서 들어올리는 정상 작업이 자기 차체와 겹치는 것은 충돌이 아니다.
    for (const tr of this.trucks) {
      const ob = tr.obstacle();
      if (!ob) continue;
      for (const { l, size } of hooked) {
        if (tr.loadIds.includes(l.id) && l.stage === 0) continue;
        if (aabbOverlap(l.pos, size, ob)) {
          this.collisionIds.push(ob.id);
          break;
        }
      }
    }
    // 이동 장비(차량) 차체 = 충돌체 (인원은 홀드 규칙이 담당 — 충돌 박스 아님)
    for (const agent of this.agents) {
      if (agent.kind !== 'vehicle') continue;
      const ob = agent.obstacle();
      for (const { l, size } of hooked) {
        if (aabbOverlap(l.pos, size, ob)) {
          this.collisionIds.push(ob.id);
          break;
        }
      }
    }

    // 최종 안착(placed)된 부재 = 세워진 구조물 → 충돌체.
    // 관입 여유 0.1m: 거더를 기둥 위에 '접촉' 안착시키는 정상 시공은 충돌이 아님.
    const PEN = 0.1;
    for (const p of this.loads) {
      if (p.state !== 'placed') continue;
      const shrunk = [p.size[0] - PEN * 2, p.size[1] - PEN * 2, p.size[2] - PEN * 2];
      for (const { l, size } of hooked) {
        if (aabbOverlap(l.pos, size, { pos: [p.pos[0], p.bottomY + PEN, p.pos[2]], size: shrunk })) {
          this.collisionIds.push(p.id);
          break;
        }
      }
    }

    this.zoneViolation = hooked.some(({ l }) =>
      this.noFlyZones.some(
        (z) =>
          l.pos[0] >= z.min[0] && l.pos[0] <= z.max[0] &&
          l.pos[2] >= z.min[1] && l.pos[2] <= z.max[1],
      ),
    );

    // 진입 에지에서 카운트 (연속 접촉을 1회로)
    const colliding = this.collisionIds.length > 0;
    if (colliding && !this._prevColliding) {
      this.collisionCount += 1;
      this.lastEvent = `⚠ 충돌: ${this.collisionIds.join(', ')}`;
    }
    if (this.zoneViolation && !this._prevViolating) {
      this.violationCount += 1;
      this.lastEvent = '⚠ 인양 금지구역 침범';
    }
    this._prevColliding = colliding;
    this._prevViolating = this.zoneViolation;
  }

  /**
   * 픽업/해제 토글 (사람: Space, RL: 이산 액션).
   * @returns {{ok: boolean, msg: string}}
   */
  toggleAttach(craneId) {
    const crane = this.cranes[craneId];
    if (this.#riggingBusy(craneId)) {
      this.lastEvent = '리깅 작업 중 — 완료까지 대기';
      return { ok: false, msg: this.lastEvent };
    }
    const held = this.loads.find((l) => l.state === 'hooked' && l.hookedBy === craneId);

    if (held) return this.#release(craneId, crane, held);
    return this.#attach(craneId, crane);
  }

  /** 픽업 적격 후보 탐색 — #attach와 attachPreview가 공유하는 단일 판정 경로 */
  #scanAttachEligible(crane) {
    const [hx, hy, hz] = crane.getHookPos();
    let best = null;
    let bestDist = Infinity;
    for (const load of this.loads) {
      if (load.state !== 'ground') continue;
      const dx = load.pos[0] - hx;
      const dz = load.pos[2] - hz;
      const horiz = Math.hypot(dx, dz);
      const vert = Math.abs(hy - load.topY);
      if (horiz <= ATTACH_MAX_HORIZ && vert <= ATTACH_MAX_VERT && horiz < bestDist) {
        best = load;
        bestDist = horiz;
      }
    }
    return best;
  }

  /** 미충족 선행 부재 목록 (최종 안착 단계에만 적용) — 판정·미션 가이드 공용 */
  #unmetOf(load) {
    if (!load.finalLeg) return [];
    return load.dependsOn.filter((id) => this.loads.find((l) => l.id === id)?.state !== 'placed');
  }

  /** 픽업 차단 사유 — 적격 후보에 대한 규칙 검사 (#attach와 공유) */
  #attachBlock(load) {
    // 시공순서: 최종 안착(건립) 단계에만 적용 — 하역·야적 이동은 선행 무관
    {
      const unmet = this.#unmetOf(load);
      if (unmet.length > 0) return { reason: 'precedence', unmet };
    }
    // 바람: 작업한계풍속 초과 시 신규 인양 금지
    if (this.windDef && this.windSpeed > this.windLimitFor(load)) {
      return { reason: 'wind', limit: this.windLimitFor(load) };
    }
    return null;
  }

  /**
   * 픽업 예비 판정 (순수 질의 — 상태 불변). 보조 UI 조준용.
   * 적격 후보가 없으면 근접(PREVIEW_NEAR_HORIZ 내) 최근접 지상 부재를 힌트로 반환.
   * @returns {{ load, horiz, vert, horizOk, vertOk, eligible, blockReason, block, ok }|null}
   */
  attachPreview(craneId) {
    const crane = this.cranes[craneId];
    if (!crane) return null;
    const [hx, hy, hz] = crane.getHookPos();
    const eligible = this.#scanAttachEligible(crane);
    let target = eligible;
    if (!target) {
      let bestDist = PREVIEW_NEAR_HORIZ;
      for (const load of this.loads) {
        if (load.state !== 'ground') continue;
        const horiz = Math.hypot(load.pos[0] - hx, load.pos[2] - hz);
        if (horiz < bestDist) {
          target = load;
          bestDist = horiz;
        }
      }
    }
    if (!target) return null;
    const horiz = Math.hypot(target.pos[0] - hx, target.pos[2] - hz);
    const vert = Math.abs(hy - target.topY);
    const block = this.#attachBlock(target);
    return {
      load: target,
      horiz,
      vert,
      horizOk: horiz <= ATTACH_MAX_HORIZ,
      vertOk: vert <= ATTACH_MAX_VERT,
      eligible: target === eligible,
      blockReason: block?.reason ?? null,
      block,
      ok: target === eligible && !block,
    };
  }

  /**
   * 선회 스윕 예고 (순수 질의): 현 반경·높이로 매달린 부재가 전체 선회 시 지날 호를
   * 샘플링해 충돌·금지구역 여부를 반환. 조작 전 예측용 — 판정 규칙은 #checkSafety와 동일.
   * @returns {{ radius, height, samples: [{angle,x,z,hit}] }|null} 매달림 없으면 null
   */
  sweepPreview(craneId, stepDeg = 5) {
    const crane = this.cranes[craneId];
    const held = this.loads.find((l) => l.state === 'hooked' && l.hookedBy === craneId);
    if (!crane || !held) return null;
    const [bx, , bz] = crane.basePos;
    const r = crane.getRadius();
    const size = yawExtents(held);
    const y = held.pos[1];
    const PEN = 0.1;
    const placed = this.loads.filter((p) => p.state === 'placed');
    const n = Math.max(8, Math.round(360 / stepDeg));
    const samples = [];
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2;
      const pos = [bx + r * Math.cos(angle), y, bz + r * Math.sin(angle)];
      let hit = null;
      for (const ob of this.obstacles) {
        if (aabbOverlap(pos, size, ob)) {
          hit = 'obstacle';
          break;
        }
      }
      if (!hit) {
        for (const p of placed) {
          const shrunk = [p.size[0] - PEN * 2, p.size[1] - PEN * 2, p.size[2] - PEN * 2];
          if (aabbOverlap(pos, size, { pos: [p.pos[0], p.bottomY + PEN, p.pos[2]], size: shrunk })) {
            hit = 'placed';
            break;
          }
        }
      }
      if (!hit) {
        for (const tr of this.trucks) {
          const ob = tr.obstacle();
          if (ob && aabbOverlap(pos, size, ob)) {
            hit = 'truck';
            break;
          }
        }
      }
      if (!hit) {
        for (const zn of this.noFlyZones) {
          if (pos[0] >= zn.min[0] && pos[0] <= zn.max[0] && pos[2] >= zn.min[1] && pos[2] <= zn.max[1]) {
            hit = 'nfz';
            break;
          }
        }
      }
      samples.push({ angle, x: pos[0], z: pos[2], hit });
    }
    return { radius: r, height: y, samples };
  }

  /**
   * 미션 가이드 (순수 질의): 목표가 있는 지상 부재의 픽업 준비 상태 — 선행 충족 여부.
   * ready=true인 부재가 "지금 들 수 있는" 후보다 (#attachBlock과 같은 unmet 규칙).
   */
  liftReadiness() {
    return this.loads
      .filter((l) => l.state === 'ground' && l.target)
      .map((l) => {
        const unmet = this.#unmetOf(l);
        return { id: l.id, pos: [...l.pos], size: [...l.size], ready: unmet.length === 0, unmet };
      });
  }

  #attach(craneId, crane) {
    const best = this.#scanAttachEligible(crane);
    if (!best) {
      this.lastEvent = '픽업 실패: 근처에 부재 없음 (후크를 부재 위로)';
      return { ok: false, msg: this.lastEvent };
    }
    const block = this.#attachBlock(best);
    if (block?.reason === 'precedence') {
      this.lastEvent = `픽업 불가: 선행 부재 미완 (${block.unmet.join(', ')})`;
      return { ok: false, msg: this.lastEvent };
    }
    if (block?.reason === 'wind') {
      this.lastEvent = `픽업 불가: 풍속 초과 (${this.windSpeed.toFixed(1)} > ${block.limit} m/s)`;
      return { ok: false, msg: this.lastEvent };
    }
    // 리깅 시간이 정의된 부재는 줄걸이 작업(rigging)부터 — 크레인은 그동안 동결
    if (best.rigTime > 0) {
      best.state = 'rigging';
      best.hookedBy = craneId;
      best.timer = best.rigTime;
      this.lastEvent = `줄걸이 시작: ${best.name} (${best.rigTime}s)`;
      return { ok: true, msg: this.lastEvent, pending: true };
    }
    return this.#finalizeAttach(craneId, crane, best);
  }

  /** 줄걸이 완료: 부재를 후크에 연결 (즉시 픽업·rigging 완료 공용) */
  #finalizeAttach(craneId, crane, load) {
    // 줄걸이 자체는 허용하되, 과하중이면 리미터가 인양을 차단한다 (실제와 동일)
    load.state = 'hooked';
    load.hookedBy = craneId;
    load.timer = 0;
    crane.loadMass = load.mass;
    // 매달림 거동 옵션: 현재 자세를 기준으로 요 추종 시작 / 이중진자 2단 생성
    load._yawOffset = load.yaw - crane.slewAngle;
    load.yawVel = 0;
    load.sway = crane.spec.physics?.doublePendulum
      ? new Sway({ damping: LOAD_SWAY_DAMPING })
      : null;
    // 슬링이 팽팽해지는 위치로 후크 스냅 + 부재 바닥이 지면 아래로 못 가게 최저높이 설정
    crane.setHookHeight(load.topY + HOOK_GAP);
    crane.minHookY = load.size[1] + HOOK_GAP;
    this.lastEvent = `픽업: ${load.name} (${load.mass}t)`;
    return { ok: true, msg: this.lastEvent };
  }

  /**
   * 해제(안착) 예비 판정 (순수 질의 — 상태 불변). 보조 UI 안착 가이드용.
   * @returns {{ held, support, bottomGap, canRelease, onTarget, err, tol, maxGap }|null}
   *   매달린 부재 없으면 null
   */
  releasePreview(craneId) {
    const held = this.loads.find((l) => l.state === 'hooked' && l.hookedBy === craneId);
    if (!held) return null;
    // 지지면: 목표 위(허용오차 내)면 목표 바닥고(기둥 위 6m 등), 아니면 지면(0)
    let support = 0;
    let onTarget = false;
    let err = null;
    if (held.target) {
      err = Math.hypot(held.pos[0] - held.target[0], held.pos[2] - held.target[1]);
      if (err <= PLACE_TOL) {
        support = held.targetElev;
        onTarget = true;
      }
    }
    const bottomGap = held.bottomY - support;
    return {
      held,
      support,
      bottomGap,
      canRelease: bottomGap <= RELEASE_MAX_GAP,
      onTarget,
      err,
      tol: PLACE_TOL,
      maxGap: RELEASE_MAX_GAP,
    };
  }

  #release(craneId, crane, held) {
    const preview = this.releasePreview(craneId);
    if (!preview.canRelease) {
      this.lastEvent = `해제 불가: 공중 해제 금지 (지지면과 ${preview.bottomGap.toFixed(1)}m)`;
      return { ok: false, msg: this.lastEvent };
    }
    // 해체 시간이 정의된 부재는 해체 작업(derigging)부터 — 크레인은 그동안 동결
    if (held.derigTime > 0) {
      held.state = 'derigging';
      held.timer = held.derigTime;
      this.lastEvent = `해체 시작: ${held.name} (${held.derigTime}s)`;
      return { ok: true, msg: this.lastEvent, pending: true };
    }
    return this.#finalizePlace(crane, held);
  }

  /** 해체 완료: 안착 판정·크레인 하중 해제 (즉시 해제·derigging 완료 공용) */
  #finalizePlace(crane, held) {
    held.hookedBy = null;
    held.timer = 0;
    crane.loadMass = 0;
    crane.minHookY = 0;
    held.sway = null; // 이중진자 2단 폐기 (다음 픽업에서 새로 생성 — 결정론 리셋)
    held.yawVel = 0;

    // 목표가 있고 허용오차 안에 안착했으면 단계 진행 — 마지막 단계면 placed(최종),
    // 중간 단계(하역·야적)면 다음 여정으로 넘어가고 ground(재인양 가능)
    if (held.target) {
      const dx = held.pos[0] - held.target[0];
      const dz = held.pos[2] - held.target[1];
      const err = Math.hypot(dx, dz);
      if (err <= PLACE_TOL) {
        held.pos[0] = held.target[0];
        held.pos[2] = held.target[1];
        held.pos[1] = held.targetElev + held.size[1] / 2; // 목표 바닥고 위에 안착
        held.yaw = 0; // 위치 스냅과 동일 의미론 — 목표 안착은 축 정렬로 시공
        if (held.finalLeg) {
          held.state = 'placed';
          held.stageChangedAt = this.time;
          this.lastEvent = `🎯 최종 안착: ${held.name} (오차 ${err.toFixed(2)}m${held.targetElev > 0 ? `, EL+${held.targetElev}m` : ''})`;
          return { ok: true, msg: this.lastEvent, placed: true, error: err };
        }
        if (held.stage === 0) held.yardedAt = this.time;
        held.advanceStage();
        held.state = 'ground';
        held.stageChangedAt = this.time;
        this.lastEvent = `📦 야적 완료: ${held.name} (다음: 건립 단계)`;
        return { ok: true, msg: this.lastEvent, placed: false, staged: true, error: err };
      }
      held.pos[1] = held.size[1] / 2;
      held.state = 'ground';
      this.lastEvent = `안착(목표 이탈 ${err.toFixed(1)}m): ${held.name}`;
      return { ok: true, msg: this.lastEvent, placed: false, error: err };
    }

    held.pos[1] = held.size[1] / 2; // 지면에 안착
    held.state = 'ground';
    this.lastEvent = `안착: ${held.name}`;
    return { ok: true, msg: this.lastEvent };
  }

  /** 목표가 지정된 부재가 모두 안착(placed)됐는지 */
  allPlaced() {
    const targets = this.loads.filter((l) => l.target);
    return targets.length > 0 && targets.every((l) => l.state === 'placed');
  }

  /** 전체 상태 스냅샷 (렌더·관측 공용) */
  getState() {
    return {
      time: this.time,
      cranes: this.cranes.map((c) => c.getState()),
      loads: this.loads.map((l) => l.getState()),
      obstacles: this.obstacles.map((o) => ({ id: o.id, pos: [...o.pos], size: [...o.size] })),
      noFlyZones: this.noFlyZones.map((z) => ({ id: z.id, min: [...z.min], max: [...z.max] })),
      trucks: this.trucks.map((t) => t.snapshot(this.time)),
      agents: this.agents.map((a) => a.snapshot()),
      wind: this.windDef
        ? {
            speed: this.windSpeed,
            dir: this.windDef.dir ?? 0,
            maxOperating: this.windDef.maxOperating ?? null,
          }
        : null,
      safety: {
        collisionIds: [...this.collisionIds],
        zoneViolation: this.zoneViolation,
        collisionCount: this.collisionCount,
        violationCount: this.violationCount,
        craneClashCount: this.craneClashCount,
        craneMinClearance: this.craneMinClearance,
        cranePairs: this.cranePairs.map((p) => ({ ...p })),
        agentHolds: [...this.agentHolds],
        agentHoldCount: this.agentHoldCount,
        agentHoldTime: this.agentHoldTime,
        dangerRadius: this.agentRules.dangerRadius,
      },
      lastEvent: this.lastEvent,
    };
  }
}

/**
 * yaw 회전한 부재의 외접 AABB 크기 — 회전 박스를 감싸는 축 정렬 박스.
 * yaw = 0이면 원본 크기 그대로 (기존 동작 불변).
 */
function yawExtents(l) {
  if (!l.yaw) return l.size;
  const c = Math.abs(Math.cos(l.yaw));
  const s = Math.abs(Math.sin(l.yaw));
  const [w, h, d] = l.size;
  return [w * c + d * s, h, w * s + d * c];
}

/**
 * 매달린 부재(중심 pos, size)와 장애물의 AABB 겹침 판정.
 * @param {number[]} lpos 부재 중심 [x, y, z]
 * @param {number[]} lsize 부재 크기 [w, h, d]
 * @param {{pos:number[], size:number[]}} ob 장애물 (pos: 바닥중심 [x,0,z], size:[w,h,d])
 */
function aabbOverlap(lpos, lsize, ob) {
  const [lx, ly, lz] = lpos;
  const [lw, lh, ld] = lsize;
  const [ox, oy, oz] = ob.pos;
  const [ow, oh, od] = ob.size;
  const horizX = Math.abs(lx - ox) <= (lw + ow) / 2;
  const horizZ = Math.abs(lz - oz) <= (ld + od) / 2;
  // 장애물은 바닥(oy)에서 oy+oh, 부재는 중심±h/2
  const vert = ly - lh / 2 <= oy + oh && ly + lh / 2 >= oy;
  return horizX && horizZ && vert;
}
