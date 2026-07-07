import { SCENARIOS } from '../../data/scenarios.js';
import { Simulation } from '../sim/Simulation.js';
import { checkLiftFeasible } from './AutoPilot.js';
import { evaluateSetup } from './SetupPlanner.js';

function check(label, ok) {
  if (!ok) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

console.log('--- P7.15~P7.20 실행 통합 ---');
const scenario = structuredClone(SCENARIOS.find((entry) => entry.id === 'operations-site').scenario);
const sim = new Simulation(scenario);
check('초기 강우로 양중 일시 차단', checkLiftFeasible(sim, 0, 'OP-A').blocked);
sim.world.time = 301;
check('강우 종료 후 기상 차단 해제', !sim.world.siteRulePreview(0).weather.blocked);
const load = scenario.loads[0];
const setup = evaluateSetup(scenario.cranes[0], {
  pos: [8, 0], boomLength: 40, configId: 'boom40',
}, [{ ...load, pos: [load.pos[0], load.size[1] / 2, load.pos[2]],
  target: [load.target[0], load.size[1] / 2, load.target[1]] }], scenario);
check('조립 물류 평가가 셋업 결과에 포함', setup.assembly.required && setup.assembly.feasible);

const ruleScenario = structuredClone(scenario);
ruleScenario.powerLines = [{ id: 'near', a: [21.2, 20, -5], b: [21.2, 20, 5], clearance: 6 }];
const ruleSim = new Simulation(ruleScenario);
ruleSim.world.step(1 / 60, [{}]);
check('World 시간축에서 전력선 위반 집계', ruleSim.getState().safety.siteRuleViolationCount === 1);
check('현장 규칙 미정의 시 기존 동작', new Simulation({
  cranes: [scenario.cranes[0]], loads: [], obstacles: [], noFlyZones: [],
}).getState().safety.siteRuleViolationCount === 0);

console.log('\nALL PASS');
