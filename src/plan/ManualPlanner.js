// 사용자가 지정한 크레인 배정·크레인별 순서를 실행 가능한 전체 시간축으로 계산한다.

import {
  candidateOutcome,
  evaluateSetupCandidate,
  setupCandidates,
  validatePlanningScenario,
} from './MacroPlanner.js';

const xz = (p) => (p.length === 3 ? [p[0], p[2]] : [p[0], p[1]]);

function phase(events, assignmentId, craneId, loadId, type, start, finish, extra = {}) {
  if (finish <= start + 1e-9) return;
  events.push({ assignmentId, craneId, loadId, type, start, finish, duration: finish - start, ...extra });
}

export function validateManualPlan(scenario, plan) {
  const errors = [...validatePlanningScenario(scenario).errors];
  const craneIds = new Set(scenario.cranes.map((c) => c.id));
  const loadIds = new Set(scenario.loads.filter((l) => l.target).map((l) => l.id));
  const assigned = new Set();
  for (const [i, item] of plan.entries()) {
    if (!craneIds.has(item.craneId)) errors.push(`plan[${i}]: 잘못된 craneId ${item.craneId}`);
    if (!loadIds.has(item.loadId)) errors.push(`plan[${i}]: 잘못된 loadId ${item.loadId}`);
    if (assigned.has(item.loadId)) errors.push(`중복 배정: ${item.loadId}`);
    assigned.add(item.loadId);
  }
  for (const loadId of loadIds) if (!assigned.has(loadId)) errors.push(`미배정 양중물: ${loadId}`);
  return { valid: errors.length === 0, errors };
}

export function evaluateManualPlan(scenario, plan, options = {}) {
  const check = validateManualPlan(scenario, plan);
  if (!check.valid) throw new Error(check.errors.join('; '));

  const craneStates = scenario.cranes.map((spec) => ({
    spec,
    pos: xz(spec.basePos),
    available: 0,
    jobs: 0,
  }));
  const stateById = new Map(craneStates.map((state) => [state.spec.id, state]));
  const loadById = new Map(scenario.loads.map((load) => [load.id, load]));
  const queues = new Map(scenario.cranes.map((crane) => [crane.id, []]));
  for (const item of plan) queues.get(item.craneId).push({ ...item });

  const completed = new Map();
  const assignments = [];
  const failed = [];
  let guard = 0;

  while (completed.size + failed.length < plan.length && guard++ < plan.length * 4) {
    const choices = [];
    for (const [craneId, queue] of queues) {
      while (queue.length && (completed.has(queue[0].loadId) || failed.some((f) => f.loadId === queue[0].loadId))) queue.shift();
      if (!queue.length) continue;
      const planItem = queue[0];
      const load = loadById.get(planItem.loadId);
      if (!(load.dependsOn ?? []).every((id) => completed.has(id))) continue;
      const craneState = stateById.get(craneId);
      let setups;
      let alternatives;
      if (planItem.setupPos) {
        const explicit = evaluateSetupCandidate(
          craneState.spec,
          load,
          scenario,
          craneState.pos,
          planItem.setupPos,
          planItem.boomLength,
          options,
        );
        if (!explicit.feasible) {
          failed.push({ loadId: load.id, craneId, reason: explicit.reason });
          queue.shift();
          continue;
        }
        setups = [explicit];
        alternatives = [
          explicit,
          ...setupCandidates(craneState.spec, load, scenario, craneState.pos, options)
            .filter((candidate) =>
              Math.hypot(candidate.pos[0] - explicit.pos[0], candidate.pos[1] - explicit.pos[1]) > 0.25 ||
              candidate.boomLength !== explicit.boomLength
            ),
        ].slice(0, 5);
      } else {
        setups = setupCandidates(craneState.spec, load, scenario, craneState.pos, options);
        alternatives = setups;
      }
      const outcomes = setups
        .map((setup) => candidateOutcome(scenario, craneState, load, completed, assignments, setup, options))
        .filter((outcome) => outcome.feasible)
        .sort((a, b) =>
          a.liftFinish - b.liftFinish ||
          Number(b.sameSetup) - Number(a.sameSetup) ||
          a.move - b.move
        );
      if (outcomes.length) {
        outcomes[0].setupAlternatives = alternatives.slice(0, 5).map((setup) => ({
          pos: setup.pos,
          boomLength: setup.boomLength,
          move: setup.path.distance,
          capacityMargin: setup.capacityMargin,
        }));
        choices.push({ craneState, load, outcome: outcomes[0] });
      }
      else {
        failed.push({ loadId: load.id, craneId, reason: '지정 크레인에서 실행 가능한 셋업 없음' });
        queue.shift();
      }
    }
    if (!choices.length) break;
    choices.sort((a, b) => a.outcome.liftFinish - b.outcome.liftFinish);
    const best = choices[0];
    assignments.push(best.outcome);
    completed.set(best.load.id, best.outcome);
    queues.get(best.craneState.spec.id).shift();
    best.craneState.pos = best.outcome.setupPos;
    best.craneState.available = best.outcome.liftFinish;
    best.craneState.jobs += 1;
  }

  for (const [craneId, queue] of queues) {
    for (const item of queue) {
      if (!completed.has(item.loadId) && !failed.some((f) => f.loadId === item.loadId)) {
        failed.push({ loadId: item.loadId, craneId, reason: '크레인별 순서와 선행 작업이 충돌해 데드락' });
      }
    }
  }

  const events = [];
  for (const a of assignments) {
    phase(events, a.assignmentId, a.craneId, a.loadId, 'spaceWait', a.teardownStart - a.spatialWait, a.teardownStart);
    phase(events, a.assignmentId, a.craneId, a.loadId, 'teardown', a.teardownStart, a.teardownFinish);
    phase(events, a.assignmentId, a.craneId, a.loadId, 'travel', a.travelStart, a.travelFinish, { path: a.movePath });
    phase(events, a.assignmentId, a.craneId, a.loadId, 'setup', a.setupStart, a.setupFinish);
    phase(events, a.assignmentId, a.craneId, a.loadId, 'waiting', a.setupFinish, a.liftStart);
    phase(events, a.assignmentId, a.craneId, a.loadId, 'lift', a.liftStart, a.liftFinish);
  }
  if (scenario.planning?.includeFinalTeardown ?? true) {
    for (const state of craneStates) {
      if (!state.jobs) continue;
      const duration = state.spec.planning?.teardownTime ?? (state.spec.type === 'tower' ? 0 : 300);
      phase(events, `${state.spec.id}:final`, state.spec.id, null, 'finalTeardown', state.available, state.available + duration);
      state.available += duration;
    }
  }
  events.sort((a, b) => a.start - b.start || a.craneId.localeCompare(b.craneId));
  const makespan = Math.max(0, ...craneStates.map((state) => state.available));
  const perCrane = craneStates.map((state) => {
    const own = events.filter((event) => event.craneId === state.spec.id);
    const busyTime = own.filter((event) => event.type !== 'waiting' && event.type !== 'spaceWait')
      .reduce((sum, event) => sum + event.duration, 0);
    const ownAssignments = assignments.filter((assignment) => assignment.craneId === state.spec.id);
    return {
      craneId: state.spec.id,
      jobs: ownAssignments.length,
      busyTime,
      idleTime: Math.max(0, makespan - busyTime),
      travelDistance: ownAssignments.reduce((sum, assignment) => sum + assignment.move, 0),
      setupChanges: ownAssignments.filter((assignment) => !assignment.sameSetup).length,
    };
  });
  return {
    policy: 'manual',
    manualPlan: plan.map((item) => ({ ...item })),
    assignments,
    events,
    makespan,
    completed: assignments.length,
    total: plan.length,
    failed,
    hardConflicts: assignments.reduce((sum, a) => sum + a.hardConflicts.length, 0),
    softConflicts: assignments.reduce((sum, a) => sum + a.softConflicts.length, 0),
    perCrane,
  };
}
