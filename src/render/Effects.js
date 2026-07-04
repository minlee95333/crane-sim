// 3층: 렌더 — 이펙트(먼지 퍼프). 상태를 관찰해 표시만 하고 상태를 변경하지 않는다.
//
// 결정론 원칙: 발생 시점은 시뮬 시간·상태 전이에서만 유도 (프레임 dt·전역 난수 없음).
// 입자 오프셋은 발생 시각으로 시드된 PRNG — 같은 리플레이는 같은 먼지를 낸다.
import * as THREE from 'three';
import { seededRandom } from './parts.js';

const PUFF_LIFE = 1.1; // s
const MAX_PUFFS = 18;
const N_PARTICLES = 26;
const DRIVE_EMIT_EVERY = 0.22; // 주행 먼지 방출 주기 (시뮬 시간 양자화)

export class Effects {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;
    this.pool = [];
    this.active = [];
    this._prevLoadState = new Map();
    this._driveQuantum = new Map(); // craneIdx → 마지막 방출 양자
    for (let i = 0; i < MAX_PUFFS; i++) this.pool.push(this.#makePuff());
  }

  #makePuff() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N_PARTICLES * 3), 3));
    const mat = new THREE.PointsMaterial({
      color: 0xb9ab8e,
      size: 0.8,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.visible = false;
    points.frustumCulled = false; // 입자 확장 중 컬링 팝 방지 (수량 적음)
    this.scene.add(points);
    return { points, born: 0, base: [0, 0, 0], dirs: new Float32Array(N_PARTICLES * 3), strength: 1 };
  }

  /** 퍼프 발생 — 발생 시각·위치로 완전 결정 */
  #spawn(pos, time, strength = 1) {
    const puff = this.pool.pop() ?? this.active.shift(); // 고갈 시 가장 오래된 것 재사용
    if (!puff) return;
    puff.born = time;
    puff.base = [...pos];
    puff.strength = strength;
    const rand = seededRandom(Math.floor(time * 997) + Math.floor(pos[0] * 13 + pos[2] * 7));
    for (let i = 0; i < N_PARTICLES; i++) {
      const ang = rand() * Math.PI * 2;
      const r = 0.3 + rand() * 0.7;
      puff.dirs[i * 3] = Math.cos(ang) * r;
      puff.dirs[i * 3 + 1] = 0.15 + rand() * 0.55;
      puff.dirs[i * 3 + 2] = Math.sin(ang) * r;
    }
    puff.points.visible = true;
    this.active.push(puff);
  }

  /**
   * 상태 관찰 → 전이 이벤트에서 먼지 발생 + 활성 퍼프 수명 진행.
   * @param {Object} state world.getState() (시뮬·계획 재생 공용)
   */
  update(state) {
    const t = state.time;

    // 부재 전이: 안착(크게)·픽업 이탈(작게)
    for (const l of state.loads ?? []) {
      const prev = this._prevLoadState.get(l.id);
      if (prev && prev !== l.state) {
        const bottom = [l.pos[0], Math.max(l.pos[1] - l.size[1] / 2, 0.05), l.pos[2]];
        if ((prev === 'hooked' || prev === 'derigging') && (l.state === 'ground' || l.state === 'placed')) {
          this.#spawn(bottom, t, 1.3);
        } else if (prev === 'rigging' && l.state === 'hooked') {
          this.#spawn([bottom[0], 0.05, bottom[2]], t, 0.6);
        }
      }
      this._prevLoadState.set(l.id, l.state);
    }

    // 주행 먼지: 트랙 뒤 (시뮬 시간 양자화 → 결정론·리플레이 일치)
    (state.cranes ?? []).forEach((c, i) => {
      const v = c.extra?.driveVel ?? 0;
      if (Math.abs(v) < 0.25) return;
      const q = Math.floor(t / DRIVE_EMIT_EVERY);
      if (this._driveQuantum.get(i) === q) return;
      this._driveQuantum.set(i, q);
      const yaw = c.extra?.driveYaw ?? 0;
      const back = -Math.sign(v) * 3.2;
      this.#spawn(
        [c.basePos[0] + Math.cos(yaw) * back, 0.05, c.basePos[2] + Math.sin(yaw) * back],
        t,
        0.5 + Math.min(Math.abs(v) * 0.3, 0.5),
      );
    });

    // 수명 진행 (시간 역행 = 리셋·되감기 → 즉시 회수)
    for (let k = this.active.length - 1; k >= 0; k--) {
      const puff = this.active[k];
      const age = t - puff.born;
      if (age < 0 || age > PUFF_LIFE) {
        puff.points.visible = false;
        this.active.splice(k, 1);
        this.pool.push(puff);
        continue;
      }
      const u = age / PUFF_LIFE;
      const spread = (0.6 + u * 2.2) * puff.strength;
      const attr = puff.points.geometry.getAttribute('position');
      for (let i = 0; i < N_PARTICLES; i++) {
        attr.array[i * 3] = puff.base[0] + puff.dirs[i * 3] * spread;
        attr.array[i * 3 + 1] = puff.base[1] + puff.dirs[i * 3 + 1] * spread * 0.8;
        attr.array[i * 3 + 2] = puff.base[2] + puff.dirs[i * 3 + 2] * spread;
      }
      attr.needsUpdate = true;
      puff.points.material.opacity = 0.42 * (1 - u) * (1 - u);
      puff.points.material.size = 0.6 + u * 1.3;
    }
  }

  /** 씬에서 전부 제거 (시나리오 전환 시) */
  dispose() {
    for (const puff of [...this.active, ...this.pool]) this.scene.remove(puff.points);
    this.active = [];
    this.pool = [];
  }
}
