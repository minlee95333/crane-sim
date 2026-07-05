// 코어: 픽업·안착 예비 판정(attachPreview/releasePreview) 테스트 (P7.11).
// 핵심 보증: 예비 판정과 실제 toggleAttach가 단일 코드 경로라 항상 일치한다 —
// 보조 UI가 녹색이면 반드시 픽업/안착이 성공하고, 아니면 반드시 실패한다.
import { World, ATTACH_MAX_HORIZ, ATTACH_MAX_VERT } from './World.js';
import { MobileCrane } from './MobileCrane.js';
import { CRAWLER_100T } from '../../data/cranes.js';

function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

const DT = 1 / 60;

function makeWorld({ loads = [], wind = null } = {}) {
  const world = new World();
  world.addCrane(new MobileCrane({ ...CRAWLER_100T }));
  for (const def of loads) world.addLoad(def);
  if (wind) world.setWind(wind);
  return world;
}

const GIRDER = { id: 'g1', name: '거더', size: [8, 0.5, 0.5], mass: 5, pos: [21.2, 0, 0] };

/** 예측(ok)과 실제(toggleAttach)가 일치하는지 단정 */
function agree(label, world, craneId = 0) {
  const p = world.attachPreview(craneId);
  const predicted = p?.ok ?? false;
  const actual = world.toggleAttach(craneId).ok;
  check(`${label} — 예측 ${predicted} = 실제 ${actual}`, predicted === actual);
  return { p, actual };
}

// ── 1. 정상 픽업: 후크를 내리면 예측·실제 모두 성공 ─────────────────────
console.log('--- 예측=실제 일치 (픽업) ---');
{
  const world = makeWorld({ loads: [{ ...GIRDER }] });
  // 내리기 전: 수직 초과 → 둘 다 실패
  const before = world.attachPreview(0);
  check('권하 전: 근접 후보는 보이되 vertOk=false', before.load.id === 'g1' && !before.vertOk && before.horizOk);
  agree('권하 전 픽업', world);
  // 후크를 부재 위로 내림 → 둘 다 성공
  world.cranes[0].setHookHeight(world.loads[0].topY + 1);
  const { actual } = agree('권하 후 픽업', world);
  check('실제로 매달림', actual === true && world.loads[0].state === 'hooked');
}

// ── 2. 수평 초과: 근접 힌트는 주되 픽업은 실패 ─────────────────────────
{
  const world = makeWorld({ loads: [{ ...GIRDER, pos: [21.2 + ATTACH_MAX_HORIZ + 1, 0, 0] }] });
  world.cranes[0].setHookHeight(1.5);
  const p = world.attachPreview(0);
  check('수평 초과: horizOk=false·근접 후보 노출', !p.horizOk && p.load.id === 'g1' && !p.eligible);
  agree('수평 초과 픽업', world);
}

// ── 3. 차단 사유: 풍속 초과·선행 미완 ──────────────────────────────────
console.log('--- 차단 사유 (wind·precedence) ---');
{
  const world = makeWorld({
    loads: [{ ...GIRDER }],
    wind: { speed: 20, maxOperating: 12 },
  });
  world.cranes[0].setHookHeight(world.loads[0].topY + 1);
  const p = world.attachPreview(0);
  check('풍속 초과: blockReason=wind·eligible 유지', p.blockReason === 'wind' && p.eligible && !p.ok);
  agree('풍속 초과 픽업', world);
}
{
  const world = makeWorld({
    loads: [
      { ...GIRDER, dependsOn: ['col-1'] },
      { id: 'col-1', name: '기둥', size: [1, 6, 1], mass: 7, pos: [-30, 0, 0], target: [-25, 0] },
    ],
  });
  world.cranes[0].setHookHeight(world.loads[0].topY + 1);
  const p = world.attachPreview(0);
  check('선행 미완: blockReason=precedence·unmet 목록', p.blockReason === 'precedence' && p.block.unmet.includes('col-1'));
  agree('선행 미완 픽업', world);
}

// ── 4. 적격 우선: 더 가깝지만 부적격(수직 초과)한 부재에 가려지지 않음 ────
console.log('--- 적격 우선 (섀도잉 회귀) ---');
{
  const world = makeWorld({
    loads: [
      { id: 'high', name: '고소 부재', size: [3, 0.5, 3], mass: 3, pos: [21.4, 0, 0], elev: 9 }, // 수평 0.2m지만 수직 초과
      { id: 'low', name: '지상 부재', size: [3, 0.5, 3], mass: 3, pos: [22.6, 0, 0] }, // 수평 1.4m·적격
    ],
  });
  world.cranes[0].setHookHeight(world.loads[1].topY + 1);
  const p = world.attachPreview(0);
  check('적격 부재(low)가 후보 — 더 가까운 부적격에 안 가려짐', p.load.id === 'low' && p.ok);
  const res = world.toggleAttach(0);
  check('실제 픽업도 low', res.ok && world.loads[1].state === 'hooked');
}

// ── 5. 안착 예비 판정: 공중=불가 → 접지=가능 → 목표 위=onTarget ─────────
console.log('--- 예측=실제 일치 (안착) ---');
{
  const world = makeWorld({ loads: [{ ...GIRDER, target: [15, 10], targetElev: 0 }] });
  world.cranes[0].setHookHeight(world.loads[0].topY + 1);
  world.toggleAttach(0);
  check('빈 후크가 아니면 releasePreview 존재', world.releasePreview(0) !== null);

  // 공중: canRelease=false → 실제 해제도 실패
  for (let i = 0; i < 240; i++) world.step(DT, [{ hoist: 1 }]); // 권상
  const air = world.releasePreview(0);
  const airRes = world.toggleAttach(0);
  check(`공중 해제: 예측 불가(간격 ${air.bottomGap.toFixed(1)}m) = 실제 거부`, !air.canRelease && !airRes.ok);

  // 지면 근처(목표 밖): canRelease=true·onTarget=false → 해제 성공(placed 아님)
  for (let i = 0; i < 60 * 20; i++) {
    if (world.releasePreview(0).canRelease) break;
    world.step(DT, [{ hoist: -1 }]);
  }
  const ground = world.releasePreview(0);
  check('접지: 예측 가능·목표 밖', ground.canRelease && !ground.onTarget && ground.err > ground.tol);
  const groundRes = world.toggleAttach(0);
  check('실제 해제 성공 (목표 이탈 안착)', groundRes.ok && world.loads[0].state === 'ground');
}

// ── 6. 빈 후크: releasePreview는 null ──────────────────────────────────
{
  const world = makeWorld({ loads: [{ ...GIRDER }] });
  check('매달림 없으면 releasePreview=null', world.releasePreview(0) === null);
  check('후보권 밖(부재 없음)이면 attachPreview=null', makeWorld({}).attachPreview(0) === null);
}

console.log('\nALL PASS');
