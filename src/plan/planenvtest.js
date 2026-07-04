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
// 직접 2개 + 재배치 1개(크롤러가 이동하면 duct-1도 가능) = 3개
check('후보 = 직접 2 + 재배치 1', r.candidates.length === 3,
  r.candidates.map((c) => `(${c.craneId},${c.loadId}${c.setupPos ? ',reloc' : ''})`).join(' '));
check('탱크→타워 조합은 후보에서 제외 (정격 — 고정식은 재배치 불가)',
  !r.candidates.some((c) => c.craneId === 1 && c.loadId === 'tank-1'));
check('직접 후보: est 30~400s·reloc=0',
  r.candidates.filter((c) => !c.setupPos).every((c) => c.est > 30 && c.est < 400 && c.reloc === 0));
check('재배치 후보: setupPos 동반·est에 재배치 시간 포함',
  r.candidates.filter((c) => c.setupPos).every((c) => c.reloc > 0 && c.est > c.reloc));
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

// --- 4.5) 재배치 후보: 도달 밖 부재도 셋업 이동으로 완주 (P8 전제 — S8/S9 stuck 결함 회귀) ---
console.log('--- 재배치 후보 ---');
const FAR = {
  cranes: [{
    ...CRAWLER_100T,
    planning: { movable: true, travelSpeed: 1.5, setupTime: 120, teardownTime: 60 },
  }],
  loads: [
    { id: 'far-1', name: '원거리 부재', size: [3, 1, 2], mass: 6, pos: [80, 0, 0], target: [70, 15] },
  ],
};
const envFar = new PlanEnvironment(FAR);
r = envFar.reset();
check('도달 밖 부재 → 재배치 후보 1개 (이전엔 즉시 stuck)',
  r.done === false && r.candidates.length === 1 && Array.isArray(r.candidates[0].setupPos));
check('재배치 est = 이동·조립 + 양중', r.candidates[0].reloc >= 120 && r.candidates[0].est > r.candidates[0].reloc + 30,
  `reloc=${r.candidates[0].reloc.toFixed(0)}s est=${r.candidates[0].est.toFixed(0)}s`);
r = envFar.step(0);
const farBase = envFar.sim.world.cranes[0].basePos;
check('재배치 후 완주 (success)', r.done === true && r.info.status === 'success');
check('basePos 실제 이동', Math.hypot(farBase[0], farBase[2]) > 30, `(${farBase[0].toFixed(1)},${farBase[2].toFixed(1)})`);
check('makespan에 주행·셋업 반영', r.info.makespan > 120, `${r.info.makespan.toFixed(1)}s`);
const envFar2 = new PlanEnvironment(FAR);
const f2 = (() => { let rr = envFar2.reset(); rr = envFar2.step(0); return rr; })();
check('재배치 결정론', f2.info.makespan === r.info.makespan);

// --- 4.6) S8/S9 완주: 재배치+작업원 순차화+유휴 퇴피로 대형 시나리오 전건 완료 (수 초 소요) ---
console.log('--- S8/S9 완주 ---');
const env8 = new PlanEnvironment(byId('macro-plan'));
const s8a = greedyRun(env8);
const w8 = env8.sim.world;
console.log(`  [S8 그리디] ${s8a.status} makespan=${(s8a.makespan / 60).toFixed(1)}min decisions=${s8a.decisions} clash=${w8.craneClashCount} col=${w8.collisionCount}`);
check('S8: 12건 전부 완료 (이전엔 2건 후 stuck)', s8a.status === 'success' && s8a.placed === 12);
check('S8: makespan 30~80분 범위', s8a.makespan > 1800 && s8a.makespan < 4800, `${(s8a.makespan / 60).toFixed(1)}min`);
check('S8: 안전 — 충돌 0·crane 접촉 ≤1(잔여 스침 1건은 알려진 한계)',
  w8.collisionCount === 0 && w8.violationCount === 0 && w8.craneClashCount <= 1);
const s8b = greedyRun(new PlanEnvironment(byId('macro-plan')));
check('S8: 결정론 (재배치·순차화 포함)', s8a.makespan === s8b.makespan && s8a.decisions === s8b.decisions);
const env9full = new PlanEnvironment(byId('yard-erection'));
const s9 = greedyRun(env9full);
const w9 = env9full.sim.world;
console.log(`  [S9 그리디] ${s9.status} makespan=${(s9.makespan / 60).toFixed(1)}min decisions=${s9.decisions} clash=${w9.craneClashCount} col=${w9.collisionCount}`);
check('S9: 하역 11 + 건립 11 = 22결정, 11부재 건립 완료', s9.status === 'success' && s9.placed === 11 && s9.decisions === 22);
check('S9: crane 간 접촉 0 (유휴 퇴피 이동 회귀)', w9.craneClashCount === 0);
check('S9: 부재-구조물 스침 ≤3 (AutoPilot 하강 경로 — 알려진 한계)', w9.collisionCount <= 3);

// S10 픽앤캐리: 픽업·목표 78m 이격 → 한 셋업 불가 → 캐리로 완주 (감격 정격·주행 전도)
const env10 = new PlanEnvironment(byId('pick-carry'));
const s10 = greedyRun(env10);
const has10carry = env10.runner.events.some((e) => e.type === 'carryStart');
console.log(`  [S10 캐리] ${s10.status} placed=${s10.placed}/2 makespan=${(s10.makespan / 60).toFixed(1)}min carry=${has10carry}`);
check('S10: 2건 캐리로 완주 (한 셋업/재배치 불가 → 픽앤캐리 폴백)',
  s10.status === 'success' && s10.placed === 2 && has10carry);
const s10b = greedyRun(new PlanEnvironment(byId('pick-carry')));
check('S10: 결정론', s10.makespan === s10b.makespan);

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
