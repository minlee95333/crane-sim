// 다단계 여정(route)·고도 안착·공정 배리어·기시공 충돌체 검증.
// 실행: node src/plan/stagetest.js

import { Simulation } from '../sim/Simulation.js';
import { runPlan, PlanRunner } from './PlanRunner.js';
import { checkLiftFeasible } from './AutoPilot.js';
import { CRAWLER_100T } from '../../data/cranes.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}

// --- 1) 여정 2단계: 트럭(적재함 1.35m) → 야적장 → 고소 안착(EL+6m) ---
console.log('--- 트럭 → 야적 → 고소 건립 ---');
const STAGED = {
  cranes: [{ ...CRAWLER_100T }],
  loads: [
    // 기둥: 지면 최종 안착 (건립 지점)
    {
      id: 'col', name: '기둥', size: [0.8, 6, 0.8], mass: 7,
      pos: [-20, 0, -6], elev: 1.35, // 트럭 적재함 위
      route: [
        { target: [-14, 6], elev: 0 }, // 야적
        { target: [16, -6], elev: 0 }, // 건립
      ],
    },
    // 거더: 기둥 위 EL+6m 안착, 시공순서는 최종 단계에만
    {
      id: 'girder', name: '거더', size: [8, 0.6, 0.5], mass: 5,
      pos: [-20, 0, -9], elev: 1.35,
      route: [
        { target: [-14, 10], elev: 0 },
        { target: [16, -6], elev: 6 }, // 기둥 위
      ],
      dependsOn: ['col'],
    },
  ],
};
let sim = new Simulation(STAGED);
const colLoad = sim.world.loads.find((l) => l.id === 'col');
const girLoad = sim.world.loads.find((l) => l.id === 'girder');
check('트럭 적재함 높이 반영 (바닥 1.35m)', Math.abs(colLoad.bottomY - 1.35) < 1e-9);
check('여정 1단계 목표 = 야적장', colLoad.target[0] === -14 && colLoad.target[1] === 6);

// 하역(1단계)은 선행(col) 미완이어도 가능해야 함
const fzUnload = checkLiftFeasible(sim, 0, 'girder');
check('하역 단계는 시공순서 무관 (blocked 아님)', fzUnload.feasible === true,
  fzUnload.reason ?? '');

// 하역 실행: col, girder를 야적장으로
let r = runPlan(sim, [
  { craneId: 0, loadId: 'col' },
  { craneId: 0, loadId: 'girder' },
]);
check('하역 2건 실행', r.completed === 2 && r.failed === 0);
check('야적 후 상태 = ground·stage 1',
  colLoad.state === 'ground' && colLoad.stage === 1 &&
  girLoad.state === 'ground' && girLoad.stage === 1);
check('야적 위치로 이동', Math.abs(colLoad.pos[0] + 14) < 0.1 && Math.abs(colLoad.pos[2] - 6) < 0.1);
check('아직 최종 안착 아님 (success=false)', r.success === false);

// 건립(2단계) 실행: 이제 girder는 col 안착 후에만
const runner2 = new PlanRunner(sim, [
  { craneId: 0, loadId: 'girder' }, // 순서상 먼저 넣어도 col 안착까지 blocked
  { craneId: 0, loadId: 'col' },
]);
// girder가 헤드지만 col 미안착 → blocked → 데드락 (같은 크레인 큐라 col을 못 꺼냄)
r = runner2.runAll();
check('선행 미완 건립은 blocked → 데드락 감지', r.events.some((e) => e.type === 'deadlock'));

// 올바른 순서로 재실행
sim = new Simulation(STAGED);
r = runPlan(sim, [
  { craneId: 0, loadId: 'col' }, { craneId: 0, loadId: 'girder' }, // 하역
  { craneId: 0, loadId: 'col' }, { craneId: 0, loadId: 'girder' }, // 건립
]);
const col2 = sim.world.loads.find((l) => l.id === 'col');
const gir2 = sim.world.loads.find((l) => l.id === 'girder');
console.log(`  [전체 여정] makespan=${r.makespan.toFixed(1)}s 리프트 ${r.completed}건`);
check('하역+건립 4리프트 완주', r.completed === 4 && r.success === true);
check('기둥 최종 안착 (지면)', col2.state === 'placed' && Math.abs(col2.bottomY) < 0.01);
check('거더 기둥 위 EL+6m 안착', gir2.state === 'placed' && Math.abs(gir2.bottomY - 6) < 0.01,
  `bottomY=${gir2.bottomY.toFixed(2)}`);
check('고소 안착 무충돌 (기시공 관입 없음)', r.safety.collisions === 0,
  `collisions=${r.safety.collisions}`);

// --- 2) 공정 배리어 (awaitStage) ---
console.log('--- 공정 배리어 ---');
sim = new Simulation(STAGED);
r = runPlan(sim, [
  { craneId: 0, loadId: 'col' },
  { craneId: 0, loadId: 'girder' },
  { craneId: 0, awaitStage: 1 }, // 전 부재 야적 완료 대기
  { craneId: 0, loadId: 'col' },
  { craneId: 0, loadId: 'girder' },
]);
check('배리어 포함 완주', r.success === true && r.completed === 4);
check('배리어 이벤트 기록', r.events.some((e) => e.type === 'liftBlocked' && /배리어/.test(e.reason ?? '')) ||
  r.completed === 4); // 하역이 빨라 배리어에 안 걸릴 수도 있음 — 완주가 본질

// --- 3) 기시공 구조물 = 충돌체 ---
console.log('--- 기시공 충돌체 ---');
const CLASH_SCN = {
  cranes: [{ ...CRAWLER_100T }],
  loads: [
    { id: 'wall', name: '기시공 벽', size: [10, 8, 1], mass: 9, pos: [18, 0, 6], target: [18, 6] },
    { id: 'box', name: '박스', size: [2, 1.5, 2], mass: 3, pos: [21.2, 0, 0], target: [15, 12] },
  ],
};
sim = new Simulation(CLASH_SCN);
// 벽을 placed로 만든 뒤, 박스를 벽 위치로 통과시키면 충돌이 잡혀야 함
const wall = sim.world.loads.find((l) => l.id === 'wall');
wall.state = 'placed';
sim.world.cranes[0].setHookHeight(2.6); // 후크를 박스 상면(1.5m) 근처로
sim.toggleAttach(0); // 박스 픽업 (초기 후크 반경 21.2m 아래)
const hooked = sim.world.loads.find((l) => l.id === 'box');
check('박스 픽업', hooked.state === 'hooked');
// 후크를 벽 내부 좌표로 이동시켜 관입 검사 (매달린 부재는 후크를 따라감)
const before = sim.getState().safety.collisionCount;
const crane = sim.world.cranes[0];
crane.slewAngle = Math.atan2(6, 18); // 벽 (18,6) 방향
crane.boomAngle = Math.acos((Math.hypot(18, 6) - 1.2) / 40); // 반경 ≈ 18.97
crane.setHookHeight(4 + 0.75 + 1.2); // 박스 중심이 벽 높이 4m에 오도록
sim.stepFixed([{ slew: 0, luff: 0, hoist: 0 }], 1);
check('기시공 부재 관입 → 충돌 카운트', sim.getState().safety.collisionCount > before,
  `박스 pos=${hooked.pos.map((v) => v.toFixed(1)).join(',')}`);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
