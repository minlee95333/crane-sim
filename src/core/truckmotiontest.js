import { truckMotionAt } from './TruckMotion.js';

function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

const options = { distance: 26, duration: 30, maxAcceleration: 0.3 };
const start = truckMotionAt(0, options);
const accelerating = truckMotionAt(2, options);
const cruising = truckMotionAt(15, options);
const braking = truckMotionAt(28, options);
const finish = truckMotionAt(30, options);

console.log('--- 트럭 종방향 이동 물리 ---');
check('정지 상태에서 출발', start.position === 0 && start.velocity === 0);
check('가속 구간에서 속도 증가', accelerating.phase === 'accelerating' && accelerating.velocity > 0);
check('중간 구간은 정속 주행', cruising.phase === 'cruising' && cruising.acceleration === 0);
check('종료 전 감속', braking.phase === 'braking' && braking.acceleration < 0);
check('정확한 거리에서 정지', finish.position === 26 && finish.velocity === 0);
check(
  '위치와 속도가 시간에 따라 연속',
  accelerating.position < cruising.position && cruising.position < braking.position,
);

console.log('\nALL PASS');
