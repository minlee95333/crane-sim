// 크레인 제원 데이터.
// 100t급 크롤러 크레인의 전형값 기반 (특정 모델 아님 — 추후 실제 모델 표로 교체 가능).
// 단위: m, t, rad, s

const deg = (d) => (d * Math.PI) / 180;

export const CRAWLER_100T = {
  id: 'crawler-100t',
  name: '100t Crawler Crane',
  type: 'mobile',
  basePos: [0, 0, 0],

  geometry: {
    boomLength: 40, // 주붐 길이 (M1: 고정)
    pivotHeight: 2.0, // 붐 힌지 높이
    pivotOffset: 1.2, // 선회중심→붐힌지 수평 오프셋
    bodyWidth: 6.0, // 크롤러 폭 (렌더·충돌용)
    bodyLength: 7.5,
    trackWidth: 1.2, // 트랙 폭 (지반 접지압 계산)
    tailSwingRadius: 4.5, // 카운터웨이트 후미 회전 반경 (테일 스윙)
    tailHeight: 2.5, // 카운터웨이트 중심 높이
    bodyRadius: 3.5, // 본체 근사 원기둥 반경 (간섭 판정)
    bodyHeight: 3.2,
  },

  // 자중 (전도/지반 안정성 검사용, t)
  masses: {
    base: 55, // 상부체+하부체 (카운터웨이트 제외)
    counterweight: 30,
    boomPerMeter: 0.35, // 격자붐 단위중량 (t/m)
  },

  // 계획 정격 여유 (checkLiftFeasible에서 적용 — 런타임 리미터는 총 정격 기준)
  rating: {
    dynamicFactor: 1.1, // 동하중계수 (인양 충격)
    hookBlockMass: 0.35, // 후크블록 공제 (t)
    pickCarryFactor: 0.66, // 픽앤캐리 정격 감격 (주행 인양 시 정적 정격의 66%)
  },

  limits: {
    slewRate: deg(1.5), // 선회 최대 1.5°/s
    slewAccel: deg(0.8), // 선회 가속 0.8°/s²
    luffRate: deg(0.7), // 기복 최대 0.7°/s
    luffAccel: deg(0.5),
    hoistSpeed: 1.0, // 권상 1.0 m/s
    hoistAccel: 0.6,
    boomAngleMin: deg(15), // 붐 최소각 (반경 최대)
    boomAngleMax: deg(82), // 붐 최대각 (반경 최소)
    ropeMin: 2.0, // 붐끝~후크 최소 거리
  },

  // 정격하중표: [작업반경(m), 정격하중(t)] — 반경↑ → 용량 급감 (기본 붐 40m)
  loadChart: [
    [4.5, 100],
    [6, 78],
    [8, 57],
    [10, 44],
    [12, 35],
    [14, 29],
    [18, 21],
    [22, 15.5],
    [26, 11.5],
    [30, 8.5],
    [34, 6.2],
    [38, 4.3],
  ],

  // 2D 정격표: [붐길이, [반경, 정격]] — 붐길이는 조립 시 결정되는 계획 변수.
  // 긴 붐 = 더 먼 반경 도달, 같은 반경에서는 정격 감소 (붐 자중·좌굴)
  capacityChart: [
    [
      40,
      [
        [4.5, 100], [6, 78], [8, 57], [10, 44], [12, 35], [14, 29],
        [18, 21], [22, 15.5], [26, 11.5], [30, 8.5], [34, 6.2], [38, 4.3],
      ],
    ],
    [
      52,
      [
        [6, 60], [8, 45], [10, 36], [12, 29], [14, 24], [18, 17.5],
        [22, 13], [26, 9.8], [30, 7.4], [34, 5.6], [38, 4.2], [42, 3.2],
        [46, 2.4], [50, 1.8],
      ],
    ],
  ],

  initial: {
    boomAngle: deg(60),
    slewAngle: 0,
    ropeLength: 15,
  },
};

export const TOWER_8T = {
  id: 'tower-8t',
  name: '8t Tower Crane',
  type: 'tower',
  basePos: [0, 0, 0],

  geometry: {
    mastHeight: 32, // 마스트(지브 하단) 높이
    jibLength: 35, // 지브 길이 (트롤리 최대 반경)
    counterJibLength: 11, // 카운터지브 (렌더·테일스윙)
    trolleyMin: 3.0, // 트롤리 최소 반경 (마스트 간섭)
    bodyRadius: 1.2, // 마스트 근사 원기둥 반경 (간섭 판정)
  },

  limits: {
    slewRate: deg(2.4), // 타워는 이동식보다 선회 빠름
    slewAccel: deg(1.2),
    trolleySpeed: 0.8, // 트롤리 주행 m/s
    trolleyAccel: 0.5,
    hoistSpeed: 1.4,
    hoistAccel: 0.8,
    ropeMin: 2.0,
  },

  // 정격하중표: [트롤리 반경(m), 정격하중(t)] — 지브 끝으로 갈수록 감소
  loadChart: [
    [3, 8],
    [13, 8], // 최대 하중 구간 (모멘트 한계 전)
    [16, 6.4],
    [20, 5.0],
    [24, 4.1],
    [28, 3.4],
    [32, 2.9],
    [35, 2.6],
  ],

  // 계획 정격 여유
  rating: {
    dynamicFactor: 1.1,
    hookBlockMass: 0.15,
  },

  initial: {
    trolleyPos: 15,
    slewAngle: 0,
    ropeLength: 12,
  },
};

/** 기본 시나리오: 크레인 1대 + 부재 4종 */
export const DEFAULT_SCENARIO = {
  cranes: [CRAWLER_100T],
  // 부재: 반경 21m 부근 배치 (초기 후크 반경 21.2m)
  // 25t 부재는 반경 21m에서 정격(~16.6t) 초과 → 리미터 데모용
  loads: [
    { id: 'girder-1', name: '철골 거더', size: [8, 0.8, 0.5], mass: 5, shape: 'h-beam', pos: [21, 0, 4] },
    { id: 'pc-slab-1', name: 'PC 슬래브', size: [4, 0.3, 2.5], mass: 8, pos: [18, 0, -8] },
    { id: 'module-1', name: '설비 모듈', size: [3, 2.5, 3], mass: 15, shape: 'module', pos: [14, 0, 10] },
    { id: 'tank-1', name: '중량 탱크', size: [4, 3, 4], mass: 25, shape: 'tank', pos: [21.2, 0, 0] },
  ],
};

/**
 * RL/게임 태스크 시나리오: "부재를 픽업해 선회로 목표 지점에 안착".
 * - 초기 후크 반경 21.2m(붐 60°)에 픽업 부재 배치 → 붐 조작 없이 픽업 가능
 * - 목표는 같은 반경, 선회 +40° 위치 → 권상·선회·권하만으로 달성(정격 내 하중)
 * - 장애물·금지구역은 이 기준 궤적 밖에 배치(회피 학습용 페널티 소스)
 */
const deg40 = deg(40);
export const PLACE_SCENARIO = {
  cranes: [CRAWLER_100T],
  loads: [
    {
      id: 'pipe-1',
      name: '배관 스풀',
      size: [6, 0.6, 0.6],
      shape: 'pipe',
      mass: 8, // 반경 21.2m 정격(~16.6t) 내
      pos: [21.2, 0, 0], // 초기 후크 바로 아래 (선회 0°)
      target: [21.2 * Math.cos(deg40), 21.2 * Math.sin(deg40)], // [x, z]
    },
  ],
  obstacles: [
    // 목표 옆 구조물 (매달린 부재가 스치면 충돌 카운트)
    { id: 'structure-1', pos: [10, 0, 24], size: [4, 8, 4] },
  ],
  noFlyZones: [
    // 크레인 뒤편 금지구역 (기준 궤적과 무관, 잘못 선회 시 침범)
    { id: 'nfz-1', min: [-6, -30], max: [6, -18] },
  ],
};
