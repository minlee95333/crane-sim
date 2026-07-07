// 3층: 렌더 — 인양 부재 뷰. 상태를 받아 위치·자세·색만 반영하고 상태를 변경하지 않는다.
//
// P7.9: shape 데이터 주도 형상(H형강·파이프·철근 다발·탱크·모듈), 슬링 4가닥(리깅 진행률
// 연출), 리깅 작업자·신호수, 안착 이즈(코어 스냅은 그대로 — 렌더만 0.4s 보간), 접지 그림자.
// 충돌 진실은 여전히 코어의 size AABB — 시각 형상은 그 박스에 내접한다.
import * as THREE from 'three';
import { HOOK_GAP } from '../core/World.js';
import { ropeSegment, stretchBetween, workerFigure, contactShadow } from './parts.js';

export const PALETTE = [0x4a7fb5, 0x6d9e6b, 0xb08a4f, 0x8a6db0, 0xb0625f]; // 미니맵과 공유
const SLING_MAT = new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.7 });
const FRAME_MAT = new THREE.LineBasicMaterial({ color: 0x2a2d31 });
const EASE_SEC = 0.4; // 안착 시각 보간 시간

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** 가장 긴 축 인덱스 (0=x, 1=y, 2=z) — 부재 장축 판별 */
function longAxis(size) {
  let axis = 0;
  for (let i = 1; i < 3; i++) if (size[i] > size[axis]) axis = i;
  return axis;
}

/** 장축을 +x로 만든 그룹 회전 적용 */
function orientAlong(group, axis) {
  if (axis === 1) group.rotation.z = Math.PI / 2; // x→y (기둥)
  else if (axis === 2) group.rotation.y = -Math.PI / 2; // x→z
}

function shadowedBox(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** H형강 (I단면): 플랜지 2 + 웹 1 — 장축 방향으로 눕히거나(보) 세운다(기둥) */
function buildHBeam(size, mat) {
  const axis = longAxis(size);
  const len = size[axis];
  const cross = [0, 1, 2].filter((i) => i !== axis);
  const h = size[cross[0]];
  const w = size[cross[1]];
  const tf = Math.max(0.04, Math.min(h * 0.14, 0.16)); // 플랜지 두께
  const tw = Math.max(0.04, Math.min(w * 0.16, 0.14)); // 웹 두께
  const g = new THREE.Group();
  const top = shadowedBox(len, tf, w, mat);
  top.position.y = h / 2 - tf / 2;
  const bottom = shadowedBox(len, tf, w, mat);
  bottom.position.y = -(h / 2 - tf / 2);
  const web = shadowedBox(len, h - tf * 2, tw, mat);
  g.add(top, bottom, web);
  orientAlong(g, axis);
  return g;
}

/** 파이프 스풀: 원통 + 양단 플랜지 */
function buildPipe(size, mat) {
  const axis = longAxis(size);
  const len = size[axis];
  const cross = [0, 1, 2].filter((i) => i !== axis);
  const r = (Math.min(size[cross[0]], size[cross[1]]) / 2) * 0.92;
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len * 0.98, 14), mat);
  body.rotation.z = Math.PI / 2; // 원통 축 y→x
  body.castShadow = true;
  g.add(body);
  for (const end of [-1, 1]) {
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.18, r * 1.18, 0.07, 14), mat);
    flange.rotation.z = Math.PI / 2;
    flange.position.x = end * (len / 2 - 0.05);
    flange.castShadow = true;
    g.add(flange);
  }
  orientAlong(g, axis);
  return g;
}

/** 철근 다발: 6+1 육각 배열 가는 원통 + 결속 밴드 2 */
function buildRebar(size, mat) {
  const axis = longAxis(size);
  const len = size[axis];
  const cross = [0, 1, 2].filter((i) => i !== axis);
  const R = (Math.min(size[cross[0]], size[cross[1]]) / 2) * 0.8;
  const rBar = Math.max(R / 3, 0.03);
  const g = new THREE.Group();
  const spots = [[0, 0]];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    spots.push([Math.cos(a) * R * 0.62, Math.sin(a) * R * 0.62]);
  }
  for (const [oy, oz] of spots) {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(rBar, rBar, len, 6), mat);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, oy, oz);
    bar.castShadow = true;
    g.add(bar);
  }
  for (const bx of [-len * 0.3, len * 0.3]) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.02, R * 1.02, 0.12, 10), mat);
    band.rotation.z = Math.PI / 2;
    band.position.x = bx;
    g.add(band);
  }
  orientAlong(g, axis);
  return g;
}

/** 수직 탱크: 원통 + 상부 돔 + 보강 리브 */
function buildTank(size, mat) {
  const r = (Math.min(size[0], size[2]) / 2) * 0.96;
  const h = size[1];
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h * 0.86, 18), mat);
  body.position.y = -h * 0.07;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat);
  dome.position.y = h * 0.36;
  dome.castShadow = true;
  g.add(dome);
  const rib = new THREE.Mesh(new THREE.TorusGeometry(r * 1.01, 0.04, 6, 20), mat);
  rib.rotation.x = Math.PI / 2;
  rib.position.y = h * 0.1;
  g.add(rib);
  return g;
}

/** 설비 모듈: 박스 + 코너 포스트 + 윤곽 프레임 */
function buildModule(size, mat) {
  const [w, h, d] = size;
  const g = new THREE.Group();
  const body = shadowedBox(w * 0.92, h * 0.92, d * 0.92, mat);
  g.add(body);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = shadowedBox(0.12, h, 0.12, mat);
      post.position.set(sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.06));
      g.add(post);
    }
  }
  const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), FRAME_MAT);
  g.add(frame);
  return g;
}

/** shape 태그 → 형상 빌더 (미지정·미지원은 박스) */
function buildShape(l, mat) {
  switch (l.shape) {
    case 'h-beam':
      return buildHBeam(l.size, mat);
    case 'pipe':
      return buildPipe(l.size, mat);
    case 'rebar':
      return buildRebar(l.size, mat);
    case 'tank':
      return buildTank(l.size, mat);
    case 'module':
      return buildModule(l.size, mat);
    default:
      return shadowedBox(...l.size, mat);
  }
}

export class LoadView {
  /** @param {Array<Object>} loadStates 초기 부재 상태 배열 */
  constructor(loadStates) {
    this.root = new THREE.Group();
    this.meshes = new Map(); // id → 형상 그룹(또는 메시)
    this.materials = new Map(); // id → 공유 재질 (이미시브 상태 표시)
    this.slings = new Map(); // id → 로프 4가닥
    this.riggers = new Map(); // id → { crew: Group(2인), signal: Group(1인) }
    this.shadows = new Map(); // id → 접지 그림자
    this._prevState = new Map(); // id → 직전 프레임 state (전이 감지)
    this._ease = new Map(); // id → { from:[x,y,z], start } 안착 보간

    loadStates.forEach((l, i) => {
      const isSteel = l.shape === 'h-beam' || l.shape === 'rebar';
      const mat = new THREE.MeshStandardMaterial({
        color: PALETTE[i % PALETTE.length],
        roughness: isSteel ? 0.45 : 0.7,
        metalness: isSteel ? 0.45 : 0.1,
      });
      mat.emissive = new THREE.Color(0x000000);
      const mesh = buildShape(l, mat);
      mesh.userData.visualEdit = { kind: 'load', id: l.id };
      this.meshes.set(l.id, mesh);
      this.materials.set(l.id, mat);
      this.root.add(mesh);

      const slings = Array.from({ length: 4 }, () => {
        const rope = ropeSegment(SLING_MAT.clone(), 0.022);
        rope.visible = false;
        this.root.add(rope);
        return rope;
      });
      this.slings.set(l.id, slings);

      const crew = new THREE.Group();
      crew.add(workerFigure(i * 7 + 1), workerFigure(i * 7 + 2));
      crew.children[0].position.set(l.size[0] / 2 + 0.7, 0, 0.4);
      crew.children[1].position.set(-(l.size[0] / 2 + 0.7), 0, -0.4);
      crew.visible = false;
      this.root.add(crew);
      const signal = workerFigure(i * 7 + 5);
      signal.visible = false;
      this.root.add(signal);
      this.riggers.set(l.id, { crew, signal });

      const shadow = contactShadow(Math.max(l.size[0], l.size[2]) / 2 + 0.5);
      this.root.add(shadow);
      this.shadows.set(l.id, shadow);

      this._prevState.set(l.id, l.state);
    });
  }

  /** 리깅 진행률에 따라 보이는 슬링 가닥 수 (연출 — 물리 아님) */
  #slingCount(l) {
    if (l.state === 'hooked') return 4;
    if (l.state === 'rigging') {
      const total = l.rigTime ?? 0;
      return total > 0 ? Math.ceil(4 * clamp01(1 - l.rigRemain / total)) : 4;
    }
    if (l.state === 'derigging') {
      const total = l.derigTime ?? 0;
      return total > 0 ? Math.ceil(4 * clamp01(l.rigRemain / total)) : 0;
    }
    return 0;
  }

  /**
   * @param {Array<Object>} loadStates world 상태의 loads (pending 동반 이동은 코어가 반영)
   * @param {Array<Object>} [trucks] world 상태의 trucks — pending 부재 표시 판정용
   * @param {Array<Object>} [craneStates] world 상태의 cranes — 슬링 상단(후크) 좌표용
   * @param {number} [time] 시뮬 시간 (s) — 안착 이즈·작업자 애니메이션용
   */
  update(loadStates, trucks = [], craneStates = [], time = null) {
    // 진입 중(가시) 트럭에 적재된 부재 — pending이라도 트럭 위에 실려 보인다
    const riding = new Set(
      trucks.filter((t) => t.visible).flatMap((t) => t.loadIds),
    );
    for (const l of loadStates) {
      const mesh = this.meshes.get(l.id);
      if (!mesh) continue;

      // 안착 이즈: (hooked|derigging)→(ground|placed) 전이 시 0.4s 시각 보간
      // — 코어 위치는 이미 목표에 스냅됐고, 렌더만 이전 표시 위치에서 부드럽게 잇는다
      const prev = this._prevState.get(l.id);
      const settled =
        (prev === 'hooked' || prev === 'derigging') &&
        (l.state === 'ground' || l.state === 'placed');
      if (time != null && settled) {
        this._ease.set(l.id, { from: [mesh.position.x, mesh.position.y, mesh.position.z], start: time });
      }
      this._prevState.set(l.id, l.state);

      let px = l.pos[0];
      let py = l.pos[1];
      let pz = l.pos[2];
      const ease = this._ease.get(l.id);
      if (ease && time != null) {
        const t = clamp01((time - ease.start) / EASE_SEC);
        const s = t * (2 - t); // ease-out
        px = ease.from[0] + (l.pos[0] - ease.from[0]) * s;
        py = ease.from[1] + (l.pos[1] - ease.from[1]) * s;
        pz = ease.from[2] + (l.pos[2] - ease.from[2]) * s;
        if (t >= 1) this._ease.delete(l.id);
      }
      mesh.position.set(px, py, pz);
      mesh.rotation.y = -(l.yaw ?? 0); // 코어 요 회전 (three.js 부호 규약)

      // 진입 중 pending 부재는 트럭 적재물로 표시하고, 진입 전에는 숨긴다.
      mesh.visible = l.state !== 'pending' || riding.has(l.id);

      // 상태별 발광: 매달림(녹색조) / 리깅 작업 중(주황조)
      const emissive =
        l.state === 'hooked'
          ? 0x223311
          : l.state === 'rigging' || l.state === 'derigging'
            ? 0x553311
            : 0x000000;
      this.materials.get(l.id).emissive.setHex(emissive);

      this.#updateSlings(l, mesh, craneStates);
      this.#updateRiggers(l, time);
      this.#updateShadow(l, mesh);
    }
  }

  /** 슬링 4가닥: 후크(코어 좌표) → 부재 상면 4모서리 (yaw 반영) */
  #updateSlings(l, mesh, craneStates) {
    const slings = this.slings.get(l.id);
    const count = this.#slingCount(l);
    const active = count > 0 && l.hookedBy != null && mesh.visible;
    if (!active) {
      for (const rope of slings) rope.visible = false;
      return;
    }
    const crane = craneStates[l.hookedBy];
    const slingColor = l.sling?.blocked ? 0xe04a34 : l.sling?.warning ? 0xe0a53a : 0x2c2f33;
    const topY = mesh.position.y + l.size[1] / 2;
    // 후크 좌표: 코어 상태 우선, 합성 상태(계획 재생)는 부재 상면 위 후크갭으로 폴백
    const hook = crane?.hookPos ?? [mesh.position.x, topY + HOOK_GAP, mesh.position.z];
    const cy = Math.cos(l.yaw ?? 0);
    const sy = Math.sin(l.yaw ?? 0);
    const corners = [
      [-l.size[0] / 2, -l.size[2] / 2],
      [l.size[0] / 2, -l.size[2] / 2],
      [l.size[0] / 2, l.size[2] / 2],
      [-l.size[0] / 2, l.size[2] / 2],
    ];
    slings.forEach((rope, i) => {
      if (i >= count) {
        rope.visible = false;
        return;
      }
      const [dx, dz] = corners[i];
      // 코어 좌표 규약으로 yaw 회전 (World.yawExtents와 동일 방향)
      const wx = mesh.position.x + dx * cy - dz * sy;
      const wz = mesh.position.z + dx * sy + dz * cy;
      rope.visible = true;
      rope.material.color.setHex(slingColor);
      stretchBetween(rope, hook, [wx, topY, wz]);
    });
  }

  /** 리깅 작업자 2인(지상 작업만) + 해체 신호수 */
  #updateRiggers(l, time) {
    const rig = this.riggers.get(l.id);
    const working = l.state === 'rigging' || l.state === 'derigging';
    const nearGround = l.pos[1] - l.size[1] / 2 < 2; // 고소 작업은 크루 생략 (구조물 위 표현 없음)
    rig.crew.visible = working && nearGround;
    if (rig.crew.visible) {
      rig.crew.position.set(l.pos[0], 0, l.pos[2]);
      rig.crew.rotation.y = -(l.yaw ?? 0);
      if (time != null) {
        // 작업 모션: 시뮬 시간 결정론 — 웅크렸다 폈다
        rig.crew.children.forEach((w, i) => {
          w.scale.y = 1 - 0.06 * Math.abs(Math.sin(time * 1.7 + i * 1.3));
        });
      }
    }
    rig.signal.visible = l.state === 'derigging';
    if (rig.signal.visible) {
      rig.signal.position.set(l.pos[0] + 2.2, 0, l.pos[2] + 2.2);
    }
  }

  /** 접지 그림자: 부재 발밑 지면 — 높이 올라갈수록 작고 옅게 */
  #updateShadow(l, mesh) {
    const shadow = this.shadows.get(l.id);
    const bottom = l.pos[1] - l.size[1] / 2;
    // 매달림 계열은 공중이어도 지면 블롭 표시. 안착 상태는 실제 지면에 놓였을 때만
    // (고소 안착 부재는 구조물이 실그림자를 받으므로 지면 블롭이 오히려 어색).
    const airborne = l.state === 'hooked' || l.state === 'rigging' || l.state === 'derigging';
    const onGround = (l.state === 'ground' || l.state === 'placed') && bottom < 0.5;
    const show = mesh.visible && l.state !== 'pending' && (airborne || onGround);
    shadow.visible = show;
    if (!show) return;
    shadow.position.set(mesh.position.x, 0, mesh.position.z);
    const s = Math.max(0.3, 1 / (1 + bottom * 0.1));
    shadow.scale.set(s, 1, s);
  }
}
