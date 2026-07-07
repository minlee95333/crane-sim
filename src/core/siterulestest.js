import {
  evaluateAssembly, evaluateLaydown, evaluateOutriggers, heightLimitAt,
  powerLineClearance, resourceAvailability, shiftAt, weatherAt,
} from './SiteRules.js';

function check(label, ok) {
  if (!ok) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

console.log('--- P7.15~P7.20 현장 규칙 ---');
const lines = [{ id: 'L', a: [0, 10, 0], b: [20, 10, 0], clearance: 6 }];
check('전력선 3D 최소이격 위반', !powerLineClearance([10, 12, 0], lines).safe);
check('전력선 원거리 통과', powerLineClearance([10, 20, 0], lines).safe);
check('고도 제한 구역 위반', !heightLimitAt([5, 16, 5], [{ id: 'H', min: [0, 0], max: [10, 10], maxHeight: 15 }]).safe);

const weather = { rain: { timeline: [[0, 0], [100, 12]] }, maxRain: 10,
  lightning: { value: 20 }, minLightningDistance: 10 };
check('기상 시간창 전 작업 가능', !weatherAt(weather, 50).blocked);
check('강우 임계 초과 작업중지', weatherAt(weather, 120).reasons.includes('rain'));
check('교대 외 시간 작업중지', !shiftAt([{ id: 'day', start: 8 * 3600, end: 17 * 3600 }], 20 * 3600).available);
check('공유 리거 부족 검출', !resourceAvailability([{ type: 'rigger', count: 2 }], { rigger: 2 }, [{ type: 'rigger', count: 1 }]).available);

const yard = { slots: [{ id: 'A', size: [10, 3], maxLayers: 2, maxMass: 10 }] };
const laydown = evaluateLaydown([
  { id: 'late', size: [5, 1, 1], mass: 3, erectionOrder: 2 },
  { id: 'early', size: [5, 1, 1], mass: 3, erectionOrder: 1 },
], yard);
check('야적 슬롯·적층 배정', laydown.feasible && laydown.placements.length === 2);
check('역순 적층 재취급 산출', Array.isArray(laydown.rehandles));

const outrigger = evaluateOutriggers({
  masses: { base: 40, counterweight: 20 },
  outrigger: { points: [[-3, -3], [3, -3], [-3, 3], [3, 3]], padArea: 1 },
}, { pos: [0, 0], loadMass: 20, radius: 10, defaultBearingCapacity: 100 },
[{ min: [0, -5], max: [5, 5], bearingCapacity: 5 }]);
check('개별 아웃리거 연약지반 실패', !outrigger.feasible && outrigger.pads.some((p) => !p.safe));

check('조립면적 부족 검출', !evaluateAssembly({}, null,
  { id: 'long', assemblyArea: [30, 10], duration: 3600 },
  { assemblyArea: [20, 20] }).feasible);
check('보조크레인 요구 검출', !evaluateAssembly({}, null,
  { id: 'jib', assemblyArea: [10, 10], assistCraneRequired: true },
  { assemblyArea: [20, 20], assistCranes: 0 }).feasible);

console.log('\nALL PASS');
