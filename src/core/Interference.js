// 1층: 코어 — 크레인 간 물리 간섭 판정 (SIM_DESIGN T1-④, P4).
//
// 모델 (준정적 기하):
//  - 붐/지브/카운터지브: 3D 선분 → 선분 간 최소거리 = 붐 이격(clearance)
//  - 테일 스윙: 카운터웨이트를 선회 반대편 tailSwingRadius 위치의 구(sphere)로,
//    상대 크레인 본체를 수직 원기둥으로 근사 → 접촉 판정
//  - 물리 충돌(clash): 붐 이격 < HARD_CLEARANCE 또는 테일 접촉
//
// 순수 함수만 — World가 매 스텝 호출해 안전 상태에 집계하고,
// PlanRunner는 경고 이격(warnClearance)으로 양보 규칙에 쓴다.

export const HARD_CLEARANCE = 1.5; // 붐 물리 충돌 판정 이격 (격자붐 폭 감안, m)
const TAIL_SIZE = 1.5; // 카운터웨이트 구 반경 (m)

/** 3D 선분 (p1→q1) ↔ (p2→q2) 최소거리 (Ericson, Real-Time Collision Detection) */
export function segDist(p1, q1, p2, q2) {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s;
  let t;

  if (a <= 1e-12 && e <= 1e-12) return len(r); // 둘 다 점
  if (a <= 1e-12) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-12) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const c1 = add(p1, scale(d1, s));
  const c2 = add(p2, scale(d2, t));
  return len(sub(c1, c2));
}

/**
 * 크레인의 간섭 기하 추출 (코어 크레인 인스턴스 → 월드좌표 기하)
 * @returns {{ segments: Array<{a,b,part}>, tail: {pos, r}|null, body: {pos, radius, height} }}
 */
export function craneGeometry(crane) {
  const [bx, by, bz] = crane.basePos;
  const th = crane.slewAngle;
  const dir = [Math.cos(th), Math.sin(th)];
  const g = crane.spec.geometry;

  if (crane.spec.type === 'tower') {
    const topY = by + crane.mastHeight + 1.4; // 지브 높이 (뷰와 동일 오프셋)
    const cjLen = g.counterJibLength ?? crane.jibLength * 0.3;
    return {
      segments: [
        // 지브: 마스트 중심 → 지브 끝
        { a: [bx, topY, bz], b: [bx + crane.jibLength * dir[0], topY, bz + crane.jibLength * dir[1]], part: 'jib' },
        // 카운터지브: 마스트 중심 → 후방
        { a: [bx, topY, bz], b: [bx - cjLen * dir[0], topY, bz - cjLen * dir[1]], part: 'counterJib' },
      ],
      tail: { pos: [bx - cjLen * dir[0], topY, bz - cjLen * dir[1]], r: TAIL_SIZE },
      body: { pos: [bx, by, bz], radius: g.bodyRadius ?? 1.2, height: crane.mastHeight },
    };
  }

  // mobile: 붐 선분 + 테일 스윙(카운터웨이트)
  const tailR = g.tailSwingRadius ?? 4.5;
  const tailY = by + (g.tailHeight ?? 2.5);
  const r = crane.getRadius();
  return {
    segments: [
      {
        a: [bx + g.pivotOffset * dir[0], by + g.pivotHeight, bz + g.pivotOffset * dir[1]],
        b: [bx + r * dir[0], by + crane.boomTipY(), bz + r * dir[1]],
        part: 'boom',
      },
    ],
    tail: { pos: [bx - tailR * dir[0], tailY, bz - tailR * dir[1]], r: TAIL_SIZE },
    body: {
      pos: [bx, by, bz],
      radius: g.bodyRadius ?? Math.max(g.bodyWidth, g.bodyLength) / 2,
      height: g.bodyHeight ?? 3.2,
    },
  };
}

/**
 * 크레인 쌍 간섭 판정.
 * @returns {{ boomDist: number, tailContact: boolean, clash: boolean }}
 */
export function checkPair(gA, gB) {
  // 붐/지브 선분 간 최소거리
  let boomDist = Infinity;
  for (const sa of gA.segments) {
    for (const sb of gB.segments) {
      boomDist = Math.min(boomDist, segDist(sa.a, sa.b, sb.a, sb.b));
    }
  }

  // 테일 접촉: 테일↔테일 (구-구), 테일↔상대 본체 (구-원기둥)
  const tailContact =
    sphereSphere(gA.tail, gB.tail) ||
    sphereCylinder(gA.tail, gB.body) ||
    sphereCylinder(gB.tail, gA.body);

  return { boomDist, tailContact, clash: boomDist < HARD_CLEARANCE || tailContact };
}

function sphereSphere(a, b) {
  if (!a || !b) return false;
  const d = len(sub(a.pos, b.pos));
  return d < a.r + b.r;
}

function sphereCylinder(sphere, cyl) {
  if (!sphere || !cyl) return false;
  const horiz = Math.hypot(sphere.pos[0] - cyl.pos[0], sphere.pos[2] - cyl.pos[2]);
  if (horiz >= sphere.r + cyl.radius) return false;
  // 수직 겹침: 구가 원기둥 높이 구간 [0, height]와 교차하는가
  return sphere.pos[1] - sphere.r < cyl.pos[1] + cyl.height && sphere.pos[1] + sphere.r > cyl.pos[1];
}

// --- 벡터 유틸 ---
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
