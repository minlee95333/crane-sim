// 3층: 렌더 — 이동식 크레인(크롤러) 3D 뷰.
// 코어의 CraneState를 받아 자세만 반영한다. 상태를 절대 변경하지 않는다.
//
// P7.9: 절차 생성 격자 붐(처짐 체인 2단), 멀티폴 권상 로프+후크블록, A-프레임 갠트리+펜던트,
// 트랙슈 스크롤(InstancedMesh), 카운터웨이트 적층. 붐 처짐은 렌더 전용 —
// 코어 반경·정격은 불변이고 로프는 '굽은 시각 붐끝'에서 코어 hookPos로 이어진다.
import * as THREE from 'three';
import { latticeMesh, hookBlockGroup, ropeSegment, stretchBetween } from './parts.js';

const MAT = {
  track: new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.9 }),
  shoe: new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.85, metalness: 0.1 }),
  body: new THREE.MeshStandardMaterial({ color: 0xd9a11a, roughness: 0.55, metalness: 0.15 }), // 크레인 옐로
  cab: new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.5 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x2a4a66, roughness: 0.15, metalness: 0.6 }),
  boom: new THREE.MeshStandardMaterial({ color: 0xc9241a, roughness: 0.5, metalness: 0.25 }), // 붐 레드
  counter: new THREE.MeshStandardMaterial({ color: 0x555b63, roughness: 0.8 }),
  counterAlt: new THREE.MeshStandardMaterial({ color: 0x484e57, roughness: 0.8 }),
  rope: new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.6 }),
  hook: new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.4, metalness: 0.5 }),
  rail: new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.6 }),
};

// 붐 처짐 (렌더 전용): 하중률 1.0에서 외측 세그먼트 힌지 약 2°
const DEFLECT_MAX = (2.0 * Math.PI) / 180;
const BOOM_SPLIT = 0.55; // 내측 세그먼트 비율
const SHOE_PITCH = 0.5; // 트랙슈 간격 (m)

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m4 = new THREE.Matrix4();

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

    this.root = new THREE.Group();

    // --- 하부체: 크롤러 트랙 2개 (언더캐리지 — driveYaw로 회전) ---
    this.lower = new THREE.Group();
    this.root.add(this.lower);
    const trackH = 1.1;
    const trackL = g.bodyLength;
    const trackW = 1.2;
    const gauge = g.bodyWidth - trackW; // 트랙 중심 간격
    this.trackDims = { trackH, trackL, trackW };
    this.tracks = [];
    for (const side of [-1, 1]) {
      const trackRoot = new THREE.Group();
      trackRoot.position.z = (side * gauge) / 2;
      this.lower.add(trackRoot);
      // 트랙 프레임 (슈 안쪽)
      const frame = box(trackL - 0.7, 0.75, trackW - 0.25, MAT.track);
      frame.position.y = trackH / 2;
      trackRoot.add(frame);
      // 스프로킷·아이들러
      for (const end of [-1, 1]) {
        const wheel = new THREE.Mesh(
          new THREE.CylinderGeometry(0.4, 0.4, trackW - 0.3, 14),
          MAT.track,
        );
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(end * (trackL / 2 - 0.45), 0.52, 0);
        wheel.castShadow = true;
        trackRoot.add(wheel);
      }
      // 트랙슈 벨트 (상·하열, 스크롤 애니메이션)
      const rows = Math.ceil(trackL / SHOE_PITCH);
      const shoes = new THREE.InstancedMesh(
        new THREE.BoxGeometry(SHOE_PITCH * 0.86, 0.16, trackW + 0.12),
        MAT.shoe,
        rows * 2,
      );
      shoes.castShadow = true;
      trackRoot.add(shoes);
      this.tracks.push({ shoes, rows });
    }
    this._scroll = 0;
    this._prevTime = null;
    this.#layoutShoes();
    // 차대
    const carBody = box(trackL * 0.55, 0.7, gauge * 0.85, MAT.counter);
    carBody.position.y = trackH + 0.35;
    this.lower.add(carBody);

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

    // 카운터웨이트 — 적층 슬래브 3장 (톤 교대)
    for (let i = 0; i < 3; i++) {
      const slab = box(1.55, 0.55, 3.0, i % 2 === 0 ? MAT.counter : MAT.counterAlt);
      slab.position.set(-2.9, 0.9 + i * 0.58, 0);
      this.upper.add(slab);
    }

    // 엔진 하우스 + 배기스택
    const house = box(3.0, 1.3, 2.8, MAT.body);
    house.position.set(-1.2, 1.25, 0);
    this.upper.add(house);
    const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.0, 8), MAT.hook);
    exhaust.position.set(-0.4, 2.4, -1.05);
    exhaust.castShadow = true;
    this.upper.add(exhaust);

    // 데크 후방 핸드레일 (장식 — 그림자 제외)
    const railTop = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.05, 0.05), MAT.rail);
    railTop.position.set(-2.9, 2.7, 1.45);
    this.upper.add(railTop);
    const railTop2 = railTop.clone();
    railTop2.position.z = -1.45;
    this.upper.add(railTop2);
    for (const dx of [-4.1, -1.7]) {
      for (const dz of [-1.45, 1.45]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.55, 0.05), MAT.rail);
        post.position.set(dx, 2.45, dz);
        this.upper.add(post);
      }
    }

    // A-프레임 갠트리 (펜던트 로프 지지) — 데크 후방에서 상향
    this.gantryApex = new THREE.Object3D();
    this.gantryApex.position.set(-2.6, 4.1, 0);
    this.upper.add(this.gantryApex);
    for (const dz of [-0.75, 0.75]) {
      const leg = ropeSegment(MAT.boom, 0.07);
      stretchBetween(leg, [-2.0, 0.6, dz], [-2.6, 4.1, 0]);
      this.upper.add(leg);
    }
    const apexBar = box(0.3, 0.3, 1.7, MAT.boom);
    apexBar.position.set(-2.6, 4.1, 0);
    this.upper.add(apexBar);

    // --- 붐 (기복): 격자 트러스 2세그먼트 체인 (외측이 처짐 힌지) ---
    this.boomPivot = new THREE.Group();
    this.boomPivot.position.set(g.pivotOffset, g.pivotHeight - (trackH + 0.7), 0);
    this.upper.add(this.boomPivot);

    this.baseBoomLength = g.boomLength;
    this.currentBoomLength = 0;
    this.boomInner = new THREE.Group(); // 내측 세그먼트 (피벗 기준)
    this.boomOuter = new THREE.Group(); // 외측 세그먼트 (처짐 회전)
    this.boomPivot.add(this.boomInner);
    this.boomInner.add(this.boomOuter);
    this.tipAnchor = new THREE.Object3D(); // 시각 붐끝 (로프 시작점·테스트 계약)
    this.boomOuter.add(this.tipAnchor);
    this.bridleAnchor = new THREE.Object3D(); // 펜던트 부착점 (붐끝 상현 근처)
    this.boomOuter.add(this.bridleAnchor);
    this.#rebuildBoom(g.boomLength);

    // 펜던트 로프 2가닥 (갠트리 → 붐 브라이들, 매 프레임 재배치)
    this.pendants = [];
    for (let i = 0; i < 2; i++) {
      const p = ropeSegment(MAT.rope, 0.028);
      this.root.add(p);
      this.pendants.push(p);
    }

    // --- 권상 로프 (멀티폴) + 후크블록 (root의 로컬 좌표로 배치) ---
    const falls = Math.max(1, Math.min(spec.geometry.hoistFalls ?? 4, 4));
    this.ropeFalls = [];
    for (let i = 0; i < falls; i++) {
      const r = ropeSegment(MAT.rope, 0.03);
      this.root.add(r);
      this.ropeFalls.push(r);
    }
    this.hookMesh = hookBlockGroup({ blockMat: MAT.hook, hookMat: MAT.hook });
    this.root.add(this.hookMesh);
  }

  /** 붐 격자 재생성 — 붐길이(계획 변수)가 바뀔 때만 호출 */
  #rebuildBoom(length) {
    this.currentBoomLength = length;
    for (const seg of [this.boomInner, this.boomOuter]) {
      for (const child of [...seg.children]) {
        if (child.isMesh) seg.remove(child);
      }
    }
    const innerLen = length * BOOM_SPLIT;
    const outerLen = length - innerLen;
    const w = 0.95;
    this.boomInner.add(latticeMesh({ length: innerLen, width: w }, MAT.boom));
    this.boomOuter.position.x = innerLen;
    this.boomOuter.add(latticeMesh({ length: outerLen, width: w * 0.9 }, MAT.boom));
    // 붐 헤드 (끝단 시브 하우징)
    const head = box(0.7, 1.0, 1.0, MAT.boom);
    head.position.x = outerLen;
    this.boomOuter.add(head);
    const sheave = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.5, 12), MAT.hook);
    sheave.rotation.x = Math.PI / 2;
    sheave.position.set(outerLen + 0.25, -0.25, 0);
    sheave.castShadow = true;
    this.boomOuter.add(sheave);
    this.boomHead = head;
    this.tipAnchor.position.set(outerLen + 0.25, -0.45, 0); // 시브 하단 = 로프 시작
    this.bridleAnchor.position.set(outerLen - 0.6, 0.55, 0);
  }

  /** 트랙슈 상·하열 배치 — 주행 거리(_scroll)에 따라 벨트가 도는 것처럼 순환 */
  #layoutShoes() {
    const { trackH, trackL } = this.trackDims;
    const half = trackL / 2;
    const wrap = (v) => ((v % trackL) + trackL) % trackL;
    for (const { shoes, rows } of this.tracks) {
      for (let i = 0; i < rows; i++) {
        // 하열: 전진 시 차체 기준 뒤로 흐름 / 상열: 앞으로
        const xb = -half + wrap(i * SHOE_PITCH - this._scroll);
        const xt = -half + wrap(i * SHOE_PITCH + this._scroll);
        shoes.setMatrixAt(i, _m4.makeTranslation(xb, 0.09, 0));
        shoes.setMatrixAt(rows + i, _m4.makeTranslation(xt, trackH - 0.06, 0));
      }
      shoes.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * @param {import('../core/Crane.js').CraneState} state
   * @param {number} [time] 시뮬 시간 (s) — 트랙슈 스크롤용. 생략 시 애니메이션 생략.
   */
  update(state, time) {
    const [bx, by, bz] = state.basePos;
    this.root.position.set(bx, by, bz);

    // 언더캐리지(트랙)는 주행 헤딩으로 회전 — 상부체 선회와 독립
    this.lower.rotation.y = -(state.extra.driveYaw ?? 0);

    // 코어: hookX = r·cos(slew), hookZ = +r·sin(slew)
    // three.js rotation.y=θ는 +x를 -z로 돌리므로 부호 반전
    this.upper.rotation.y = -state.slewAngle;
    this.boomPivot.rotation.z = state.extra.boomAngle;

    // 붐 처짐 (렌더 전용): 하중률 비례 — 코어 반경·정격 불변
    const ratio = Number.isFinite(state.loadRatio) ? state.loadRatio : 1.2;
    this.boomOuter.rotation.z = state.loadMass > 0 ? -DEFLECT_MAX * Math.min(ratio, 1.2) : 0;

    // 붐길이 (2D 정격표의 계획 변수) 반영 — 바뀔 때만 격자 재생성
    const boomLength = state.extra.boomLength ?? this.baseBoomLength;
    if (Math.abs(boomLength - this.currentBoomLength) > 1e-9) this.#rebuildBoom(boomLength);

    // 트랙슈 스크롤 (시뮬 시간 결정론 — 재생·리플레이에서도 동일)
    if (time != null && this._prevTime != null && time > this._prevTime) {
      const v = state.extra.driveVel ?? 0;
      if (v !== 0) {
        this._scroll += v * (time - this._prevTime);
        this.#layoutShoes();
      }
    }
    this._prevTime = time ?? null;

    // --- 로프·후크: 시각 붐끝(처짐 반영) → 코어 hookPos ---
    this.root.updateMatrixWorld(true);
    const tipW = this.tipAnchor.getWorldPosition(_v1);
    const [hx, hy, hz] = state.hookPos;
    // ropeFalls/hookMesh는 basePos에 놓인 root의 자식 → 로컬 = 월드 − basePos (root 무회전)
    const tipL = [tipW.x - bx, tipW.y - by, tipW.z - bz];
    const hookL = [hx - bx, hy - by, hz - bz];
    // 멀티폴: 시브 축(선회 접선) 방향으로 가닥 벌림
    const perp = [-Math.sin(state.slewAngle), 0, Math.cos(state.slewAngle)];
    const n = this.ropeFalls.length;
    this.ropeFalls.forEach((rope, i) => {
      const k = n > 1 ? (i - (n - 1) / 2) : 0;
      const spreadTip = k * 0.11;
      const spreadHook = k * 0.055;
      stretchBetween(
        rope,
        [tipL[0] + perp[0] * spreadTip, tipL[1], tipL[2] + perp[2] * spreadTip],
        [hookL[0] + perp[0] * spreadHook, hookL[1], hookL[2] + perp[2] * spreadHook],
      );
    });

    this.hookMesh.position.set(hookL[0], hookL[1], hookL[2]);
    this.hookMesh.rotation.y = -state.slewAngle;

    // 펜던트: 갠트리 apex → 붐 브라이들 (둘 다 월드 → root 로컬)
    const apexW = this.gantryApex.getWorldPosition(_v2);
    const bridleW = this.bridleAnchor.getWorldPosition(_v1);
    const spread = 0.35;
    this.pendants.forEach((p, i) => {
      const s = (i === 0 ? -1 : 1) * spread;
      stretchBetween(
        p,
        [apexW.x - bx + perp[0] * s, apexW.y - by, apexW.z - bz + perp[2] * s],
        [bridleW.x - bx + perp[0] * s * 0.4, bridleW.y - by, bridleW.z - bz + perp[2] * s * 0.4],
      );
    });
  }
}
