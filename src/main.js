// 조립·메인 루프.
// M4+: 시나리오 라이브러리 + 환경 렌더(목표/장애물/금지구역) + 다중 크레인 + 기록/리플레이.
// 루프 구조: 입력 → sim.step(dt, commands) → 상태 → 뷰 반영 → 렌더
import { SceneManager } from './render/SceneManager.js';
import { MobileCraneView } from './render/MobileCraneView.js';
import { TowerCraneView } from './render/TowerCraneView.js';
import { LoadView } from './render/LoadView.js';
import { SiteView } from './render/SiteView.js';
import { Simulation } from './sim/Simulation.js';
import { Recorder, replay } from './sim/Recorder.js';
import { KeyboardControl } from './control/KeyboardControl.js';
import { Dashboard } from './ui/Dashboard.js';
import { SchedulePlayer } from './plan/SchedulePlayer.js';
import { generateValidatedMacroPlan } from './plan/PlanRepair.js';
import { evaluateManualPlan } from './plan/ManualPlanner.js';
import { validateSchedule3D } from './plan/ScheduleValidator.js';
import { SCENARIOS } from '../data/scenarios.js';

const container = document.getElementById('app');
const hud = document.getElementById('hud');
const dashboardRoot = document.getElementById('dashboard');

const sceneManager = new SceneManager(container);
const keyboard = new KeyboardControl();
const recorder = new Recorder();

const rad2deg = (r) => (r * 180) / Math.PI;

// --- 시나리오 상태 ---
let scenarioIdx = 1; // 시작: S1 기본 안착
let sim = null;
let craneViews = [];
let loadView = null;
let siteView = null;
let activeCrane = 0; // 조종 중인 크레인 (Tab 전환)
let paused = false;
let macroPlan = null;
let planPlayer = null;
let pendingSetupIndex = null;

// --- 리플레이 상태 ---
let lastRecording = null;
let playback = null; // { frames, i } — 재생 중이면 non-null

const dashboard = new Dashboard(dashboardRoot, SCENARIOS, {
  scenario: (index) => loadScenario(index),
  crane: (index) => { activeCrane = index; },
  speed: (speed) => sim.setTimeScale(speed),
  pause: () => { paused = !paused; },
  reset: () => loadScenario(scenarioIdx),
  attach: () => {
    if (!playback && !paused) sim.toggleAttach(activeCrane);
  },
  record: () => toggleRecording(),
  replay: () => startReplay(),
  plan: () => {
    try {
      macroPlan = generateValidatedMacroPlan(SCENARIOS[scenarioIdx].scenario, {
        policy: dashboard.getPlanPolicy(),
        hardClearance: SCENARIOS[scenarioIdx].scenario.planning?.hardClearance,
        softClearance: SCENARIOS[scenarioIdx].scenario.planning?.softClearance,
        sampleStep: 5,
      });
      planPlayer = new SchedulePlayer(SCENARIOS[scenarioIdx].scenario, macroPlan);
      dashboard.setPlanResult(macroPlan);
    } catch (error) {
      dashboard.setPlanResult(null);
      console.error(error);
    }
  },
  planPlay: () => {
    if (!planPlayer) return;
    planPlayer.toggle();
  },
  planReset: () => planPlayer?.reset(),
  planSpeed: (speed) => planPlayer?.setSpeed(speed),
  planSeek: (time) => planPlayer?.seek(time),
  manualPlan: (plan) => {
    try {
      const scenario = SCENARIOS[scenarioIdx].scenario;
      macroPlan = evaluateManualPlan(scenario, plan, {
        hardClearance: scenario.planning?.hardClearance,
        softClearance: scenario.planning?.softClearance,
      });
      macroPlan.validation3D = validateSchedule3D(scenario, macroPlan, { sampleStep: 5 });
      planPlayer = new SchedulePlayer(scenario, macroPlan);
      dashboard.setPlanResult(macroPlan);
    } catch (error) {
      dashboard.showPlanError(error.message);
    }
  },
  requestSetupPick: (index) => {
    pendingSetupIndex = index;
  },
});

sceneManager.onGroundDoubleClick((pos) => {
  if (pendingSetupIndex == null) return;
  const index = pendingSetupIndex;
  pendingSetupIndex = null;
  dashboard.applySetupPoint(index, pos);
});

function craneViewFor(spec) {
  return spec.type === 'tower' ? new TowerCraneView(spec) : new MobileCraneView(spec);
}

/** 시나리오 로드: sim·뷰 전부 재구성 */
function loadScenario(idx) {
  scenarioIdx = ((idx % SCENARIOS.length) + SCENARIOS.length) % SCENARIOS.length;
  const entry = SCENARIOS[scenarioIdx];

  // 기존 뷰 제거
  for (const v of craneViews) sceneManager.scene.remove(v.root);
  if (loadView) sceneManager.scene.remove(loadView.root);
  if (siteView) sceneManager.scene.remove(siteView.root);

  sim = new Simulation(entry.scenario);
  sim.setTimeScale(5); // 실제 크레인 속도는 느리므로 기본 ×5
  activeCrane = 0;
  paused = false;
  macroPlan = null;
  planPlayer = null;
  pendingSetupIndex = null;
  playback = null;
  if (recorder.active) recorder.stop();

  const state = sim.getState();
  craneViews = entry.scenario.cranes.map((spec) => {
    const view = craneViewFor(spec);
    sceneManager.scene.add(view.root);
    return view;
  });
  loadView = new LoadView(state.loads);
  sceneManager.scene.add(loadView.root);
  siteView = new SiteView(state, entry.scenario);
  sceneManager.scene.add(siteView.root);
  const framePoints = [
    ...entry.scenario.cranes.map((c) => c.basePos),
    ...(entry.scenario.loads ?? []).flatMap((l) => [
      l.pos,
      l.target,
      ...(l.route ?? []).map((leg) => leg.target),
    ].filter(Boolean)),
  ];
  sceneManager.framePoints(framePoints);
  dashboard.setScenario(scenarioIdx);
  dashboard.setCranes(entry.scenario.cranes, activeCrane);
  dashboard.setPlanResult(null);
}

loadScenario(scenarioIdx);

// --- 키 입력 (배속·시나리오·크레인 전환·기록/리플레이) ---
window.addEventListener('keydown', (e) => {
  if (e.code === 'Tab') e.preventDefault();

  if (e.code === 'Digit1') sim.setTimeScale(1);
  if (e.code === 'Digit2') sim.setTimeScale(5);
  if (e.code === 'Digit3') sim.setTimeScale(10);
  if (e.code === 'Digit4') sim.setTimeScale(20);

  if (e.code === 'KeyN') loadScenario(scenarioIdx + (e.shiftKey ? -1 : 1));
  if (e.code === 'KeyO') loadScenario(scenarioIdx); // 현재 시나리오 리셋

  if (e.code === 'Tab') {
    activeCrane = (activeCrane + 1) % sim.getState().cranes.length;
    dashboard.setActiveCrane(activeCrane);
  }

  // R: 기록 시작/종료(종료 시 JSON 다운로드)
  if (e.code === 'KeyR' && !playback) {
    toggleRecording();
  }

  // P: 마지막 기록 리플레이
  if (e.code === 'KeyP' && lastRecording && !recorder.active) {
    startReplay();
  }
});

function toggleRecording() {
  if (playback) return;
  if (recorder.active) {
    const data = recorder.stop();
    downloadJSON(data, `episode-${data.scenarioId}-${Date.now()}.json`);
    lastRecording = data;
  } else {
    loadScenario(scenarioIdx);
    recorder.start(SCENARIOS[scenarioIdx].id);
  }
}

function startReplay() {
  if (!lastRecording || recorder.active) return;
  const recIdx = SCENARIOS.findIndex((s) => s.id === lastRecording.scenarioId);
  if (recIdx >= 0) {
    loadScenario(recIdx);
    playback = { frames: lastRecording.frames, i: 0 };
  }
}

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- 메인 루프 ---
let lastTime = performance.now();
let frames = 0;
let fps = 0;
let fpsTimer = 0;

function loop(now) {
  const frameDt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  // FPS 측정
  frames += 1;
  fpsTimer += frameDt;
  if (fpsTimer >= 0.5) {
    fps = Math.round(frames / fpsTimer);
    frames = 0;
    fpsTimer = 0;
  }

  const nCranes = sim.getState().cranes.length;
  let state;
  let command = { slew: 0, luff: 0, hoist: 0 };

  if (planPlayer) {
    planPlayer.update(frameDt);
    state = planPlayer.stateAt(sim.getState());
  } else if (playback) {
    // --- 리플레이: 기록된 프레임을 순서대로 재생 ---
    const f = playback.frames[playback.i];
    if (f) {
      if (f.at != null && f.at >= 0) sim.toggleAttach(f.at);
      sim.setTimeScale(f.ts ?? 1);
      state = sim.step(f.dt, f.cmds);
      command = f.cmds[activeCrane] ?? command;
      playback.i += 1;
    } else {
      playback = null; // 재생 끝
      state = sim.getState();
    }
  } else if (!paused) {
    // --- 라이브: 키보드 → 활성 크레인 ---
    let attachId = -1;
    if (keyboard.consumeAttach()) {
      sim.toggleAttach(activeCrane);
      attachId = activeCrane;
    }
    const keyCommand = keyboard.getCommand();
    const panelCommand = dashboard.getCommand();
    const clamp1 = (v) => Math.max(-1, Math.min(1, v));
    command = {
      slew: clamp1(keyCommand.slew + panelCommand.slew),
      luff: clamp1(keyCommand.luff + panelCommand.luff),
      hoist: clamp1(keyCommand.hoist + panelCommand.hoist),
      drive: clamp1((keyCommand.drive ?? 0) + (panelCommand.drive ?? 0)),
      steer: clamp1((keyCommand.steer ?? 0) + (panelCommand.steer ?? 0)),
    };
    const commands = Array.from({ length: nCranes }, (_, i) =>
      i === activeCrane ? command : { slew: 0, luff: 0, hoist: 0 },
    );
    recorder.frame(frameDt, sim.timeScale, commands, attachId);
    state = sim.step(frameDt, commands);
  } else {
    state = sim.getState();
  }

  state.cranes.forEach((cs, i) => craneViews[i].update(cs));
  siteView.update(state); // 트럭 등 현장 상태 (부재 동반 이동은 코어가 처리)
  loadView.update(state.loads, state.trucks);

  sceneManager.render();
  drawHUD(state, command);
  dashboard.update(state, activeCrane, {
    speed: sim.timeScale,
    paused,
    recording: recorder.active,
    playing: Boolean(playback),
    canReplay: Boolean(lastRecording),
  });
  if (planPlayer) dashboard.setPlanPlayback(planPlayer.playing, planPlayer.time, macroPlan.makespan);
  requestAnimationFrame(loop);
}

function drawHUD(state, command) {
  const entry = SCENARIOS[scenarioIdx];
  const c = state.cranes[activeCrane];
  const ratioPct = c.loadMass > 0 ? (c.loadRatio * 100).toFixed(0) : '-';
  const limiterMsg = c.extra.limiterActive
    ? '\n⛔ 모멘트 리미터 작동: 권상·반경확대 차단 (반경을 줄이세요)'
    : '';

  // 임무(목표) 진행 상황
  const targetLoads = state.loads.filter((l) => l.target);
  const placed = targetLoads.filter((l) => l.state === 'placed').length;
  let missionLine = '임무     : (자유 연습 — 목표 없음)';
  if (targetLoads.length > 0) {
    const current = targetLoads.find((l) => l.state !== 'placed');
    if (!current) {
      missionLine = `임무     : ✅ 완료! (${placed}/${targetLoads.length} 안착)`;
    } else {
      const hook = c.hookPos;
      const dist =
        current.state === 'hooked'
          ? Math.hypot(current.pos[0] - current.target[0], current.pos[2] - current.target[1])
          : Math.hypot(hook[0] - current.pos[0], hook[2] - current.pos[2]);
      const phase = current.state === 'hooked' ? '목표까지' : '부재까지';
      missionLine = `임무     : ${placed}/${targetLoads.length} 안착 | ${current.name} ${phase} ${dist.toFixed(1)}m`;
    }
  }

  // 리깅 작업 상태 (활성 크레인)
  const rigLoad = state.loads.find(
    (l) => l.hookedBy === activeCrane && (l.state === 'rigging' || l.state === 'derigging'),
  );
  const rigLine = rigLoad
    ? `\n🔧 ${rigLoad.state === 'rigging' ? '줄걸이' : '해체'} 작업 중: ${rigLoad.name} (남은 ${rigLoad.rigRemain.toFixed(0)}s — 크레인 동결)`
    : '';

  const s = state.safety ?? { collisionCount: 0, violationCount: 0, collisionIds: [], zoneViolation: false };
  const clashNow = (s.cranePairs ?? []).some((p) => p.clash);
  const safetyWarn =
    (s.collisionIds.length > 0 ? ` ⚠충돌중(${s.collisionIds.join(',')})` : '') +
    (s.zoneViolation ? ' ⚠금지구역!' : '') +
    (clashNow ? ' ⚠크레인간섭!' : '');
  const clearanceInfo =
    state.cranes.length > 1 && Number.isFinite(s.craneMinClearance)
      ? ` · 붐이격 ${s.craneMinClearance.toFixed(1)}m · 크레인충돌 ${s.craneClashCount ?? 0}회`
      : '';
  const swayLine = c.extra.swayMag > 0.05 ? ` | 흔들림 ${c.extra.swayMag.toFixed(2)}m` : '';
  const windLine = state.wind
    ? `\n풍속     : ${state.wind.speed.toFixed(1)} m/s${state.wind.maxOperating ? ` (한계 ${state.wind.maxOperating})` : ''}${state.wind.maxOperating && state.wind.speed > state.wind.maxOperating ? ' ⛔ 작업중지' : ''}`
    : '';

  const recLine = recorder.active
    ? `\n● REC 기록 중 (${recorder.frameCount}f) — R로 종료·저장`
    : playback
      ? `\n▶ 리플레이 재생 중 (${playback.i}/${playback.frames.length}f)`
      : '';

  const craneLabel =
    state.cranes.length > 1
      ? `크레인   : [${activeCrane + 1}/${state.cranes.length}] ${sim.scenario.cranes[activeCrane].name} (Tab 전환)`
      : `크레인   : ${sim.scenario.cranes[0].name}`;

  const radiusLabel = c.type === 'tower' ? '트롤리   ' : '작업반경 ';

  hud.textContent = [
    `Crane Sim — ${entry.name} | FPS ${fps} | t=${state.time.toFixed(1)}s | 배속 ×${sim.timeScale}`,
    `${entry.desc}`,
    ``,
    craneLabel,
    `입력     : slew=${command.slew} luff=${command.luff} hoist=${command.hoist}${c.type !== 'tower' ? ` drive=${command.drive ?? 0} steer=${command.steer ?? 0}` : ''}`,
    c.type !== 'tower'
      ? `주행     : ${(c.extra.driveVel ?? 0).toFixed(2)} m/s · 헤딩 ${rad2deg(c.extra.driveYaw ?? 0).toFixed(0)}° · 위치 (${c.basePos[0].toFixed(1)}, ${c.basePos[2].toFixed(1)})`
      : `위치     : 고정식 (마스트)`,
    `선회각   : ${rad2deg(c.slewAngle).toFixed(1)}°`,
    `${radiusLabel}: ${c.radius.toFixed(2)} m`,
    `후크높이 : ${c.hookHeight.toFixed(2)} m${swayLine}${windLine}`,
    `정격하중 : ${c.capacity.toFixed(1)} t`,
    `인양하중 : ${c.loadMass > 0 ? c.loadMass.toFixed(1) + ' t' : '(없음)'}`,
    `하중률   : ${ratioPct}%${c.loadRatio >= 0.9 && c.loadMass > 0 ? ' ⚠' : ''}${limiterMsg}${rigLine}`,
    ``,
    missionLine,
    `안전     : 충돌 ${s.collisionCount}회 · 금지구역 ${s.violationCount}회${clearanceInfo}${safetyWarn}`,
    `이벤트   : ${state.lastEvent ?? '-'}`,
    `${recLine}`,
    ``,
    `[주행] W/S 전·후진  A/D 좌·우회전    [팔] ←/→ 선회  ↑/↓ 기복  Q/E 권상·권하  Space 픽업`,
    `N 다음 시나리오  O 리셋  Tab 크레인 전환  1~4 배속  R 기록  P 리플레이`,
    `마우스: 회전 | 휠: 줌 | 우클릭: 이동`,
  ].join('\n');
}

requestAnimationFrame(loop);
