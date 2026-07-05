// 3층: 렌더 — 지상 에이전트 뷰(작업 인원·지게차). 코어 상태를 받아 표시만 한다.
// 위치·헤딩은 전부 코어(Agent) 산출 — 여기는 피규어·보행 모션·경광등 연출만.
import * as THREE from 'three';
import { workerFigure, contactShadow } from './parts.js';

const MAT = {
  body: new THREE.MeshStandardMaterial({ color: 0xd97b18, roughness: 0.55, metalness: 0.2 }), // 지게차 주황
  dark: new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.85 }),
  mast: new THREE.MeshStandardMaterial({ color: 0x54595f, roughness: 0.5, metalness: 0.4 }),
  fork: new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.4, metalness: 0.5 }),
  beacon: new THREE.MeshBasicMaterial({ color: 0xffb020 }),
};

function box(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true;
  return m;
}

/** 지게차 (전방 = +x, 코어 heading과 정렬) */
function forklift() {
  const g = new THREE.Group();
  const body = box(2.4, 1.0, 1.7, MAT.body);
  body.position.set(-0.5, 0.75, 0);
  g.add(body);
  const guard = box(1.1, 1.1, 1.5, MAT.dark); // 헤드가드 (오픈 캡 근사)
  guard.position.set(-0.5, 1.75, 0);
  g.add(guard);
  const counter = box(0.7, 0.8, 1.5, MAT.dark);
  counter.position.set(-1.7, 0.7, 0);
  g.add(counter);
  // 마스트 + 포크 (전방)
  for (const dz of [-0.45, 0.45]) {
    const rail = box(0.12, 2.1, 0.12, MAT.mast);
    rail.position.set(0.85, 1.15, dz);
    g.add(rail);
  }
  for (const dz of [-0.35, 0.35]) {
    const tine = box(1.0, 0.07, 0.16, MAT.fork);
    tine.position.set(1.55, 0.18, dz);
    g.add(tine);
  }
  // 바퀴 4
  for (const [dx, dz] of [[0.45, -0.8], [0.45, 0.8], [-1.25, -0.8], [-1.25, 0.8]]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.28, 12), MAT.dark);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(dx, 0.34, dz);
    wheel.castShadow = true;
    g.add(wheel);
  }
  // 경광등 (시간 점멸은 update에서)
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), MAT.beacon.clone());
  beacon.position.set(-0.5, 2.42, 0);
  g.add(beacon);
  g.userData.beacon = beacon;
  return g;
}

export class AgentView {
  /** @param {Array<Object>} agentStates world 상태의 agents */
  constructor(agentStates) {
    this.root = new THREE.Group();
    this.figures = new Map(); // id → { group, kind }
    agentStates.forEach((agent, i) => {
      const group = agent.kind === 'vehicle' ? forklift() : workerFigure(1000 + i * 13);
      if (agent.kind === 'worker') group.rotation.y = 0; // 헤딩이 지배 (시드 회전 제거)
      const shadow = contactShadow(agent.kind === 'vehicle' ? 2.2 : 0.7);
      group.add(shadow);
      this.figures.set(agent.id, { group, kind: agent.kind });
      this.root.add(group);
    });
  }

  /**
   * @param {Array<Object>} agentStates
   * @param {number} [time] 시뮬 시간 (보행 모션·경광등 — 결정론)
   */
  update(agentStates = [], time = null) {
    agentStates.forEach((agent, i) => {
      const fig = this.figures.get(agent.id);
      if (!fig) return;
      fig.group.position.set(agent.pos[0], 0, agent.pos[1]);
      // 코어 헤딩 [hx, hz] → three rotation.y (부호 반전 규약)
      fig.group.rotation.y = -Math.atan2(agent.heading[1], agent.heading[0]);
      if (fig.kind === 'worker') {
        // 보행 바운스 (이동 중일 때만, 시뮬 시간 결정론)
        const bob = agent.moving && time != null ? 1 + 0.045 * Math.sin(time * 9 + i * 2.1) : 1;
        fig.group.scale.y = bob;
      } else if (time != null) {
        fig.group.userData.beacon.visible = time % 0.9 < 0.5; // 경광등 점멸
      }
    });
  }
}
