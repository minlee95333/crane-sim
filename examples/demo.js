// 사용법 데모: 계획 계층 전체를 한 번에 시연.
// 실행: node examples/demo.js
import { Simulation } from '../src/sim/Simulation.js';
import { runPlan, autoPlan } from '../src/plan/PlanRunner.js';
import { suggestSetups } from '../src/plan/SetupPlanner.js';
import { PlanEnvironment } from '../src/plan/PlanEnvironment.js';
import { evaluateLift, exportPlanSpec } from '../src/plan/oracle.js';
import { SCENARIOS } from '../data/scenarios.js';
import { CRAWLER_100T } from '../data/cranes.js';

const won = (n) => '₩' + Math.round(n).toLocaleString();
const scenario = SCENARIOS.find((s) => s.id === 'dual-site').scenario; // S6 협동 현장

console.log('══════════ 1) 계획 실행 + 비용 (PlanRunner) ══════════');
const plan = [
  { craneId: 0, loadId: 'tank-1' },
  { craneId: 1, loadId: 'duct-1' },
];
let r = runPlan(new Simulation(scenario), plan);
console.log(`계획: ${plan.map((a) => `크레인${a.craneId}→${a.loadId}`).join(', ')}`);
console.log(`makespan ${r.makespan.toFixed(1)}s | 완료 ${r.completed}건 | 총비용 ${won(r.cost.total)}`);
console.log(`  임대 ${won(r.cost.rental)} + 유휴 ${won(r.cost.idle)} + 노무 ${won(r.cost.labor)}`);
console.log(`  안전: 충돌 ${r.safety.collisions} · 크레인간섭 ${r.safety.craneClashes}`);

console.log('\n══════════ 2) 계획 A vs B 비교 ══════════');
const rSeq = runPlan(new Simulation(scenario), plan, { yield: false });
console.log(`양보 ON : ${r.makespan.toFixed(1)}s, 간섭 ${r.safety.craneClashes}회`);
console.log(`양보 OFF: ${rSeq.makespan.toFixed(1)}s, 간섭 ${rSeq.safety.craneClashes}회  ← 빠르지만 위험`);

console.log('\n══════════ 3) 자동 계획 생성 (autoPlan 베이스라인) ══════════');
const auto = autoPlan(new Simulation(scenario));
console.log('greedy 배정:', auto.map((a) => `크레인${a.craneId}→${a.loadId}`).join(', '));

console.log('\n══════════ 4) 셋업 위치·붐길이 추천 (SetupPlanner) ══════════');
const lifts = [{ id: 'L1', pos: [0, 0], target: [0, 6], mass: 2 }, { id: 'L2', pos: [80, 0], target: [80, -6], mass: 2 }];
const setups = suggestSetups(CRAWLER_100T, lifts);
console.log(`80m 떨어진 2건 → 추천 셋업 ${setups.length}개, 최상위:`);
console.log(`  위치 [${setups[0].pos.map((v) => v.toFixed(0))}], 붐 ${setups[0].boomLength}m, 여유 ${setups[0].score.toFixed(1)}t`);

console.log('\n══════════ 5) 계획 RL 환경 (PlanEnvironment) ══════════');
const env = new PlanEnvironment(scenario);
let s = env.reset();
let decisions = 0;
while (!s.done) {
  // 그리디 정책: 예상 사이클타임 최소 후보 선택 (여기에 RL 에이전트가 붙는다)
  let best = 0;
  s.candidates.forEach((c, i) => { if (c.est < s.candidates[best].est) best = i; });
  const pick = s.candidates[best];
  console.log(`  결정 ${++decisions}: 후보 ${s.candidates.length}개 → 크레인${pick.craneId}→${pick.loadId} (예상 ${pick.est.toFixed(0)}s)`);
  s = env.step(best);
}
console.log(`결과: ${s.info.status} | makespan ${s.info.makespan.toFixed(1)}s`);

console.log('\n══════════ 6) V2 오라클 (evaluateLift) ══════════');
const est = evaluateLift(scenario, 0, 'tank-1', { mode: 'estimate' });
const sim = evaluateLift(scenario, 0, 'tank-1', { mode: 'simulate' });
console.log(`tank-1: 근사 ${est.cycleTime.toFixed(1)}s vs 물리실측 ${sim.cycleTime.toFixed(1)}s`);
const spec = exportPlanSpec(scenario);
console.log(`V2 export: 크레인 ${spec.cranes.length}대, 양중 ${spec.lifts.length}건 → V2 JSON 준비 완료`);
