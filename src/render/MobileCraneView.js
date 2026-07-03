// 3층: 렌더 — 이동식 크레인 3D 뷰.
// 코어의 CraneState를 받아 자세만 반영한다. 상태를 절대 변경하지 않는다.
import * as THREE from 'three';

const MAT = {
  track: new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.9 }),
  body: new THREE.MeshStandardMaterial({ color: 0xd9a11a, roughness: 0.55, metalness: 0.15 }), // 크레인 옐로
  cab: new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.5 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x2a4a66, roughness: 0.15, metalness: 0.6 }),
  boom: new THREE.MeshStandardMaterial({ color: 0xc9241a, roughness: 0.5, metalness: 0.2 }), // 붐 레드
  counter: new THREE.MeshStandardMaterial({ color: 0x555b63, roughness: 0.8 }),
  rope: new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.6 }),
  hook: new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.4, metalness: 0.5 }),
};

function box(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export class MobileCraneView {
  /** @param {Object} spec 크레인 제원 (geometry 사용) */
  constructor(spec) {
    const g = spec.geometry;
    this.spec = spec;

    // 루트 (베이스 위치)
    this.root = new THREE.Group();

    // --- 하부체: 크롤러 트랙 2개 ---
    const trackH = 1.1;
    const trackL = g.bodyLength;
    const trackW = 1.2;
    const gauge = g.bodyWidth - trackW; // 트랙 중심 간격
    for (const side of [-1, 1]) {
      const track = box(trackL, trackH, trackW, MAT.track);
      track.position.set(0, trackH / 2, (side * gauge) / 2);
      this.root.add(track);
    }
    // 차대
    const carBody = box(trackL * 0.6, 0.7, gauge * 0.9, MAT.counter);
    carBody.position.y = trackH + 0.35;
    this.root.add(carBody);

    // --- 상부체 (선회) ---
    this.upper = new THREE.Group();
    this.upper.position.y = trackH + 0.7;
    this.root.add(this.upper);

    // 데크
    const deck = box(6.5, 0.6, 3.2, MAT.body);
    deck.position.set(-0.5, 0.3, 0);
    this.upper.add(deck);

    // 운전실 (붐 옆)
    const cab = box(2.2, 1.6, 1.4, MAT.body);
    cab.position.set(1.8, 1.4, 1.4);
    this.upper.add(cab);
    const glass = box(1.0, 1.0, 1.35, MAT.glass);
    glass.position.set(2.5, 1.5, 1.4);
    this.upper.add(glass);

    // 카운터웨이트
    const cw = box(1.6, 1.8, 3.0, MAT.counter);
    cw.position.set(-2.9, 1.2, 0);
    this.upper.add(cw);

    // 엔진 하우스
    const house = box(3.0, 1.3, 2.8, MAT.body);
    house.position.set(-1.2, 1.25, 0);
    this.upper.add(house);

    // --- 붐 (기복) ---
    // 피벗: 상부체 로컬 (pivotOffset, pivotHeight-하부체높이, 0)
    this.boomPivot = new THREE.Group();
    this.boomPivot.position.set(g.pivotOffset, g.pivotHeight - (trackH + 0.7), 0);
    this.upper.add(this.boomPivot);

    // 붐 본체: +x 방향, 길이 boomLength (격자 느낌은 M6에서)
    const boomLen = g.boomLength;
    this.baseBoomLength = boomLen;
    this.boomMesh = box(boomLen, 0.9, 0.9, MAT.boom);
    this.boomMesh.position.x = boomLen / 2;
    this.boomPivot.add(this.boomMesh);
    // 붐 헤드
    this.boomHead = box(1.2, 1.2, 1.2, MAT.boom);
    this.boomHead.position.x = boomLen;
    this.boomPivot.add(this.boomHead);

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

  /** @param {import('../core/Crane.js').CraneState} state */
  update(state) {
    const [bx, by, bz] = state.basePos;
    this.root.position.set(bx, by, bz);

    // 코어: hookX = r·cos(slew), hookZ = +r·sin(slew)
    // three.js rotation.y=θ는 +x를 -z로 돌리므로 부호 반전
    this.upper.rotation.y = -state.slewAngle;
    this.boomPivot.rotation.z = state.extra.boomAngle;
    const boomLength = state.extra.boomLength ?? this.baseBoomLength;
    this.boomMesh.scale.x = boomLength / this.baseBoomLength;
    this.boomMesh.position.x = boomLength / 2;
    this.boomHead.position.x = boomLength;

    // 로프: 붐끝(월드)에서 후크까지 — 흔들림 시 기울어짐
    const [hx, hy, hz] = state.hookPos;
    const tipX = bx + state.radius * Math.cos(state.slewAngle);
    const tipZ = bz + state.radius * Math.sin(state.slewAngle);
    const tipY = by + state.extra.boomTipY;
    // ropeMesh/hookMesh는 basePos에 놓인 root의 자식이다.
    // 월드 좌표를 그대로 넣으면 basePos가 두 번 더해진다.
    const a = new THREE.Vector3(tipX - bx, tipY - by, tipZ - bz);
    const b = new THREE.Vector3(hx - bx, hy - by, hz - bz);
    const dir = b.clone().sub(a);
    const ropeLen = Math.max(dir.length(), 0.01);
    this.ropeMesh.scale.y = ropeLen;
    this.ropeMesh.position.copy(a.clone().add(b).multiplyScalar(0.5));
    this.ropeMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());

    this.hookMesh.position.copy(b);
    this.hookMesh.rotation.y = -state.slewAngle;
  }
}
