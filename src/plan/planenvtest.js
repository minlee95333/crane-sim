// P7 검증: PlanEnvironment(계획 수준 RL 인터페이스) + V2 연동 오라클.
// 실행: node src/plan/planenvtest.js

import { PlanEnvironment } from './PlanEnvironment.js';
import { evaluateLift, exportPlanSpec } from './oracle.js';
import { SCENARIOS } from '../../data/scenarios.js';
import { CRAWLER_100T } from '../../data/cranes.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}
const byId = (id) => SCENARIOS.find((s) => s.id === id).scenario;

/** 그리디 정책: 예상 사이클타임 최소 후보 선택 */
function greedyRun(env) {
  let r = env.reset();
  let total = 0;
  let steps = 0;
  while (!r.done && steps < 50) {
    let best = 0;
    r.candidates.forEach((c, i) => {
      if (c.est < r.candidates[best].est) best = i;
    });
    r = env.step(best);
    total += r.reward;
    steps += 1;
  }
  return { ...r.info, totalReward: total, decisions: steps };
}

// --- 1) 의사결정 시점·후보 구조 (S6 협동 현장) ---
console.log('--- PlanEnvironment 기본 ---');
const env = new PlanEnvironment(byId('dual-site'));
let r = env.reset();
check('초기 = 의사결정 시점', r.done === false && r.info.status === 'decision');
check('후보 = 타당 (크레인×양중물) 조합 2개', r.candidates.length === 2,
  r.candidates.map((c) => `(${c.craneId},${c.loadId})`).join(' '));
check('탱크→타워 조합은 후보에서 제외 (정격)', !r.candidates.some((c) => c.craneId === 1 && c.loadId === 'tank-1'));
check('후보에 예상 사이클타임 포함', r.candidates.every((c) => c.est > 30 && c.est < 400));
check('관측 벡터 유한', r.observation.every(Number.isFinite));

// --- 2) 그리디 정책 완주 ---
const g = greedyRun(new PlanEnvironment(byId('dual-site')));
console.log(`  [S6 그리디] makespan=${g.makespan.toFixed(1)}s R=${g.totalReward.toFixed(1)} decisions=${g.decisions}`);
check('그리디 완주 (success)', g.status === 'success');
check('의사결정 2회 (양중 2건)', g.decisions === 2);
check('makespan 병렬 범위 (110~170s)', g.makespan > 110 && g.makespan < 170);
check('누적 보상 양수 (완료 보너스 > 시간 비용)', g.totalReward > 0, `R=${g.totalReward.toFixed(1)}`);
check('종결 시 PlanRunner 결과 포함', g.result?.success === true && g.result.cost.total > 0);

// --- 3) 반입 대기: 후보 없으면 자동 진행 ---
console.log('--- 시간 제약 통합 ---');
const LATE = {
  cranes: [CRAWLER_100T],
  loads: [{ id: 'late', name: 'late', size: [3, 1.5, 3], mass: 5, pos: [20, 0, 3], target: [14, 15], arriveTime: 60 }],
};
const envLate = new PlanEnvironment(LATE);
r = envLate.reset();
check('반입까지 자동 진행 후 의사결정', r.info.status === 'decision' && envLate.runner.steps / 60 >= 60,
  `t=${(envLate.runner.steps / 60).toFixed(1)}s`);
r = envLate.step(0);
check('반입 후 완주', r.done === true && r.info.status === 'success');

// --- 4) 시공순서: 선행 미완 부재는 후보에서 자동 제외 ---
const DAG = {
  cranes: [CRAWLER_100T],
  loads: [
    { id: 'col', name: 'col', size: [3, 1.5, 3], mass: 5, pos: [20, 0, 3], target: [14, 15] },
    { id: 'beam', name: 'beam', size: [3, 1.5, 3], mass: 5, pos: [20, 0, -3], target: [15, -14], dependsOn: ['col'] },
  ],
};
const envDag = new PlanEnvironment(DAG);
r = envDag.reset();
check('첫 후보 = col만 (beam은 선행 미완)', r.candidates.length === 1 && r.candidates[0].loadId === 'col');
r = envDag.step(0);
check('col 안착 후 beam이 후보로', !r.done && r.candidates.length === 1 && r.candidates[0].loadId === 'beam');
r = envDag.step(0);
check('DAG 순서로 전건 완료', r.done && r.info.status === 'success' && r.info.placed === 2);

// --- 5) 오류 처리 + 결정론 ---
let threw = false;
try {
  new PlanEnvironment(byId('dual-site')).reset() && envDag.step(0);
} catch {
  threw = true;
}
check('종결 후 step → 예외', threw);
const g2 = greedyRun(new PlanEnvironment(byId('dual-site')));
check('결정론: 동일 정책 → 동일 makespan·보상',
  g.makespan === g2.makespan && Math.abs(g.totalReward - g2.totalReward) < 1e-9);

// --- 6) V2 오라클 ---
console.log('--- V2 오라클 ---');
const est = evaluateLift(byId('place-basic'), 0, 'pipe-1', { mode: 'estimate' });
const simr = evaluateLift(byId('place-basic'), 0, 'pipe-1', { mode: 'simulate' });
console.log(`  [S1] estimate=${est.cycleTime.toFixed(1)}s simulate=${simr.cycleTime.toFixed(1)}s ratio=${(est.cycleTime / simr.cycleTime).toFixed(2)}`);
check('estimate 모드 타당·시간 산출', est.feasible === true && est.cycleTime > 0);
check('simulate 모드 = 물리 완주값', simr.feasible === true && simr.cycleTime > 30);
check('근사/실측 비율 0.5~2.0 (캘리브레이션 범위)', est.cycleTime / simr.cycleTime > 0.5 && est.cycleTime / simr.cycleTime < 2.0);
check('반입 전 → blocked 반환', evaluateLift(LATE, 0, 'late').blocked === true);

// exportPlanSpec: V2 호환 JSON (x/z → x/y 매핑)
const spec = exportPlanSpec(byId('nfz-detour')); // S3: 금지구역 있음
check('크레인 스펙 변환', spec.cranes.length === 1 && spec.cranes[0].boomLen === 40 && spec.cranes[0].capacityCurve.length > 5);
check('양중물 변환 (weight·target)', spec.lifts[0].weight === 8 && Math.abs(spec.lifts[0].targetY - 21.2) < 0.01);
check('금지구역 → restricted_zones (x1,y1,x2,y2)',
  spec.restrictedZones[0].x1 === 12 && spec.restrictedZones[0].y2 === 26);
const spec6 = exportPlanSpec(byId('dual-site'));
check('2대 현장: 타입·좌표 매핑', spec6.cranes.length === 2 && spec6.cranes[1].type === 'tower' && spec6.cranes[0].x === -28);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
