// 계획 계층: 지상 인원·장비 간섭이 실측 사이클 타임을 실제로 바꾸는지 (P7.10).
// 핵심 지표 검증 — 동일 양중을 에이전트 있음/없음으로 AutoPilot 완주시켜
// (1) 간섭 속에서도 완주(라이브니스), (2) 홀드 시간 발생, (3) 사이클 타임 증가를 확인.
import { Simulation } from '../sim/Simulation.js';
import { runLift } from './AutoPilot.js';
import { SCENARIOS } from '../../data/scenarios.js';

function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

const S12 = SCENARIOS.find((entry) => entry.id === 'ground-traffic').scenario;

console.log('--- S12: 에이전트 간섭 하 AutoPilot 완주 ---');
const withAgents = new Simulation(S12);
const resultWith = runLift(withAgents, 0, 'HM-1');
const holdTime = withAgents.getState().safety.agentHoldTime;
check(`간섭 속 완주 (${resultWith.reason ?? 'ok'})`, resultWith.ok === true);
check(`홀드 발생 — 누적 ${holdTime.toFixed(1)}s`, holdTime > 0);

console.log('--- 대조: 에이전트 없는 동일 양중 ---');
const noAgents = new Simulation({ ...S12, agents: undefined });
const resultBase = runLift(noAgents, 0, 'HM-1');
check(`대조군 완주 (사이클 ${resultBase.cycleTime.toFixed(1)}s)`, resultBase.ok === true);
check(
  `간섭이 사이클 타임을 늘림 (${resultBase.cycleTime.toFixed(1)}s → ${resultWith.cycleTime.toFixed(1)}s)`,
  resultWith.cycleTime > resultBase.cycleTime,
);

console.log('--- 결정론: 같은 시드 재실행 = 같은 사이클 타임 ---');
const rerun = new Simulation(S12);
const resultRerun = runLift(rerun, 0, 'HM-1');
check(
  '재실행 사이클 타임·홀드 시간 동일',
  resultRerun.cycleTime === resultWith.cycleTime &&
    rerun.getState().safety.agentHoldTime === holdTime,
);

console.log('\nALL PASS');
