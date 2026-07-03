// P3 검증: 리깅/해체 상태기계·시험인양·크리프·노무비.
// 실행: node src/plan/rigtest.js

import { Simulation } from '../sim/Simulation.js';
import { runLift } from './AutoPilot.js';
import { runPlan } from './PlanRunner.js';
import { SCENARIOS } from '../../data/scenarios.js';
import { CRAWLER_100T } from '../../data/cranes.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}
const byId = (id) => SCENARIOS.find((s) => s.id === id).scenario;

// --- 1) 코어: 리깅 상태기계 ---
console.log('--- 코어 리깅 상태기계 ---');
const CORE = {
  cranes: [CRAWLER_100T],
  loads: [
    // 목표 = 현재 위치 → 이동 없이 줄걸이/해체만 검증
    { id: 'p1', name: '배관', size: [4, 0.6, 0.6], mass: 8, pos: [21.2, 0, 0], target: [21.2, 0], rigTime: 10, derigTime: 5 },
  ],
};
let sim = new Simulation(CORE);
sim.stepFixed([{ hoist: -1 }], 1800); // 30초 권하 → 후크가 부재 근처
let r = sim.toggleAttach(0);
check('줄걸이 시작 (pending)', r.ok === true && r.pending === true, r.msg);
let l = sim.getState().loads[0];
check('상태 = rigging, 아직 미인양', l.state === 'rigging' && sim.getState().cranes[0].loadMass === 0);

// 작업 중 크레인 동결
const slewBefore = sim.getState().cranes[0].slewAngle;
sim.stepFixed([{ slew: 1 }], 300); // 5초 선회 시도
check('리깅 중 크레인 조작 동결', sim.getState().cranes[0].slewAngle === slewBefore);
check('리깅 중 재토글 거부', sim.toggleAttach(0).ok === false);
l = sim.getState().loads[0];
check('타이머 진행 (남은 ≈5s)', l.rigRemain > 4.9 && l.rigRemain < 5.1, `remain=${l.rigRemain.toFixed(2)}`);

sim.stepFixed([{}], 301); // 나머지 5초
l = sim.getState().loads[0];
check('줄걸이 완료 → hooked', l.state === 'hooked' && sim.getState().cranes[0].loadMass === 8);

// 해체
r = sim.toggleAttach(0);
check('해체 시작 (pending)', r.ok === true && r.pending === true, r.msg);
check('상태 = derigging', sim.getState().loads[0].state === 'derigging');
sim.stepFixed([{}], 301); // 5초
l = sim.getState().loads[0];
check('해체 완료 → placed (목표 안착)', l.state === 'placed');
check('크레인 하중 해제', sim.getState().cranes[0].loadMass === 0);

// --- 2) 하위 호환: rigTime 미지정 = 즉시 토글 ---
console.log('--- 하위 호환 ---');
sim = new Simulation(byId('place-basic')); // S1: 리깅 시간 없음
sim.stepFixed([{ hoist: -1 }], 1800);
r = sim.toggleAttach(0);
check('rigTime 0 → 즉시 hooked', r.ok === true && sim.getState().loads[0].state === 'hooked');

// --- 3) AutoPilot: S7 리깅 현실화 완주 ---
console.log('--- AutoPilot × S7 ---');
const rS1 = runLift(new Simulation(byId('place-basic')), 0, 'pipe-1');
sim = new Simulation(byId('rig-real'));
const rS7 = runLift(sim, 0, 'pipe-1');
console.log(`  [S1] t=${rS1.cycleTime.toFixed(1)}s | [S7] t=${rS7.cycleTime.toFixed(1)}s (리깅 90+45, 시험 10)`);
check('S7 완주 성공', rS7.ok === true, rS7.reason ?? '');
check('시험인양 위상 수행', rS7.phases.some((p) => p.phase === 'trial'));
check('S7 사이클타임 = S1 + 리깅분 (+135s 이상)', rS7.cycleTime > rS1.cycleTime + 135,
  `Δ=${(rS7.cycleTime - rS1.cycleTime).toFixed(1)}s`);
check('안착 성공 (placed)', sim.getState().loads[0].state === 'placed');

// --- 4) PlanRunner: 노무비 ---
console.log('--- 노무비 ---');
sim = new Simulation(byId('rig-real'));
r = runPlan(sim, [{ craneId: 0, loadId: 'pipe-1' }]);
console.log(
  `  [S7 plan] makespan=${r.makespan.toFixed(1)}s rig=${r.cranes[0].rigTime.toFixed(1)}s ` +
    `cost=₩${Math.round(r.cost.total).toLocaleString()} (rental ${Math.round(r.cost.rental)} + idle ${Math.round(r.cost.idle)} + labor ${Math.round(r.cost.labor)})`,
);
check('계획 성공', r.success === true);
check('리깅 시간 집계 ≈ 135s', r.cranes[0].rigTime > 130 && r.cranes[0].rigTime < 141, `${r.cranes[0].rigTime.toFixed(1)}s`);
check('노무비 > 0', r.cost.labor > 0);
check('총비용 = 임대+유휴+노무', Math.abs(r.cost.total - (r.cost.rental + r.cost.idle + r.cost.labor)) < 1e-6);

// --- 5) 결정론 ---
const r2 = runPlan(new Simulation(byId('rig-real')), [{ craneId: 0, loadId: 'pipe-1' }]);
check('결정론: 동일 steps', r.steps === r2.steps, `${r.steps} vs ${r2.steps}`);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
