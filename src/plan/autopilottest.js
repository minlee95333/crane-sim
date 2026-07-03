// P1 검증: AutoPilot이 다양한 시나리오에서 양중 1건을 자동 완주하는지.
// 실행: node src/plan/autopilottest.js

import { Simulation } from '../sim/Simulation.js';
import { AutoPilot, runLift } from './AutoPilot.js';
import { SCENARIOS } from '../../data/scenarios.js';
import { CRAWLER_100T } from '../../data/cranes.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}
const byId = (id) => SCENARIOS.find((s) => s.id === id).scenario;
const fmt = (r) => `t=${r.cycleTime.toFixed(1)}s steps=${r.steps} err=${r.placeError?.toFixed(2)}m col=${r.collisions} vio=${r.violations}`;

// --- 1) S1 기본 안착 ---
console.log('--- S1 기본 안착 ---');
let sim = new Simulation(byId('place-basic'));
let r = runLift(sim, 0, 'pipe-1');
console.log(`  [S1] ${fmt(r)}`);
check('완주 성공', r.ok === true, r.reason ?? '');
check('부재 placed', sim.getState().loads[0].state === 'placed');
check('사이클타임 합리적 (30~200s)', r.cycleTime > 30 && r.cycleTime < 200);
check('충돌·침범 0', r.collisions === 0 && r.violations === 0);
check('안착 오차 < 0.5m', r.placeError !== null && r.placeError < 0.5);

// --- 2) 결정론 ---
const r2 = runLift(new Simulation(byId('place-basic')), 0, 'pipe-1');
check('결정론: 동일 조건 → 동일 steps', r.steps === r2.steps, `${r.steps} vs ${r2.steps}`);

// --- 3) S2 장애물 넘기기 — 이동고도 자동 설정으로 무충돌 ---
console.log('--- S2 장애물 넘기기 ---');
sim = new Simulation(byId('obstacle-hop'));
r = runLift(sim, 0, 'module-1');
console.log(`  [S2] ${fmt(r)}`);
check('완주 성공', r.ok === true, r.reason ?? '');
check('10m 장애물 위 통과 (충돌 0)', r.collisions === 0);

// --- 4) S4 릴레이 (흔들림 ON) — 같은 sim에서 연속 2건 ---
console.log('--- S4 릴레이 + 흔들림 ---');
sim = new Simulation(byId('relay-sway'));
r = runLift(sim, 0, 'pc-slab-1');
console.log(`  [S4-1] ${fmt(r)}`);
check('1건차(흔들림) 완주', r.ok === true, r.reason ?? '');
let rB = runLift(sim, 0, 'pipe-1');
console.log(`  [S4-2] ${fmt(rB)}`);
check('2건차 연속 완주 (릴레이)', rB.ok === true, rB.reason ?? '');
check('전체 임무 완료 (allPlaced)', sim.world.allPlaced() === true);

// --- 5) S5 타워크레인 ---
console.log('--- S5 타워크레인 ---');
sim = new Simulation(byId('tower-yard'));
r = runLift(sim, 0, 'rebar-1');
console.log(`  [S5] ${fmt(r)}`);
check('타워 완주 (트롤리 반경 제어)', r.ok === true, r.reason ?? '');
check('타워 무충돌·무침범', r.collisions === 0 && r.violations === 0);

// --- 6) S6 협동 현장 — 두 크레인이 각자 양중 ---
console.log('--- S6 협동 현장 ---');
sim = new Simulation(byId('dual-site'));
r = runLift(sim, 0, 'tank-1');
console.log(`  [S6 crawler] ${fmt(r)}`);
check('크롤러(크레인0) 완주', r.ok === true, r.reason ?? '');
rB = runLift(sim, 1, 'duct-1');
console.log(`  [S6 tower] ${fmt(rB)}`);
check('타워(크레인1) 완주', rB.ok === true, rB.reason ?? '');
check('S6 전체 완료', sim.world.allPlaced() === true);

// --- 7) 타당성 사전검사 ---
console.log('--- 타당성 검사 ---');
const heavy = {
  cranes: [CRAWLER_100T],
  loads: [
    { id: 'too-heavy', name: '초과중량', size: [4, 3, 4], mass: 50, pos: [21.2, 0, 0], target: [10, 15] },
    { id: 'no-target', name: '목표없음', size: [2, 1, 2], mass: 5, pos: [18, 0, 5] },
    { id: 'too-far', name: '도달불가', size: [2, 1, 2], mass: 3, pos: [21, 0, 0], target: [50, 20] },
  ],
};
let p = new AutoPilot(new Simulation(heavy), 0, 'too-heavy');
check('정격 초과 → infeasible', p.done && !p.ok && p.reason.includes('정격'), p.reason);
p = new AutoPilot(new Simulation(heavy), 0, 'no-target');
check('목표 미정의 → infeasible', p.done && !p.ok && p.reason.includes('목표'), p.reason);
p = new AutoPilot(new Simulation(heavy), 0, 'too-far');
check('도달범위 밖 → infeasible', p.done && !p.ok && p.reason.includes('도달범위'), p.reason);
check('infeasible은 스텝 소모 0', p.steps === 0);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
