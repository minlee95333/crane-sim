// 3층: 렌더 — 인양 부재 뷰. 상태를 받아 위치·색만 반영.
import * as THREE from 'three';

const PALETTE = [0x4a7fb5, 0x6d9e6b, 0xb08a4f, 0x8a6db0, 0xb0625f];

export class LoadView {
  /** @param {Array<Object>} loadStates 초기 부재 상태 배열 */
  constructor(loadStates) {
    this.root = new THREE.Group();
    this.meshes = new Map(); // id → mesh

    loadStates.forEach((l, i) => {
      const mat = new THREE.MeshStandardMaterial({
        color: PALETTE[i % PALETTE.length],
        roughness: 0.7,
        metalness: 0.1,
      });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...l.size), mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // 매달림 표시용 이미시브 (기본 꺼짐)
      mat.emissive = new THREE.Color(0x000000);
      this.meshes.set(l.id, mesh);
      this.root.add(mesh);
    });
  }

  /** @param {Array<Object>} loadStates world 상태의 loads */
  update(loadStates, cargoOffsets = new Map()) {
    for (const l of loadStates) {
      const mesh = this.meshes.get(l.id);
      if (!mesh) continue;
      const cargoOffset = cargoOffsets.get(l.id);
      mesh.position.set(
        l.pos[0] + (cargoOffset?.[0] ?? 0),
        l.pos[1] + (cargoOffset?.[1] ?? 0),
        l.pos[2] + (cargoOffset?.[2] ?? 0),
      );
      // 진입 중 pending 부재는 트럭 적재물로 표시하고, 진입 전에는 숨긴다.
      mesh.visible = l.state !== 'pending' || Boolean(cargoOffset);
      // 상태별 발광: 매달림(녹색조) / 리깅 작업 중(주황조)
      const emissive =
        l.state === 'hooked'
          ? 0x223311
          : l.state === 'rigging' || l.state === 'derigging'
            ? 0x553311
            : 0x000000;
      mesh.material.emissive.setHex(emissive);
    }
  }
}
