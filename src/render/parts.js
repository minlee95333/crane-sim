// 3층: 렌더 — 공용 절차 지오메트리 빌더 (외부 에셋 0, 전부 코드 생성).
// 뷰 클래스들이 공유한다. WebGL 컨텍스트 없이 생성 가능해야 한다 (Node 헤드리스 테스트).
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

const Y_UP = new THREE.Vector3(0, 1, 0);

/** 시드 고정 PRNG (mulberry32) — 렌더 장식 배치도 재현성 유지 (전역 Math.random 금지) */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 단위 원기둥 메시를 두 점 사이에 늘여 배치 (로프·타이바·펜던트 공용) */
export function stretchBetween(mesh, from, to) {
  const a = from instanceof THREE.Vector3 ? from : new THREE.Vector3(...from);
  const b = to instanceof THREE.Vector3 ? to : new THREE.Vector3(...to);
  const dir = b.clone().sub(a);
  const len = Math.max(dir.length(), 0.01);
  mesh.scale.set(1, len, 1);
  mesh.position.copy(a.clone().add(b).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(Y_UP, dir.normalize());
}

/** 로프용 단위 원기둥 (scale.y로 길이 조절) */
export function ropeSegment(material, radius = 0.035) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 5, 1, true), material);
  mesh.castShadow = true;
  return mesh;
}

/** 부재(member) 원기둥 지오메트리를 a→b로 변환해 목록에 추가 (격자 트러스 내부용) */
function pushMember(geos, a, b, radius) {
  const av = new THREE.Vector3(...a);
  const bv = new THREE.Vector3(...b);
  const dir = bv.clone().sub(av);
  const len = dir.length();
  if (len < 1e-6) return;
  const geo = new THREE.CylinderGeometry(radius, radius, 1, 5, 1, true);
  const mat4 = new THREE.Matrix4().compose(
    av.add(bv).multiplyScalar(0.5),
    new THREE.Quaternion().setFromUnitVectors(Y_UP, dir.normalize()),
    new THREE.Vector3(1, len, 1),
  );
  geo.applyMatrix4(mat4);
  geos.push(geo);
}

/**
 * 격자 트러스 지오메트리 — +x 방향, 길이 length. 현(chord) + 지그재그 레이싱 + 가로대.
 * 재질당 1메시로 병합해 드로콜을 아낀다.
 * @param {Object} o { length, width, height?, bays?, chordRadius?, laceRadius?, section? }
 *   section: 'square'(현 4개, 붐·마스트) | 'triangle'(현 3개·상현 1, 타워 지브)
 */
export function latticeGeometry({
  length,
  width,
  height = width,
  bays = Math.max(2, Math.round(length / 1.8)),
  chordRadius = 0.055,
  laceRadius = 0.03,
  section = 'square',
}) {
  const geos = [];
  const hw = width / 2;
  const hh = height / 2;
  // 단면 코너 (y, z)
  const corners =
    section === 'triangle'
      ? [
          [hh, 0],
          [-hh, -hw],
          [-hh, hw],
        ]
      : [
          [hh, -hw],
          [hh, hw],
          [-hh, -hw],
          [-hh, hw],
        ];
  // 현: 전장 1부재
  for (const [cy, cz] of corners) pushMember(geos, [0, cy, cz], [length, cy, cz], chordRadius);
  // 면: 코너 인덱스 쌍
  const faces =
    section === 'triangle'
      ? [
          [0, 1],
          [0, 2],
          [1, 2],
        ]
      : [
          [0, 1],
          [2, 3],
          [0, 2],
          [1, 3],
        ];
  const bayLen = length / bays;
  for (let i = 0; i < bays; i++) {
    const x0 = i * bayLen;
    const x1 = x0 + bayLen;
    for (const [ai, bi] of faces) {
      const A = corners[ai];
      const B = corners[bi];
      // 지그재그 사재 (베이마다 방향 교대)
      if (i % 2 === 0) pushMember(geos, [x0, A[0], A[1]], [x1, B[0], B[1]], laceRadius);
      else pushMember(geos, [x0, B[0], B[1]], [x1, A[0], A[1]], laceRadius);
      // 베이 경계 가로대
      pushMember(geos, [x1, A[0], A[1]], [x1, B[0], B[1]], laceRadius);
    }
  }
  return BufferGeometryUtils.mergeGeometries(geos);
}

/** 격자 트러스 메시 (그림자 캐스팅 포함) */
export function latticeMesh(opts, material) {
  const mesh = new THREE.Mesh(latticeGeometry(opts), material);
  mesh.castShadow = true;
  return mesh;
}

/**
 * 후크블록 — 원점은 로프 하단(후크점). 시브 하우징·시브·훅이 아래로 매달린다.
 * 전체 시각 길이 ≈ 코어 HOOK_GAP(1.2m)와 맞춘다.
 */
export function hookBlockGroup({ blockMat, hookMat }) {
  const g = new THREE.Group();
  // 시브 하우징
  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.75, 0.28), blockMat);
  housing.position.y = -0.42;
  housing.castShadow = true;
  g.add(housing);
  // 시브(도르래) 2개 — 하우징 상부에 살짝 노출
  for (const dz of [-0.09, 0.09]) {
    const sheave = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.06, 12), hookMat);
    sheave.rotation.x = Math.PI / 2;
    sheave.position.set(0, -0.12, dz);
    g.add(sheave);
  }
  // 훅 생크 + 훅 (3/4 토러스)
  const shank = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.25, 6), hookMat);
  shank.position.y = -0.85;
  g.add(shank);
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.075, 8, 16, Math.PI * 1.5), hookMat);
  hook.position.y = -1.08;
  hook.rotation.z = Math.PI * 0.75; // 개구부가 위쪽을 향하게
  hook.castShadow = true;
  g.add(hook);
  return g;
}

/**
 * 작업자 피규어 (~1.75m, 하이비즈 조끼 + 안전모). 원점은 발바닥.
 * @param {number} seed 색·자세 변형 시드 (결정론)
 */
export function workerFigure(seed = 1) {
  const rand = seededRandom(seed);
  const vest = new THREE.MeshStandardMaterial({
    color: rand() > 0.5 ? 0xf07818 : 0xd9c928, // 주황/노랑 조끼
    roughness: 0.8,
    emissive: 0x331c00,
  });
  const pants = new THREE.MeshStandardMaterial({ color: 0x3a4450, roughness: 0.9 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc8987a, roughness: 0.7 });
  const helmet = new THREE.MeshStandardMaterial({
    color: rand() > 0.5 ? 0xf2f2ee : 0xe8c826,
    roughness: 0.35,
  });
  const g = new THREE.Group();
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.8, 0.22), pants);
  legs.position.y = 0.4;
  g.add(legs);
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.6, 0.26), vest);
  torso.position.y = 1.1;
  torso.castShadow = true;
  g.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), skin);
  head.position.y = 1.55;
  g.add(head);
  const hat = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), helmet);
  hat.position.y = 1.58;
  g.add(hat);
  // 개별 회전 변형 (군중 복제 티 방지)
  g.rotation.y = rand() * Math.PI * 2;
  return g;
}

/**
 * 접지 그림자 — 반투명 원 2~3장 스택 (텍스처 불필요 → 헤드리스 안전).
 * 태양 그림자가 닿지 않는 각도에서도 물체가 지면에 '붙어' 보이게 한다.
 */
export function contactShadow(radius = 2) {
  const g = new THREE.Group();
  const layers = [
    [radius, 0.08],
    [radius * 0.68, 0.1],
    [radius * 0.42, 0.12],
  ];
  layers.forEach(([r, opacity], i) => {
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(r, 24),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity,
        depthWrite: false,
      }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.02 + i * 0.008;
    g.add(disc);
  });
  return g;
}
