import { emptyDescriptor } from './scenario.js';
import { validateScenarioQuick } from './QuickScenarioValidator.js';

function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

console.log('--- 편집기 빠른 타당성 사전검증 ---');

const desc = emptyDescriptor();
desc.cranes.push({ id: 'c1', base: 'crawler', pos: [0, 0], boomLength: 40 });
desc.loads.push({ id: 'l1', mass: 5, size: [3, 1, 3], pos: [10, 0], target: [15, 0] });
check('정상 배치는 현재 셋업에서 인양 가능', !validateScenarioQuick(desc).some((x) => x.code === 'lift-infeasible'));

desc.loads[0].mass = 100;
check('정격 초과를 양중물 오류로 표시', validateScenarioQuick(desc).some((x) =>
  x.kind === 'load' && x.id === 'l1' && x.code === 'lift-infeasible'));

desc.loads[0].mass = 5;
desc.loads[0].target = [80, 0];
check('현장 밖 목표를 목표 객체 오류로 표시', validateScenarioQuick(desc).some((x) =>
  x.kind === 'target' && x.code === 'site-boundary'));

desc.loads[0].target = [15, 0];
desc.noFlyZones.push({ id: 'z1', min: [14, -2], max: [16, 2] });
check('제한구역 내부 목표 검출', validateScenarioQuick(desc).some((x) =>
  x.kind === 'target' && x.code === 'no-fly-zone'));

desc.obstacles.push(
  { id: 'o1', pos: [25, 0], size: [6, 4, 6] },
  { id: 'o2', pos: [27, 0], size: [6, 4, 6] },
);
check('장애물 상호 겹침을 양쪽에 표시', validateScenarioQuick(desc).filter((x) =>
  x.kind === 'obstacle' && x.code === 'overlap').length === 2);
