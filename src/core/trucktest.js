// 트럭 코어 승격 검증: 결정론 운동·World 통합(동반 이동/단일 출차/충돌체)·자동 유도.
// 실행: node src/core/trucktest.js

import { Truck, deriveTrucks } from './Truck.js';
import { Simulation, FIXED_DT } from '../sim/Simulation.js';
import { SCENARIOS } from '../../data/scenarios.js';
import { CRAWLER_100T } from '../../data/cranes.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}

// --- 1) Truck 운동 닫힌식: 단계 전이 + 결정론 ---
console.log('--- Truck 운동 ---');
const tr = new Truck({
  id: 'T', dockPos: [-30, 0], heading: [0, 1], arriveTime: 30,
  entryDistance: 26, entryDuration: 30, exitDuration: 30, loads: ['a', 'b'],
});
check('진입 전 scheduled·비표시', tr.motionAt(-1).phase === 'scheduled' && !tr.motionAt(-1).visible);
const mid = tr.motionAt(15);
check('진입 중 entering·후방 오프셋', mid.phase === 'entering' && mid.offset < 0 && mid.offset > -26);
check('가속 프로파일: 출발 직후 속도 < 평균속도', tr.motionAt(1).velocity < 26 / 30);
check('도킹(t=30): 오프셋 0', tr.motionAt(30).phase === 'docked' && tr.motionAt(30).offset === 0);
check('departAt 없으면 계속 docked', tr.motionAt(9999).phase === 'docked');
const dep = tr.motionAt(110, 100);
check('출차: 후진(속도 음수)·후방 이동', dep.phase === 'departing' && dep.velocity < 0 && dep.offset < 0);
check('출차 완료 후 gone·비표시', tr.motionAt(131, 100).phase === 'gone' && !tr.motionAt(131, 100).visible);
check('결정론: 동일 시각 → 동일 위치', JSON.stringify(tr.motionAt(17)) === JSON.stringify(tr.motionAt(17)));

// --- 2) World 통합: 진입 동반 이동·도킹 무점프·단일 출차 ---
console.log('--- World 통합 ---');
const SCN = {
  cranes: [CRAWLER_100T],
  loads: [
    { id: 'a', name: 'a', size: [2, 1, 2], mass: 3, pos: [-30, 0, -3], elev: 1.35,
      route: [{ target: [-20, -5], elev: 0 }, { target: [15, 5], elev: 0 }], arriveTime: 30 },
    { id: 'b', name: 'b', size: [2, 1, 2], mass: 3, pos: [-30, 0, 3], elev: 1.35,
      route: [{ target: [-20, 5], elev: 0 }, { target: [15, -5], elev: 0 }], arriveTime: 30 },
  ],
  trucks: [{
    id: 'T-1', dockPos: [-30, 0], heading: [0, -1], size: [3.2, 2.9, 10],
    arriveTime: 30, entryDistance: 26, entryDuration: 30, exitDuration: 30, loads: ['a', 'b'],
  }],
};
const sim = new Simulation(SCN);
const w = sim.world;
check('트럭 1대 등록·적재 위치 스냅샷', w.trucks.length === 1 && w.trucks[0].cargoDock.size === 2);

sim.stepFixed([], Math.round(15 / FIXED_DT)); // t=15 (진입 중)
const la = w.loads[0];
const t0m = w.trucks[0].motionAt(w.time);
check('진입 중 pending 부재가 트럭과 동반 이동',
  la.state === 'pending' && Math.abs(la.pos[2] - (-3 + -1 * t0m.offset)) < 0.1,
  `z=${la.pos[2].toFixed(2)} offset=${t0m.offset.toFixed(2)}`);

sim.stepFixed([], Math.round(15.5 / FIXED_DT)); // t=30.5 (도킹 직후)
check('도킹 후 부재는 원위치(점프 없음)·하역 가능',
  la.state === 'ground' && Math.abs(la.pos[0] - -30) < 1e-6 && Math.abs(la.pos[2] - -3) < 0.05);
check('도킹 트럭은 충돌체', w.trucks[0].obstacle() !== null);

// 하역 완료를 직접 기록 (물리 하역 생략 — 트럭 수명주기만 검증)
for (const l of w.loads) {
  l.stage = 1;
  l.state = 'ground';
  l.yardedAt = 40;
  l.stageChangedAt = 40;
  l.pos = l.id === 'a' ? [-20, 0.5, -5] : [-20, 0.5, 5];
}
sim.stepFixed([], 1);
check('전량 하역 → 출차 시각 확정 (yardedAt 최댓값)', w.trucks[0].departAt === 40);
sim.stepFixed([], Math.round(45 / FIXED_DT)); // t≈75.5 (출차 완료)
check('출차 완료: gone·충돌체 해제', w.trucks[0].phase === 'gone' && w.trucks[0].obstacle() === null);

// 건립 완료로 stageChangedAt이 갱신돼도 출차 시각은 불변 (재진입 결함 회귀)
w.loads[0].stageChangedAt = 999;
sim.stepFixed([], 1);
check('건립 진행이 출차 시각을 바꾸지 않음 (재진입 없음)',
  w.trucks[0].departAt === 40 && w.trucks[0].phase === 'gone');

// --- 3) 트럭 충돌체: 타 부재는 충돌, 자기 적재 하역은 예외 ---
console.log('--- 충돌 판정 ---');
const sim2 = new Simulation(SCN);
const w2 = sim2.world;
sim2.stepFixed([], Math.round(31 / FIXED_DT)); // 도킹 완료
// 크레인 자세를 트럭 상공으로: 후크가 부재 a의 적재 위치(-30,-3) 위 저고도에 오도록
const crane2 = w2.cranes[0];
const [cbx, , cbz] = crane2.basePos;
const rTruck = Math.hypot(-30 - cbx, -3 - cbz); // 크레인 기준 반경
crane2.slewAngle = Math.atan2(-3 - cbz, -30 - cbx);
crane2.boomAngle = Math.acos((rTruck - crane2.pivotOffset) / crane2.boomLength);
// 후크 y≈3 (트럭 AABB 내)
crane2.ropeLength = crane2.pivotHeight + crane2.boomLength * Math.sin(crane2.boomAngle) - 3;
// 자기 적재 부재의 하역 권상 (stage 0) — 부재는 후크를 따라 트럭 AABB 안에 위치
w2.loads[0].state = 'hooked';
w2.loads[0].hookedBy = 0;
sim2.stepFixed([], 1);
check('자기 적재 부재의 하역 권상은 충돌 아님', w2.collisionCount === 0,
  `loadPos=${w2.loads[0].pos.map((v) => v.toFixed(1))}`);
// 하역이 끝난(stage 1) 부재가 같은 위치로 재통과하면 충돌
w2.loads[0].stage = 1;
sim2.stepFixed([], 1);
check('하역 후 트럭 상공 재통과는 충돌', w2.collisionCount === 1 &&
  w2.collisionIds.includes('truck:T-1'),
  `count=${w2.collisionCount} ids=${w2.collisionIds.join(',')}`);

// --- 4) 자동 유도 (scenario.trucks 미지정) + S9 명시 스펙 ---
console.log('--- 스펙 유도 ---');
const derived = deriveTrucks({ loads: SCN.loads });
check('arriveTime 그룹 자동 유도', derived.length === 1 && derived[0].loads.length === 2);
check('단일 여정 시나리오는 트럭 없음', deriveTrucks({ loads: [{ id: 'x', pos: [0, 0, 0], size: [1, 1, 1], target: [5, 5] }] }).length === 0);
const s9 = SCENARIOS.find((s) => s.id === 'yard-erection').scenario;
check('S9는 명시 트럭 스펙 사용 (데이터 주도)', s9.trucks?.length === 1 && s9.trucks[0].loads.length === 11);
const s9sim = new Simulation(s9);
check('S9 트럭이 World에 로드', s9sim.world.trucks.length === 1 && s9sim.world.trucks[0].id === 'T-1');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
