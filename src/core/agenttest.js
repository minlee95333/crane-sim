// 코어: 지상 에이전트(인원 배회·차량 순환)와 홀드 규칙 테스트 (P7.10).
// 보증: (1) 시드 결정론, (2) 영역·장애물 준수, (3) 홀드가 크레인을 실제로 동결·해제,
// (4) 차량이 루트를 돌고 크레인 앞에서 대기, (5) agents 미정의 시나리오 완전 불변.
import { World } from './World.js';
import { MobileCrane } from './MobileCrane.js';
import { Agent, buildAgents } from './Agent.js';
import { CRAWLER_100T } from '../../data/cranes.js';

const DT = 1 / 60;

function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

const GIRDER = { id: 'g1', name: '거더', size: [8, 0.5, 0.5], mass: 5, pos: [21.2, 0, 0] };

function attachNow(world) {
  world.cranes[0].setHookHeight(world.loads[0].topY + 1);
  const res = world.toggleAttach(0);
  if (!res.ok) throw new Error(`픽업 실패: ${res.msg}`);
}

/** 시나리오 데이터에서 에이전트 월드 구성 */
function makeWorld({ agents, loads = [], obstacles = [], crane = true, cranePos } = {}) {
  const world = new World();
  if (crane) {
    const spec = cranePos ? { ...CRAWLER_100T, basePos: cranePos } : { ...CRAWLER_100T };
    world.addCrane(new MobileCrane(spec));
  }
  for (const def of loads) world.addLoad(def);
  for (const def of obstacles) world.addObstacle(def);
  if (agents) {
    const built = buildAgents({ agents, site: { width: 90, depth: 56, minX: -45, minZ: -28 } });
    for (const agent of built.agents) world.addAgent(agent);
    world.setAgentRules(built.rules);
  }
  return world;
}

const WANDER = {
  seed: 777,
  workers: [{ count: 4, area: { min: [-30, -20], max: [30, 20] }, speed: [0.9, 1.4], idle: [1, 3] }],
  vehicles: [{ route: [[-20, 10], [20, 10], [20, -10], [-20, -10]], speed: 3 }],
};

// ── 1. 시드 결정론: 같은 시드 = 같은 궤적, 다른 시드 = 다른 궤적 ─────────
console.log('--- 시드 결정론 ---');
{
  const a = makeWorld({ agents: WANDER, crane: false });
  const b = makeWorld({ agents: WANDER, crane: false });
  for (let i = 0; i < 3000; i++) {
    a.step(DT, []);
    b.step(DT, []);
  }
  check(
    '같은 시드: 3000스텝 후 전 에이전트 위치 비트 동일',
    a.agents.every((ag, i) => ag.pos[0] === b.agents[i].pos[0] && ag.pos[1] === b.agents[i].pos[1]),
  );
  const c = makeWorld({ agents: { ...WANDER, seed: 778 }, crane: false });
  for (let i = 0; i < 3000; i++) c.step(DT, []);
  check(
    '다른 시드: 작업자 궤적이 달라짐',
    a.agents.some((ag, i) => c.agents[i].kind === 'worker' &&
      Math.hypot(ag.pos[0] - c.agents[i].pos[0], ag.pos[1] - c.agents[i].pos[1]) > 0.5),
  );
}

// ── 2. 영역·장애물 준수 ─────────────────────────────────────────────
console.log('--- 배회 영역·장애물 준수 ---');
{
  const shed = { id: 'shed', pos: [0, 0, 0], size: [8, 5, 8] };
  const world = makeWorld({ agents: WANDER, obstacles: [shed], crane: false });
  let inBounds = true;
  let clearOfShed = true;
  for (let i = 0; i < 6000; i++) {
    world.step(DT, []);
    if (i < 600) continue; // 워밍업 (초기 스폰은 월드를 모른 채 샘플)
    for (const ag of world.agents) {
      if (ag.kind !== 'worker') continue;
      if (ag.pos[0] < -30.6 || ag.pos[0] > 30.6 || ag.pos[1] < -20.6 || ag.pos[1] > 20.6) inBounds = false;
      if (Math.abs(ag.pos[0]) < 4.2 && Math.abs(ag.pos[1]) < 4.2) clearOfShed = false;
    }
  }
  check('작업자가 지정 영역을 벗어나지 않음 (100s)', inBounds);
  check('작업자가 구조물 발밑으로 걸어들어가지 않음', clearOfShed);
}

// ── 3. 홀드: 위험 반경 내 인원 → 크레인 동결, 인원 없으면 정상 ─────────
console.log('--- 접근 홀드 (신호수 규칙) ---');
{
  // 작업자 4명의 활동 영역을 매달린 부재(21.2, 0) 바로 밑 4×4m로 고정 → 상시 홀드
  const nearAgents = {
    seed: 5,
    dangerRadius: 6,
    workers: [{ count: 4, area: { min: [19.2, -2], max: [23.2, 2] }, idle: [0.5, 1.5] }],
  };
  const held = makeWorld({ agents: nearAgents, loads: [{ ...GIRDER }] });
  attachNow(held);
  for (let i = 0; i < 600; i++) held.step(DT, [{ slew: 1, hoist: 1 }]);
  check('위험 반경 내 인원 → 선회·권상 동결 (10s간 0°)', held.cranes[0].slewAngle === 0);
  check('홀드 진입 카운트 기록', held.agentHoldCount >= 1);
  check(`홀드 누적 시간 집계 (${held.agentHoldTime.toFixed(1)}s)`, held.agentHoldTime > 9);

  const farAgents = {
    seed: 5,
    dangerRadius: 6,
    workers: [{ count: 4, area: { min: [-40, -24], max: [-30, -16] }, idle: [0.5, 1.5] }],
  };
  const free = makeWorld({ agents: farAgents, loads: [{ ...GIRDER }] });
  attachNow(free);
  for (let i = 0; i < 600; i++) free.step(DT, [{ slew: 1, hoist: 1 }]);
  check('반경 밖 인원 → 정상 작업 (선회 진행)', free.cranes[0].slewAngle > 0.1);
  check('홀드 미발생', free.agentHoldCount === 0 && free.agentHoldTime === 0);
}

// ── 4. 차량: 순환 루트 완주 + 크레인 앞 정지 대기 ────────────────────
console.log('--- 차량 순환·대기 ---');
{
  const world = makeWorld({ agents: { seed: 9, vehicles: WANDER.vehicles }, crane: false });
  const vehicle = world.agents[0];
  const corners = WANDER.vehicles[0].route;
  const best = corners.map(() => Infinity);
  for (let i = 0; i < 60 * 60; i++) {
    world.step(DT, []);
    corners.forEach((c, k) => {
      best[k] = Math.min(best[k], Math.hypot(vehicle.pos[0] - c[0], vehicle.pos[1] - c[1]));
    });
  }
  check('차량이 60s 동안 루트 4코너를 모두 경유', best.every((d) => d < 2));

  const blocked = makeWorld({
    agents: { seed: 9, vehicles: WANDER.vehicles },
    cranePos: [0, 0, 10], // 상단 도로(z=10) 위에 크레인 주기 — 차량이 앞에서 대기해야 함
  });
  const bv = blocked.agents[0];
  for (let i = 0; i < 60 * 60; i++) blocked.step(DT, []);
  const gap = Math.hypot(bv.pos[0] - 0, bv.pos[1] - 10);
  check(
    `루트를 막은 크레인 앞에서 정지 대기 (이격 ${gap.toFixed(1)}m, waiting=${bv.waiting})`,
    bv.waiting === true && gap > 3.5 && gap < 12,
  );
}

// ── 5. 미정의 회귀: agents 없는 시나리오는 에이전트 0·상태 필드 기본값 ──
console.log('--- 미정의 회귀 ---');
{
  const world = makeWorld({ loads: [{ ...GIRDER }] });
  attachNow(world);
  for (let i = 0; i < 300; i++) world.step(DT, [{ slew: 1 }]);
  const state = world.getState();
  check('agents 미정의 → 에이전트 0·홀드 0·선회 정상', state.agents.length === 0 &&
    state.safety.agentHoldCount === 0 && world.cranes[0].slewAngle > 0);
}

// ── 6. Agent 클래스 직접: 차량 obstacle AABB가 헤딩을 따라 회전 ────────
console.log('--- 차량 충돌체 ---');
{
  const v = new Agent({ id: 'v', kind: 'vehicle', route: [[0, 0], [10, 0]], size: [2, 2, 5] }, 1);
  v.heading = [1, 0]; // +x 진행 → 길이 5가 x축
  const obX = v.obstacle();
  v.heading = [0, 1]; // +z 진행 → 길이 5가 z축
  const obZ = v.obstacle();
  check('차량 AABB가 진행 방향으로 정렬', obX.size[0] === 5 && obX.size[2] === 2 &&
    obZ.size[0] === 2 && obZ.size[2] === 5);
}

console.log('\nALL PASS');
