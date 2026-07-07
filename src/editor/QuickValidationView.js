import * as THREE from 'three';

/** 빠른 사전검증 결과를 편집 객체의 적색 와이어 박스로 표시한다. */
export class QuickValidationView {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'quick-validation';
  }

  update(issues, resolveObject) {
    this.root.clear();
    const keys = new Set();
    for (const item of issues) {
      const key = `${item.kind}:${item.id}`;
      if (keys.has(key)) continue;
      keys.add(key);
      const object = resolveObject(item.kind, item.id);
      if (!object) continue;
      object.updateWorldMatrix(true, true);
      const box = new THREE.BoxHelper(object, item.severity === 'error' ? 0xff3b30 : 0xffb020);
      box.material.depthTest = false;
      box.material.transparent = true;
      box.material.opacity = 0.95;
      box.renderOrder = 110;
      this.root.add(box);
    }
  }
}
