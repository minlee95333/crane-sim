// P2 검증: PlanRunner가 다중 양중 계획을 병렬 실행하고
// 타임라인·makespan·비용·간섭 대기를 올바르게 산출하는지.
// 실행: node src/plan/plantest.js

import { Simulation } from '../sim/Simulation.js';
import { PlanRunner, runPlan, autoPlan } from './PlanRunner.js';
import { SCENARIOS } from '../../data/scenarios.js';
import { CRAWLER_100T } from '../../data/cranes.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}
const byId = (id) => SCENARIOS.find((s) => s.id === id).scenario;
const count = (evts, type) => evts.filter((e) => e.type === type).length;

// --- 1) S6 협동 현장 — 2대 병렬 실행 ---
console.log('--- S6 병렬 실행 ---');
const PLAN_S6 = [
  { craneId: 0, loadId: 'tank-1' },
  { craneId: 1, loadId: 'duct-1' },
];
let sim = new Simulation(byId('dual-site'));
let r = runPlan(sim, PLAN_S6);
console.log(
  `  [S6] makespan=${r.makespan.toFixed(1)}s completed=${r.completed} ` +
    `cost=₩${Math.round(r.cost.total).toLocaleString()} (rental ${Math.round(r.cost.rental)}, idle ${Math.round(r.cost.idle)})`,
);
check('계획 성공 (전건 안착)', r.success === true);
check('완료 2건 / 실패 0건', r.completed === 2 && r.failed === 0);
// P1 단독 실행: 크롤러 86.1s + 타워 123.5s = 209.6s 순차 → 병렬이면 대폭 단축
check('병렬 효과: makespan < 순차합의 75%', r.makespan < 209.6 * 0.75, `${r.makespan.toFixed(1)}s`);
check('liftStart/End 각 2회', count(r.events, 'liftStart') === 2 && count(r.events, 'liftEnd') === 2);
check('무충돌·무침범', r.safety.collisions === 0 && r.safety.violations === 0);

// --- 2) 비용 모델 ---
console.log('--- 비용 모델 ---');
check('총비용 > 0 (KRW)', r.cost.total > 0 && r.cost.currency === 'KRW');
const crane0 = r.cranes[0];
check('먼저 끝난 크레인에 유휴 발생', crane0.idleTime > 10, `idle=${crane0.idleTime.toFixed(1)}s`);
check('비용 = 임대 + 유휴', Math.abs(r.cost.total - (r.cost.rental + r.cost.idle)) < 1e-6);
check('busy+idle = makespan (크레인0)', Math.abs(crane0.busyTime + crane0.idleTime - r.makespan) < 1e-6);

// --- 3) 결정론 ---
const r2 = runPlan(new Simulation(byId('dual-site')), PLAN_S6);
check('결정론: 동일 계획 → 동일 steps', r.steps === r2.steps, `${r.steps} vs ${r2.steps}`);

// --- 4) S4 단일 크레인 순차 큐 (흔들림 ON) ---
console.log('--- S4 순차 큐 ---');
sim = new Simulation(byId('relay-sway'));
r = runPlan(sim, [
  { craneId: 0, loadId: 'pc-slab-1' },
  { craneId: 0, loadId: 'pipe-1' },
]);
console.log(`  [S4] makespan=${r.makespan.toFixed(1)}s completed=${r.completed}`);
check('순차 2건 완료', r.success === true && r.completed === 2);
check('makespan ≈ 두 사이클 합 (120~250s)', r.makespan > 120 && r.makespan < 250);

// --- 5) autoPlan 베이스라인 생성기 ---
console.log('--- autoPlan ---');
sim = new Simulation(byId('dual-site'));
const plan = autoPlan(sim);
check('S6 자동 배정 2건', plan.length === 2, JSON.stringify(plan));
// 타당성 필터: 탱크 14t는 타워(지브끝 2.6t) 불가 → 크레인0, 덕트는 크롤러 도달범위 밖 → 크레인1
check('탱크→크롤러(0), 덕트→타워(1)',
  plan.find((a) => a.loadId === 'tank-1')?.craneId === 0 &&
  plan.find((a) => a.loadId === 'duct-1')?.craneId === 1);
r = runPlan(sim, plan);
check('autoPlan 실행 성공', r.success === true);

// --- 6) 간섭 대기 규칙 ---
console.log('--- 간섭 대기 ---');
// 두 크롤러가 같은 중앙 구역에서 동시 작업 → 후크 이격 8m 미만 → 크레인1 대기
const INTERFERENCE = {
  cranes: [
    { ...CRAWLER_100T, basePos: [-15, 0, 0] },
    { ...CRAWLER_100T, basePos: [15, 0, 0], initial: { ...CRAWLER_100T.initial, slewAngle: Math.PI } },
  ],
  loads: [
    { id: 'A', name: 'A', size: [2, 1, 2], mass: 5, pos: [3, 0, 0], target: [-3.43, -13.79] },
    { id: 'B', name: 'B', size: [2, 1, 2], mass: 5, pos: [-2, 0, 5], target: [1.44, 11.38] },
  ],
};
sim = new Simulation(INTERFERENCE);
const runner = new PlanRunner(sim, [
  { craneId: 0, loadId: 'A' },
  { craneId: 1, loadId: 'B' },
]);
r = runner.runAll();
const wait1 = r.cranes[1].waitTime;
console.log(`  [간섭] makespan=${r.makespan.toFixed(1)}s crane1 wait=${wait1.toFixed(1)}s waitEvents=${count(r.events, 'waitStart')}`);
check('간섭 시 크레인1 대기 발생', wait1 > 1, `wait=${wait1.toFixed(1)}s`);
check('대기 이벤트 기록', count(r.events, 'waitStart') >= 1 && count(r.events, 'waitEnd') >= 1);
check('대기 후 데드락 없이 완주', r.success === true && r.completed === 2);

// --- 7) 타당성 탈락 스킵 (같은 크레인 큐 계속 진행) ---
console.log('--- infeasible 스킵 ---');
sim = new Simulation({
  cranes: [CRAWLER_100T],
  loads: [
    { id: 'heavy', name: '초과중량', size: [4, 3, 4], mass: 50, pos: [21.2, 0, 0], target: [10, 15] },
    { id: 'light', name: '경량', size: [2, 1, 2], mass: 5, pos: [18, 0, 5], target: [10, -12] },
  ],
});
r = runPlan(sim, [
  { craneId: 0, loadId: 'heavy' },
  { craneId: 0, loadId: 'light' },
]);
check('탈락 1건 기록 + 다음 건 진행', r.failed === 1 && r.completed === 1);
check('탈락 사유 이벤트(infeasible)', r.events.some((e) => e.type === 'liftFailed' && e.infeasible === true));
check('전건 성공은 아님 (success=false)', r.success === false);
check('경량 부재는 안착됨', sim.world.loads.find((l) => l.id === 'light').state === 'placed');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
