// 코어: 매달린 하중 기준 전도 안전율 순수 질의 회귀 테스트.
import { World } from './World.js';
import { MobileCrane } from './MobileCrane.js';
import { checkStability } from './Stability.js';
import { CRAWLER_100T } from '../../data/cranes.js';

function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

const world = new World();
world.addCrane(new MobileCrane({ ...CRAWLER_100T }));
world.addLoad({ id: 'load', name: '시험 하중', size: [2, 1, 2], mass: 8, pos: [21.2, 0, 0] });

check('빈 후크는 안전율 없음', world.stabilityPreview(0) === null);
check('없는 크레인은 안전율 없음', world.stabilityPreview(99) === null);

world.cranes[0].setHookHeight(world.loads[0].topY + 1);
check('시험 하중 픽업 성공', world.toggleAttach(0).ok);

const before = structuredClone(world.getState());
const factor = world.stabilityPreview(0);
const expected = checkStability({
  spec: world.cranes[0].spec,
  boomLength: world.cranes[0].boomLength,
  radius: world.cranes[0].getRadius(),
  loadMass: world.loads[0].mass,
}).tippingMargin;
const after = world.getState();

check('Stability 준정적 모멘트 결과를 그대로 반환', Math.abs(factor - expected) < 1e-12);
check('안전율은 유한한 양수', Number.isFinite(factor) && factor > 0);
check('질의 전후 World 상태 불변', JSON.stringify(after) === JSON.stringify(before));
check('상태 스냅샷이 코어 안전율을 렌더 계약으로 제공', after.cranes[0].stabilityFactor === factor);

console.log('\nALL PASS');
