// 비원점 크레인 렌더 좌표 회귀 테스트.
import { MobileCraneView } from './MobileCraneView.js';
import { TowerCraneView } from './TowerCraneView.js';
import { SiteView } from './SiteView.js';
import { LoadView } from './LoadView.js';
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
