// M1 검증: 렌더 없이 코어+인터페이스만으로 상태가 올바르게 진행되는지 확인.
// 실행: node src/sim/selftest.js

import { Simulation } from './Simulation.js';
import { DEFAULT_SCENARIO, CRAWLER_100T, TOWER_8T } from '../../data/cranes.js';

const rad2deg = (r) => ((r * 180) / Math.PI).toFixed(1);

const sim = new Simulation(DEFAULT_SCENARIO);

function printState(label) {
  const s = sim.getState();
  const c = s.cranes[0];
  console.log(
    `[${label}] t=${s.time.toFixed(1)}s | ` +
      `slew=${rad2deg(c.slewAngle)}° boom=${rad2deg(c.extra.boomAngle)}° ` +
      `radius=${c.radius.toFixed(2)}m hook=(${c.hookPos.map((v) => v.toFixed(1)).join(', ')}) ` +
      `capacity=${c.capacity.toFixed(1)}t`,
  );
}

let failures = 0;
function check(name, cond) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${name}`);
  if (!cond) failures++;
}

// --- 초기 상태 ---
printState('init');
const init = sim.getState().cranes[0];
check('초기 반경 = 1.2 + 40·cos60° = 21.2m', Math.abs(init.radius - 21.2) < 0.01);
check('초기 정격하중이 반경 21.2m 구간(15.5~21t) 내', init.capacity > 15.5 && init.capacity < 21);

// --- 1) 10초 선회 (+1) ---
sim.stepFixed([{ slew: 1 }], 600);
printState('slew 10s');
let s = sim.getState().cranes[0];
// 가속램프 때문에 1.5°/s × 10s = 15°보다 약간 작아야 함
check('선회각 0 < θ < 15°', s.slewAngle > 0 && s.slewAngle < (15 * Math.PI) / 180);
check('선회해도 반경 불변', Math.abs(s.radius - init.radius) < 1e-9);

// --- 2) 20초 기복 내림 (luff +1 = 반경 확대) ---
const rBefore = s.radius;
sim.stepFixed([{ luff: 1 }], 1200);
printState('luff-out 20s');
s = sim.getState().cranes[0];
check('반경 증가', s.radius > rBefore);
check('반경 커지면 정격하중 감소', s.capacity < init.capacity);

// --- 3) 권하 (hoist -1 = 후크 하강) — 지면 관통 금지 ---
sim.stepFixed([{ hoist: -1 }], 3600); // 60초면 로프 최대까지 충분
printState('hoist-down 60s');
s = sim.getState().cranes[0];
check('후크가 지면(y=0) 아래로 안 내려감', s.hookPos[1] >= -1e-9);

// --- 4) 붐각 한계 — 계속 내려도 min에서 멈춤 ---
sim.stepFixed([{ luff: 1 }], 36000); // 10분
s = sim.getState().cranes[0];
printState('luff-out to limit');
check('붐각이 최소각(15°)에서 정지', Math.abs(s.extra.boomAngle - (15 * Math.PI) / 180) < 1e-6);

// --- 5) reset 재현성 ---
const r1 = sim.reset();
sim.stepFixed([{ slew: 1, luff: 1 }], 300);
const a = JSON.stringify(sim.getState());
sim.reset();
sim.stepFixed([{ slew: 1, luff: 1 }], 300);
const b = JSON.stringify(sim.getState());
check('reset 후 동일 명령 → 동일 상태 (결정론)', a === b);
check('reset이 초기 상태 반환', Math.abs(r1.cranes[0].radius - 21.2) < 0.01);

// --- 6) M3: 픽업 / 과하중 리미터 / 공중해제 금지 ---
console.log('\n--- M3 checks ---');
sim.reset();
// 초기 후크 (21.2, ?, 0) 바로 아래에 25t 탱크(tank-1)가 있음 → 권하 후 픽업
sim.stepFixed([{ hoist: -1 }], 1800); // 30초 권하 → 후크가 탱크 상면 근처까지
let r = sim.toggleAttach(0);
check('25t 탱크 픽업 성공(줄걸이는 허용)', r.ok);

s = sim.getState().cranes[0];
check('과하중 상태 (25t > 정격 16.6t)', s.loadMass === 25 && s.loadRatio > 1);

// 과하중 상태에서 권상 시도 → 리미터가 차단, 후크 높이 불변
const hookYBefore = sim.getState().cranes[0].hookPos[1];
sim.stepFixed([{ hoist: 1 }], 300);
s = sim.getState().cranes[0];
check('리미터: 과하중 권상 차단', Math.abs(s.hookPos[1] - hookYBefore) < 1e-9);
check('리미터 활성 플래그', s.extra.limiterActive === true);

// 반경 확대(luff +1)도 차단
const radBefore = s.radius;
sim.stepFixed([{ luff: 1 }], 300);
s = sim.getState().cranes[0];
check('리미터: 반경 확대 차단', Math.abs(s.radius - radBefore) < 1e-9);

// 반경 축소(luff -1)는 허용 → 정격 회복 후 권상 가능
sim.stepFixed([{ luff: -1 }], 3600); // 60초 붐 올림
s = sim.getState().cranes[0];
check('반경 축소 후 정격 회복 (25t 인양 가능)', s.capacity > 25);
const hookY2 = s.hookPos[1];
sim.stepFixed([{ hoist: 1 }], 600);
s = sim.getState().cranes[0];
check('정격 내에서 권상 허용', s.hookPos[1] > hookY2 + 1);

// 공중 해제 금지
r = sim.toggleAttach(0);
check('공중 해제 거부', r.ok === false);

// 권하 후 해제 성공
sim.stepFixed([{ hoist: -1 }], 3600);
r = sim.toggleAttach(0);
check('지면 안착 후 해제 성공', r.ok === true);
s = sim.getState().cranes[0];
check('해제 후 인양하중 0', s.loadMass === 0);

// --- 7) 타워크레인 기구학 ---
console.log('\n--- Tower crane checks ---');
const tSim = new Simulation({ cranes: [TOWER_8T], loads: [] });
let t = tSim.getState().cranes[0];
check('초기 반경 = 트롤리 위치(15m)', Math.abs(t.radius - 15) < 1e-9);
check('초기 후크높이 = 마스트 32 - 로프 12 = 20m', Math.abs(t.hookHeight - 20) < 1e-9);
check('초기 정격이 반경 15m 구간(6.4~8t) 내', t.capacity > 6.4 && t.capacity < 8);

tSim.stepFixed([{ luff: 1 }], 2400); // 40초 트롤리 아웃
t = tSim.getState().cranes[0];
check('트롤리 지브 끝(35m)에서 정지', Math.abs(t.radius - 35) < 1e-6);
check('지브 끝 정격 = 2.6t', Math.abs(t.capacity - 2.6) < 0.01);

tSim.stepFixed([{ luff: -1 }], 3600); // 60초 트롤리 인
t = tSim.getState().cranes[0];
check('트롤리 최소 반경(3m)에서 정지', Math.abs(t.radius - 3) < 1e-6);

tSim.stepFixed([{ hoist: -1 }], 3600); // 권하 — 지면 관통 금지
t = tSim.getState().cranes[0];
check('타워 후크도 지면 아래로 안 내려감', t.hookPos[1] >= -1e-9);

tSim.stepFixed([{ slew: 1 }], 600); // 10초 선회
t = tSim.getState().cranes[0];
check('타워 선회 동작 (0 < θ < 24°)', t.slewAngle > 0 && t.slewAngle < (24 * Math.PI) / 180);

// --- 8) 후크 흔들림 (옵션 물리) ---
console.log('\n--- Sway checks ---');
const swaySim = new Simulation({
  cranes: [{ ...CRAWLER_100T, physics: { sway: true } }],
  loads: [],
});
let swayMax = 0; // 진동 위상 무관하게 구간 최대로 판정
for (let i = 0; i < 300; i++) {
  swaySim.stepFixed([{ slew: 1 }], 1); // 5초 선회 가속 → 외란
  swayMax = Math.max(swayMax, swaySim.getState().cranes[0].extra.swayMag);
}
check('선회 가속 중 흔들림 발생 (최대 >0.05m)', swayMax > 0.05, `max=${swayMax.toFixed(3)}`);
let sw;
swaySim.stepFixed([{}], 2400); // 40초 정지 대기 → 감쇠
sw = swaySim.getState().cranes[0];
check('정지 후 흔들림 감쇠 (<0.1m)', sw.extra.swayMag < 0.1, `mag=${sw.extra.swayMag.toFixed(3)}`);
const swayOffHook = new Simulation({ cranes: [CRAWLER_100T], loads: [] });
swayOffHook.stepFixed([{ slew: 1 }], 300);
check('물리 OFF 크레인은 흔들림 0', swayOffHook.getState().cranes[0].extra.swayMag === 0);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
