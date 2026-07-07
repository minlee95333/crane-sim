import * as THREE from 'three';
import { SCENARIOS } from '../../data/scenarios.js';
import { applyVisualEdit, stageVisualEdit, VisualScenarioEditor } from './VisualScenarioEditor.js';
import { buildScenario, descriptorFromScenario } from './scenario.js';

function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

console.log('--- 3D 시나리오 편집 계약 ---');

const sourceEntry = SCENARIOS.find((entry) => entry.scenario.cranes.length && entry.scenario.loads.length);
const descriptor = descriptorFromScenario(sourceEntry.scenario, sourceEntry.name);
const rebuilt = buildScenario(descriptor);
check('기존 시나리오의 크레인 제원 보존', rebuilt.cranes[0].type === sourceEntry.scenario.cranes[0].type);
check('기존 시나리오의 부재 형상 보존', rebuilt.loads[0].shape === sourceEntry.scenario.loads[0].shape);

const sameDescriptor = applyVisualEdit(
  descriptor, { kind: 'crane', id: descriptor.cranes[0].id, pos: [11, 12] },
);
check('드래그 커밋은 descriptor를 제자리 갱신', sameDescriptor === descriptor);
check('크레인 드래그 좌표 반영', descriptor.cranes[0].pos[0] === 11 && descriptor.cranes[0].pos[1] === 12);

const load = descriptor.loads[0];
applyVisualEdit(descriptor, { kind: 'load', id: load.id, pos: [13, 14] });
applyVisualEdit(descriptor, { kind: 'target', id: load.id, pos: [15, 16] });
check('부재와 목표를 독립 이동', load.pos.join(',') === '13,14' && load.target.join(',') === '15,16');

const staged = new Map();
stageVisualEdit(staged, { kind: 'load', id: load.id, pos: [1, 2] });
stageVisualEdit(staged, { kind: 'load', id: load.id, pos: [3, 4] });
stageVisualEdit(staged, { kind: 'target', id: load.id, pos: [5, 6] });
check(
  '커밋 좌표는 다음 프레임에도 객체별 최신값 유지',
  staged.size === 2 && staged.get(`load:${load.id}`).pos.join(',') === '3,4',
);

const listeners = [];
const fakeCanvas = {
  style: {},
  addEventListener(type, handler, options) { listeners.push({ type, handler, options }); },
};
new VisualScenarioEditor({
  camera: new THREE.PerspectiveCamera(),
  domElement: fakeCanvas,
  scene: new THREE.Scene(),
  controls: { enabled: true },
  getObjects: () => [],
});
check(
  '객체 편집 포인터가 카메라보다 먼저 캡처됨',
  listeners.length === 4 && listeners.every((listener) => listener.options?.capture === true),
);

if (descriptor.obstacles.length) {
  applyVisualEdit(descriptor, { kind: 'obstacle', id: descriptor.obstacles[0].id, pos: [17, 18] });
  check('장애물 드래그 좌표 반영', descriptor.obstacles[0].pos.join(',') === '17,18');
}

if (descriptor.noFlyZones.length) {
  const zone = descriptor.noFlyZones[0];
  const width = zone.max[0] - zone.min[0];
  const depth = zone.max[1] - zone.min[1];
  applyVisualEdit(descriptor, { kind: 'noFlyZone', id: zone.id, pos: [20, 25] });
  check(
    '제한구역은 크기를 유지하며 중심 이동',
    zone.max[0] - zone.min[0] === width &&
      zone.max[1] - zone.min[1] === depth &&
      (zone.min[0] + zone.max[0]) / 2 === 20 &&
      (zone.min[1] + zone.max[1]) / 2 === 25,
  );
}
