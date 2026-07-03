// M4 검증: RL 환경(Environment)이 관측·보상·종료를 올바르게 내는지.
// 렌더 없이 스크립트 정책으로 "픽업 → 선회 → 목표 안착"을 완주시켜 확인한다.
// 실행: node src/sim/envtest.js

import { Environment } from './Environment.js';
import { Simulation } from './Simulation.js';
import { Recorder, replay } from './Recorder.js';
import { PLACE_SCENARIO } from '../../data/cranes.js';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}

const TARGET_ANGLE = (40 * Math.PI) / 180;

// --- 1) 관측/리셋 형태 ---
const env = new Environment(PLACE_SCENARIO);
const obs0 = env.reset();
check('reset이 관측 벡터 반환', Array.isArray(obs0) && obs0.length === env.observationSize);
check('관측 차원 = 11', env.observationSize === 11, `size=${env.observationSize}`);
check('관측값 모두 유한', obs0.every(Number.isFinite));

// --- 2) 스크립트 정책으로 목표 안착 완주 ---
// 화이트박스 제어: 내부 상태를 보고 단계를 전환(스크립트 테스트라 허용).
env.reset();
let totalReward = 0;
let done = false;
let info = {};
let phase = 'lower'; // lower → pickup → lift → slew → drop → release → done
let stepBonusSeen = false;

for (let i = 0; i < env.opts.maxSteps && !done; i++) {
  const s = env.sim.getState();
  const c = s.cranes[0];
  const load = s.loads[0];
  let action = { slew: 0, luff: 0, hoist: 0, attach: false };

  switch (phase) {
    case 'lower': // 후크를 부재 상면 근처까지 내림
      action.hoist = -1;
      if (c.hookHeight < 4) phase = 'pickup';
      break;
    case 'pickup': // 줄걸이
      action.attach = true;
      phase = 'lift';
      break;
    case 'lift': // 부재를 충분히 들어올림 (지면 이격)
      action.hoist = 1;
      if (c.hookHeight > 14) phase = 'slew';
      break;
    case 'slew': // 목표 각도까지 선회
      action.slew = 1;
      if (c.slewAngle >= TARGET_ANGLE) phase = 'drop';
      break;
    case 'drop': // 목표 위에서 내림
      action.hoist = -1;
      if (load.pos[1] - load.size[1] / 2 <= 0.4) phase = 'release';
      break;
    case 'release': // 해제 → 안착
      action.attach = true;
      phase = 'done';
      break;
    default:
      break;
  }

  const r = env.step(action);
  totalReward += r.reward;
  done = r.done;
  info = r.info;
  if (r.info.placedThisStep) stepBonusSeen = true;
}

console.log(`  [완주] steps=${info.steps} totalReward=${totalReward.toFixed(2)} success=${info.success}`);
check('목표 안착 성공(success)', info.success === true);
check('안착 스텝에 placedThisStep 이벤트', stepBonusSeen === true);
check('누적 보상 양수', totalReward > 0, `R=${totalReward.toFixed(2)}`);
check('충돌 0회 (기준 궤적)', info.collisions === 0, `collisions=${info.collisions}`);
check('금지구역 침범 0회', info.violations === 0, `violations=${info.violations}`);
check('타임아웃 아님', info.timeout === false);

// --- 3) 무동작 정책 → 타임아웃, 실패 ---
const env2 = new Environment(PLACE_SCENARIO, { maxSteps: 200 });
env2.reset();
let d = false, last = {};
while (!d) {
  const r = env2.step({});
  d = r.done;
  last = r.info;
}
check('무동작 → 타임아웃', last.timeout === true);
check('무동작 → 실패(success=false)', last.success === false);

// --- 4) 결정론: 동일 정책 → 동일 보상 ---
function scriptedRun() {
  const e = new Environment(PLACE_SCENARIO);
  e.reset();
  let R = 0, dn = false, ph = 'lower';
  for (let i = 0; i < e.opts.maxSteps && !dn; i++) {
    const st = e.sim.getState();
    const cc = st.cranes[0];
    const ld = st.loads[0];
    let a = { slew: 0, luff: 0, hoist: 0, attach: false };
    if (ph === 'lower') { a.hoist = -1; if (cc.hookHeight < 4) ph = 'pickup'; }
    else if (ph === 'pickup') { a.attach = true; ph = 'lift'; }
    else if (ph === 'lift') { a.hoist = 1; if (cc.hookHeight > 14) ph = 'slew'; }
    else if (ph === 'slew') { a.slew = 1; if (cc.slewAngle >= TARGET_ANGLE) ph = 'drop'; }
    else if (ph === 'drop') { a.hoist = -1; if (ld.pos[1] - ld.size[1] / 2 <= 0.4) ph = 'release'; }
    else if (ph === 'release') { a.attach = true; ph = 'done'; }
    const rr = e.step(a);
    R += rr.reward; dn = rr.done;
  }
  return R;
}
check('결정론: 동일 정책 → 동일 누적보상', Math.abs(scriptedRun() - scriptedRun()) < 1e-9);

// --- 5) 안전 관측 옵션 ---
const envS = new Environment(PLACE_SCENARIO, { observeSafety: true });
check('observeSafety 관측 차원 = 14', envS.observationSize === 14, `size=${envS.observationSize}`);
check('안전 관측값 유한', envS.reset().every(Number.isFinite));

// --- 6) 기록/리플레이 결정론 ---
// 프레임 단위(브라우저와 동일 경로)로 기록 → 새 sim에 재생 → 최종 상태 일치
const recSim = new Simulation(PLACE_SCENARIO);
recSim.reset();
const rec = new Recorder();
rec.start('place-basic');
const FRAME = 1 / 30; // 렌더 프레임 dt (고정스텝과 다르게 잡아 accumulator 경로 검증)
const runFrame = (cmds, at = -1) => {
  if (at >= 0) recSim.toggleAttach(at);
  rec.frame(FRAME, recSim.timeScale, cmds, at);
  recSim.step(FRAME, cmds);
};
recSim.setTimeScale(2);
for (let i = 0; i < 900; i++) runFrame([{ hoist: -1 }]); // 권하
runFrame([{}], 0); // 픽업 토글
for (let i = 0; i < 300; i++) runFrame([{ hoist: 1 }]); // 권상
for (let i = 0; i < 600; i++) runFrame([{ slew: 1 }]); // 선회
const recording = rec.stop();
const liveState = JSON.stringify(recSim.getState());
const replayState = JSON.stringify(replay(new Simulation(PLACE_SCENARIO), recording));
check('리플레이 = 라이브 최종 상태 일치', liveState === replayState);
check('기록 프레임 수 일치', recording.frames.length === 1801, `frames=${recording.frames.length}`);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
