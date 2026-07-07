import { World, TANDEM_HOLD_DEVIATION } from './World.js';

function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

function fakeCrane(hook, capacity = 8) {
  return {
    hook: [...hook],
    basePos: [0, 0, 0],
    loadMass: 0,
    minHookY: 0,
    slewAngle: 0,
    windAccel: [0, 0],
    spec: { type: 'mobile', geometry: { bodyRadius: 1, tailSwingRadius: 1, pivotHeight: 1 }, rating: {} },
    getHookPos() { return [...this.hook]; },
    getCapacity() { return capacity; },
    getRadius() { return 5; },
    boomTipY() { return 10; },
    getState() {
      return { type: 'mobile', basePos: [...this.basePos], slewAngle: 0, radius: 5,
        hookHeight: this.hook[1], hookPos: [...this.hook], capacity,
        loadMass: this.loadMass, loadRatio: this.loadMass / capacity, extra: {} };
    },
    step() {},
    setHookHeight(y) { this.hook[1] = y; },
  };
}

console.log('--- 탠덤 리프트 코어 ---');
const world = new World();
world.addCrane(fakeCrane([-4, 1, 0]));
world.addCrane(fakeCrane([4, 1, 0]));
world.addLoad({
  id: 'TG', name: '대형 거더', size: [10, 1, 1], mass: 12, pos: [0, 0, 0],
  target: [0, 10], tandem: true, liftPoints: [[-4, 0], [4, 0]], cog: [1, 0],
});
const load = world.loads[0];
const shares = world.tandemLoadShares(load);
check('분담 하중 합은 총 하중', Math.abs(shares[0] + shares[1] - load.mass) < 1e-9);
check('편심 무게중심은 가까운 후크 분담을 키움', shares[1] > shares[0]);
check('1대 정격보다 총 하중이 큼', load.mass > world.cranes[0].getCapacity());
check('두 크레인 분담분은 각 정격 이내', shares.every((v) => v <= 8));
const preview = world.tandemAttachPreview(0, 1, 'TG');
check('양단 정렬 시 동시 attach 가능', preview.ok);
check('1대 단독 시도는 총 하중으로 리미터 차단', preview.singleCraneLimiter.every(Boolean));
const attached = world.toggleAttach(0);
check('탠덤 attach가 두 크레인을 동시에 점유', attached.ok && load.tandemCraneIds.length === 2);
check('각 리미터에는 분담 하중만 적용', Math.abs(world.cranes[0].loadMass + world.cranes[1].loadMass - 12) < 1e-9);
world.cranes[1].hook[0] += TANDEM_HOLD_DEVIATION + 0.1;
const sync = world.tandemSyncPreview('TG');
check('후크 간격 과이탈을 홀드로 판정', sync.hold);
world.step(1 / 60, [{ slew: 1 }, { slew: -1 }]);
check('과이탈 시 두 크레인 홀드', world.tandemHolds.has(0) && world.tandemHolds.has(1));

console.log('\nALL PASS');
