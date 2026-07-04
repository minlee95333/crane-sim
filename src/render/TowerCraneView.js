// 3층: 렌더 — 타워크레인 3D 뷰.
// 코어의 CraneState를 받아 자세만 반영한다. 상태를 절대 변경하지 않는다.
//
// P7.9: 격자 마스트·삼각 단면 지브 트러스(절차 생성), 카운터지브 발라스트 판,
// 트롤리 시브·멀티폴 로프, 항공 장애등(시뮬 시간 결정론 점멸).
import * as THREE from 'three';
import { latticeMesh, hookBlockGroup, ropeSegment, stretchBetween } from './parts.js';

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
  beacon: new THREE.MeshBasicMaterial({ color: 0xff2a1a }),
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

    // --- 기초 블록 + 앵커 ---
    const base = box(4, 1.2, 4, MAT.base);
    base.position.y = 0.6;
    this.root.add(base);
    for (const [dx, dz] of [[-1.6, -1.6], [-1.6, 1.6], [1.6, -1.6], [1.6, 1.6]]) {
      const anchor = box(0.5, 0.35, 0.5, MAT.counter);
      anchor.position.set(dx, 1.35, dz);
      this.root.add(anchor);
    }

    // --- 마스트: 격자 트러스 (수직) ---
    const mastLen = g.mastHeight - 1.2;
    const mast = latticeMesh(
      { length: mastLen, width: 1.5, bays: Math.max(4, Math.round(mastLen / 2.2)), chordRadius: 0.07 },
      MAT.mast,
    );
    mast.rotation.z = Math.PI / 2; // +x 방향 트러스를 +y로 세움
    mast.position.y = 1.2;
    this.root.add(mast);

    // --- 상부 (선회부): 지브 + 카운터지브 + 운전실 ---
    this.upper = new THREE.Group();
    this.upper.position.y = g.mastHeight;
    this.root.add(this.upper);

    // 턴테이블·타워헤드(에이펙스 격자)
    const head = box(1.8, 1.2, 1.8, MAT.mast);
    head.position.y = 0.6;
    this.upper.add(head);
    const apex = latticeMesh({ length: 5, width: 0.8, bays: 4, chordRadius: 0.05 }, MAT.mast);
    apex.rotation.z = Math.PI / 2;
    apex.position.y = 1.2;
    this.upper.add(apex);

    // 운전실
    const cab = box(1.6, 1.8, 1.5, MAT.cab);
    cab.position.set(1.2, 1.4, 1.3);
    this.upper.add(cab);
    const glass = box(0.9, 1.0, 1.45, MAT.glass);
    glass.position.set(1.7, 1.4, 1.3);
    this.upper.add(glass);

    // 지브 (+x): 삼각 단면 트러스 (상현 1 + 하현 2)
    const jibY = 1.35;
    const jib = latticeMesh(
      {
        length: g.jibLength,
        width: 0.95,
        height: 1.05,
        section: 'triangle',
        bays: Math.max(6, Math.round(g.jibLength / 1.6)),
        chordRadius: 0.055,
      },
      MAT.jib,
    );
    jib.position.set(0, jibY, 0);
    this.upper.add(jib);

    // 카운터지브 (-x): 플랫폼 + 발라스트 판 + 난간
    const cjLen = g.counterJibLength ?? g.jibLength * 0.3;
    const cjib = box(cjLen, 0.35, 1.8, MAT.jib);
    cjib.position.set(-cjLen / 2, jibY, 0);
    this.upper.add(cjib);
    for (let i = 0; i < 3; i++) {
      const plate = box(0.45, 1.6, 2.2, MAT.counter);
      plate.position.set(-cjLen + 0.7 + i * 0.55, jibY - 1.0, 0);
      this.upper.add(plate);
    }
    for (const dz of [-0.85, 0.85]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(cjLen - 0.5, 0.05, 0.05), MAT.cab);
      rail.position.set(-cjLen / 2, jibY + 0.75, dz);
      this.upper.add(rail);
    }

    // 타이바 (apex → 지브/카운터지브)
    const tie1 = ropeSegment(MAT.rope, 0.045);
    stretchBetween(tie1, [0, 6.0, 0], [g.jibLength * 0.6, jibY + 0.55, 0]);
    this.upper.add(tie1);
    const tie2 = ropeSegment(MAT.rope, 0.045);
    stretchBetween(tie2, [0, 6.0, 0], [-cjLen + 0.7, jibY + 0.35, 0]);
    this.upper.add(tie2);

    // 항공 장애등 (에이펙스 상단, 시뮬 시간 결정론 점멸)
    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), MAT.beacon);
    this.beacon.position.y = 6.4;
    this.upper.add(this.beacon);

    // 트롤리 (지브 하현을 따라 이동) + 시브
    this.trolley = new THREE.Group();
    this.trolley.position.y = 0.9;
    const tBody = box(1.1, 0.4, 1.2, MAT.trolley);
    this.trolley.add(tBody);
    for (const dz of [-0.3, 0.3]) {
      const sheave = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.07, 12), MAT.hook);
      sheave.rotation.x = Math.PI / 2;
      sheave.position.set(0, -0.28, dz);
      this.trolley.add(sheave);
    }
    this.upper.add(this.trolley);

    // --- 권상 로프 (멀티폴) + 후크블록 (root의 로컬 좌표로 배치) ---
    const falls = Math.max(1, Math.min(spec.geometry.hoistFalls ?? 2, 4));
    this.ropeFalls = [];
    for (let i = 0; i < falls; i++) {
      const r = ropeSegment(MAT.rope, 0.028);
      this.root.add(r);
      this.ropeFalls.push(r);
    }
    this.hookMesh = hookBlockGroup({ blockMat: MAT.hook, hookMat: MAT.hook });
    this.root.add(this.hookMesh);
  }

  /**
   * @param {import('../core/Crane.js').CraneState} state
   * @param {number} [time] 시뮬 시간 (s) — 장애등 점멸용. 생략 시 상시 점등.
   */
  update(state, time) {
    const [bx, by, bz] = state.basePos;
    this.root.position.set(bx, by, bz);

    // 코어: hookX = r·cos(slew), hookZ = +r·sin(slew) → three.js는 부호 반전
    this.upper.rotation.y = -state.slewAngle;
    this.trolley.position.x = state.extra.trolleyPos;

    // 장애등: 0.8s 점등 / 0.8s 소등 (시간의 결정론 함수)
    this.beacon.visible = time == null ? true : time % 1.6 < 0.8;

    // 로프: 트롤리(월드)에서 후크까지 — 흔들림 시 기울어짐
    const [hx, hy, hz] = state.hookPos;
    const suspY = by + state.extra.mastHeight + 0.55;
    const sx = bx + state.extra.trolleyPos * Math.cos(state.slewAngle);
    const sz = bz + state.extra.trolleyPos * Math.sin(state.slewAngle);

    // ropeFalls/hookMesh는 basePos에 놓인 root의 자식이다.
    // 월드 좌표를 그대로 넣으면 basePos가 두 번 더해진다.
    const suspL = [sx - bx, suspY - by, sz - bz];
    const hookL = [hx - bx, hy - by, hz - bz];
    const perp = [-Math.sin(state.slewAngle), 0, Math.cos(state.slewAngle)];
    const n = this.ropeFalls.length;
    this.ropeFalls.forEach((rope, i) => {
      const k = n > 1 ? (i - (n - 1) / 2) : 0;
      const spreadTop = k * 0.3;
      const spreadHook = k * 0.09;
      stretchBetween(
        rope,
        [suspL[0] + perp[0] * spreadTop, suspL[1], suspL[2] + perp[2] * spreadTop],
        [hookL[0] + perp[0] * spreadHook, hookL[1], hookL[2] + perp[2] * spreadHook],
      );
    });

    this.hookMesh.position.set(hookL[0], hookL[1], hookL[2]);
    this.hookMesh.rotation.y = -state.slewAngle;
  }
}
