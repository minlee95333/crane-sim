import { shortestPath, segmentBlocked } from './PathPlanner.js';
import {
  candidateOutcome,
  evaluateSetupCandidate,
  generateMacroPlan,
  planningZones,
  setupCandidates,
  validatePlanningScenario,
} from './MacroPlanner.js';
import { SchedulePlayer } from './SchedulePlayer.js';
import { validateSchedule3D } from './ScheduleValidator.js';
import { generateValidatedMacroPlan } from './PlanRepair.js';
import { evaluateManualPlan, validateManualPlan } from './ManualPlanner.js';
import { Simulation } from '../sim/Simulation.js';
import { SCENARIOS } from '../../data/scenarios.js';

function check(label, condition, detail = '') {
  if (!condition) throw new Error(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  PASS: ${label}${detail ? ` — ${detail}` : ''}`);
}

console.log('--- 제한구역 경로 ---');
const zones = [{ id: 'block', min: [4, -2], max: [6, 2] }];
check('직선 경로 차단', segmentBlocked([0, 0], [10, 0], zones));
const path = shortestPath([0, 0], [10, 0], zones, { clearance: 1 });
check('우회 경로 존재', path.ok && path.path.length >= 3);
check('우회 거리가 직접거리보다 큼', path.distance > path.directDistance);

console.log('--- 시나리오 검증 ---');
const cyclic = {
  cranes: [{ id: 'C' }],
  loads: [
    { id: 'A', target: [0, 0], dependsOn: ['B'] },
    { id: 'B', target: [0, 0], dependsOn: ['A'] },
  ],
};
check('DAG 순환 검출', !validatePlanningScenario(cyclic).valid);

console.log('--- S8 거시 계획 ---');
const entry = SCENARIOS.find((s) => s.id === 'macro-plan');
const scenario = entry.scenario;
const plans = Object.fromEntries(
  ['earliestFinish', 'nearest', 'radiusPriority'].map((policy) => [
    policy,
    generateMacroPlan(scenario, { policy }),
  ]),
);
for (const [policy, result] of Object.entries(plans)) {
  check(`${policy}: 12건 완료`, result.completed === 12 && result.failed.length === 0);
  check(`${policy}: 단계 이벤트 생성`, result.events.some((e) => e.type === 'travel') && result.events.some((e) => e.type === 'setup'));
  check(`${policy}: 최종 해체 생성`, result.events.some((e) => e.type === 'finalTeardown'));
}
check('최단 종료 정책이 nearest보다 느리지 않음', plans.earliestFinish.makespan <= plans.nearest.makespan);
check('크레인별 통계 3대', plans.earliestFinish.perCrane.length === 3);

const firstLoad = scenario.loads[0];
const firstCrane = scenario.cranes[0];
const candidates = setupCandidates(firstCrane, firstLoad, scenario, [firstCrane.basePos[0], firstCrane.basePos[2]]);
check('픽업·목표 공통 셋업 후보 생성', candidates.length > 0);
check('후보에 정격 여유·이동 경로 포함', Number.isFinite(candidates[0].capacityMargin) && candidates[0].path.ok);
check('후보에 필요 붐 길이 포함', Number.isFinite(candidates[0].requiredBoomLength));
const clearance = firstCrane.geometry.bodyRadius;
const allZones = planningZones(scenario, firstCrane);
check(
  '이동 경로가 장애물·고정 크레인 여유구역을 회피',
  candidates[0].path.path.slice(1).every((point, i) =>
    !segmentBlocked(candidates[0].path.path[i], point, allZones, clearance)
  ),
);

const occupied = {
  assignmentId: 'OTHER:L',
  craneId: scenario.cranes[1].id,
  setupPos: candidates[0].pos,
  setupStart: 0,
  liftStart: 10,
  liftFinish: 100,
  actualRadius: 5,
  workingRadius: 10,
};
const delayed = candidateOutcome(
  scenario,
  { spec: firstCrane, pos: [firstCrane.basePos[0], firstCrane.basePos[2]], available: 0, jobs: 0 },
  firstLoad,
  new Map(),
  [occupied],
  candidates[0],
);
check('동시 셋업 점유 충돌 시 작업 지연', delayed.spatialWait >= occupied.liftFinish);

const crossingTravel = {
  assignmentId: 'OTHER:MOVE',
  craneId: scenario.cranes[1].id,
  setupPos: [30, 30],
  setupStart: 20,
  liftStart: 30,
  liftFinish: 200,
  travelStart: 0,
  travelFinish: 20,
  travelTime: 20,
  movePath: [[0, -10], [0, 10]],
  actualRadius: 5,
  workingRadius: 10,
};
const crossingSetup = {
  ...candidates[0],
  pos: [10, 0],
  path: {
    ok: true,
    path: [[-10, 0], [10, 0]],
    distance: 20,
    directDistance: 20,
    detourDistance: 0,
  },
};
const crossingDelayed = candidateOutcome(
  scenario,
  { spec: firstCrane, pos: [-10, 0], available: 0, jobs: 0 },
  firstLoad,
  new Map(),
  [crossingTravel],
  crossingSetup,
);
check('동시 이동 경로 교차 시 이동 지연', crossingDelayed.spatialWait >= crossingTravel.travelFinish);

console.log('--- 3D 계획 재생 상태 ---');
const sim = new Simulation(scenario);
const player = new SchedulePlayer(scenario, plans.earliestFinish);
const first = plans.earliestFinish.assignments.find((a) => a.move > 0);
const travelMid = (first.travelStart + first.travelFinish) / 2;
const travelState = player.stateAt(sim.getState(), travelMid);
const ci = scenario.cranes.findIndex((c) => c.id === first.craneId);
check('TRAVEL 중 크레인 베이스 이동', travelState.cranes[ci].basePos[0] !== scenario.cranes[ci].basePos[0]);
const liftMid = (first.liftStart + first.liftFinish) / 2;
const beforeLift = player.stateAt(sim.getState(), first.liftStart - 0.001);
const atLiftStart = player.stateAt(sim.getState(), first.liftStart);
check(
  'LIFT 시작 시 후크 위치 연속',
  Math.hypot(
    beforeLift.cranes[ci].hookPos[0] - atLiftStart.cranes[ci].hookPos[0],
    beforeLift.cranes[ci].hookPos[1] - atLiftStart.cranes[ci].hookPos[1],
    beforeLift.cranes[ci].hookPos[2] - atLiftStart.cranes[ci].hookPos[2],
  ) < 0.01,
);
const liftState = player.stateAt(sim.getState(), liftMid);
const movingLoad = liftState.loads.find((l) => l.id === first.loadId);
check('LIFT 중 양중물 공중 이동', movingLoad.state === 'hooked' && movingLoad.pos[1] > 0);
const liftingCrane = liftState.cranes[ci];
check(
  'LIFT 중 크레인 후크가 양중물을 추적',
  Math.hypot(liftingCrane.hookPos[0] - movingLoad.pos[0], liftingCrane.hookPos[2] - movingLoad.pos[2]) < 1e-6,
);
check('LIFT 중 크레인 자세 갱신', Number.isFinite(liftingCrane.slewAngle) && liftingCrane.radius > 0);

console.log('--- 전체 계획 3D 충돌 검증 ---');
const validation = validateSchedule3D(scenario, plans.earliestFinish, { sampleStep: 10 });
check('전체 시간축 샘플링 수행', validation.samples > 100);
check('위반 결과가 구간 이벤트로 집계', Array.isArray(validation.violations));
check('기본 안전 주차 자세에서 3D 검증 통과', validation.valid);
const validation2 = validateSchedule3D(scenario, plans.earliestFinish, { sampleStep: 10 });
check('3D 검증 결정론', JSON.stringify(validation) === JSON.stringify(validation2));

console.log('--- 3D 충돌 자동 복구 ---');
const unsafeParking = { 'TC-01': (5 * Math.PI) / 4 };
const unsafePlan = generateMacroPlan(scenario, { policy: 'earliestFinish' });
unsafePlan.parkSlewAngles = unsafeParking;
const unsafeValidation = validateSchedule3D(scenario, unsafePlan, { sampleStep: 10 });
check('의도적으로 불안전한 주차 자세에서 붐 간섭 검출', (unsafeValidation.byType.boomCrane ?? 0) >= 1);
const repaired = generateValidatedMacroPlan(scenario, {
  policy: 'earliestFinish',
  sampleStep: 10,
  maxRepairs: 6,
  parkSlewAngles: unsafeParking,
});
check('충돌 기반 지연 제약 생성', repaired.repairs.length >= 1);
check('자동 복구 후 전체 작업 완료', repaired.completed === repaired.total);
check('자동 복구 후 3D 검증 통과', repaired.validation3D.valid);

console.log('--- 수동 계획 편집 재계산 ---');
const editable = [...plans.earliestFinish.assignments]
  .sort((a, b) => a.craneId.localeCompare(b.craneId) || a.liftStart - b.liftStart)
  .map((a) => ({ craneId: a.craneId, loadId: a.loadId }));
check('자동계획을 수동 큐로 변환 가능', validateManualPlan(scenario, editable).valid);
const manual = evaluateManualPlan(scenario, editable);
check('수동 계획 전체 완료', manual.completed === manual.total && manual.failed.length === 0);
check('수동 계획에 Gantt 이벤트 생성', manual.events.some((event) => event.type === 'lift'));
const duplicate = [...editable, { ...editable[0] }];
check('중복 배정 검출', !validateManualPlan(scenario, duplicate).valid);
const sameCraneIndices = editable
  .map((item, index) => ({ item, index }))
  .filter(({ item }) => item.craneId === editable[0].craneId);
const reordered = editable.map((item) => ({ ...item }));
if (sameCraneIndices.length >= 2) {
  const a = sameCraneIndices[0].index;
  const b = sameCraneIndices[1].index;
  [reordered[a], reordered[b]] = [reordered[b], reordered[a]];
}
const reorderedResult = evaluateManualPlan(scenario, reordered);
check('크레인 큐 순서 변경 후 재계산', reorderedResult.completed === reorderedResult.total);
const firstAutoAssignment = plans.earliestFinish.assignments.find((assignment) =>
  assignment.craneId === editable[0].craneId && assignment.loadId === editable[0].loadId
);
const explicitPlan = editable.map((item, index) => index === 0
  ? {
      ...item,
      setupPos: [...firstAutoAssignment.setupPos],
      boomLength: firstAutoAssignment.boomLength,
    }
  : { ...item }
);
const explicitResult = evaluateManualPlan(scenario, explicitPlan);
const explicitAssignment = explicitResult.assignments.find((assignment) => assignment.loadId === explicitPlan[0].loadId);
check(
  '명시적 셋업 위치가 시간축에 반영',
  Math.hypot(
    explicitAssignment.setupPos[0] - explicitPlan[0].setupPos[0],
    explicitAssignment.setupPos[1] - explicitPlan[0].setupPos[1],
  ) < 1e-6,
);
const obstacleSetup = evaluateSetupCandidate(
  firstCrane,
  firstLoad,
  scenario,
  [firstCrane.basePos[0], firstCrane.basePos[2]],
  [0, -18],
  40,
);
check('장애물 위 직접 셋업 거부', !obstacleSetup.feasible);

console.log('--- S9 하역→야적→건립 거시 연결 ---');
const s9 = SCENARIOS.find((entry) => entry.id === 'yard-erection').scenario;
const s9Plan = generateMacroPlan(s9);
check('11개 부재 × 2단계 = 22리프트 계획', s9Plan.completed === 22 && s9Plan.total === 22);
check('전 부재 하역 후 건립 시작', Math.min(
  ...s9Plan.assignments.filter((a) => a.stage === 1).map((a) => a.liftStart),
) >= Math.max(
  ...s9Plan.assignments.filter((a) => a.stage === 0).map((a) => a.liftFinish),
));
const s9Final = new SchedulePlayer(s9, s9Plan).stateAt(
  new Simulation(s9).getState(),
  s9Plan.makespan,
);
const s9Player = new SchedulePlayer(s9, s9Plan);
const s9Base = new Simulation(s9).getState();
const s9Initial = s9Player.stateAt(s9Base, 0);
check(
  '도킹 전 전 부재는 pending 상태',
  s9Initial.loads.filter((load) => load.arriveTime > 0).every((load) => load.state === 'pending'),
);
const firstUnload = s9Plan.assignments.find((assignment) => assignment.stage === 0);
const duringUnload = s9Player.stateAt(
  s9Base,
  firstUnload.liftStart + firstUnload.liftDuration * 0.5,
).loads.find((load) => load.id === firstUnload.loadId);
check(
  '하역 중 부재가 트럭 적재함에서 야적장으로 이동',
  duringUnload.state === 'hooked' &&
    Math.hypot(
      duringUnload.pos[0] - firstUnload.pickupPos[0],
      duringUnload.pos[2] - firstUnload.pickupPos[2],
    ) > 0.5,
);
check('리플레이 종료 시 입체 건물 전 부재 최종 안착', s9Final.loads.every((load) => load.state === 'placed'));
check('거더가 기둥 상부 EL+6m에 안착', Math.abs(
  s9Final.loads.find((load) => load.id === 'GX-1').pos[1] - 6.3,
) < 1e-6);

console.log('\nALL PASS');
