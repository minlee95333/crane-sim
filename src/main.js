// 조립·메인 루프.
// M4+: 시나리오 라이브러리 + 환경 렌더(목표/장애물/금지구역) + 다중 크레인 + 기록/리플레이.
// 루프 구조: 입력 → sim.step(dt, commands) → 상태 → 뷰 반영 → 렌더
import { SceneManager } from './render/SceneManager.js';
import { MobileCraneView } from './render/MobileCraneView.js';
import { TowerCraneView } from './render/TowerCraneView.js';
import { LoadView } from './render/LoadView.js';
import { SiteView } from './render/SiteView.js';
import { Effects } from './render/Effects.js';
import { AgentView } from './render/AgentView.js';
import { CameraRig } from './render/CameraRig.js';
import { SoundView } from './render/SoundView.js';
import { OverlayView } from './render/OverlayView.js';
import { ScreenWidgets } from './render/ScreenWidgets.js';
import { Simulation } from './sim/Simulation.js';
import { Recorder, replay } from './sim/Recorder.js';
import { KeyboardControl } from './control/KeyboardControl.js';
import { Dashboard } from './ui/Dashboard.js';
import { SchedulePlayer } from './plan/SchedulePlayer.js';
import { generateValidatedMacroPlan } from './plan/PlanRepair.js';
import { evaluateManualPlan } from './plan/ManualPlanner.js';
import { validateSchedule3D } from './plan/ScheduleValidator.js';
import { SCENARIOS } from '../data/scenarios.js';
import {
  addDescriptorObject, buildScenario, descriptorFromScenario, emptyDescriptor,
  parseDescriptor, removeDescriptorObject, updateDescriptorEnvironment, updateDescriptorObject,
} from './editor/scenario.js';
import {
  applyVisualEdit, stageVisualEdit, VisualScenarioEditor,
} from './editor/VisualScenarioEditor.js';
import { validateScenarioQuick } from './editor/QuickScenarioValidator.js';
import { QuickValidationView } from './editor/QuickValidationView.js';
import { DescriptorHistory } from './editor/DescriptorHistory.js';
import { calibrationReport } from './plan/Calibration.js';

const container = document.getElementById('app');
const hud = document.getElementById('hud');
const dashboardRoot = document.getElementById('dashboard');

const sceneManager = new SceneManager(container);
const keyboard = new KeyboardControl();
const recorder = new Recorder();
const cameraRig = new CameraRig(sceneManager.camera, sceneManager.controls);
const sound = new SoundView();
// 플레이 보조 오버레이 (P7.11): 씬 앵커 마커 + 화면 위젯 — H 토글
const overlayView = new OverlayView();
sceneManager.scene.add(overlayView.root);
const quickValidationView = new QuickValidationView();
quickValidationView.root.visible = false;
sceneManager.scene.add(quickValidationView.root);
const widgets = new ScreenWidgets(document.getElementById('overlay'));
let assistOn = true;
let hudOn = true; // 좌상단 정보창 (I 토글)
// 브라우저 자동재생 정책: 첫 제스처에서 오디오 컨텍스트 생성
for (const evt of ['pointerdown', 'keydown']) {
  window.addEventListener(evt, () => sound.unlock(), { once: true });
}

const rad2deg = (r) => (r * 180) / Math.PI;

// --- 시나리오 상태 ---
let scenarioIdx = 1; // 시작: S1 기본 안착
let sim = null;
let craneViews = [];
let loadView = null;
let siteView = null;
let agentView = null;
let effects = null;
let activeCrane = 0; // 조종 중인 크레인 (Tab 전환)
let paused = false;
let macroPlan = null;
let planPlayer = null;
let pendingSetupIndex = null;
let scoreShown = false;
let customScenarioIndex = -1;
let visualEditOn = false;
let visualDescriptor = null;
let pausedBeforeVisual = false;
let visualEditor = null;
let visualDirty = false;
const visualStagedEdits = new Map();
const editorHistory = new DescriptorHistory(50);

// --- 리플레이 상태 ---
let lastRecording = null;
let playback = null; // { frames, i } — 재생 중이면 non-null

const dashboard = new Dashboard(dashboardRoot, SCENARIOS, {
  scenario: (index) => {
    if (visualEditOn) toggleVisualEdit();
    loadScenario(index);
    resetEditorHistory();
  },
  crane: (index) => { activeCrane = index; },
  speed: (speed) => sim.setTimeScale(speed),
  pause: () => { paused = !paused; },
  reset: () => {
    if (visualEditOn) toggleVisualEdit();
    loadScenario(scenarioIdx);
    resetEditorHistory();
  },
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
  scenarioTemplate: () => {
    dashboard.setScenarioJSON(emptyDescriptor());
    dashboard.showScenarioValidation([]);
  },
  scenarioApply: () => {
    const parsed = parseDescriptor(dashboard.getScenarioJSON());
    if (!parsed.valid) {
      dashboard.showScenarioValidation(parsed.errors);
      return;
    }
    commitEditorHistory(parsed.descriptor);
    applyCustomDescriptor(parsed.descriptor);
  },
  scenarioSave: () => {
    const parsed = parseDescriptor(dashboard.getScenarioJSON());
    if (!parsed.valid) return dashboard.showScenarioValidation(parsed.errors);
    downloadJSON(parsed.descriptor, `scenario-${Date.now()}.json`);
  },
  scenarioLoad: () => dashboard.openScenarioFile(),
  visualEdit: () => toggleVisualEdit(),
  editorUndo: () => restoreEditorHistory(editorHistory.undo()),
  editorRedo: () => restoreEditorHistory(editorHistory.redo()),
  objectAdd: () => {
    const descriptor = editableDescriptor();
    const item = addDescriptorObject(descriptor, dashboard.getObjectKind());
    applyEditedDescriptor(descriptor, { kind: dashboard.getObjectKind(), id: item.id });
  },
  objectUpdate: () => {
    const selected = dashboard.getSelectedObject();
    if (!selected) return;
    const descriptor = editableDescriptor();
    updateDescriptorObject(descriptor, selected.kind, selected.id, dashboard.getObjectValues());
    applyEditedDescriptor(descriptor, selected);
  },
  objectDelete: () => {
    const selected = dashboard.getSelectedObject();
    if (!selected) return;
    const descriptor = editableDescriptor();
    removeDescriptorObject(descriptor, selected.kind, selected.id);
    applyEditedDescriptor(descriptor);
  },
  environmentUpdate: () => {
    const descriptor = editableDescriptor();
    updateDescriptorEnvironment(descriptor, dashboard.getEnvironmentValues());
    applyEditedDescriptor(descriptor);
  },
  calibrate: () => {
    const scenario = SCENARIOS[scenarioIdx].scenario;
    const cases = (scenario.loads ?? []).slice(0, 3).map((load) => ({ craneId: 0, loadId: load.id }));
    dashboard.showCalibration(calibrationReport(scenario, cases));
  },
  requestSetupPick: (index) => {
    pendingSetupIndex = index;
  },
  camera: () => {
    cameraRig.cycle();
    dashboard.setCameraMode(cameraRig.label);
  },
  mute: () => dashboard.setMuted(sound.toggleMute()),
  hud: () => {
    hudOn = !hudOn;
    hud.style.display = hudOn ? '' : 'none';
    dashboard.setHud(hudOn);
  },
  assist: () => {
    assistOn = !assistOn;
    widgets.setEnabled(assistOn);
    dashboard.setAssist(assistOn);
  },
});

visualEditor = new VisualScenarioEditor({
  camera: sceneManager.camera,
  domElement: sceneManager.renderer.domElement,
  scene: sceneManager.scene,
  controls: sceneManager.controls,
  getObjects: () => [
    ...craneViews.map((view) => view.root),
    ...(loadView ? [...loadView.meshes.values()] : []),
    ...(siteView ? [
      ...[...siteView.targets.values()].flatMap((target) => [target.fill, target.ring]),
      ...siteView.obstacles.values(),
      ...[...siteView.noFlyZones.values()].flatMap((zone) => [zone.fill, zone.border]),
    ] : []),
  ],
  onPreview: (edit) => previewVisualEdit(edit),
  onSelect: (selection) => dashboard.selectScenarioObject(selection),
  onCommit: (edit) => {
    applyVisualEdit(visualDescriptor, edit);
    stageVisualEdit(visualStagedEdits, edit);
    commitEditorHistory(visualDescriptor);
    dashboard.setScenarioJSON(visualDescriptor);
    visualDirty = true;
    dashboard.showScenarioPending();
    updateQuickValidation();
  },
});

sceneManager.onGroundDoubleClick((pos) => {
  if (pendingSetupIndex == null) return;
  const index = pendingSetupIndex;
  pendingSetupIndex = null;
  scoreShown = false;
  widgets.hideScore();
  dashboard.applySetupPoint(index, pos);
});

function craneViewFor(spec) {
  return spec.type === 'tower' ? new TowerCraneView(spec) : new MobileCraneView(spec);
}

function editableDescriptor() {
  return visualDescriptor
    ? structuredClone(visualDescriptor)
    : descriptorFromScenario(SCENARIOS[scenarioIdx].scenario, SCENARIOS[scenarioIdx].name);
}

function applyEditedDescriptor(descriptor, selected = null) {
  commitEditorHistory(descriptor);
  dashboard.setScenarioJSON(descriptor);
  applyCustomDescriptor(descriptor);
  dashboard.setEditorDescriptor(visualDescriptor, selected);
}

function syncEditorHistory() {
  dashboard.setEditorHistory(editorHistory.canUndo, editorHistory.canRedo);
}

function resetEditorHistory() {
  editorHistory.reset(visualDescriptor);
  syncEditorHistory();
}

function commitEditorHistory(descriptor) {
  editorHistory.commit(descriptor);
  syncEditorHistory();
}

function restoreEditorHistory(descriptor) {
  if (!descriptor) return syncEditorHistory();
  dashboard.setScenarioJSON(descriptor);
  applyCustomDescriptor(descriptor);
  dashboard.setEditorDescriptor(visualDescriptor);
  syncEditorHistory();
}

function applyCustomDescriptor(descriptor) {
  visualDescriptor = structuredClone(descriptor);
  const entry = {
    id: 'custom',
    name: descriptor.name ?? '사용자 시나리오',
    desc: '시나리오 편집기에서 생성',
    scenario: buildScenario(descriptor),
  };
  if (customScenarioIndex < 0) {
    SCENARIOS.push(entry);
    customScenarioIndex = SCENARIOS.length - 1;
    dashboard.addScenario(entry, customScenarioIndex);
  } else {
    SCENARIOS[customScenarioIndex] = entry;
    dashboard.renameScenario(customScenarioIndex, entry.name);
  }
  dashboard.showScenarioValidation([]);
  visualDirty = false;
  visualStagedEdits.clear();
  loadScenario(customScenarioIndex);
}

function toggleVisualEdit() {
  visualEditOn = !visualEditOn;
  if (visualEditOn) {
    const entry = SCENARIOS[scenarioIdx];
    visualDescriptor = descriptorFromScenario(entry.scenario, entry.name);
    dashboard.setScenarioJSON(visualDescriptor);
    dashboard.setEditorDescriptor(visualDescriptor);
    pausedBeforeVisual = paused;
    paused = true;
    planPlayer = null;
    playback = null;
    visualDirty = false;
    visualStagedEdits.clear();
  } else {
    visualEditor.setEnabled(false);
    if (visualDirty) applyCustomDescriptor(visualDescriptor);
    paused = pausedBeforeVisual;
  }
  if (visualEditOn) visualEditor.setEnabled(true);
  quickValidationView.root.visible = visualEditOn;
  dashboard.setVisualEdit(visualEditOn);
}

function previewVisualEdit(edit) {
  const [x, z] = edit.pos;
  if (edit.kind === 'crane') {
    const index = visualDescriptor.cranes.findIndex((item) => item.id === edit.id);
    if (index >= 0) craneViews[index].root.position.set(x, 0, z);
  } else if (edit.kind === 'load') {
    const mesh = loadView.meshes.get(edit.id);
    if (mesh) mesh.position.set(x, mesh.position.y, z);
  } else if (edit.kind === 'target') {
    const target = siteView.targets.get(edit.id);
    target?.fill.position.set(x, target.fill.position.y, z);
    target?.ring.position.set(x, target.ring.position.y, z);
  } else if (edit.kind === 'obstacle') {
    const obstacle = siteView.obstacles.get(edit.id);
    obstacle?.position.set(x, obstacle.position.y, z);
  } else if (edit.kind === 'noFlyZone') {
    const zone = siteView.noFlyZones.get(edit.id);
    zone?.fill.position.set(x, zone.fill.position.y, z);
    zone?.border.position.set(x, 0, z);
  }
}

function visualObject(kind, id) {
  if (kind === 'crane') {
    const index = visualDescriptor.cranes.findIndex((item) => item.id === id);
    return craneViews[index]?.root ?? null;
  }
  if (kind === 'load') return loadView?.meshes.get(id) ?? null;
  if (kind === 'target') return siteView?.targets.get(id)?.fill ?? null;
  if (kind === 'obstacle') return siteView?.obstacles.get(id) ?? null;
  if (kind === 'noFlyZone') return siteView?.noFlyZones.get(id)?.fill ?? null;
  return null;
}

function updateQuickValidation() {
  if (!visualDescriptor || !loadView || !siteView) return;
  const issues = validateScenarioQuick(visualDescriptor);
  quickValidationView.update(issues, visualObject);
  dashboard.showQuickValidation(issues);
}

/** 시나리오 로드: sim·뷰 전부 재구성 */
function loadScenario(idx) {
  scenarioIdx = ((idx % SCENARIOS.length) + SCENARIOS.length) % SCENARIOS.length;
  const entry = SCENARIOS[scenarioIdx];
  if (!visualEditOn) visualDescriptor = descriptorFromScenario(entry.scenario, entry.name);

  // 기존 뷰 제거
  for (const v of craneViews) sceneManager.scene.remove(v.root);
  if (loadView) sceneManager.scene.remove(loadView.root);
  if (siteView) sceneManager.scene.remove(siteView.root);
  if (agentView) sceneManager.scene.remove(agentView.root);
  if (effects) effects.dispose();

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
    view.root.userData.visualEdit = { kind: 'crane', id: spec.id };
    sceneManager.scene.add(view.root);
    return view;
  });
  loadView = new LoadView(state.loads);
  sceneManager.scene.add(loadView.root);
  siteView = new SiteView(state, entry.scenario);
  sceneManager.scene.add(siteView.root);
  agentView = new AgentView(state.agents ?? []);
  sceneManager.scene.add(agentView.root);
  effects = new Effects(sceneManager.scene);
  const framePoints = [
    ...entry.scenario.cranes.map((c) => c.basePos),
    ...(entry.scenario.loads ?? []).flatMap((l) => [
      l.pos,
      l.target,
      ...(l.route ?? []).map((leg) => leg.target),
    ].filter(Boolean)),
  ];
  sceneManager.applySite(entry.scenario, framePoints); // 그림자·포그·펜스 현장 맞춤
  sceneManager.framePoints(framePoints);
  cameraRig.retarget(); // 비궤도 모드면 새 현장으로 스냅
  dashboard.setScenario(scenarioIdx);
  dashboard.setCranes(entry.scenario.cranes, activeCrane);
  dashboard.setPlanResult(null);
  dashboard.setEditorDescriptor(visualDescriptor);
  widgets.showOnboarding(entry); // 시나리오 목표·조작 요약 카드 (6초)
  if (visualEditOn) paused = true;
  updateQuickValidation();
}

loadScenario(scenarioIdx);
dashboard.setScenarioJSON(visualDescriptor);
resetEditorHistory();

// --- 키 입력 (배속·시나리오·크레인 전환·기록/리플레이) ---
window.addEventListener('keydown', (e) => {
  if (e.code === 'Tab') e.preventDefault();
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyZ') {
    e.preventDefault();
    restoreEditorHistory(e.shiftKey ? editorHistory.redo() : editorHistory.undo());
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyY') {
    e.preventDefault();
    restoreEditorHistory(editorHistory.redo());
    return;
  }

  if (e.code === 'Digit1') sim.setTimeScale(1);
  if (e.code === 'Digit2') sim.setTimeScale(5);
  if (e.code === 'Digit3') sim.setTimeScale(10);
  if (e.code === 'Digit4') sim.setTimeScale(20);

  if (e.code === 'KeyN') {
    if (visualEditOn) toggleVisualEdit();
    loadScenario(scenarioIdx + (e.shiftKey ? -1 : 1));
    resetEditorHistory();
  }
  if (e.code === 'KeyO') {
    if (visualEditOn) toggleVisualEdit();
    loadScenario(scenarioIdx);
    resetEditorHistory();
  }
  if (e.code === 'KeyG') sceneManager.toggleGrid(); // 개발용 그리드·축
  if (e.code === 'KeyC') {
    cameraRig.cycle();
    dashboard.setCameraMode(cameraRig.label);
  }
  if (e.code === 'KeyM') dashboard.setMuted(sound.toggleMute());
  if (e.code === 'KeyH') {
    assistOn = !assistOn;
    widgets.setEnabled(assistOn);
    dashboard.setAssist(assistOn);
  }
  if (e.code === 'KeyI') {
    hudOn = !hudOn;
    hud.style.display = hudOn ? '' : 'none';
    dashboard.setHud(hudOn);
  }

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
    const data = recorder.stop(sim.completionScore());
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
  let command = { slew: 0, luff: 0, hoist: 0, tag: 0 };

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
      tag: clamp1((keyCommand.tag ?? 0) + (panelCommand.tag ?? 0)),
    };
    const commands = Array.from({ length: nCranes }, (_, i) =>
      i === activeCrane ? command : { slew: 0, luff: 0, hoist: 0, tag: 0 },
    );
    recorder.frame(frameDt, sim.timeScale, commands, attachId);
    state = sim.step(frameDt, commands);
  } else {
    state = sim.getState();
  }

  state.cranes.forEach((cs, i) => craneViews[i].update(cs, state.time));
  siteView.update(state); // 트럭 등 현장 상태 (부재 동반 이동은 코어가 처리)
  loadView.update(state.loads, state.trucks, state.cranes, state.time);
  agentView.update(state.agents ?? [], state.time);
  effects.update(state); // 안착·주행 먼지 (상태 전이·시뮬 시간 결정론)
  for (const edit of visualStagedEdits.values()) previewVisualEdit(edit);
  visualEditor?.refreshPreview();
  cameraRig.update(state.cranes[activeCrane]);
  const liveNow = !playback && !planPlayer && !paused;
  sound.update(state, { live: liveNow, activeCrane });

  // 보조 오버레이: 판정은 코어 질의(단일 경로) — 계획 재생 중엔 sim 상태와 무관하므로 질의 안 함
  const attachP = liveNow ? sim.world.attachPreview(activeCrane) : null;
  const releaseP = liveNow ? sim.world.releasePreview(activeCrane) : null;
  const nfzP = liveNow && assistOn ? sim.world.nfzProximity(activeCrane) : null;
  const drivingNow = Math.abs(command.drive ?? 0) > 0 || Math.abs(state.cranes[activeCrane]?.extra?.driveVel ?? 0) > 0.05;
  const driveP = liveNow && releaseP && assistOn && drivingNow
    ? sim.world.drivePathPreview(activeCrane, command.steer)
    : null;
  const guidanceP = liveNow && assistOn ? sim.world.guidanceTarget(activeCrane) : null;
  overlayView.update(state, activeCrane, {
    live: liveNow,
    enabled: assistOn,
    preview: attachP,
    release: releaseP,
    sweep: liveNow && releaseP && assistOn ? sim.world.sweepPreview(activeCrane) : null,
    readiness: liveNow && !releaseP && assistOn ? sim.world.liftReadiness() : null,
    nfz: nfzP,
    drivePath: driveP,
    time: state.time,
  });
  // 계획 재생 주석: 현재 시각에 활성인 계획 이벤트 요약 (Tier3)
  const planNote =
    planPlayer && macroPlan
      ? macroPlan.events
          .filter((e) => e.start <= planPlayer.time && planPlayer.time < e.start + e.duration)
          .slice(0, 3)
          .map((e) => `${e.craneId} ${e.type}${e.loadId ? '·' + e.loadId : ''}`)
          .join('  |  ')
      : null;
  widgets.update(state, activeCrane, sceneManager.camera, {
    spec: sim.scenario.cranes[activeCrane],
    scenario: sim.scenario,
    live: liveNow,
    preview: attachP,
    release: releaseP,
    nfz: nfzP,
    guidance: guidanceP,
    planNote,
  });
  if (!planPlayer && !scoreShown) {
    const score = sim.completionScore();
    if (score) {
      scoreShown = true;
      widgets.showScore(score);
    }
  }

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
  if (!hudOn) return; // 정보창 숨김 (I)
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
  const holdLine = (s.agentHolds ?? []).includes(activeCrane)
    ? '\n⛔ 지상 인원·장비 접근 — 작업 일시정지 (위험반경 통과 대기)'
    : '';
  const agentInfo = (state.agents ?? []).length > 0
    ? ` · 홀드 ${s.agentHoldCount ?? 0}회 ${(s.agentHoldTime ?? 0).toFixed(0)}s`
    : '';
  const clearanceInfo =
    state.cranes.length > 1 && Number.isFinite(s.craneMinClearance)
      ? ` · 붐이격 ${s.craneMinClearance.toFixed(1)}m · 크레인충돌 ${s.craneClashCount ?? 0}회`
      : '';
  const swayLine = c.extra.swayMag > 0.05 ? ` | 흔들림 ${c.extra.swayMag.toFixed(2)}m` : '';
  const windLine = state.wind
    ? `\n풍속     : ${state.wind.speed.toFixed(1)} m/s · 풍향 ${rad2deg(state.wind.dir ?? 0).toFixed(0)}°${state.wind.maxOperating ? ` (한계 ${state.wind.maxOperating})` : ''}${state.wind.maxOperating && state.wind.speed > state.wind.maxOperating ? ' ⛔ 작업중지' : ''}`
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
    `Crane Sim — ${entry.name} | FPS ${fps} | t=${state.time.toFixed(1)}s | 배속 ×${sim.timeScale} | 카메라 ${cameraRig.label}`,
    `${entry.desc}`,
    ``,
    craneLabel,
    `입력     : slew=${command.slew} luff=${command.luff} hoist=${command.hoist} tag=${command.tag ?? 0}${c.type !== 'tower' ? ` drive=${command.drive ?? 0} steer=${command.steer ?? 0}` : ''}`,
    c.type !== 'tower'
      ? `주행     : ${(c.extra.driveVel ?? 0).toFixed(2)} m/s · 헤딩 ${rad2deg(c.extra.driveYaw ?? 0).toFixed(0)}° · 위치 (${c.basePos[0].toFixed(1)}, ${c.basePos[2].toFixed(1)})`
      : `위치     : 고정식 (마스트)`,
    `선회각   : ${rad2deg(c.slewAngle).toFixed(1)}°`,
    `${radiusLabel}: ${c.radius.toFixed(2)} m`,
    `후크높이 : ${c.hookHeight.toFixed(2)} m${swayLine}${windLine}`,
    `정격하중 : ${c.capacity.toFixed(1)} t`,
    `인양하중 : ${c.loadMass > 0 ? c.loadMass.toFixed(1) + ' t' : '(없음)'}`,
    `하중률   : ${ratioPct}%${c.loadRatio >= 0.9 && c.loadMass > 0 ? ' ⚠' : ''}${limiterMsg}${rigLine}${holdLine}`,
    ``,
    missionLine,
    `안전     : 충돌 ${s.collisionCount}회 · 금지구역 ${s.violationCount}회${clearanceInfo}${agentInfo}${safetyWarn}`,
    `이벤트   : ${state.lastEvent ?? '-'}`,
    `${recLine}`,
    ``,
    `[주행] W/S 전·후진  A/D 좌·우회전    [팔] ←/→ 선회  ↑/↓ 기복  Q/E 권상·권하  Z/X 태그라인  Space 픽업`,
    `N 다음 시나리오  O 리셋  Tab 크레인 전환  1~4 배속  C 카메라  M 소리  H 보조UI  I 정보창  G 그리드  R 기록  P 리플레이`,
    `마우스: 회전 | 휠: 줌 | 우클릭: 이동`,
  ].join('\n');
}

requestAnimationFrame(loop);
