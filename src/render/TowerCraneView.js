// 3층: 렌더 — 타워크레인 3D 뷰.
// 코어의 CraneState를 받아 자세만 반영한다. 상태를 절대 변경하지 않는다.
import * as THREE from 'three';

const MAT = {
  mast: new THREE.MeshStandardMaterial({ color: 0xd9a11a, roughness: 0.55, metalness: 0.15 }),
  jib: new THREE.MeshStandardMaterial({ color: 0xd9a11a, roughness: 0.55, metalness: 0.15 }),
  cab: new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.5 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x2a4a66, roughness: 0.15, metalness: 0.6 }),
  counter: new THREE.MeshStandardMaterial({ color: 0x555b63, roughness: 0.8 }),
  trolley: new THREE.MeshStandardMaterial({ color: 0xc9241a, roughness: 0.5, metalness: 0.2 }),
  rope: new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.6 }),
  hook: new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.4, metalness: 0.5 }),
  base: new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.9 }),
};

function box(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export class TowerCraneView {
  /** @param {Object} spec 크레인 제원 (geometry 사용) */
  constructor(spec) {
    const g = spec.geometry;
    this.spec = spec;

    this.root = new THREE.Group();

    // --- 기초 블록 ---
    const base = box(4, 1.2, 4, MAT.base);
    base.position.y = 0.6;
    this.root.add(base);

    // --- 마스트: 격자 느낌으로 세그먼트 분할 ---
    const mastW = 1.6;
    const segH = 4;
    const nSeg = Math.ceil(g.mastHeight / segH);
    for (let i = 0; i < nSeg; i++) {
      const seg = box(mastW, segH - 0.25, mastW, MAT.mast);
      seg.position.y = 1.2 + i * segH + segH / 2;
      this.root.add(seg);
    }

    // --- 상부 (선회부): 지브 + 카운터지브 + 운전실 ---
    this.upper = new THREE.Group();
    this.upper.position.y = g.mastHeight;
    this.root.add(this.upper);

    // 턴테이블·타워헤드
    const head = box(1.8, 1.2, 1.8, MAT.mast);
    head.position.y = 0.6;
    this.upper.add(head);
    const apex = box(0.9, 5, 0.9, MAT.mast);
    apex.position.y = 3.5;
    this.upper.add(apex);

    // 운전실
    const cab = box(1.6, 1.8, 1.5, MAT.cab);
    cab.position.set(1.2, 1.4, 1.3);
    this.upper.add(cab);
    const glass = box(0.9, 1.0, 1.45, MAT.glass);
    glass.position.set(1.7, 1.4, 1.3);
    this.upper.add(glass);

    // 지브 (+x)
    const jib = box(g.jibLength, 0.8, 0.8, MAT.jib);
    jib.position.set(g.jibLength / 2, 1.4, 0);
    this.upper.add(jib);

    // 카운터지브 (-x) + 카운터웨이트
    const cjLen = g.counterJibLength ?? g.jibLength * 0.3;
    const cjib = box(cjLen, 0.7, 1.6, MAT.jib);
    cjib.position.set(-cjLen / 2, 1.4, 0);
    this.upper.add(cjib);
    const cw = box(1.6, 1.6, 2.2, MAT.counter);
    cw.position.set(-cjLen + 0.8, 0.8, 0);
    this.upper.add(cw);

    // 타이바 (apex → 지브/카운터지브, 렌더 전용 간단 표현)
    const tie1 = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 6), MAT.rope);
    this.#stretch(tie1, [0, 6, 0], [g.jibLength * 0.6, 1.8, 0]);
    this.upper.add(tie1);
    const tie2 = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 6), MAT.rope);
    this.#stretch(tie2, [0, 6, 0], [-cjLen * 0.8, 1.8, 0]);
    this.upper.add(tie2);

    // 트롤리 (지브를 따라 이동)
    this.trolley = box(1.2, 0.5, 1.2, MAT.trolley);
    this.trolley.position.y = 0.9;
    this.upper.add(this.trolley);

    // --- 로프 + 후크 (root의 로컬 좌표로 배치) ---
    this.ropeMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 6), MAT.rope);
    this.ropeMesh.castShadow = true;
    this.root.add(this.ropeMesh);

    this.hookMesh = new THREE.Group();
    const block = box(0.5, 0.8, 0.35, MAT.hook);
    block.position.y = -0.4;
    this.hookMesh.add(block);
    const hookTip = new THREE.Mesh(
      new THREE.TorusGeometry(0.25, 0.08, 8, 16, Math.PI * 1.5),
      MAT.hook,
    );
    hookTip.position.y = -1.0;
    hookTip.castShadow = true;
    this.hookMesh.add(hookTip);
    this.root.add(this.hookMesh);
  }

  /** 두 로컬 점 사이에 원기둥을 늘여 배치 (타이바용) */
  #stretch(mesh, from, to) {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const dir = b.clone().sub(a);
    mesh.scale.y = dir.length();
    mesh.position.copy(mid);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  }

  /** @param {import('../core/Crane.js').CraneState} state */
  update(state) {
    const [bx, by, bz] = state.basePos;
    this.root.position.set(bx, by, bz);

    // 코어: hookX = r·cos(slew), hookZ = +r·sin(slew) → three.js는 부호 반전
    this.upper.rotation.y = -state.slewAngle;
    this.trolley.position.x = state.extra.trolleyPos;

    // 로프: 트롤리(월드)에서 후크까지 — 흔들림 시 기울어짐
    const [hx, hy, hz] = state.hookPos;
    const suspY = by + state.extra.mastHeight + 0.9;
    const sx = bx + state.extra.trolleyPos * Math.cos(state.slewAngle);
    const sz = bz + state.extra.trolleyPos * Math.sin(state.slewAngle);

    // ropeMesh/hookMesh는 basePos에 놓인 root의 자식이다.
    // 월드 좌표를 그대로 넣으면 basePos가 두 번 더해진다.
    const a = new THREE.Vector3(sx - bx, suspY - by, sz - bz);
    const b = new THREE.Vector3(hx - bx, hy - by, hz - bz);
    const dir = b.clone().sub(a);
    const len = Math.max(dir.length(), 0.01);
    this.ropeMesh.scale.y = len;
    this.ropeMesh.position.copy(a.clone().add(b).multiplyScalar(0.5));
    this.ropeMesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir.normalize(),
    );

    this.hookMesh.position.copy(b);
    this.hookMesh.rotation.y = -state.slewAngle;
  }
}
