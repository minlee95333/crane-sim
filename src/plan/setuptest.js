// P5 검증: 2D 정격표·동하중 여유·전도/지반 안정성·SetupPlanner.
// 실행: node src/plan/setuptest.js

import { LoadChart2D } from '../core/LoadChart2D.js';
import { checkStability } from '../core/Stability.js';
import { MobileCrane } from '../core/MobileCrane.js';
import { Simulation } from '../sim/Simulation.js';
import { checkLiftFeasible } from './AutoPilot.js';
import { evaluateSetup, suggestSetups } from './SetupPlanner.js';
import { CRAWLER_100T } from '../../data/cranes.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}

// --- 1) 2D 정격표 보간 ---
console.log('--- LoadChart2D ---');
const chart = new LoadChart2D(CRAWLER_100T.capacityChart);
check('붐 40m, r=22 → 15.5t (기존 표와 동일)', Math.abs(chart.capacityAt(40, 22) - 15.5) < 1e-9);
check('붐 52m, r=22 → 13t (긴 붐 = 감격)', Math.abs(chart.capacityAt(52, 22) - 13) < 1e-9);
check('붐 46m (중간) → 선형 보간 14.25t', Math.abs(chart.capacityAt(46, 22) - 14.25) < 1e-9);
check('표 밖 붐길이는 클램프', chart.capacityAt(30, 10) === 44 && chart.capacityAt(60, 50) === 1.8);
check('붐 40m은 r=45 도달 불가(0t), 52m은 가능', chart.capacityAt(40, 45) === 0 && Math.abs(chart.capacityAt(52, 45) - 2.6) < 0.01);

// 크레인 인스턴스: 붐 52m 변형
const long = new MobileCrane({ ...CRAWLER_100T, geometry: { ...CRAWLER_100T.geometry, boomLength: 52 } });
check('붐 52m 도달범위 max ≈ 51.4m', Math.abs(long.getRadiusRange()[1] - 51.43) < 0.05, `${long.getRadiusRange()[1].toFixed(2)}`);
check('붐 52m 크레인 정격 r=45 ≈ 2.6t', Math.abs(long.capacityAtRadius(45) - 2.6) < 0.01);

// --- 2) 전도/지반 안정성 ---
console.log('--- Stability ---');
let st = checkStability({ spec: CRAWLER_100T, boomLength: 40, radius: 12, loadMass: 25 });
check('r=12m, 25t → 전도 안전율 ≥ 1.33', st.tipOK === true, `margin=${st.tippingMargin.toFixed(2)}`);
st = checkStability({ spec: CRAWLER_100T, boomLength: 40, radius: 20, loadMass: 15 });
check('r=20m, 15t → 전도 여유 부족 (정격표는 통과해도)', st.tipOK === false, `margin=${st.tippingMargin.toFixed(2)}`);
st = checkStability({ spec: CRAWLER_100T, boomLength: 40, radius: 12, loadMass: 25, ground: { bearingCapacity: 15 } });
check('연약 지반(15t/m²) → 접지압 초과', st.groundOK === false, `p=${st.groundPressure.toFixed(1)}t/m²`);
st = checkStability({ spec: CRAWLER_100T, boomLength: 40, radius: 12, loadMass: 25, ground: { bearingCapacity: 25 } });
check('견고 지반(25t/m²) → 통과', st.groundOK === true && st.ok === true);
check('masses 없는 크레인은 skip', checkStability({ spec: { geometry: {} }, boomLength: 30, radius: 10, loadMass: 2 }).skipped === true);

// --- 3) checkLiftFeasible 통합 (동하중 여유 + 지반) ---
console.log('--- 타당성 검사 통합 ---');
// 동하중계수: 총 정격으로는 들 수 있지만 계획 여유(×1.1 + 후크블록)로는 탈락
let sim = new Simulation({
  cranes: [CRAWLER_100T],
  loads: [{ id: 'dyn', name: '경계하중', size: [3, 2, 3], mass: 15, pos: [22.5, 0, 0], target: [0, 22.5] }],
});
let fz = checkLiftFeasible(sim, 0, 'dyn');
check('동하중 여유 탈락 (15t, 총정격 15.0t)', fz.feasible === false && fz.reason.includes('동하중'), fz.reason);
check('런타임 총 정격으로는 가능 (계획이 더 보수적)', sim.world.cranes[0].capacityAtRadius(22.5) >= 15);

// 지반 조건: 같은 양중이 지반에 따라 갈림
const groundLoad = { id: 'g1', name: '기기', size: [3, 2, 3], mass: 18, pos: [14, 0, 0], target: [0, 14] };
sim = new Simulation({ cranes: [CRAWLER_100T], loads: [groundLoad], ground: { bearingCapacity: 12 } });
fz = checkLiftFeasible(sim, 0, 'g1');
check('연약 지반 → 셋업 불가', fz.feasible === false && fz.reason.includes('지반'), fz.reason);
sim = new Simulation({ cranes: [CRAWLER_100T], loads: [groundLoad], ground: { bearingCapacity: 25 } });
check('견고 지반 → 가능', checkLiftFeasible(sim, 0, 'g1').feasible === true);

// --- 4) SetupPlanner ---
console.log('--- SetupPlanner ---');
const LIFT_A = { id: 'a', pos: [30, 0], target: [30, 15], mass: 12 };
let ev = evaluateSetup(CRAWLER_100T, { pos: [0, 0], boomLength: 40 }, [LIFT_A]);
check('원거리 셋업(r=30) → 정격 부족', ev.feasible === false, ev.lifts[0].reason);
ev = evaluateSetup(CRAWLER_100T, { pos: [30, 7.5], boomLength: 40 }, [LIFT_A]);
check('근접 셋업(r=7.5) → 타당 + 큰 여유', ev.feasible === true && ev.minCapMargin > 40, `margin=${ev.minCapMargin.toFixed(1)}t`);

let sugg = suggestSetups(CRAWLER_100T, [LIFT_A]);
check('추천 셋업 존재', sugg.length >= 1);
check('최상위 추천은 짧은 붐(40m) 선호', sugg[0].boomLength === 40, `boom=${sugg[0].boomLength}, score=${sugg[0].score.toFixed(1)}`);

// 80m 떨어진 두 양중 → 붐 40m로는 어떤 위치에서도 불가, 52m만 가능
const FAR = [
  { id: 'L1', pos: [0, 0], target: [0, 6], mass: 2 },
  { id: 'L2', pos: [80, 0], target: [80, -6], mass: 2 },
];
sugg = suggestSetups(CRAWLER_100T, FAR);
check('원거리 2건: 후보 존재', sugg.length >= 1);
check('모든 후보가 긴 붐(52m) — 붐길이가 계획 변수', sugg.every((s) => s.boomLength === 52),
  sugg.length ? `top=[${sugg[0].pos.map((v) => v.toFixed(0))}] boom=${sugg[0].boomLength}` : '');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
