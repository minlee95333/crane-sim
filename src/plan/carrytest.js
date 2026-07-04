// 픽앤캐리(주행 인양) 실행 검증 (SIM_DESIGN T2-⑧):
//   감격 정격·주행 전도 물리 + AutoPilot 캐리 페이즈 + PlanRunner carryTo 액션 + 차등.
// 실행: node src/plan/carrytest.js

import { Simulation } from '../sim/Simulation.js';
import { runLift, checkCarryFeasible } from './AutoPilot.js';
import { runPlan } from './PlanRunner.js';
import { CRAWLER_100T } from '../../data/cranes.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}

const CARRY_CRANE = (basePos) => ({
  ...CRAWLER_100T,
  basePos,
  planning: { movable: true, carrySpeed: 0.5, carryAccel: 0.3, carryRadius: 8 },
});

// 크레인 [25,0]. 픽업[40,0](r=15) — 목표[-30,0]은 픽업과 70m 이격, 한 셋업 도달 불가.
// 캐리 목적지[-10,0]에서 목표 r=20 도달. 12t는 안착 r=20 정적 정격(~18t) 내.
const scnLight = () => ({
  cranes: [CARRY_CRANE([25, 0, 0])],
  loads: [{ id: 'mod', name: '모듈', size: [3, 2, 3], mass: 12, pos: [40, 0, 0], target: [-30, 0] }],
  ground: { bearingCapacity: 30, grade: '양호' },
});

// --- 1) 캐리 타당성 + 실행 완주 ---
console.log('--- 픽앤캐리 실행 ---');
let sim = new Simulation(scnLight());
const cz = checkCarryFeasible(sim, 0, 'mod', [-10, 0]);
check('캐리 타당: 픽업 r=15·안착 r=20·감격 정격 내', cz.feasible === true,
  `carryR=${cz.carryRadius?.toFixed(1)} rPick=${cz.rPick?.toFixed(1)} rPlace=${cz.rPlace?.toFixed(1)}`);

sim = new Simulation(scnLight());
let r = runLift(sim, 0, 'mod', { carryTo: [-10, 0] });
const base = sim.world.cranes[0].basePos;
check('캐리 양중 완주 (한 셋업 불가 → 캐리로 안착)', r.ok === true && sim.world.loads[0].state === 'placed');
check('베이스가 캐리 목적지로 이동', Math.abs(base[0] - (-10)) < 0.3 && Math.abs(base[2]) < 0.3,
  `(${base[0].toFixed(1)},${base[2].toFixed(1)})`);
check('캐리 페이즈 전이 (lift-carry → carry → lift)',
  r.phases.some((p) => p.phase === 'lift-carry') && r.phases.some((p) => p.phase === 'carry'));
check('충돌 없음', r.collisions === 0);
console.log(`  [캐리] cycleTime=${r.cycleTime.toFixed(1)}s phases=${r.phases.length}`);

// --- 2) 결정론 ---
const r2 = runLift(new Simulation(scnLight()), 0, 'mod', { carryTo: [-10, 0] });
check('결정론: 동일 steps·cycleTime', r.steps === r2.steps && r.cycleTime === r2.cycleTime);

// --- 3) 감격 정격 차등: 픽업·안착은 정적 정격 내지만 캐리 감격으론 불가 ---
console.log('--- 감격 정격 차등 ---');
// 크레인 [25,0], 픽업[32,0](r=7 정적 67t), 목표[18,0](캐리[3,0]서 r=15 정적 27t).
// 45t: 픽업 49.5t≤67 ok, 안착 49.5t... r=15 정적 27t < 49.5 — 안착이 먼저 걸림.
// 차등을 감격에만 걸리게: 목표를 캐리목적지 r=7로 → 정적 67t 통과, 감격 37t 탈락.
const scnHeavy = {
  cranes: [CARRY_CRANE([25, 0, 0])],
  loads: [{ id: 'heavy', name: '중량 모듈', size: [3, 2, 3], mass: 45, pos: [32, 0, 0], target: [-4, 0] }],
  ground: { bearingCapacity: 40, grade: '견고' },
};
const simHeavy = new Simulation(scnHeavy);
const czHeavy = checkCarryFeasible(simHeavy, 0, 'heavy', [3, 0]); // 안착 r=|-4-3|=7 정적 67t
check('45t: 픽업·안착 정적 정격 통과하나 캐리 감격(37t)엔 탈락',
  czHeavy.feasible === false && /감격 정격/.test(czHeavy.reason ?? ''), czHeavy.reason);
// 규칙(정적)이면 통과할 배치임을 확인 — checkStability 아닌 정적 정격 여유
const crane = simHeavy.world.cranes[0];
check('차등 근거: 정적 정격은 픽업·안착 모두 45t 수용',
  crane.capacityAtRadius(7) > 45 * 1.1, `정적 r=7 = ${crane.capacityAtRadius(7).toFixed(0)}t`);

// --- 4) PlanRunner carryTo 액션 ---
console.log('--- PlanRunner 캐리 액션 ---');
sim = new Simulation(scnLight());
r = runPlan(sim, [{ craneId: 0, loadId: 'mod', carryTo: [-10, 0] }]);
check('carryTo 액션으로 계획 실행 성공', r.success === true && r.completed === 1);
check('carryStart 이벤트 발생', r.events.some((e) => e.type === 'carryStart'));
check('최종 안착 확인', sim.world.loads[0].state === 'placed');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
