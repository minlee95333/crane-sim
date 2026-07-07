import { SCENARIOS } from '../../data/scenarios.js';
import { generateMacroPlan, tandemCandidates } from './MacroPlanner.js';
import { validateSchedule3D } from './ScheduleValidator.js';

function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

console.log('--- 탠덤 거시 계획 ---');
const scenario = SCENARIOS.find((entry) => entry.id === 'tandem-lift').scenario;
const load = scenario.loads[0];
const states = scenario.cranes.map((spec) => ({
  spec, pos: [spec.basePos[0], spec.basePos[2]], available: 0, jobs: 0,
}));
const candidates = tandemCandidates(scenario, {
  ...load, pos: [load.pos[0], load.size[1] / 2, load.pos[2]],
  target: [load.target[0], load.size[1] / 2, load.target[1]],
}, states);
check('크레인쌍 셋업 후보 생성', candidates.length > 0 && candidates[0].craneIds.length === 2);
check('분담 하중 합은 총 하중', Math.abs(candidates[0].shares.reduce((a, b) => a + b, 0) - load.mass) < 1e-9);

const plan = generateMacroPlan(scenario);
check('탠덤 부재 1건 완료', plan.completed === 1 && plan.failed.length === 0);
check('하나의 배정이 크레인 2대를 점유', plan.assignments[0].tandem && plan.assignments[0].craneIds.length === 2);
const liftEvents = plan.events.filter((event) => event.type === 'lift');
check('두 lift 이벤트가 동일 시간에 동기화', liftEvents.length === 2 &&
  liftEvents[0].start === liftEvents[1].start && liftEvents[0].finish === liftEvents[1].finish);
const validation = validateSchedule3D(scenario, plan, { sampleStep: 30 });
check('정상 계획에 동기 위반 없음', !validation.violations.some((v) => v.type === 'tandemSynchronization'));

const broken = structuredClone(plan);
broken.events.find((event) => event.type === 'lift' && event.craneId === 'TC-B').start += 1;
const brokenValidation = validateSchedule3D(scenario, broken, { sampleStep: 30 });
check('시간축 불일치 검출', brokenValidation.violations.some((v) => v.type === 'tandemSynchronization'));

console.log('\nALL PASS');
