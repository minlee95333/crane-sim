import { Simulation } from '../sim/Simulation.js';
import { CRAWLER_100T } from '../../data/cranes.js';
import { angleDelta } from './World.js';
import { evaluateSling } from './Rigging.js';
import { calculateScore } from './Score.js';
import { Recorder } from '../sim/Recorder.js';
import { SCENARIOS } from '../../data/scenarios.js';

function check(label, condition, detail = '') {
  if (!condition) throw new Error(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  PASS: ${label}${detail ? ` — ${detail}` : ''}`);
}

const deg = (value) => value * Math.PI / 180;

console.log('--- targetYaw·태그라인 ---');
const scenario = {
  cranes: [{ ...CRAWLER_100T, physics: { loadYaw: true } }],
  loads: [{
    id: 'yaw-load', size: [6, 1, 1], mass: 2, pos: [21.2, 0, 0], target: [21.2, 0],
    targetYaw: deg(90), slingHeight: 6,
  }],
};
const sim = new Simulation(scenario);
const crane = sim.world.cranes[0];
const load = sim.world.loads[0];
crane.setHookHeight(load.topY + 1.2);
check('부재 픽업', sim.toggleAttach(0).ok);
load.pos[1] = load.size[1] / 2;
load.yaw = 0;
let preview = sim.world.releasePreview(0);
check('위치는 맞지만 자세 오차로 해제 차단', preview.onTarget && !preview.yawOk && !preview.canRelease);
check('각도 오차는 최단각 90°', Math.abs(Math.abs(preview.yawError) - deg(90)) < 1e-9);
const before = load.yaw;
for (let i = 0; i < 240; i++) sim.world.step(1 / 60, [{ tag: 1 }]);
check('태그라인 명령이 부재 요를 변경', load.yaw > before + deg(5));
load.yaw = deg(85);
load.pos[1] = load.size[1] / 2;
preview = sim.world.releasePreview(0);
check('±10° 이내 자세는 해제 가능', preview.yawOk && preview.canRelease);
check('안착 성공과 자세 오차 기록', sim.toggleAttach(0).placed && Math.abs(load.placementYawError) <= deg(10));
check('목표 자세로 스냅', Math.abs(angleDelta(load.yaw, deg(90))) < 1e-9);

console.log('--- 슬링 장력 ---');
const safe = evaluateSling({ size: [4, 1, 2], mass: 12, slingHeight: 4 });
check('장력 수직성분 합 = 총 하중', Math.abs(safe.totalVertical - 12) < 1e-9);
check('가닥당 장력 유한 양수', Number.isFinite(safe.tensionPerLeg) && safe.tensionPerLeg > 0);
const shallow = evaluateSling({
  size: [12, 1, 2], mass: 12, slingHeight: 2, blockUnsafeSling: true,
});
check('60° 미만 슬링 경고·옵션 차단', shallow.warning && shallow.blocked);

console.log('--- 완료 채점 ---');
const scoreState = {
  time: 120,
  loads: [{
    target: [0, 0], state: 'placed', placementError: 0.1, placementYawError: deg(2),
  }],
  safety: { collisionCount: 0, violationCount: 0, craneClashCount: 0, agentHoldTime: 5 },
};
const score = calculateScore(scoreState, { parTime: 150 });
check('완료 상태에 0~100점·1~5별 산출', score.value >= 0 && score.value <= 100 &&
  score.stars >= 1 && score.stars <= 5);
check('미완료 상태는 채점 없음', calculateScore({ ...scoreState, loads: [{ target: [0, 0], state: 'ground' }] }) === null);
const unsafeScore = calculateScore({
  ...scoreState,
  safety: { collisionCount: 2, violationCount: 1, craneClashCount: 0, agentHoldTime: 30 },
}, { parTime: 150 });
check('안전 위반은 점수를 낮춤', unsafeScore.value < score.value);
const recorder = new Recorder();
recorder.start('score-test');
recorder.frame(1 / 60, 1, [{ tag: 1, drive: 0.5 }]);
const recording = recorder.stop(score);
check('Recorder에 tag 명령과 완료 점수 동봉', recording.frames[0].cmds[0].tag === 1 &&
  recording.score.value === score.value);
const s14 = SCENARIOS.find((entry) => entry.id === 'yaw-rig-score').scenario;
check('S14가 targetYaw·loadYaw·채점 데이터로 활성화', s14.loads[0].targetYaw != null &&
  s14.cranes[0].physics.loadYaw && s14.scoring.parTime > 0);

console.log('\nALL PASS');
