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
