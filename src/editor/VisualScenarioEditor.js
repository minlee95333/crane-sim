import * as THREE from 'three';

/** descriptor의 한 시각 객체 위치를 변경한다. */
export function applyVisualEdit(descriptor, edit) {
  const pos = [...edit.pos];
  if (edit.kind === 'crane') descriptor.cranes.find((x) => x.id === edit.id).pos = pos;
  else if (edit.kind === 'load') descriptor.loads.find((x) => x.id === edit.id).pos = pos;
  else if (edit.kind === 'target') descriptor.loads.find((x) => x.id === edit.id).target = pos;
  else if (edit.kind === 'obstacle') descriptor.obstacles.find((x) => x.id === edit.id).pos = pos;
  else if (edit.kind === 'noFlyZone') {
    const zone = descriptor.noFlyZones.find((x) => x.id === edit.id);
    const center = [(zone.min[0] + zone.max[0]) / 2, (zone.min[1] + zone.max[1]) / 2];
    const delta = [pos[0] - center[0], pos[1] - center[1]];
    zone.min = [zone.min[0] + delta[0], zone.min[1] + delta[1]];
    zone.max = [zone.max[0] + delta[0], zone.max[1] + delta[1]];
  }
  return descriptor;
}

/** 같은 객체의 최신 편집만 유지하는 세션 미리보기 버퍼. */
export function stageVisualEdit(staged, edit) {
  staged.set(`${edit.kind}:${edit.id}`, { ...edit, pos: [...edit.pos] });
  return staged;
}

function editTag(object) {
  let node = object;
  while (node) {
    if (node.userData.visualEdit) return node.userData.visualEdit;
    node = node.parent;
  }
  return null;
}

function editNode(object) {
  let node = object;
  while (node) {
    if (node.userData.visualEdit) return node;
    node = node.parent;
  }
  return null;
}

/** Three.js 장면의 태그된 객체를 지면에서 선택·드래그한다. */
export class VisualScenarioEditor {
  constructor({ camera, domElement, scene, controls, getObjects, onPreview, onCommit, onSelect }) {
    this.camera = camera;
    this.domElement = domElement;
    this.controls = controls;
    this.getObjects = getObjects;
    this.onPreview = onPreview;
    this.onCommit = onCommit;
    this.onSelect = onSelect;
    this.enabled = false;
    this.dragging = false;
    this.currentEdit = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.hit = new THREE.Vector3();
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(1.1, 1.35, 32),
      new THREE.MeshBasicMaterial({ color: 0xffcc55, side: THREE.DoubleSide, depthTest: false }),
    );
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.renderOrder = 100;
    this.marker.visible = false;
    scene.add(this.marker);

    this._down = (event) => this.#pointerDown(event);
    this._move = (event) => this.#pointerMove(event);
    this._up = (event) => this.#pointerUp(event);
    // OrbitControls보다 먼저 객체 선택을 판정해야 같은 포인터로 카메라 회전이 시작되지 않는다.
    domElement.addEventListener('pointerdown', this._down, { capture: true });
    domElement.addEventListener('pointermove', this._move, { capture: true });
    domElement.addEventListener('pointerup', this._up, { capture: true });
    domElement.addEventListener('pointercancel', this._up, { capture: true });
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.domElement.style.cursor = enabled ? 'grab' : '';
    if (!enabled) this.#finish(false);
  }

  refreshPreview() {
    if (this.dragging && this.currentEdit) this.onPreview?.(this.currentEdit);
  }

  #setRay(event) {
    const rect = this.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  #pointerDown(event) {
    if (!this.enabled || event.button !== 0) return;
    this.#setRay(event);
    const intersection = this.raycaster.intersectObjects(this.getObjects(), true)
      .find((hit) => editTag(hit.object));
    if (!intersection) return;
    const node = editNode(intersection.object);
    const tag = node.userData.visualEdit;
    this.onSelect?.(tag);
    const center = node.getWorldPosition(new THREE.Vector3());
    this.dragOffset = new THREE.Vector2(center.x - intersection.point.x, center.z - intersection.point.z);
    this.dragging = true;
    this.currentEdit = { ...tag, pos: [center.x, center.z] };
    this.marker.visible = true;
    this.marker.position.set(center.x, 0.08, center.z);
    this.controlsEnabledBeforeDrag = this.controls.enabled;
    this.controls.enabled = false;
    this.domElement.style.cursor = 'grabbing';
    this.domElement.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  #pointerMove(event) {
    if (!this.dragging) return;
    this.#setRay(event);
    if (!this.raycaster.ray.intersectPlane(this.ground, this.hit)) return;
    const x = this.hit.x + this.dragOffset.x;
    const z = this.hit.z + this.dragOffset.y;
    this.currentEdit = { ...this.currentEdit, pos: [x, z] };
    this.marker.position.set(x, 0.08, z);
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  #pointerUp(event) {
    if (!this.dragging) return;
    const edit = this.currentEdit;
    this.#finish(true);
    this.domElement.releasePointerCapture?.(event.pointerId);
    this.onCommit?.(edit);
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  #finish(keepMarker) {
    const wasDragging = this.dragging;
    this.dragging = false;
    this.currentEdit = null;
    if (wasDragging) this.controls.enabled = this.controlsEnabledBeforeDrag;
    this.marker.visible = Boolean(keepMarker && this.enabled);
    this.domElement.style.cursor = this.enabled ? 'grab' : '';
  }
}
