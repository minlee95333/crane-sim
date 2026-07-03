// P6 검증: 반입 스케줄(pending)·시공순서 DAG(dependsOn)·바람 윈도우·데드락 감지.
// 실행: node src/plan/scheduletest.js

import { Simulation } from '../sim/Simulation.js';
import { checkLiftFeasible } from './AutoPilot.js';
import { runPlan, autoPlan } from './PlanRunner.js';
import { CRAWLER_100T } from '../../data/cranes.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}
const evt = (r, type) => r.events.filter((e) => e.type === type);

// 공용: 반경 유효한 표준 양중 (r픽업 20.2, r목표 20.5)
const L = (id, extra = {}) => ({
  id, name: id, size: [3, 1.5, 3], mass: 5,
  pos: [20, 0, 3], target: [14, 15], ...extra,
});

// --- 1) 반입 스케줄 (pending → ground) ---
console.log('--- 반입 스케줄 ---');
let sim = new Simulation({ cranes: [CRAWLER_100T], loads: [L('late', { arriveTime: 30 })] });
check('t=0: 반입 전 상태', sim.getState().loads[0].state === 'pending');
let fz = checkLiftFeasible(sim, 0, 'late');
check('반입 전 → blocked (스킵 아님)', fz.feasible === false && fz.blocked === true, fz.reason);
sim.stepFixed([{}], 1794); // 29.9초
check('도착 직전까지 pending', sim.getState().loads[0].state === 'pending');
sim.stepFixed([{}], 12); // 30초 경과
check('도착 후 ground 전환', sim.getState().loads[0].state === 'ground');

// PlanRunner: 반입까지 대기 후 완주
sim = new Simulation({ cranes: [CRAWLER_100T], loads: [L('late', { arriveTime: 60 })] });
let r = runPlan(sim, [{ craneId: 0, loadId: 'late' }]);
console.log(`  [반입 대기] makespan=${r.makespan.toFixed(1)}s blocked=${evt(r, 'liftBlocked').length}`);
check('반입 대기 후 완주', r.success === true);
check('liftBlocked 이벤트 기록', evt(r, 'liftBlocked').length >= 1);
check('makespan > 반입 시각 (대기 반영)', r.makespan > 60);
check('시작이 반입 후', evt(r, 'liftStart')[0].t >= 60);

// --- 2) 시공순서 DAG ---
console.log('--- 시공순서 ---');
const COL = L('col', { pos: [20, 0, 3], target: [14, 15] });
const BEAM = L('beam', { pos: [20, 0, -3], target: [15, -14], dependsOn: ['col'] });

// World 수준: 선행 미완 시 픽업 거부
sim = new Simulation({ cranes: [CRAWLER_100T], loads: [COL, BEAM] });
sim.stepFixed([{ hoist: -1 }], 1800); // 후크를 beam 근처로 (초기 후크 반경 21.2 ≈ beam 반경 20.2)
// 후크는 [21.2, ·, 0] — beam[20,0,-3]이 3.2m라 픽업 범위(2m) 밖. 직접 판정만 확인:
fz = checkLiftFeasible(sim, 0, 'beam');
check('선행 미완 → blocked', fz.feasible === false && fz.blocked === true && fz.reason.includes('선행'), fz.reason);
check('선행 부재(col)는 feasible', checkLiftFeasible(sim, 0, 'col').feasible === true);

// 올바른 순서 [col → beam]: 성공 + 순서 보장
sim = new Simulation({ cranes: [CRAWLER_100T], loads: [COL, BEAM] });
r = runPlan(sim, [
  { craneId: 0, loadId: 'col' },
  { craneId: 0, loadId: 'beam' },
]);
check('순서 준수 계획 성공', r.success === true && r.completed === 2);
const colEnd = evt(r, 'liftEnd').find((e) => e.loadId === 'col').t;
const beamStart = evt(r, 'liftStart').find((e) => e.loadId === 'beam').t;
check('beam은 col 안착 후 시작', beamStart >= colEnd);

// 잘못된 순서 [beam → col]: 헤드가 영원히 차단 → 데드락 감지
sim = new Simulation({ cranes: [CRAWLER_100T], loads: [COL, BEAM] });
r = runPlan(sim, [
  { craneId: 0, loadId: 'beam' },
  { craneId: 0, loadId: 'col' },
]);
console.log(`  [역순 계획] makespan=${r.makespan.toFixed(1)}s deadlock=${evt(r, 'deadlock').length}`);
check('역순 계획 → 데드락 감지 (무한 대기 아님)', evt(r, 'deadlock').length >= 1 && r.success === false);
check('데드락 사유 = 선행 미완', evt(r, 'deadlock')[0].reason?.includes('선행'), evt(r, 'deadlock')[0].reason);

// --- 3) 바람 윈도우 ---
console.log('--- 바람 ---');
const WINDY = {
  cranes: [CRAWLER_100T],
  loads: [L('w1')],
  wind: { timeline: [[0, 20], [90, 6]], maxOperating: 12 },
};
sim = new Simulation(WINDY);
fz = checkLiftFeasible(sim, 0, 'w1');
check('풍속 20 > 한계 12 → blocked', fz.feasible === false && fz.blocked === true && fz.reason.includes('풍속'), fz.reason);
// 부재별 한계 오버라이드: 소형 부재는 25m/s까지 허용
sim = new Simulation({ ...WINDY, loads: [L('w2', { maxWind: 25 })] });
check('부재별 한계(25) → 풍속 20에도 가능', checkLiftFeasible(sim, 0, 'w2').feasible === true);
// World 픽업 가드 (부재를 초기 후크 바로 아래에 배치)
sim = new Simulation({ ...WINDY, loads: [L('w3', { pos: [21.2, 0, 0] })] });
sim.stepFixed([{ hoist: -1 }], 1800);
check('World 픽업 가드 (풍속)', sim.toggleAttach(0).msg.includes('풍속'));

// PlanRunner: 바람 잦아든 후(90s) 시작
sim = new Simulation(WINDY);
r = runPlan(sim, [{ craneId: 0, loadId: 'w1' }]);
console.log(`  [바람 대기] makespan=${r.makespan.toFixed(1)}s start=${evt(r, 'liftStart')[0]?.t.toFixed(1)}s`);
check('바람 윈도우 대기 후 완주', r.success === true);
check('시작이 바람 완화(90s) 후', evt(r, 'liftStart')[0].t >= 90);

// 상수 강풍 (미래 변화 없음) → 데드락
sim = new Simulation({ ...WINDY, wind: { speed: 20, maxOperating: 12 } });
r = runPlan(sim, [{ craneId: 0, loadId: 'w1' }]);
check('상수 강풍 → 데드락 감지', evt(r, 'deadlock').length >= 1 && r.success === false);

// --- 4) autoPlan: 위상 정렬 + blocked 포함 ---
console.log('--- autoPlan ---');
// 시나리오에 beam(선행 col)이 먼저 나열돼도 col을 먼저 배정
sim = new Simulation({
  cranes: [CRAWLER_100T],
  loads: [BEAM, COL, L('late2', { pos: [18, 0, -8], target: [8, 18], arriveTime: 40 })],
});
const plan = autoPlan(sim);
check('3건 모두 배정 (반입 대기 포함)', plan.length === 3, JSON.stringify(plan.map((p) => p.loadId)));
check('위상 정렬: col이 beam보다 먼저',
  plan.findIndex((p) => p.loadId === 'col') < plan.findIndex((p) => p.loadId === 'beam'));
r = runPlan(sim, plan);
check('autoPlan 실행 성공 (3건)', r.success === true && r.completed === 3);

// --- 5) 결정론 ---
const r2 = runPlan(
  new Simulation({ cranes: [CRAWLER_100T], loads: [L('late', { arriveTime: 60 })] }),
  [{ craneId: 0, loadId: 'late' }],
);
const r3 = runPlan(
  new Simulation({ cranes: [CRAWLER_100T], loads: [L('late', { arriveTime: 60 })] }),
  [{ craneId: 0, loadId: 'late' }],
);
check('결정론: 동일 steps', r2.steps === r3.steps, `${r2.steps} vs ${r3.steps}`);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
