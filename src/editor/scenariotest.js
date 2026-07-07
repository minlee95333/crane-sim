import {
  addDescriptorObject, buildScenario, emptyDescriptor, parseDescriptor,
  removeDescriptorObject, updateDescriptorEnvironment, updateDescriptorObject, validateDescriptor,
} from './scenario.js';

function check(label, ok) {
  if (!ok) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

console.log('--- 시나리오 편집 계약 ---');
const desc = emptyDescriptor();
desc.cranes.push({ id: 'C1', base: 'crawler', pos: [0, 0] });
desc.loads.push({ id: 'L1', mass: 5, pos: [10, 0], target: [0, 10], targetYaw: 1.57 });
desc.powerLines.push({ id: 'P', a: [0, 12, 0], b: [20, 12, 0], clearance: 6 });
desc.weather = { rain: { value: 0 }, maxRain: 10 };
check('유효 descriptor 검증', validateDescriptor(desc).valid);
const scenario = buildScenario(desc);
check('신규 현실 필드 보존', scenario.powerLines.length === 1 && scenario.weather.maxRain === 10);
check('부재 targetYaw 보존', scenario.loads[0].targetYaw === 1.57);
check('JSON 왕복', parseDescriptor(JSON.stringify(desc)).valid);
check('중복 ID 거부', !validateDescriptor({ ...desc, loads: [...desc.loads, { ...desc.loads[0] }] }).valid);
check('잘못된 JSON 오류 반환', !parseDescriptor('{').valid);
const obstacle = addDescriptorObject(desc, 'obstacle');
check('장애물 추가 시 고유 ID와 기본 크기 생성', obstacle.id && obstacle.size.length === 3);
updateDescriptorObject(desc, 'obstacle', obstacle.id, {
  x: 12, z: 13, width: 8, height: 9, depth: 10, mass: 0,
});
check('선택 객체 위치·크기 수정', obstacle.pos.join(',') === '12,13' && obstacle.size.join(',') === '8,9,10');
check('선택 객체 삭제', removeDescriptorObject(desc, 'obstacle', obstacle.id));
updateDescriptorEnvironment(desc, {
  width: 160, depth: 120, windSpeed: 7, windDirection: 90,
  maxOperatingWind: 14, gustPercent: 20, gustPeriod: 30, bearingCapacity: 25,
  workerCount: 6, workerSpeed: 1.2, vehicleCount: 2, vehicleSpeed: 2.5, dangerRadius: 7,
});
check(
  '현장·풍속·지반 환경 수정',
  desc.site.width === 160 && desc.site.minX === -80 &&
    desc.wind.speed === 7 && desc.ground.bearingCapacity === 25,
);
check(
  '풍향·돌풍·작업한계 편집',
  Math.abs(desc.wind.dir - Math.PI / 2) < 1e-9 &&
    desc.wind.gust.amp === 0.2 && desc.wind.gust.period === 30 && desc.wind.maxOperating === 14,
);
check(
  '작업자·이동장비 수와 이동규칙 생성',
  desc.agents.workers[0].count === 6 && desc.agents.vehicles[0].count === 2 &&
    desc.agents.vehicles[0].route.length === 4 && desc.agents.dangerRadius === 7,
);
console.log('\nALL PASS');
