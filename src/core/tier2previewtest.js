// 코어: P7.12+ Tier2 순수 질의(NFZ·주행 경로·한계 반경·안내 대상) 회귀 테스트.
import { World } from './World.js';
import { MobileCrane } from './MobileCrane.js';
import { CRAWLER_100T } from '../../data/cranes.js';

function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

function makeWorld({ pos = [21.2, 0, 0], target = [30, 10], mass = 8 } = {}) {
  const world = new World();
  world.addCrane(new MobileCrane({ ...CRAWLER_100T }));
  world.addLoad({ id: 'load', name: '시험 하중', size: [2, 1, 2], mass, pos, target });
  return world;
}

function hook(world) {
  const load = world.loads[0];
  load.state = 'hooked';
  load.hookedBy = 0;
  world.cranes[0].loadMass = load.mass;
}

console.log('--- NFZ 접근 질의 ---');
{
  const world = makeWorld();
  world.addNoFlyZone({ id: 'nfz-near', min: [24, -2], max: [30, 2] });
  check('빈 후크는 NFZ 접근 결과 없음', world.nfzProximity(0) === null);
  hook(world);
  const near = world.nfzProximity(0);
  check('중심점→사각형 최근접 거리 계산', Math.abs(near.distance - 2.8) < 1e-9);
  check('3m 이내 near=true와 구역 ID 반환', near.near && near.zoneId === 'nfz-near');
  world.loads[0].pos[0] = 25;
  check('#checkSafety 중심점 규칙처럼 내부 거리는 0', world.nfzProximity(0).distance === 0);
}

console.log('--- 캐리 주행 경로 질의 ---');
{
  const world = makeWorld();
  hook(world);
  world.addObstacle({ id: 'wall', pos: [10, 0, 0], size: [2, 4, 8] });
  const straight = world.drivePathPreview(0, 0, 12, 1);
  check('이동식+매달림이면 13개 경로 샘플', straight.samples.length === 13);
  check('직진 예고는 현재 헤딩 +x를 유지', straight.samples[4].x === 4 && Math.abs(straight.samples[4].z) < 1e-12);
  check('#baseBlocked 동일 규칙으로 장애물 전 차단 표시', !straight.samples[5].blocked && straight.samples[6].blocked);
  const curved = world.drivePathPreview(0, 1, 8, 1);
  check('조향 입력은 곡선 경로(z 변위)를 만든다', curved.samples.at(-1).z > 0.5);
  check('빈 후크는 주행 경로 결과 없음', makeWorld().drivePathPreview(0) === null);
}

console.log('--- 정격 한계 반경 질의 ---');
{
  const world = makeWorld({ mass: 8 });
  hook(world);
  const staticLimit = world.limitRadius(0);
  check('한계 반경에서 보간 정격=현재 하중', Math.abs(world.cranes[0].capacityAtRadius(staticLimit) - 8) < 1e-9);
  check('8t 정적 한계 반경은 30~34m 사이', staticLimit > 30 && staticLimit < 34);
  world.cranes[0].driveVel = 0.2;
  const carryLimit = world.limitRadius(0);
  check('캐리 감격 시 한계 반경이 정적보다 작아짐', carryLimit < staticLimit);
  check('빈 후크는 한계 반경 없음', makeWorld().limitRadius(0) === null);
}

console.log('--- 화면 안내 대상·순수성 ---');
{
  const world = makeWorld({ target: [30, 10] });
  const pickup = world.guidanceTarget(0);
  check('빈 후크는 추천 픽업 부재를 안내', pickup.kind === 'load' && pickup.id === 'load');
  hook(world);
  const before = JSON.stringify(world.getState());
  const target = world.guidanceTarget(0);
  world.nfzProximity(0);
  world.drivePathPreview(0, 0.5);
  world.limitRadius(0);
  check('매달림 중에는 목표 좌표를 안내', target.kind === 'target' && target.pos[0] === 30 && target.pos[2] === 10);
  check('Tier2 질의 호출 전후 World 상태 불변', JSON.stringify(world.getState()) === before);
}

console.log('\nALL PASS');
