// 3층: 렌더 — 카메라 리그. 활성 크레인 상태를 읽어 시점만 옮긴다 (상태 불변).
// 모드: 궤도(OrbitControls) → 추적(후방 3인칭) → 운전실(캡 시점) → 후크캠.
// 합성 상태(계획 재생)에도 동작하도록 모든 필드는 ?? 가드.
import * as THREE from 'three';

const MODES = ['orbit', 'follow', 'cab', 'hook'];
const LABELS = { orbit: '궤도', follow: '추적', cab: '운전실', hook: '후크' };

export class CameraRig {
  /** @param {THREE.Camera} camera @param {Object} controls OrbitControls */
  constructor(camera, controls) {
    this.camera = camera;
    this.controls = controls;
    this.mode = 'orbit';
    this._look = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._lookTarget = new THREE.Vector3();
    this._snapped = false;
  }

  get label() {
    return LABELS[this.mode];
  }

  /** 다음 모드로 순환. 궤도 복귀 시 OrbitControls 재활성. */
  cycle() {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
    this._snapped = false;
    if (this.mode === 'orbit') this.controls.enabled = true;
    return this.mode;
  }

  /** 시나리오 전환 등 — 다음 프레임에 스냅 (긴 러버밴딩 방지) */
  retarget() {
    this._snapped = false;
  }

  /** @param {Object} craneState 활성 크레인 상태 (합성 상태 허용) */
  update(craneState) {
    if (this.mode === 'orbit' || !craneState) {
      this.controls.enabled = true;
      return;
    }
    this.controls.enabled = false;
    const [bx, by, bz] = craneState.basePos ?? [0, 0, 0];
    const th = craneState.slewAngle ?? 0;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const hook = craneState.hookPos ?? [bx + 12 * c, 6, bz + 12 * s];

    let px;
    let py;
    let pz;
    if (this.mode === 'follow') {
      // 상부체 후방 3인칭 — 선회를 따라 돈다
      px = bx - c * 17;
      py = by + 10.5;
      pz = bz - s * 17;
      this._lookTarget.set((hook[0] + bx) / 2, Math.max(4, (hook[1] + by) / 2), (hook[2] + bz) / 2);
    } else if (this.mode === 'cab') {
      // 운전실: 크롤러는 상부체 데크, 타워는 마스트 상부 캡 (붐 우측 오프셋)
      const isTower = craneState.type === 'tower';
      const upY = isTower ? (craneState.extra?.mastHeight ?? 30) + 1.6 : 3.5;
      const fwd = isTower ? 1.6 : 2.7;
      const side = 1.35;
      px = bx + c * fwd - s * side;
      py = by + upY;
      pz = bz + s * fwd + c * side;
      this._lookTarget.set(hook[0], hook[1], hook[2]);
    } else {
      // 후크캠: 후크 후상방에서 하중·안착 지점 주시
      px = hook[0] - c * 6;
      py = hook[1] + 5;
      pz = hook[2] - s * 6;
      this._lookTarget.set(hook[0], hook[1] - 1.5, hook[2]);
    }
    this._desired.set(px, py, pz);
    if (!this._snapped) {
      this.camera.position.copy(this._desired);
      this._look.copy(this._lookTarget);
      this._snapped = true;
    } else {
      this.camera.position.lerp(this._desired, 0.1);
      this._look.lerp(this._lookTarget, 0.14);
    }
    this.camera.lookAt(this._look);
  }
}
