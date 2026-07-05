// 코어: 픽앤캐리 감격 정격의 런타임 정합 (P7.12) — 주행 중 정격·리미터가 감격을 반영.
import { World } from './World.js';
import { MobileCrane } from './MobileCrane.js';
import { CRAWLER_100T } from '../../data/cranes.js';

const DT = 1 / 60;
function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

// 반경 21.2m 정적 정격 ≈16.6t. 감격 후 ≈10.9t — 12t 부재는 정지 시 적법, 주행 시 과부하.
const HEAVY = { id: 'h1', name: '중량 모듈', size: [3, 2, 3], mass: 12, pos: [21.2, 0, 0] };

const world = new World();
world.addCrane(new MobileCrane({ ...CRAWLER_100T }));
world.addLoad(HEAVY);
world.cranes[0].setHookHeight(world.loads[0].topY + 1);
world.toggleAttach(0);
const crane = world.cranes[0];

const staticCap = crane.getCapacity();
check(`정지 시 정적 정격 (${staticCap.toFixed(1)}t)·리미터 미작동`, staticCap > 15 && !crane.limiterActive);

// 주행 시작 → 감격 적용 + 과부하 리미터 (12t > 10.9t)
for (let i = 0; i < 120; i++) world.step(DT, [{ drive: 1 }]);
const carryCap = crane.getCapacity();
check(
  `주행 중 감격 정격 = 정적×0.66 (${carryCap.toFixed(1)}t)`,
  Math.abs(carryCap - staticCap * 0.66) < 0.2 && crane.getExtraState().carryDerated,
);
check('감격 초과 하중은 캐리 중 리미터 작동', crane.limiterActive === true);
const hookBefore = crane.getHookPos()[1];
for (let i = 0; i < 60; i++) world.step(DT, [{ drive: 1, hoist: 1 }]);
check('리미터가 캐리 중 권상 차단', crane.getHookPos()[1] <= hookBefore + 1e-9);

// 정지 → 정적 정격 복귀·리미터 해제
for (let i = 0; i < 300; i++) world.step(DT, [{}]);
check(
  `정지 후 정적 정격 복귀 (${crane.getCapacity().toFixed(1)}t)·리미터 해제`,
  Math.abs(crane.getCapacity() - staticCap) < 1e-9 && !crane.limiterActive,
);

console.log('\nALL PASS');
