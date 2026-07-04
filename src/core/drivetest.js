// 실시간 수동 주행 검증: 언더캐리지 헤딩·drive/steer·가감속·충돌 차단·결정론.
// 실행: node src/core/drivetest.js

import { Simulation, FIXED_DT } from '../sim/Simulation.js';
import { CRAWLER_100T, TOWER_8T } from '../../data/cranes.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}
const ZERO = { slew: 0, luff: 0, hoist: 0 };
const drive = (d, s = 0) => ({ ...ZERO, drive: d, steer: s });
const secs = (n) => Math.round(n / FIXED_DT);

const DRIVABLE = { ...CRAWLER_100T, planning: { movable: true, driveSpeed: 1.0, driveAccel: 0.5, steerRate: 0.2 } };
const scn = (over = {}) => ({ cranes: [{ ...DRIVABLE, basePos: [0, 0, 0] }], loads: [], ...over });

// --- 1) 전진 주행: 헤딩(+x) 방향으로 이동 ---
console.log('--- 전진 주행 ---');
let sim = new Simulation(scn());
sim.stepFixed([drive(1)], secs(10)); // 10초 전진
let b = sim.world.cranes[0].basePos;
check('전진: +x로 이동', b[0] > 5 && Math.abs(b[2]) < 1e-6, `(${b[0].toFixed(1)},${b[2].toFixed(1)})`);
check('가감속: 10초에 최고속×10s(10m) 미만 (램프)', b[0] < 10, `${b[0].toFixed(1)}m`);

// --- 2) 정지 명령 → 관성 감속 후 멈춤 ---
const vMoving = sim.world.cranes[0].driveVel;
sim.stepFixed([ZERO], secs(5));
check('명령 0 → 감속 정지', Math.abs(sim.world.cranes[0].driveVel) < 1e-4, `vel0=${vMoving.toFixed(2)}`);

// --- 3) 조향: 헤딩 회전 후 그 방향으로 주행 ---
console.log('--- 조향 ---');
sim = new Simulation(scn());
sim.stepFixed([drive(0, 1)], secs(8)); // 우회전 (steerRate 0.2 × 8s = 1.6rad)
const yaw = sim.world.cranes[0].driveYaw;
check('조향으로 헤딩 변경', Math.abs(yaw - 1.6) < 0.05, `yaw=${yaw.toFixed(2)}rad`);
sim.stepFixed([drive(1)], secs(10));
b = sim.world.cranes[0].basePos;
check('회전한 헤딩 방향으로 주행 (z 성분 발생)', Math.abs(b[2]) > 2, `(${b[0].toFixed(1)},${b[2].toFixed(1)})`);

// --- 4) 현장 경계 차단 ---
console.log('--- 충돌 차단 ---');
sim = new Simulation(scn({ site: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 } }));
sim.stepFixed([drive(1)], secs(60)); // 계속 전진 — 경계에 막힘
b = sim.world.cranes[0].basePos;
const r = CRAWLER_100T.geometry.bodyRadius;
check('현장 경계에서 정지 (이탈 안 함)', b[0] <= 20 - r + 0.5, `x=${b[0].toFixed(1)} (경계 20, 반경 ${r})`);

// --- 5) 장애물 차단 ---
sim = new Simulation(scn({ obstacles: [{ id: 'blk', pos: [12, 0, 0], size: [4, 5, 4] }] }));
sim.stepFixed([drive(1)], secs(30));
b = sim.world.cranes[0].basePos;
check('장애물 앞에서 정지', b[0] < 12 - 2 - r + 0.6, `x=${b[0].toFixed(1)} (장애물 12±2)`);

// --- 6) 타 크레인 본체 차단 ---
sim = new Simulation({ cranes: [{ ...DRIVABLE, id: 'A', basePos: [0, 0, 0] }, { ...DRIVABLE, id: 'B', basePos: [14, 0, 0] }], loads: [] });
sim.stepFixed([drive(1), ZERO], secs(30));
b = sim.world.cranes[0].basePos;
check('타 크레인 본체 앞에서 정지', b[0] < 14 - 2 * r + 0.6, `x=${b[0].toFixed(1)} (상대 14, 반경 ${r}×2)`);

// --- 7) 고정식(타워)은 주행 무시 ---
console.log('--- 고정식·결정론 ---');
sim = new Simulation({ cranes: [TOWER_8T], loads: [] });
sim.stepFixed([drive(1, 1)], secs(10));
b = sim.world.cranes[0].basePos;
check('타워는 drive/steer 무시 (위치 불변)', b[0] === 0 && b[2] === 0);

// --- 8) 결정론 ---
const run = () => {
  const s = new Simulation(scn());
  s.stepFixed([drive(1, 0.3)], secs(12));
  return s.world.cranes[0].basePos;
};
const a1 = run();
const a2 = run();
check('결정론: 동일 입력 → 동일 위치', a1[0] === a2[0] && a1[2] === a2[2]);

// --- 9) 수동 픽앤캐리: 하중 매단 채 주행하면 부재가 따라온다 ---
console.log('--- 수동 픽앤캐리 ---');
sim = new Simulation({
  cranes: [{ ...DRIVABLE, basePos: [0, 0, 0], initial: { boomAngle: (60 * Math.PI) / 180, slewAngle: 0, ropeLength: 15 } }],
  loads: [{ id: 'p', name: 'p', size: [2, 1, 2], mass: 5, pos: [21.2, 0, 0] }],
});
// 부재 위로 후크 정렬은 생략 — 직접 hooked 상태로 만들어 주행 동반 이동만 검증
const crane = sim.world.cranes[0];
const load = sim.world.loads[0];
load.state = 'hooked'; load.hookedBy = 0; crane.loadMass = load.mass;
const lx0 = load.pos[0];
sim.stepFixed([drive(1)], secs(6));
check('하중이 크레인 주행을 따라 이동 (수동 픽앤캐리)', load.pos[0] > lx0 + 1 && load.state === 'hooked',
  `load.x ${lx0.toFixed(1)}→${load.pos[0].toFixed(1)}`);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
