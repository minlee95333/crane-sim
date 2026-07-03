// 2D 거시 계획 → 3D 검증 → 충돌 작업 지연 → 재계획 자동 복구 루프.

import { generateMacroPlan } from './MacroPlanner.js';
import { validateSchedule3D } from './ScheduleValidator.js';

function assignmentAt(result, craneId, time, exact = false) {
  const own = result.assignments
    .filter((assignment) => assignment.craneId === craneId)
    .sort((a, b) => a.liftStart - b.liftStart);
  const active = own.find((assignment) => time >= assignment.liftStart && time < assignment.liftFinish);
  if (exact) return active ?? null;
  return (
    active ??
    [...own].reverse().find((assignment) => assignment.liftStart <= time) ??
    own.find((assignment) => assignment.liftStart > time) ??
    null
  );
}

function repairConstraints(result, validation, notBefore, parkSlewAngles, buffer) {
  const added = [];
  for (const violation of validation.violations) {
    if (!violation.craneIds?.length) continue;
    const time = (violation.start + violation.end) / 2;
    const activeAssignments = violation.craneIds
      .map((craneId) => assignmentAt(result, craneId, time, true))
      .filter(Boolean);

    if (activeAssignments.length < 2) {
      const activeIds = new Set(activeAssignments.map((assignment) => assignment.craneId));
      const idleId = violation.craneIds.find((craneId) => !activeIds.has(craneId));
      if (!idleId) continue;
      const previous = parkSlewAngles[idleId] ?? 0;
      const next = previous + Math.PI / 2;
      parkSlewAngles[idleId] = next;
      added.push({
        violationType: violation.type,
        violationStart: violation.start,
        parkedCrane: idleId,
        parkSlewAngle: next,
      });
      continue;
    }

    // 먼저 시작한 작업을 유지하고, 나중 작업을 선행 작업 종료 뒤로 이동한다.
    activeAssignments.sort((a, b) => a.liftStart - b.liftStart || a.craneId.localeCompare(b.craneId));
    const blocker = activeAssignments[0];
    const victim = activeAssignments[activeAssignments.length - 1];
    if (blocker.assignmentId === victim.assignmentId) continue;
    const start = blocker.liftFinish + buffer;
    if ((notBefore[victim.assignmentId] ?? 0) >= start - 1e-9) continue;
    notBefore[victim.assignmentId] = start;
    added.push({
      violationType: violation.type,
      violationStart: violation.start,
      blocker: blocker.assignmentId,
      delayed: victim.assignmentId,
      notBefore: start,
    });
  }
  return added;
}

/**
 * 충돌 없는 계획을 목표로 제한 횟수만큼 재계획한다.
 * 해결하지 못한 경우에도 마지막 계획과 남은 위반을 반환한다.
 */
export function generateValidatedMacroPlan(scenario, options = {}) {
  const maxRepairs = options.maxRepairs ?? 6;
  const repairBuffer = options.repairBuffer ?? 10;
  const sampleStep = options.sampleStep ?? 5;
  const notBefore = { ...(options.notBefore ?? {}) };
  const parkSlewAngles = { ...(options.parkSlewAngles ?? {}) };
  const repairs = [];
  let result;
  let validation;

  for (let iteration = 0; iteration <= maxRepairs; iteration++) {
    result = generateMacroPlan(scenario, { ...options, notBefore });
    result.parkSlewAngles = { ...parkSlewAngles };
    validation = validateSchedule3D(scenario, result, { sampleStep });
    if (validation.valid) break;
    const added = repairConstraints(result, validation, notBefore, parkSlewAngles, repairBuffer);
    if (!added.length) break;
    repairs.push(...added.map((repair) => ({ iteration: iteration + 1, ...repair })));
  }

  result.validation3D = validation;
  result.repairs = repairs;
  result.repairConstraints = notBefore;
  result.parkSlewAngles = parkSlewAngles;
  result.repaired = repairs.length > 0;
  return result;
}
