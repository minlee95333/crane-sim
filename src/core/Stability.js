// 1층: 코어 — 크레인 셋업 안정성 (전도 / 지반 지지력) (SIM_DESIGN T1-③, P5).
//
// 정격표는 크레인의 "구조·안정 한계(이상 지반 가정)"를 담지만,
// 실제 셋업 가능 여부는 별도로 (1) 전도 모멘트 여유, (2) 지반 접지압을 검사해야 한다.
// 준정적 모멘트 균형 — 시나리오에 지반 조건(ground)이 정의된 경우에만 적용된다.
//
// 방향(direction): 크롤러는 전도선(tipping line)이 트랙 가장자리라
//   over-side(트랙 측면, 짧은 변)가 over-front(전후)보다 불리하다.
//   계획 검사는 보수적으로 over-side를 기본으로 쓴다.
//
// 필요 제원 (spec.masses): { base(상부+하부 자중 t), counterweight(t), boomPerMeter(t/m) }
// masses 미정의 크레인(타워 등 — 기초는 별도 설계)은 검사를 건너뛴다(skipped).

const DEFAULT_SAFETY = 1.33; // 전도 안전율 (크롤러 관행 ~75% 정격 = 1/0.75)

/**
 * @param {Object} p
 * @param {Object} p.spec 크레인 제원 (geometry, masses, rating 사용)
 * @param {number} p.boomLength 붐길이 (m)
 * @param {number} p.radius 검사 반경 (m) — 보통 max(픽업, 목표)
 * @param {number} p.loadMass 인양 하중 (t)
 * @param {'side'|'front'} [p.direction] 전도 방향 (기본 side = 보수적)
 * @param {{bearingCapacity:number}|null} [p.ground] 지반 허용지지력 (t/m²). null이면 지반 검사 생략
 * @param {number} [p.safetyFactor] 전도 안전율
 * @returns {{ok, skipped?, tipOK, tippingMargin, groundOK, groundPressure, direction}}
 */
export function checkStability({
  spec,
  boomLength,
  radius,
  loadMass,
  direction = 'side',
  ground = null,
  safetyFactor = DEFAULT_SAFETY,
}) {
  const m = spec.masses;
  const g = spec.geometry;
  if (!m) return { ok: true, skipped: true };

  const trackW = g.trackWidth ?? 1.2;
  const trackL = g.bodyLength;
  // 전도선(트랙 바깥 가장자리)까지의 거리: side = 폭/2, front = 길이/2
  const d = direction === 'side' ? g.bodyWidth / 2 : g.bodyLength / 2;

  const boomMass = (m.boomPerMeter ?? 0.35) * boomLength;
  const hookMass = spec.rating?.hookBlockMass ?? 0;
  // 붐 무게중심 수평거리 ≈ 힌지~붐끝 수평 중간점
  const boomCG = g.pivotOffset + (radius - g.pivotOffset) / 2;

  // --- 전도 모멘트 균형 (전도선 기준) ---
  const stabilizing =
    m.base * d + m.counterweight * (d + (g.tailSwingRadius ?? 4.5));
  const overturning =
    (loadMass + hookMass) * Math.max(0, radius - d) +
    boomMass * Math.max(0, boomCG - d);
  const tippingMargin = overturning > 1e-9 ? stabilizing / overturning : Infinity;
  const tipOK = tippingMargin >= safetyFactor;

  // --- 지반 접지압 (강체 기초 근사: peak = W/A × (1 + 6e/B)) ---
  const W = m.base + m.counterweight + boomMass + loadMass + hookMass;
  const area = 2 * trackL * trackW; // 트랙 2줄 접지 면적
  const ecc =
    ((loadMass + hookMass) * radius +
      boomMass * boomCG -
      m.counterweight * (g.tailSwingRadius ?? 4.5)) /
    W;
  const B = direction === 'side' ? g.bodyWidth : g.bodyLength;
  const groundPressure = (W / area) * (1 + (6 * Math.abs(ecc)) / B);
  const groundOK = !ground || groundPressure <= ground.bearingCapacity;

  return {
    ok: tipOK && groundOK,
    tipOK,
    tippingMargin,
    groundOK,
    groundPressure,
    direction,
  };
}

const G = 9.81; // 중력가속도 (m/s²) — 동적 하중전이 항의 무차원화용

/**
 * 픽앤캐리(주행 인양) 정격 감격 (SIM_DESIGN T2-⑧).
 * 하중을 매단 채 주행하면 노면 요철·동하중으로 정격이 급감한다 — 정적 정격 × 감격계수.
 * 감격계수는 제원(rating.pickCarryFactor)에서 온다 (크롤러 오버프론트 관행 ~0.66~0.75).
 * @param {number} staticCapacity 캐리 반경에서의 정적 정격 (t)
 * @param {Object} rating spec.rating
 * @returns {number} 감격 정격 (t)
 */
export function pickCarryCapacity(staticCapacity, rating = {}) {
  return staticCapacity * (rating.pickCarryFactor ?? 0.66);
}

/**
 * 주행 중 전도 안정성 (픽앤캐리): 하중을 캐리 반경에 매단 채 주행할 때
 * 종방향 가감속이 하중을 관성으로 전도선 쪽에 실어 여유를 깎는다.
 *
 * 정적 전도에 동적 항을 더한다:
 *   overturning = (load+hook)·(rCarry−d) + boom·(boomCG−d) + load·(a/g)·hCarry
 *   - 첫 두 항: 정적 (checkStability와 동일 구조)
 *   - 셋째 항: 관성력 load·a 가 캐리 높이 hCarry에서 만드는 추가 전도모멘트
 * 크롤러 주행은 트랙 종축 정렬(over-front) — 전도선 d = bodyLength/2.
 *
 * @param {Object} p
 * @param {Object} p.spec 크레인 제원
 * @param {number} p.boomLength 붐길이 (m)
 * @param {number} p.carryRadius 캐리 반경 (m, 하중을 몸체 가까이 — 보통 최소반경)
 * @param {number} p.carryHeight 캐리 시 하중 무게중심 높이 (m, 지면 위)
 * @param {number} p.loadMass 하중 (t)
 * @param {number} p.accel 주행 가감속 크기 (m/s², 최악 = 제동)
 * @param {'front'|'side'} [p.direction] 전도선 방향 (기본 front = 주행 정렬)
 * @param {number} [p.safetyFactor]
 * @returns {{ok, skipped?, tipOK, tippingMargin, deratedFrom, direction}}
 */
export function checkTravelStability({
  spec,
  boomLength,
  carryRadius,
  carryHeight,
  loadMass,
  accel,
  direction = 'front',
  safetyFactor = DEFAULT_SAFETY,
}) {
  const m = spec.masses;
  const g = spec.geometry;
  if (!m) return { ok: true, skipped: true };

  const d = direction === 'side' ? g.bodyWidth / 2 : g.bodyLength / 2;
  const boomMass = (m.boomPerMeter ?? 0.35) * boomLength;
  const hookMass = spec.rating?.hookBlockMass ?? 0;
  const boomCG = g.pivotOffset + (carryRadius - g.pivotOffset) / 2;

  const stabilizing =
    m.base * d + m.counterweight * (d + (g.tailSwingRadius ?? 4.5));
  const staticOT =
    (loadMass + hookMass) * Math.max(0, carryRadius - d) +
    boomMass * Math.max(0, boomCG - d);
  // 동적 하중전이: 관성력(load·a)이 캐리 높이에서 만드는 전도모멘트 (무차원화 a/g)
  const dynamicOT = loadMass * (Math.abs(accel) / G) * Math.max(0, carryHeight);
  const overturning = staticOT + dynamicOT;
  const tippingMargin = overturning > 1e-9 ? stabilizing / overturning : Infinity;

  return {
    ok: tippingMargin >= safetyFactor,
    tipOK: tippingMargin >= safetyFactor,
    tippingMargin,
    dynamicShare: overturning > 0 ? dynamicOT / overturning : 0,
    direction,
  };
}
