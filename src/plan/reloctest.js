// 재배치(주행·셋업) 통합 검증: PlanRunner가 setupPos/boomLength 액션으로
// park→teardown→travel→setup 상태기계를 물리 실행 안에서 완주하는지.
// 실행: node src/plan/reloctest.js

import { Simulation } from '../sim/Simulation.js';
import { PlanRunner, runPlan, macroToPlan } from './PlanRunner.js';
import { generateMacroPlan } from './MacroPlanner.js';
import { CRAWLER_100T, TOWER_8T } from '../../data/cranes.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}
const count = (evts, type) => evts.filter((e) => e.type === type).length;

const MOVABLE_CRAWLER = {
  ...CRAWLER_100T,
  planning: { movable: true, travelSpeed: 1.5, setupTime: 120, teardownTime: 60 },
};

// --- 1) 단일 크레인 재배치: 초기 위치에서 도달 불가한 부재를 셋업 이동 후 양중 ---
console.log('--- 재배치 후 양중 ---');
// 부재가 x=80 부근 → 초기(0,0)에서 rMax 39.8m 밖. 셋업 [55,0]으로 이동하면 r=25 도달.
const FAR = {
  cranes: [MOVABLE_CRAWLER],
  loads: [
    { id: 'far-1', name: '원거리 부재', size: [3, 1, 2], mass: 6, pos: [80, 0, 0], target: [70, 15] },
  ],
};
let sim = new Simulation(FAR);
const noMove = runPlan(sim, [{ craneId: 0, loadId: 'far-1' }]);
check('재배치 없으면 실패 (도달 밖)', noMove.success === false && noMove.failed === 1);

sim = new Simulation(FAR);
let r = runPlan(sim, [{ craneId: 0, loadId: 'far-1', setupPos: [55, 0] }]);
const base = sim.world.cranes[0].basePos;
console.log(
  `  [재배치] makespan=${r.makespan.toFixed(1)}s base=(${base[0].toFixed(1)},${base[2].toFixed(1)}) ` +
    `travel=${r.cranes[0].travelDistance.toFixed(1)}m fuel=₩${Math.round(r.cost.fuel)}`,
);
check('재배치 후 양중 성공', r.success === true && r.completed === 1);
check('basePos가 실제로 이동', Math.abs(base[0] - 55) < 0.1 && Math.abs(base[2]) < 0.1);
check('주행 거리 ≈ 55m', Math.abs(r.cranes[0].travelDistance - 55) < 1);
check('재배치 이벤트 순서', count(r.events, 'relocateStart') === 1 &&
  count(r.events, 'travelStart') === 1 && count(r.events, 'setupStart') === 1 &&
  count(r.events, 'relocateEnd') === 1);
check('첫 재배치는 해체 생략 (미조립 규약)', count(r.events, 'teardownStart') === 0);
check('연료비 발생', r.cost.fuel > 0);
check('makespan에 주행·셋업 반영', r.makespan > 55 / 1.5 + 120, `${r.makespan.toFixed(1)}s`);

// 결정론
const r2 = runPlan(new Simulation(FAR), [{ craneId: 0, loadId: 'far-1', setupPos: [55, 0] }]);
check('결정론: 동일 steps', r.steps === r2.steps, `${r.steps} vs ${r2.steps}`);

// --- 2) 2회 재배치: 두 번째부터는 해체(teardown) 시간 포함 ---
console.log('--- 연속 재배치 ---');
const TWO_SITES = {
  cranes: [MOVABLE_CRAWLER],
  loads: [
    { id: 'L1', name: 'L1', size: [2, 1, 2], mass: 5, pos: [20, 0, 0], target: [15, 12] },
    { id: 'L2', name: 'L2', size: [2, 1, 2], mass: 5, pos: [90, 0, 0], target: [85, -12] },
  ],
};
sim = new Simulation(TWO_SITES);
r = runPlan(sim, [
  { craneId: 0, loadId: 'L1' }, // 초기 위치에서 가능
  { craneId: 0, loadId: 'L2', setupPos: [70, 0] }, // 이동 필요
]);
check('연속 작업 완주', r.success === true && r.completed === 2);
check('두 번째 재배치는 해체 포함', count(r.events, 'teardownStart') === 1);

// --- 3) 붐길이 교체 (이동 없이 setup만) ---
console.log('--- 붐 교체 ---');
// r=45 부재: 붐 40m(rMax 39.8) 불가 → 붐 52m(rMax 51.4)로 교체 필요
const LONG_REACH = {
  cranes: [MOVABLE_CRAWLER],
  loads: [
    { id: 'far-2', name: '장반경 부재', size: [2, 1, 2], mass: 2, pos: [45, 0, 0], target: [40, 20] },
  ],
};
sim = new Simulation(LONG_REACH);
r = runPlan(sim, [{ craneId: 0, loadId: 'far-2', boomLength: 52 }]);
check('붐 52m 교체 후 양중 성공', r.success === true, r.events.map((e) => e.type).join(','));
check('붐길이 적용', sim.world.cranes[0].boomLength === 52);
check('이동 없음 (주행거리 0)', r.cranes[0].travelDistance === 0);

// --- 4) 고정식(타워) 재배치 거부 ---
console.log('--- 타워 고정 ---');
const TOWER_SITE = {
  cranes: [TOWER_8T],
  loads: [
    { id: 'T1', name: 'T1', size: [2, 1, 2], mass: 2, pos: [60, 0, 0], target: [55, 10] },
  ],
};
r = runPlan(new Simulation(TOWER_SITE), [{ craneId: 0, loadId: 'T1', setupPos: [40, 0] }]);
check('타워 재배치 → 영구 실패', r.success === false && r.failed === 1);
check('사유: 고정식', r.events.some((e) => e.type === 'liftFailed' && /고정식/.test(e.reason)));

// --- 5) 주행 경로: 금지구역 우회 ---
console.log('--- 경로 우회 ---');
const DETOUR = {
  cranes: [MOVABLE_CRAWLER],
  loads: [
    { id: 'D1', name: 'D1', size: [2, 1, 2], mass: 5, pos: [80, 0, 0], target: [70, 12] },
  ],
  noFlyZones: [{ id: 'block', min: [20, -15], max: [35, 15] }], // 직선 경로를 막는 구역
};
sim = new Simulation(DETOUR);
r = runPlan(sim, [{ craneId: 0, loadId: 'D1', setupPos: [55, 0] }]);
check('우회 완주', r.success === true);
check('우회로 주행거리 > 직선 55m', r.cranes[0].travelDistance > 56,
  `${r.cranes[0].travelDistance.toFixed(1)}m`);

// --- 6) macroToPlan 변환 ---
console.log('--- macroToPlan ---');
const MACRO_SCN = {
  site: { width: 200, depth: 120, minX: -100, minZ: -60 },
  cranes: [{ ...MOVABLE_CRAWLER, id: 'MC-01', basePos: [-40, 0, 0] }],
  loads: [
    { id: 'M1', name: 'M1', size: [2, 1, 2], mass: 5, pos: [-20, 0, 0], target: [-15, 10], duration: 300 },
  ],
  planning: { defaultLiftDuration: 300 },
};
const macro = generateMacroPlan(MACRO_SCN);
const plan = macroToPlan(MACRO_SCN, macro);
check('macro → plan 변환', plan.length === macro.assignments.length && plan[0].craneId === 0);
check('setupPos 포함', Array.isArray(plan[0].setupPos) && plan[0].setupPos.length === 2);
r = runPlan(new Simulation(MACRO_SCN), plan);
check('macro 계획 물리 실행 성공', r.success === true, JSON.stringify(r.events.filter((e) => e.type === 'liftFailed')));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
