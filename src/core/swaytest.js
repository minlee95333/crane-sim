// 코어: 매달림 거동 옵션(바람 외력·부재 요·이중진자) 물리 테스트 (P7.9).
// 핵심 보증: (1) 켠 경우의 물리가 해석해와 맞고, (2) 결정론이며, (3) 끈 경우 기존과 완전 동일.
import { World, WIND_ACCEL_COEF, HOOK_WIND_AREA } from './World.js';
import { MobileCrane } from './MobileCrane.js';
import { CRAWLER_100T } from '../../data/cranes.js';

const DT = 1 / 60;
const G = 9.81;

function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

/** 크롤러 1대 + 부재/장애물/바람 구성 헬퍼 */
function makeWorld({ physics = null, wind = null, loads = [], obstacles = [] } = {}) {
  const world = new World();
  const spec = physics ? { ...CRAWLER_100T, physics } : { ...CRAWLER_100T };
  world.addCrane(new MobileCrane(spec));
  for (const def of loads) world.addLoad(def);
  for (const def of obstacles) world.addObstacle(def);
  if (wind) world.setWind(wind);
  return world;
}

const GIRDER = { id: 'g1', name: '거더', size: [8, 0.5, 0.5], mass: 5, pos: [21.2, 0, 0] };
const MODULE = { id: 'm1', name: '모듈', size: [3, 2, 3], mass: 5, pos: [21.2, 0, 0] };

/** 후크를 부재 위로 내려 즉시 픽업 (초기 후크는 21m 상공 — 수직 허용 4m 밖) */
function attachNow(world) {
  world.cranes[0].setHookHeight(world.loads[0].topY + 1);
  const res = world.toggleAttach(0);
  if (!res.ok) throw new Error(`픽업 실패: ${res.msg}`);
}

// ── 1. 정상풍 정착 오프셋 = a·L/g (빈 후크) ─────────────────────────────
console.log('--- 바람 외력 → 흔들림 정착 ---');
{
  const world = makeWorld({ physics: { sway: true }, wind: { speed: 10, dir: 0 } });
  for (let i = 0; i < 60 * 60; i++) world.step(DT, [{}]);
  const sway = world.cranes[0].sway;
  const accel =
    (WIND_ACCEL_COEF * 10 ** 2 * HOOK_WIND_AREA) / (CRAWLER_100T.rating.hookBlockMass * 1000);
  const expected = (accel * world.cranes[0].ropeLength) / G;
  check(
    `정상풍 정착 오프셋 ≈ a·L/g (${sway.ox.toFixed(3)} ≈ ${expected.toFixed(3)}m)`,
    Math.abs(sway.ox - expected) < 0.02,
  );
  check('바람 직각 방향 오프셋 없음 (dir=0 → oz=0)', Math.abs(sway.oz) < 1e-9);
}

// ── 2. 결정론: 같은 입력 두 번 = 같은 궤적 ──────────────────────────────
console.log('--- 결정론 ---');
{
  const build = () =>
    makeWorld({
      physics: { sway: true, loadYaw: true, doublePendulum: true },
      wind: { speed: 9, dir: 1.1, gust: { amp: 0.3, period: 8 } },
      loads: [{ ...MODULE }],
    });
  const a = build();
  const b = build();
  attachNow(a);
  attachNow(b);
  for (let i = 0; i < 600; i++) {
    a.step(DT, [{ slew: 1, hoist: 0.3 }]);
    b.step(DT, [{ slew: 1, hoist: 0.3 }]);
  }
  const la = a.loads[0];
  const lb = b.loads[0];
  check(
    '600스텝 후 흔들림·요·위치가 비트 단위 동일',
    a.cranes[0].sway.ox === b.cranes[0].sway.ox &&
      a.cranes[0].sway.oz === b.cranes[0].sway.oz &&
      la.yaw === lb.yaw &&
      la.pos[0] === lb.pos[0] &&
      la.pos[2] === lb.pos[2],
  );
}

// ── 3. 거스트: 결정론 변조가 [1-amp, 1+amp] 안에서 요동 ─────────────────
console.log('--- 거스트 변조 ---');
{
  const world = makeWorld({ wind: { speed: 10, gust: { amp: 0.3, period: 8 } } });
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < 60 * 40; i++) {
    world.step(DT, [{}]);
    min = Math.min(min, world.windSpeed);
    max = Math.max(max, world.windSpeed);
  }
  check(`거스트가 풍속을 요동시킴 (min ${min.toFixed(1)}, max ${max.toFixed(1)})`, min <= 8.7 && max >= 11.3);
  check('요동 범위가 [speed·(1−amp), speed·(1+amp)] 이내', min >= 6.99 && max <= 13.01);
}

// ── 4. 플래그 OFF 회귀: 바람이 있어도 물리 불변 (규칙만 소비) ────────────
console.log('--- 플래그 OFF 회귀 ---');
{
  const noWind = makeWorld({ loads: [{ ...MODULE }] });
  const withWind = makeWorld({
    loads: [{ ...MODULE }],
    wind: { speed: 12, dir: 0.7, gust: { amp: 0.3, period: 8 } },
  });
  attachNow(noWind);
  attachNow(withWind);
  for (let i = 0; i < 600; i++) {
    noWind.step(DT, [{ slew: 1, hoist: 0.5 }]);
    withWind.step(DT, [{ slew: 1, hoist: 0.5 }]);
  }
  const pa = noWind.loads[0].pos;
  const pb = withWind.loads[0].pos;
  check(
    'sway 미장착 크레인은 바람이 있어도 부재 궤적 완전 동일',
    pa[0] === pb[0] && pa[1] === pb[1] && pa[2] === pb[2],
  );
  check('loadYaw 미장착이면 요 회전 없음', noWind.loads[0].yaw === 0 && withWind.loads[0].yaw === 0);
}

// ── 5. 부재 요: 선회를 지연 추종 후 수렴 ────────────────────────────────
console.log('--- 부재 요(yaw) 추종 ---');
{
  const world = makeWorld({ physics: { loadYaw: true }, loads: [{ ...GIRDER }] });
  attachNow(world);
  let midLag = 0;
  for (let i = 0; i < 60 * 60; i++) {
    world.step(DT, [{ slew: 1 }]);
    if (i === 60 * 30) midLag = Math.abs(world.loads[0].yaw - world.cranes[0].slewAngle);
  }
  for (let i = 0; i < 60 * 40; i++) world.step(DT, [{}]); // 정지 후 수렴 대기
  const finalErr = Math.abs(world.loads[0].yaw - world.cranes[0].slewAngle);
  check(`선회 중에는 지연(래그 ${((midLag * 180) / Math.PI).toFixed(1)}°)`, midLag > 0.02);
  check(
    `정지 후 선회각에 수렴 (오차 ${((finalErr * 180) / Math.PI).toFixed(2)}°)`,
    finalErr < 0.02 && world.loads[0].yaw > 1.3,
  );
}

// ── 6. 요 회전 부재의 외접 AABB 충돌 ────────────────────────────────────
console.log('--- 회전 외접 AABB 충돌 ---');
{
  // 장애물: z=3에 벽 — 8m 거더가 90° 돌면 z로 ±4m 뻗어 닿고, 축 정렬이면 ±0.25m라 안 닿는다
  const wall = { id: 'wall-1', pos: [21.2, 0, 3], size: [4, 30, 4.5] };
  const rotated = makeWorld({ physics: { loadYaw: true }, loads: [{ ...GIRDER }], obstacles: [wall] });
  attachNow(rotated);
  rotated.loads[0].yaw = Math.PI / 2; // 회전 상태 주입 (동역학은 1스텝에 거의 못 되돌림)
  rotated.step(DT, [{}]);
  check('90° 회전한 거더가 벽과 충돌 검출', rotated.collisionIds.includes('wall-1'));

  const aligned = makeWorld({ physics: { loadYaw: true }, loads: [{ ...GIRDER }], obstacles: [wall] });
  attachNow(aligned);
  aligned.step(DT, [{}]);
  check('축 정렬(0°) 거더는 충돌 없음 (오탐 방지)', aligned.collisionIds.length === 0);
}

// ── 7. 이중진자: 후크 대비 부재가 뒤처졌다 따라오고, 끄면 강체 추종 ───────
console.log('--- 이중진자 2단 ---');
{
  const dual = makeWorld({ physics: { doublePendulum: true }, loads: [{ ...MODULE }] });
  const rigid = makeWorld({ loads: [{ ...MODULE }] });
  attachNow(dual);
  attachNow(rigid);
  let maxDev = 0;
  let rigidDev = 0;
  const run = (world, cmd, steps, track) => {
    for (let i = 0; i < steps; i++) {
      world.step(DT, [cmd]);
      const hook = world.cranes[0].getHookPos();
      const l = world.loads[0];
      const dev = Math.hypot(l.pos[0] - hook[0], l.pos[2] - hook[2]);
      track(dev);
    }
  };
  run(dual, { slew: 1 }, 300, (d) => (maxDev = Math.max(maxDev, d)));
  run(dual, {}, 300, (d) => (maxDev = Math.max(maxDev, d)));
  run(rigid, { slew: 1 }, 300, (d) => (rigidDev = Math.max(rigidDev, d)));
  check(`선회 가감속에 부재가 후크 대비 처짐 (최대 ${maxDev.toFixed(3)}m)`, maxDev > 0.02 && maxDev < 1);
  check('doublePendulum 끄면 강체 추종 (편차 0)', rigidDev === 0);
}

console.log('\nALL PASS');
