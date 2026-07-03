// 3층: 렌더 — 현장 환경 뷰(목표 지점·장애물·인양 금지구역).
// world 상태의 loads[].target / obstacles / noFlyZones를 받아 표시만 한다.
import * as THREE from 'three';
import { truckMotionAt } from '../core/TruckMotion.js';

const MAT = {
  targetFill: new THREE.MeshBasicMaterial({
    color: 0x35c26a,
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),
  targetRing: new THREE.MeshBasicMaterial({ color: 0x35c26a, side: THREE.DoubleSide }),
  targetDone: new THREE.MeshBasicMaterial({
    color: 0x4a7fb5,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),
  obstacle: new THREE.MeshStandardMaterial({ color: 0x6f7680, roughness: 0.85 }),
  obstacleEdge: new THREE.LineBasicMaterial({ color: 0x3a3f46 }),
  nfzFill: new THREE.MeshBasicMaterial({
    color: 0xd8402a,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),
  nfzEdge: new THREE.LineBasicMaterial({ color: 0xd8402a }),
};

const PLACE_TOL_VIS = 1.5; // World.PLACE_TOL과 동일 (표시용 반경)
const TRUCK_ENTRY_DURATION = 30;
const TRUCK_EXIT_DURATION = 30;
const TRUCK_TRAVEL_DISTANCE = 26;
const TRUCK_MAX_ACCELERATION = 0.3;
const TRUCK_WHEEL_RADIUS = 0.55;
const TRUCK_PITCH_GAIN = 0.08;

export class SiteView {
  /** @param {Object} state world.getState() — loads/obstacles/noFlyZones 사용 */
  constructor(state, scenario = {}) {
    this.root = new THREE.Group();
    this.targets = new Map(); // loadId → { fill, ring }
    this.trucks = [];
    this.cargoOffsets = new Map();
    this.#addLogisticsSite(scenario);

    // --- 목표 지점: 안착 허용 반경 원 + 링 ---
    for (const l of state.loads) {
      if (!l.target) continue;
      const [tx, tz] = l.target;

      const fill = new THREE.Mesh(new THREE.CircleGeometry(PLACE_TOL_VIS, 40), MAT.targetFill);
      fill.rotation.x = -Math.PI / 2;
      fill.position.set(tx, 0.03, tz);
      this.root.add(fill);

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(PLACE_TOL_VIS - 0.12, PLACE_TOL_VIS, 48),
        MAT.targetRing,
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(tx, 0.04, tz);
      this.root.add(ring);

      this.targets.set(l.id, { fill, ring });
    }

    // --- 장애물: 회색 박스 + 윤곽선 ---
    for (const ob of state.obstacles ?? []) {
      const [w, h, d] = ob.size;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), MAT.obstacle);
      mesh.position.set(ob.pos[0], h / 2, ob.pos[2]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry),
        MAT.obstacleEdge,
      );
      edges.position.copy(mesh.position);
      this.root.add(edges);
    }

    // --- 인양 금지구역: 바닥 붉은 영역 + 테두리 ---
    for (const z of state.noFlyZones ?? []) {
      const w = z.max[0] - z.min[0];
      const d = z.max[1] - z.min[1];
      const cx = (z.min[0] + z.max[0]) / 2;
      const cz = (z.min[1] + z.max[1]) / 2;

      const fill = new THREE.Mesh(new THREE.PlaneGeometry(w, d), MAT.nfzFill);
      fill.rotation.x = -Math.PI / 2;
      fill.position.set(cx, 0.02, cz);
      this.root.add(fill);

      const border = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(z.min[0], 0.05, z.min[1]),
          new THREE.Vector3(z.max[0], 0.05, z.min[1]),
          new THREE.Vector3(z.max[0], 0.05, z.max[1]),
          new THREE.Vector3(z.min[0], 0.05, z.max[1]),
        ]),
        MAT.nfzEdge,
      );
      this.root.add(border);
    }
  }

  /** 안착 완료된 목표는 파란색으로 전환 */
  update(state) {
    this.cargoOffsets.clear();
    for (const l of state.loads) {
      const t = this.targets.get(l.id);
      if (!t) continue;
      const leg = l.route?.[l.stage];
      const target = leg?.target ?? l.target;
      const elev = leg?.elev ?? l.targetElev ?? 0;
      if (target) {
        t.fill.position.set(target[0], elev + 0.03, target[1]);
        t.ring.position.set(target[0], elev + 0.04, target[1]);
      }
      if (l.state === 'placed' && t.fill.material !== MAT.targetDone) {
        t.fill.material = MAT.targetDone;
        t.ring.material = MAT.targetDone;
      }
    }
    const loadById = new Map(state.loads.map((load) => [load.id, load]));
    for (const delivery of this.trucks) {
      const loads = delivery.loadIds.map((id) => loadById.get(id)).filter(Boolean);
      const entryStart = delivery.arriveTime - TRUCK_ENTRY_DURATION;
      const exitStart = loads.length > 0 && loads.every((load) => load.stage > 0)
        ? Math.max(...loads.map((load) => load.yardedAt ?? state.time))
        : null;
      let offsetZ = 0;
      let wheelDistance = 0;
      let worldAcceleration = 0;
      if (state.time < entryStart) {
        delivery.root.visible = false;
      } else if (state.time < delivery.arriveTime) {
        const motion = truckMotionAt(state.time - entryStart, {
          distance: TRUCK_TRAVEL_DISTANCE,
          duration: TRUCK_ENTRY_DURATION,
          maxAcceleration: TRUCK_MAX_ACCELERATION,
        });
        offsetZ = -delivery.travelDirection * (TRUCK_TRAVEL_DISTANCE - motion.position);
        wheelDistance = motion.position;
        worldAcceleration = delivery.travelDirection * motion.acceleration;
        delivery.root.visible = true;
      } else if (exitStart == null || state.time < exitStart) {
        wheelDistance = TRUCK_TRAVEL_DISTANCE;
        delivery.root.visible = true;
      } else if (state.time < exitStart + TRUCK_EXIT_DURATION) {
        const motion = truckMotionAt(state.time - exitStart, {
          distance: TRUCK_TRAVEL_DISTANCE,
          duration: TRUCK_EXIT_DURATION,
          maxAcceleration: TRUCK_MAX_ACCELERATION,
        });
        offsetZ = -delivery.travelDirection * motion.position;
        wheelDistance = TRUCK_TRAVEL_DISTANCE - motion.position;
        worldAcceleration = -delivery.travelDirection * motion.acceleration;
        delivery.root.visible = true;
      } else {
        delivery.root.visible = false;
      }
      delivery.root.position.set(delivery.bayX, 0, delivery.bayZ + offsetZ);
      delivery.chassis.rotation.x = -worldAcceleration * TRUCK_PITCH_GAIN;
      for (const wheel of delivery.wheels) {
        wheel.rotation.x = (wheelDistance / TRUCK_WHEEL_RADIUS) * delivery.travelDirection;
      }
      if (state.time >= entryStart && state.time < delivery.arriveTime) {
        for (const load of loads) {
          this.cargoOffsets.set(load.id, [0, 0, offsetZ]);
        }
      }
    }
    return this.cargoOffsets;
  }

  #addLogisticsSite(scenario) {
    if (!scenario.loads?.some((load) => (load.route?.length ?? 0) > 1)) return;

    const yard = new THREE.Group();
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(18, 0.15, 30),
      new THREE.MeshStandardMaterial({ color: 0x716b5f, roughness: 0.95 }),
    );
    slab.position.set(-21, 0.075, 0);
    slab.receiveShadow = true;
    yard.add(slab);
    const stripeMat = new THREE.MeshBasicMaterial({ color: 0xe0b84f });
    for (const x of [-29.5, -21, -12.5]) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 30), stripeMat);
      stripe.position.set(x, 0.17, 0);
      yard.add(stripe);
    }
    this.root.add(yard);

    const truckMat = new THREE.MeshStandardMaterial({ color: 0x315f86, roughness: 0.55 });
    const trailerMat = new THREE.MeshStandardMaterial({ color: 0x9da4a8, metalness: 0.35 });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x17191b, roughness: 0.9 });
    const deliveries = new Map();
    for (const load of scenario.loads) {
      const arriveTime = load.arriveTime ?? 0;
      if (!deliveries.has(arriveTime)) deliveries.set(arriveTime, []);
      deliveries.get(arriveTime).push(load);
    }
    for (const [arriveTime, loads] of deliveries) {
      const xs = loads.map((load) => load.pos[0]);
      const zs = loads.map((load) => load.pos[2]);
      const bayX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
      const zMin = Math.min(...loads.map((load) => load.pos[2] - load.size[2] / 2));
      const zMax = Math.max(...loads.map((load) => load.pos[2] + load.size[2] / 2));
      const z = (zMin + zMax) / 2;
      const trailerLength = Math.max(7, zMax - zMin + 1);
      const travelDirection = z >= 0 ? -1 : 1;
      const truck = new THREE.Group();
      const chassis = new THREE.Group();
      const wheels = [];
      const trailer = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.15, trailerLength), trailerMat);
      trailer.position.set(0, 0.78, 0);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(3.2, 3, 3.5), truckMat);
      cab.position.set(0, 1.5, travelDirection * (trailerLength / 2 + 2));
      chassis.add(trailer, cab);
      truck.add(chassis);
      for (const dz of [
        travelDirection * (trailerLength / 2 + 1.2),
        -trailerLength / 3,
        trailerLength / 3,
      ]) {
        for (const dx of [-1.65, 1.65]) {
          const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.35, 16), tireMat);
          wheel.rotation.z = Math.PI / 2;
          wheel.position.set(dx, 0.55, dz);
          truck.add(wheel);
          wheels.push(wheel);
        }
      }
      truck.position.set(bayX, 0, z);
      truck.visible = arriveTime === 0;
      this.root.add(truck);
      this.trucks.push({
        root: truck,
        loadIds: loads.map((load) => load.id),
        arriveTime,
        bayX,
        bayZ: z,
        travelDirection,
        chassis,
        wheels,
      });
    }

    const footprint = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(10, 0.12, 14)),
      new THREE.LineBasicMaterial({ color: 0xf0c84b }),
    );
    footprint.position.set(16, 0.08, 0);
    this.root.add(footprint);
  }
}
