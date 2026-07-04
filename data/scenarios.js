// 시나리오 라이브러리 — 난이도·상황별 환경 정의.
// 각 항목: { id, name, desc, scenario } / scenario = { cranes, loads, obstacles, noFlyZones }
// 좌표 규약: 크레인 선회각 θ에서 후크 = (r·cosθ, ·, r·sinθ)

import { CRAWLER_100T, TOWER_8T, DEFAULT_SCENARIO, PLACE_SCENARIO } from './cranes.js';

const deg = (d) => (d * Math.PI) / 180;
const onArc = (r, angDeg) => [r * Math.cos(deg(angDeg)), r * Math.sin(deg(angDeg))];

// 후크 흔들림(펜듈럼) 물리 켠 크롤러 변형
const CRAWLER_SWAY = { ...CRAWLER_100T, id: 'crawler-100t-sway', physics: { sway: true } };

/** S1 — 기본 안착: 픽업 → 선회 40° → 안착 (장애물은 궤적 밖) */
const S1 = PLACE_SCENARIO;

/** S2 — 장애물 넘기기: 직선 선회 경로 위 10m 구조물. 충분히 권상 후 통과 */
const S2 = {
  cranes: [CRAWLER_100T],
  loads: [
    {
      id: 'module-1',
      name: '설비 모듈',
      size: [3, 2.5, 3],
      mass: 10,
      pos: [21.2, 0, 0],
      target: onArc(21.2, 60),
    },
  ],
  obstacles: [
    // 픽업(0°)→목표(60°) 아크 중간(30°)의 고층 구조물 — 낮게 지나가면 충돌
    { id: 'rack-1', pos: [onArc(21.2, 30)[0], 0, onArc(21.2, 30)[1]], size: [5, 10, 5] },
  ],
  noFlyZones: [],
};

/** S3 — 금지구역 우회: 직선 아크가 금지구역 통과. 반경을 줄여(붐 올림) 안쪽으로 우회 */
const S3 = {
  cranes: [CRAWLER_100T],
  loads: [
    {
      id: 'girder-1',
      name: '철골 거더',
      size: [8, 0.8, 0.5],
      mass: 8,
      pos: [21.2, 0, 0],
      target: onArc(21.2, 90),
    },
  ],
  obstacles: [],
  noFlyZones: [
    // 34.5°~55.5° 구간의 반경 21.2m 아크를 덮는 사각 구역 → r≤15로 우회 가능
    { id: 'office-zone', min: [12, 12], max: [26, 26] },
  ],
};

/** S4 — 다중 부재 릴레이: 부재 2개를 순서대로 각자 목표에 (흔들림 물리 ON) */
const S4 = {
  cranes: [CRAWLER_SWAY],
  loads: [
    {
      id: 'pc-slab-1',
      name: 'PC 슬래브',
      size: [4, 0.3, 2.5],
      mass: 8,
      pos: [21.2, 0, 0],
      target: onArc(21.2, -50),
    },
    {
      id: 'pipe-1',
      name: '배관 스풀',
      size: [6, 0.6, 0.6],
      mass: 6,
      pos: [onArc(21.2, 25)[0], 0, onArc(21.2, 25)[1]],
      target: onArc(21.2, 70),
    },
  ],
  obstacles: [{ id: 'shed-1', pos: [onArc(26, -15)[0], 0, onArc(26, -15)[1]], size: [4, 5, 4] }],
  noFlyZones: [],
};

/** S5 — 타워크레인 야드: 트롤리·선회로 자재 야적장 정리 */
const S5 = {
  cranes: [TOWER_8T],
  loads: [
    {
      id: 'rebar-1',
      name: '철근 다발',
      size: [8, 0.5, 0.8],
      mass: 3,
      pos: [15, 0, 0], // 초기 트롤리 반경 15m, 선회 0°
      target: onArc(25, 110), // 트롤리 확장 + 선회 필요
    },
    {
      id: 'form-1',
      name: '거푸집 팩',
      size: [3, 1.5, 2],
      mass: 2,
      pos: [onArc(20, 40)[0], 0, onArc(20, 40)[1]],
      target: onArc(10, 180),
    },
  ],
  obstacles: [
    { id: 'core-wall', pos: [onArc(18, 75)[0], 0, onArc(18, 75)[1]], size: [6, 14, 3] },
  ],
  noFlyZones: [{ id: 'gate-zone', min: [-30, -8], max: [-18, 8] }],
};

/** S6 — 협동 현장: 이동식 + 타워 2대 (Tab으로 조종 크레인 전환) */
const S6 = {
  cranes: [
    { ...CRAWLER_100T, basePos: [-28, 0, 0] },
    { ...TOWER_8T, basePos: [28, 0, 0] },
  ],
  loads: [
    {
      id: 'tank-1',
      name: '중량 탱크',
      size: [4, 3, 4],
      mass: 14,
      pos: [-28 + 21.2, 0, 0], // 크롤러 초기 후크 아래
      target: [-28 + onArc(21.2, 55)[0], onArc(21.2, 55)[1]],
    },
    {
      id: 'duct-1',
      name: '덕트 모듈',
      size: [5, 1.2, 1.5],
      mass: 3,
      pos: [28 - 15, 0, 0], // 타워 초기 트롤리 반경 15m, 선회 180° 방향
      target: [28 + onArc(22, 120)[0], onArc(22, 120)[1]],
    },
  ],
  obstacles: [{ id: 'plant-1', pos: [0, 0, 14], size: [8, 12, 6] }],
  noFlyZones: [{ id: 'road-zone', min: [-8, -30], max: [8, -14] }],
};

/** S7 — 리깅 현실화: S1과 같은 과업이지만 줄걸이·해체·시험인양 시간이 소요됨 */
const S7 = {
  cranes: S1.cranes,
  loads: S1.loads.map((l) => ({ ...l })),
  obstacles: S1.obstacles,
  noFlyZones: S1.noFlyZones,
  // 사이클 타임 현실화 (P3): 줄걸이 90s, 해체 45s, 시험인양 유지 10s
  rigging: { rigTime: 90, derigTime: 45, trialLiftTime: 10 },
};

/** S8 — 거시 계획 현장: 3대 크레인 × 12개 양중물, 셋업 이동·순서·제한구역 */
const PLAN_CRAWLER_A = {
  ...CRAWLER_100T,
  id: 'MC-01',
  name: 'Crawler A',
  basePos: [-45, 0, -25],
  planning: { movable: true, travelSpeed: 1.2, setupTime: 480, teardownTime: 240, workingRadius: 32 },
};
const PLAN_CRAWLER_B = {
  ...CRAWLER_100T,
  id: 'MC-02',
  name: 'Crawler B',
  basePos: [45, 0, -25],
  planning: { movable: true, travelSpeed: 1.2, setupTime: 480, teardownTime: 240, workingRadius: 32 },
};
const PLAN_TOWER = {
  ...TOWER_8T,
  id: 'TC-01',
  name: 'Tower Center',
  basePos: [0, 0, 20],
  planning: { movable: false, setupTime: 0, teardownTime: 0, workingRadius: 35 },
};
const planLoad = (id, mass, pos, target, dependsOn = []) => ({
  id,
  name: id,
  size: mass > 10 ? [5, 1.2, 2] : [4, 0.8, 1.5],
  mass,
  pos: [pos[0], 0, pos[1]],
  target,
  duration: 900,
  dependsOn,
});
const S8 = {
  site: { width: 140, depth: 120, minX: -70, minZ: -45 },
  cranes: [PLAN_CRAWLER_A, PLAN_CRAWLER_B, PLAN_TOWER],
  loads: [
    planLoad('COL-A1', 12, [-55, -8], [-38, -5]),
    planLoad('COL-A2', 12, [-35, -10], [-22, 8]),
    planLoad('COL-B1', 12, [55, -8], [38, -5]),
    planLoad('COL-B2', 12, [35, -10], [22, 8]),
    planLoad('BEAM-A1', 8, [-52, 8], [-30, 12], ['COL-A1', 'COL-A2']),
    planLoad('BEAM-B1', 8, [52, 8], [30, 12], ['COL-B1', 'COL-B2']),
    planLoad('CORE-1', 6, [-12, 2], [-8, 25]),
    planLoad('CORE-2', 6, [12, 2], [8, 25], ['CORE-1']),
    planLoad('SLAB-A', 7, [-42, 25], [-20, 30], ['BEAM-A1']),
    planLoad('SLAB-B', 7, [42, 25], [20, 30], ['BEAM-B1']),
    planLoad('DUCT-1', 3, [-10, 42], [-5, 45], ['CORE-2']),
    planLoad('DUCT-2', 3, [10, 42], [5, 45], ['CORE-2']),
  ],
  obstacles: [
    { id: 'site-office', pos: [0, 0, -18], size: [16, 8, 10] },
  ],
  noFlyZones: [
    { id: 'central-road', min: [-8, -38], max: [8, -5] },
    { id: 'east-storage', min: [48, 15], max: [66, 34] },
  ],
  planning: {
    defaultLiftDuration: 900,
    includeFinalTeardown: true,
    hardClearance: 1.5,
    softClearance: 5,
  },
};

/**
 * S9 — 트럭 반입 → 야적장 하역 → 철골 건립 (P7.5 차등 시연의 기준 현장):
 *   부재는 트럭(서측 하역 베이 x=-34, 적재함 높이 1.35m)으로 반입되고,
 *   크레인이 야적장(x=-24/-17 적재열)에 **하역**한 뒤, 전 부재 야적 완료 후(공정 배리어)
 *   동측 2×2 철골 프레임을 시공순서대로 **건립**한다 — 부재당 여정 2단계(route).
 *
 *   입체 건물: 기둥(EL 0, 높이 6m) → 거더(기둥 위 EL+6m 안착) → 데크(EL+6.6m)
 *   → 지붕 유닛(EL+7m). 최종 안착 부재는 충돌체가 된다 (세워진 구조물 관통 불가).
 *
 *   트럭 1대가 전 부재 11개를 적재해 30초간 진입하고 t=30에 도킹한다.
 *   전량 하역 후 한 번만 출차한다. arriveTime은 하역 가능한 도킹 완료 시각이다.
 *   지반 조건이 전도 안정성을 물게 한다: 7t 기둥은 전도 안전율 1.33 기준 r≈24.3m가
 *   한계 (정격표는 26m+ 허용 — 규칙과 물리가 갈리는 지점).
 */
const YARD_CRAWLER = (id, name, basePos) => ({
  ...CRAWLER_100T,
  id,
  name,
  basePos,
  physics: { sway: true },
  planning: { movable: true, travelSpeed: 1.0, setupTime: 300, teardownTime: 150, workingRadius: 30 },
});
const TRUCK_BED = 1.35; // 트레일러 적재함 높이 (m)
// 부재: 트럭 적재함 → [하역] 야적장 슬롯 → [건립] 건물 목표(고도 포함)
const memberLoad = (id, name, size, mass, truckPos, yardPos, target, targetElev, dependsOn = [], arriveTime = 0) => ({
  id, name, size, mass,
  pos: [truckPos[0], 0, truckPos[1]],
  elev: TRUCK_BED,
  route: [
    { target: yardPos, elev: 0 }, // 1단계: 야적장 하역
    { target, elev: targetElev }, // 2단계: 건립 (기둥 위 EL+6m 등)
  ],
  dependsOn, // 최종(건립) 단계에만 적용 — 하역은 선행 무관
  ...(arriveTime > 0 ? { arriveTime } : {}),
});
const S9 = {
  site: { width: 120, depth: 90, minX: -60, minZ: -45 },
  cranes: [
    YARD_CRAWLER('CR-A', 'Crawler A', [-16, 0, -18]), // 남측 하역 셋업에서 시작
    YARD_CRAWLER('CR-B', 'Crawler B', [-16, 0, 18]), // 북측 하역 셋업에서 시작
  ],
  loads: [
    // ── T1 남측 트럭 (t=0): 기둥 2 + 거더 2 + 데크 1 ──
    memberLoad('C-11', '기둥 C-11', [0.8, 6, 0.8], 7, [-34, -20], [-24, -11], [12, -6], 0, [], 30),
    memberLoad('C-21', '기둥 C-21', [0.8, 6, 0.8], 7, [-34, -17.5], [-24, -7], [20, -6], 0, [], 30),
    memberLoad('GX-1', '거더 GX-1', [8, 0.6, 0.5], 5, [-34, -15], [-17, -10], [16, -6], 6, ['C-11', 'C-21'], 30),
    memberLoad('GZ-1', '거더 GZ-1', [0.5, 0.6, 12], 5, [-34, -12.5], [-17, -5], [12, 0], 6, ['C-11', 'C-12'], 30),
    memberLoad('D-1', '데크 D-1', [7, 0.4, 5], 4, [-34, -10], [-24, -3], [16, -3], 6.6, ['GX-1', 'GZ-1', 'GZ-2'], 30),
    // ── T2 북측 트럭 (t=300): 기둥 2 + 거더 2 + 데크 1 ──
    memberLoad('C-12', '기둥 C-12', [0.8, 6, 0.8], 7, [-34, 20], [-24, 11], [12, 6], 0, [], 30),
    memberLoad('C-22', '기둥 C-22', [0.8, 6, 0.8], 7, [-34, 17.5], [-24, 7], [20, 6], 0, [], 30),
    memberLoad('GX-2', '거더 GX-2', [8, 0.6, 0.5], 5, [-34, 15], [-17, 10], [16, 6], 6, ['C-12', 'C-22'], 30),
    memberLoad('GZ-2', '거더 GZ-2', [0.5, 0.6, 12], 5, [-34, 12.5], [-17, 5], [20, 0], 6, ['C-21', 'C-22'], 30),
    memberLoad('D-2', '데크 D-2', [7, 0.4, 5], 4, [-34, 10], [-24, 3], [16, 3], 6.6, ['GX-2', 'GZ-1', 'GZ-2'], 30),
    // ── 같은 트럭의 지붕 유닛 ──
    memberLoad('M-1', '지붕 유닛 M-1', [6, 1.5, 6], 6, [-34, 5], [-17, 0], [16, 0], 7.0, ['D-1', 'D-2'], 30),
  ],
  // 반입 트럭 (코어 엔티티 — 데이터 주도): 1대가 전 부재를 싣고 t=0 진입, t=30 도킹.
  // 전량 하역 후 한 번만 후진 출차. 도킹 풋프린트는 셋업·주행 회피 대상.
  trucks: [{
    id: 'T-1',
    dockPos: [-34, 0],
    heading: [0, -1], // 남향 전면 — 북측 외곽에서 진입
    size: [3.2, 2.9, 42], // 트레일러+캡 근사 AABB (부재 적재 범위)
    bedHeight: TRUCK_BED,
    arriveTime: 30,
    entryDistance: 26,
    entryDuration: 30,
    exitDuration: 30,
    loads: ['C-11', 'C-21', 'GX-1', 'GZ-1', 'D-1', 'C-12', 'C-22', 'GX-2', 'GZ-2', 'D-2', 'M-1'],
  }],
  obstacles: [{ id: 'site-office', pos: [0, 0, -24], size: [12, 6, 8] }],
  noFlyZones: [],
  ground: { bearingCapacity: 25, grade: '다짐 지반' },
  rigging: { rigTime: 60, derigTime: 30, trialLiftTime: 0 },
  planning: { defaultLiftDuration: 300 },
};

/**
 * S10 — 픽앤캐리(주행 인양) 현장 (SIM_DESIGN T2-⑧):
 *   좁고 긴 통로형 부지. 반입 모듈을 픽업 지점에서 반대편 설치 지점으로 옮기는데,
 *   픽업과 목표가 78m 이격 — 한 셋업(도달 지름 ~72m)으로 둘 다 담을 수 없다.
 *   빈 재배치로도 "픽업+목표 동시 도달 셋업"이 없으므로, 크레인이 하중을 매단 채
 *   중앙으로 주행(픽앤캐리)해 안착한다. 감격 정격(정적의 66%)과 주행 중 전도가 제약.
 *
 *   차등: 12t 모듈은 캐리 가능. 규칙 기반(정적 정격)만 보면 40t도 될 것 같지만,
 *   물리(감격 정격)로는 캐리 불가 — 별도 세트다운 재배치가 필요해진다.
 */
const CARRY_CRAWLER = {
  ...CRAWLER_100T,
  id: 'PC-01',
  name: 'Pick&Carry Crawler',
  basePos: [34, 0, 0], // 픽업 근처에서 시작
  planning: { movable: true, travelSpeed: 1.0, setupTime: 300, teardownTime: 150, carrySpeed: 0.5, carryAccel: 0.3, carryRadius: 8 },
};
const S10 = {
  site: { width: 120, depth: 40, minX: -60, minZ: -20 },
  cranes: [CARRY_CRAWLER],
  loads: [
    { id: 'PM-1', name: '설비 모듈 1', size: [3, 2, 3], mass: 12, pos: [44, 0, 6], target: [-34, 6] },
    { id: 'PM-2', name: '설비 모듈 2', size: [3, 2, 3], mass: 10, pos: [44, 0, -6], target: [-34, -6] },
  ],
  ground: { bearingCapacity: 30, grade: '다짐 노반' },
  rigging: { rigTime: 45, derigTime: 25, trialLiftTime: 0 },
  planning: { defaultLiftDuration: 300 },
};

/**
 * S11 — 강풍 리깅 (P7.9 매달림 거동 옵션 시연장):
 *   바람 외력→흔들림(sway), 부재 요 회전(loadYaw), 이중진자(doublePendulum) 전부 ON.
 *   거스트 주기(9s)가 진자 고유주기(~7s)에 가까워 공진성 요동이 생기고,
 *   풍속 타임라인이 한계(14 m/s)에 접근하며 거스트 창에서만 픽업이 열린다.
 *   플래그는 이 시나리오 전용 — 다른 시나리오·계획 계층 결과는 불변.
 */
const STORM_CRAWLER = {
  ...CRAWLER_100T,
  id: 'crawler-100t-storm',
  physics: { sway: true, loadYaw: true, doublePendulum: true },
};
const S11 = {
  site: { width: 90, depth: 70, minX: -45, minZ: -35 },
  cranes: [STORM_CRAWLER],
  loads: [
    {
      id: 'girder-w1',
      name: '장스팬 거더',
      size: [12, 0.9, 0.4],
      mass: 6.5,
      shape: 'h-beam',
      windArea: 10.8, // 12m × 0.9m 측면 — 수풍면적이 커 바람에 민감
      pos: [21.2, 0, 0],
      target: onArc(21.2, 75),
    },
    {
      id: 'panel-w1',
      name: '외장 패널 팩',
      size: [5, 2.4, 0.6],
      mass: 3,
      windArea: 12,
      maxWind: 12, // 패널은 부재별 한계가 더 낮다 — 후반 타임라인에서 작업 불가
      pos: [onArc(21.2, -30)[0], 0, onArc(21.2, -30)[1]],
      target: onArc(15, -95),
    },
  ],
  obstacles: [],
  noFlyZones: [],
  wind: {
    timeline: [
      [0, 7], // 초반: 여유 있는 바람
      [120, 10], // 중반: 흔들림 뚜렷
      [240, 12.5], // 후반: 거스트 피크가 한계(14)를 넘나듦 — 작업 창 좁아짐
    ],
    dir: deg(115), // 선회 아크를 가로지르는 방향 — 횡풍 흔들림 유도
    gust: { amp: 0.35, period: 9 },
    maxOperating: 14,
  },
  rigging: { rigTime: 45, derigTime: 25 },
};

export const SCENARIOS = [
  { id: 'free', name: '자유 연습', desc: '목표 없음 — 부재 4종 자유 조작', scenario: DEFAULT_SCENARIO },
  { id: 'place-basic', name: 'S1 기본 안착', desc: '픽업 → 선회 40° → 목표 안착', scenario: S1 },
  { id: 'obstacle-hop', name: 'S2 장애물 넘기기', desc: '10m 구조물 위로 충분히 권상 후 통과', scenario: S2 },
  { id: 'nfz-detour', name: 'S3 금지구역 우회', desc: '붐을 올려 반경을 줄이고 안쪽으로 우회', scenario: S3 },
  { id: 'relay-sway', name: 'S4 릴레이(흔들림)', desc: '부재 2개 연속 안착 — 후크 흔들림 물리 ON', scenario: S4 },
  { id: 'tower-yard', name: 'S5 타워크레인 야드', desc: '트롤리·선회로 자재 2건 이송', scenario: S5 },
  { id: 'dual-site', name: 'S6 협동 현장', desc: '크롤러+타워 2대 — Tab으로 크레인 전환', scenario: S6 },
  { id: 'rig-real', name: 'S7 리깅 현실화', desc: '줄걸이 90s·해체 45s·시험인양 10s — 사이클타임 현실화', scenario: S7 },
  { id: 'macro-plan', name: 'S8 전체 계획 현장', desc: '크레인 3대 · 양중물 12개 · 셋업 이동과 시공순서', scenario: S8 },
  { id: 'yard-erection', name: 'S9 트럭 하역·철골 건립', desc: '트럭 1대 전량 반입 → 야적장 하역 → 2×2 입체 철골 건립 (여정 2단계·고소 안착·전도안정성)', scenario: S9 },
  { id: 'pick-carry', name: 'S10 픽앤캐리 통로', desc: '픽업·목표 78m 이격 — 하중 매단 채 주행(감격 정격·주행 전도)으로 안착', scenario: S10 },
  { id: 'storm-rig', name: 'S11 강풍 리깅', desc: '바람 외력→흔들림·부재 요 회전·이중진자 ON — 거스트 창에서 정밀 안착', scenario: S11 },
];
