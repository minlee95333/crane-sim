// 비원점 크레인 렌더 좌표 회귀 테스트.
import * as THREE from 'three';
import { MobileCraneView } from './MobileCraneView.js';
import { TowerCraneView } from './TowerCraneView.js';
import { SiteView } from './SiteView.js';
import { LoadView } from './LoadView.js';
import { CameraRig } from './CameraRig.js';
import { SoundView } from './SoundView.js';
import { AgentView } from './AgentView.js';
import { OverlayView } from './OverlayView.js';
import { ScreenWidgets } from './ScreenWidgets.js';
import { Simulation } from '../sim/Simulation.js';
import { SCENARIOS } from '../../data/scenarios.js';

function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

function nearVec(actual, expected, eps = 1e-9) {
  return actual.distanceTo(expected) <= eps;
}

const scenario = SCENARIOS.find((entry) => entry.id === 'dual-site').scenario;
const sim = new Simulation(scenario);
const state = sim.getState();

console.log('--- 비원점 혼합 크레인 렌더 좌표 ---');

for (let i = 0; i < state.cranes.length; i++) {
  const craneState = state.cranes[i];
  const spec = scenario.cranes[i];
  const View = spec.type === 'tower' ? TowerCraneView : MobileCraneView;
  const view = new View(spec);
  view.update(craneState);
  view.root.updateMatrixWorld(true);

  const hookWorld = view.hookMesh.getWorldPosition(view.hookMesh.position.clone());
  const expected = {
    x: craneState.hookPos[0],
    y: craneState.hookPos[1],
    z: craneState.hookPos[2],
  };

  check(
    `${spec.type} 후크 월드 위치가 코어 상태와 일치`,
    nearVec(hookWorld, { ...hookWorld, ...expected }),
  );
}

const mobileSpec = scenario.cranes.find((spec) => spec.type === 'mobile');
const mobileState = state.cranes.find((crane) => crane.type === 'mobile');
const longBoomView = new MobileCraneView(mobileSpec);
longBoomView.update({
  ...mobileState,
  extra: { ...mobileState.extra, boomLength: 52 },
});
// 격자 붐(2세그먼트 체인)에서 시각 붐끝이 피벗에서 계획 붐길이만큼 떨어져 있는지 —
// 무하중(처짐 0)이므로 피벗→붐끝 거리 = 붐길이 (+시브 오프셋 0.25/-0.45 허용)
{
  longBoomView.root.updateMatrixWorld(true);
  const tip = longBoomView.tipAnchor.getWorldPosition(longBoomView.tipAnchor.position.clone());
  const pivot = longBoomView.boomPivot.getWorldPosition(longBoomView.boomPivot.position.clone());
  const dist = tip.distanceTo(pivot);
  check(`계획 붐 길이 52m가 격자 붐 시각 길이에 반영 (${dist.toFixed(2)}m)`, Math.abs(dist - 52) < 0.8);
  check('무하중 시 붐 처짐 0 (외측 세그먼트 회전 없음)', longBoomView.boomOuter.rotation.z === 0);
}
// 하중률에 따른 렌더 전용 처짐 — 코어 상태(hookPos)는 그대로 그린다
{
  const loadedView = new MobileCraneView(mobileSpec);
  loadedView.update({ ...mobileState, loadMass: 10, loadRatio: 0.8 });
  check('하중 시 붐 처짐 발생 (렌더 전용)', loadedView.boomOuter.rotation.z < 0);
  loadedView.root.updateMatrixWorld(true);
  const hookWorld = loadedView.hookMesh.getWorldPosition(loadedView.hookMesh.position.clone());
  check(
    '처짐 중에도 후크는 코어 hookPos에 위치 (물리 불변)',
    Math.abs(hookWorld.x - mobileState.hookPos[0]) < 1e-9 &&
      Math.abs(hookWorld.y - mobileState.hookPos[1]) < 1e-9,
  );
}

console.log('--- 부재 형상·슬링·리깅 연출 ---');
{
  // H형강: 시각 형상의 바운딩 박스가 코어 size 박스에 내접 (충돌 진실은 코어 AABB)
  const girder = { id: 'hb', name: 'H거더', size: [8, 0.8, 0.5], shape: 'h-beam', mass: 5,
    pos: [0, 0.4, 0], state: 'ground', yaw: 0 };
  const lv = new LoadView([girder]);
  const bbox = new THREE.Box3().setFromObject(lv.meshes.get('hb'));
  const dims = bbox.getSize(new THREE.Vector3());
  check(
    `H형강 bbox ≈ 코어 size (${dims.x.toFixed(1)}×${dims.y.toFixed(1)}×${dims.z.toFixed(1)})`,
    Math.abs(dims.x - 8) < 0.05 && Math.abs(dims.y - 0.8) < 0.05 && Math.abs(dims.z - 0.5) < 0.05,
  );

  // 슬링: hooked 상태에서 4가닥이 후크→상면 모서리로 이어짐
  const hooked = { ...girder, pos: [10, 6, 0], state: 'hooked', hookedBy: 0, rigRemain: 0 };
  const craneState = { hookPos: [10, 6 + 0.4 + 1.2, 0] };
  lv.update([hooked], [], [craneState], 1);
  const slings = lv.slings.get('hb');
  check('매달림 시 슬링 4가닥 표시', slings.every((rope) => rope.visible));
  const cornerX = slings.map((rope) => rope.position.x);
  check(
    '슬링이 부재 폭(±4m 모서리) 방향으로 벌어짐',
    Math.min(...cornerX) < 9 && Math.max(...cornerX) > 11,
  );

  // 리깅 진행률: 절반 진행 시 슬링 일부만, 작업자 크루 표시
  const rigging = { ...girder, pos: [10, 0.4, 0], state: 'rigging', hookedBy: 0,
    rigRemain: 45, rigTime: 90 };
  lv.update([rigging], [], [craneState], 2);
  const visibleCount = slings.filter((rope) => rope.visible).length;
  check(`리깅 50% 진행 시 슬링 ${visibleCount}가닥 (0<n<4)`, visibleCount > 0 && visibleCount < 4);
  check('리깅 중 작업자 크루 표시', lv.riggers.get('hb').crew.visible);

  // 안착 이즈: hooked→ground 전이 후 렌더 위치가 이전↔목표 사이를 지나 0.4s에 목표 도달
  const placedAt = { ...girder, pos: [12, 0.4, 2], state: 'ground', yaw: 0 };
  lv.update([hooked], [], [craneState], 3); // hooked 위치 (10, 6, 0)
  lv.update([placedAt], [], [craneState], 3.02); // 전이 — 이즈 시작 (from 위치 유지)
  lv.update([placedAt], [], [craneState], 3.22); // 중간 프레임 (t=0.5)
  const mid = lv.meshes.get('hb').position.clone();
  check(
    '안착 전이 중 렌더 위치가 이전과 목표 사이 (이즈)',
    mid.x > 10 && mid.x < 12 && mid.y < 6 && mid.y > 0.4,
  );
  lv.update([placedAt], [], [craneState], 4);
  const done = lv.meshes.get('hb').position.clone();
  check('이즈 완료 후 코어 위치와 일치', Math.abs(done.x - 12) < 1e-9 && Math.abs(done.y - 0.4) < 1e-9);
}

console.log('--- 지상 에이전트 뷰 ---');
{
  const agents = [
    { id: 'W-1', kind: 'worker', pos: [5, 3], heading: [1, 0], moving: true, waiting: false },
    { id: 'V-1', kind: 'vehicle', pos: [-8, 2], heading: [0, 1], moving: true, waiting: false },
  ];
  const av = new AgentView(agents);
  av.update(agents, 1.0);
  const worker = av.figures.get('W-1').group;
  const vehicle = av.figures.get('V-1').group;
  check(
    '작업자·차량이 코어 좌표에 배치',
    worker.position.x === 5 && worker.position.z === 3 &&
      vehicle.position.x === -8 && vehicle.position.z === 2,
  );
  check(
    '차량이 헤딩(+z) 방향으로 회전',
    Math.abs(vehicle.rotation.y - -Math.PI / 2) < 1e-9,
  );
  check('보행 중 바운스 모션 적용', worker.scale.y !== 1);
}

console.log('--- 보조 오버레이 (씬 앵커) ---');
{
  const ov = new OverlayView();
  const craneState = { hookPos: [21.2, 8, 0] };
  const baseState = { cranes: [craneState], agents: [], safety: {} };
  const girder = { id: 'g', pos: [22, 0.25, 0], size: [8, 0.5, 0.5], yaw: 0 };

  // 빈 후크 + 적격 후보 → 조준점 녹색, 후크 투영 위치
  ov.update(baseState, 0, {
    live: true,
    preview: { load: girder, horiz: 0.8, vert: 1.2, horizOk: true, vertOk: true, eligible: true, ok: true },
    release: null,
  });
  check(
    '조준점이 후크 지면 투영에 표시 (녹색)',
    ov.reticle.visible && ov.reticle.position.x === 21.2 && ov.reticle.position.z === 0 &&
      ov.reticleRing.material === ov.mats.ok,
  );
  check('픽업 가이드(허용원·브래킷) 표시', ov.pickupRing.visible && ov.brackets.every((b) => b.visible));

  // 조건 일부만 충족 → 호박색
  ov.update(baseState, 0, {
    live: true,
    preview: { load: girder, horiz: 1.2, vert: 9, horizOk: true, vertOk: false, eligible: false, ok: false },
    release: null,
  });
  check('수직 미충족 시 조준점 호박색', ov.reticleRing.material === ov.mats.near);

  // 매달림 + 목표 위 + 접지 가능 → 안착 링 녹색 + 간격선
  const held = { id: 'g', pos: [15, 0.5, 10], size: [3, 0.6, 3], target: [15, 10], targetElev: 0 };
  ov.update({ ...baseState, agents: [{ id: 'w', kind: 'worker', pos: [16, 10.5] }], safety: { agentHolds: [0], dangerRadius: 6 } }, 0, {
    live: true,
    preview: null,
    release: { held, support: 0, bottomGap: 0.2, canRelease: true, onTarget: true, err: 0.3, tol: 1.5, maxGap: 0.5 },
    time: 2,
  });
  check(
    '안착 링 녹색 + 간격선 표시',
    ov.settleRing.visible && ov.settleRing.material === ov.mats.ok && ov.gapLine.visible,
  );
  check(
    '홀드 중 위험반경 링 적색 + 침입자 마커',
    ov.dangerRing.visible && ov.dangerRing.material === ov.mats.danger &&
      ov.intruderMarks[0].visible && Math.abs(ov.dangerRing.scale.x - 6) < 0.5,
  );

  // live=false → 전체 숨김
  ov.update(baseState, 0, { live: false, preview: null, release: null });
  check('계획 재생·리플레이 중 오버레이 숨김', ov.root.visible === false);

  // ScreenWidgets: DOM 없는 환경에서 no-op
  const sw = new ScreenWidgets(null);
  sw.update(baseState, 0, null, {});
  check('ScreenWidgets는 DOM 미지원 환경에서 no-op', sw.ok === false);
}

console.log('--- 카메라 리그·사운드 (헤드리스) ---');
{
  const controls = { enabled: true, update() {} };
  const rig = new CameraRig(new THREE.PerspectiveCamera(), controls);
  check('초기 모드 = 궤도', rig.mode === 'orbit' && rig.label === '궤도');
  rig.cycle(); // follow
  const cs = { basePos: [10, 0, 0], slewAngle: 0, hookPos: [30, 5, 0], type: 'mobile', extra: {} };
  rig.update(cs);
  check('추적 모드: 카메라가 크레인 후방(-x)에 스냅', rig.camera.position.x < 10 && rig.camera.position.y > 5);
  check('비궤도 모드에서 OrbitControls 비활성', controls.enabled === false);
  rig.cycle(); // cab
  rig.cycle(); // hook
  rig.update(cs);
  check('후크캠: 후크 근처 후상방', Math.abs(rig.camera.position.x - 24) < 1 && rig.camera.position.y > 9);
  rig.cycle(); // orbit 복귀
  rig.update(cs);
  check('궤도 복귀 시 OrbitControls 재활성', controls.enabled === true);

  // SoundView: Node(AudioContext 없음)에서 전체 no-op — 구성·호출 안전만 보증
  const sv = new SoundView();
  sv.unlock();
  sv.update({ time: 1, cranes: [cs], loads: [], safety: {} }, { live: true, activeCrane: 0 });
  check('SoundView는 오디오 미지원 환경에서 no-op', sv.supported === false && sv.ctx === null);
}

console.log('--- S9 트럭 렌더 ---');
const s9 = SCENARIOS.find((entry) => entry.id === 'yard-erection').scenario;
const s9State = new Simulation(s9).getState();
const siteView = new SiteView(s9State, s9);
check('전 부재를 운송하는 트럭 1대만 생성', siteView.trucks.length === 1);
siteView.update(s9State);
const loadView = new LoadView(s9State.loads);
loadView.update(s9State.loads, s9State.trucks); // 동반 이동 자체는 코어 담당 — trucktest에서 검증
check('t=0에 트럭 1대가 진입 시작', siteView.trucks[0].root.visible);
check('진입 중 전 부재가 트럭 적재물로 표시', [...loadView.meshes.values()].every((mesh) => mesh.visible));
const first = siteView.trucks[0];
const entryStartZ = first.root.position.z;
siteView.update({ ...s9State, time: 1 });
const earlyTravel = Math.abs(first.root.position.z - entryStartZ);
check(
  '출발 직후 가속 물리로 선형 보간보다 천천히 이동',
  earlyTravel > 0 && earlyTravel < 26 / 30,
);
check('가속 시 차체 피치와 바퀴 회전 반영', Math.abs(first.chassis.rotation.x) > 0 &&
  Math.abs(first.wheels[0].rotation.x) > 0);
siteView.update({ ...s9State, time: 15 });
const entryMidZ = first.root.position.z;
siteView.update({ ...s9State, time: 30 });
check(
  '트럭이 차체 종축을 따라 30초 동안 전진 진입',
  (entryMidZ - entryStartZ) * first.travelDirection > 0 &&
    (first.root.position.z - entryMidZ) * first.travelDirection > 0 &&
    Math.abs(first.root.position.z - first.bayZ) < 1e-9 &&
    Math.abs(first.root.position.x - first.bayX) < 1e-9,
);
const exitState = structuredClone(s9State);
exitState.time = 115;
for (const load of exitState.loads.filter((load) => load.arriveTime === 30)) {
  load.stage = 1;
  load.stageChangedAt = 100;
  load.yardedAt = 100;
}
siteView.update(exitState);
check(
  '마지막 하역 후 트럭이 차체 종축을 따라 후진 출차',
  first.root.visible &&
    (first.root.position.z - first.bayZ) * first.travelDirection < 0 &&
    Math.abs(first.root.position.x - first.bayX) < 1e-9,
);
siteView.update({ ...exitState, time: 131 });
check('출차 완료 트럭은 현장에서 사라짐', !first.root.visible);
const erectionState = structuredClone(exitState);
erectionState.time = 500;
erectionState.loads[0].stageChangedAt = 500;
erectionState.loads[0].state = 'placed';
siteView.update(erectionState);
check('건립 완료 시각이 갱신돼도 출차한 트럭은 재진입하지 않음', !first.root.visible);

console.log('\nALL PASS');
