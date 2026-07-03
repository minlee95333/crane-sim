// P4 검증: 크레인 간 붐 이격·테일스윙 접촉 판정과 PlanRunner 양보 규칙.
// 실행: node src/plan/interferencetest.js

import { segDist, checkPair, craneGeometry, HARD_CLEARANCE } from '../core/Interference.js';
import { Simulation } from '../sim/Simulation.js';
import { runPlan } from './PlanRunner.js';
import { CRAWLER_100T } from '../../data/cranes.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}

// --- 1) 선분 거리 기하 단위 검증 ---
console.log('--- 선분 거리 기하 ---');
check('교차 선분 → 거리 0', segDist([-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0]) < 1e-9);
check('평행 선분 offset 2 → 거리 2', Math.abs(segDist([0, 0, 0], [10, 0, 0], [0, 2, 0], [10, 2, 0]) - 2) < 1e-9);
check('어긋난 수직 선분 (z 간격 3)', Math.abs(segDist([-5, 0, 0], [5, 0, 0], [0, -5, 3], [0, 5, 3]) - 3) < 1e-9);
check('점-선분 (끝점 밖)', Math.abs(segDist([0, 0, 0], [10, 0, 0], [13, 4, 0], [13, 4, 0]) - 5) < 1e-9);

// --- 2) World: 붐 교차 → 물리 충돌(clash) 집계 ---
console.log('--- 붐 교차 clash ---');
// 두 크롤러가 마주보고 붐이 X자로 교차 (A tip x=+3.2, B tip x=-3.2, 동일 평면)
let sim = new Simulation({
  cranes: [
    { ...CRAWLER_100T, basePos: [-18, 0, 0] },
    { ...CRAWLER_100T, basePos: [18, 0, 0], initial: { ...CRAWLER_100T.initial, slewAngle: Math.PI } },
  ],
  loads: [],
});
sim.stepFixed([{}, {}], 1);
let s = sim.getState().safety;
check('붐 교차 감지 (이격 < HARD)', s.craneMinClearance < HARD_CLEARANCE, `min=${s.craneMinClearance.toFixed(2)}m`);
check('크레인 충돌 카운트 1회 (진입 에지)', s.craneClashCount === 1);
sim.stepFixed([{}, {}], 60);
check('연속 접촉은 1회 유지', sim.getState().safety.craneClashCount === 1);

// --- 3) 테일스윙 접촉 ---
console.log('--- 테일스윙 ---');
// 베이스 8m 간격, 카운터웨이트가 서로 마주봄 (A: 붐 -x → 테일 +x / B: 붐 +x → 테일 -x)
sim = new Simulation({
  cranes: [
    { ...CRAWLER_100T, basePos: [0, 0, 0], initial: { ...CRAWLER_100T.initial, slewAngle: Math.PI } },
    { ...CRAWLER_100T, basePos: [8, 0, 0] },
  ],
  loads: [],
});
sim.stepFixed([{}, {}], 1);
s = sim.getState().safety;
const pair = s.cranePairs[0];
check('테일 접촉 감지', pair.tailContact === true);
check('테일 접촉도 clash 집계', s.craneClashCount === 1);
// 기하 함수 직접 확인: 붐끼리는 멀리 (반대 방향)
const gA = craneGeometry(sim.world.cranes[0]);
const gB = craneGeometry(sim.world.cranes[1]);
check('붐 자체는 원거리 (테일만 접촉)', checkPair(gA, gB).boomDist > 10, `boom=${checkPair(gA, gB).boomDist.toFixed(1)}m`);

// --- 4) PlanRunner: 양보 ON → 무충돌 완주 ---
console.log('--- 양보 규칙 (교차 작업) ---');
const CROSS = {
  cranes: [
    { ...CRAWLER_100T, basePos: [-18, 0, 0] },
    // 크레인1은 135°에서 시작 (초기엔 비교차) → 작업하러 오면서 크레인0 작업구역을 지나감
    { ...CRAWLER_100T, basePos: [18, 0, 0], initial: { ...CRAWLER_100T.initial, slewAngle: (Math.PI * 3) / 4 } },
  ],
  loads: [
    // 서로 반대편으로 교차 이송 → 붐이 X자로 스칠 수밖에 없는 배치
    { id: 'A', name: 'A', size: [2, 1, 2], mass: 5, pos: [0, 0, 1], target: [3, -1] },
    { id: 'B', name: 'B', size: [2, 1, 2], mass: 5, pos: [0, 0, -1], target: [-3, 1] },
  ],
};
const PLAN = [
  { craneId: 0, loadId: 'A' },
  { craneId: 1, loadId: 'B' },
];
let r = runPlan(new Simulation(CROSS), PLAN);
console.log(
  `  [yield ON ] makespan=${r.makespan.toFixed(1)}s clash=${r.safety.craneClashes} wait1=${r.cranes[1].waitTime.toFixed(1)}s`,
);
check('양보 ON: 완주 성공', r.success === true);
check('양보 ON: 크레인 충돌 0회', r.safety.craneClashes === 0);
check('양보 ON: 크레인1 대기 발생', r.cranes[1].waitTime > 5, `wait=${r.cranes[1].waitTime.toFixed(1)}s`);

// --- 5) 대조: 양보 OFF → 물리 충돌 발생 ---
const r0 = runPlan(new Simulation(CROSS), PLAN, { yield: false });
console.log(`  [yield OFF] makespan=${r0.makespan.toFixed(1)}s clash=${r0.safety.craneClashes}`);
check('양보 OFF: 크레인 충돌 발생 (규칙의 효과 입증)', r0.safety.craneClashes >= 1, `clash=${r0.safety.craneClashes}`);
check('양보 OFF가 더 빠름 (안전-시간 트레이드오프)', r0.makespan < r.makespan);

// --- 6) 결정론 ---
const r2 = runPlan(new Simulation(CROSS), PLAN);
check('결정론: 동일 steps', r.steps === r2.steps, `${r.steps} vs ${r2.steps}`);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
