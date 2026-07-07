// 다중 크레인·다중 양중물 거시 계획 엔진.
// 상세 리깅/조작 물리 대신 TEARDOWN→TRAVEL→SETUP→LIFT 이벤트를 계산한다.

import { evaluateSetup, radiusRangeOf } from './SetupPlanner.js';
import { pointInZone, shortestPath } from './PathPlanner.js';
import { Truck, deriveTrucks } from '../core/Truck.js';
import { evaluateLaydown } from '../core/SiteRules.js';

const xz = (p) => (p.length === 3 ? [p[0], p[2]] : [p[0], p[1]]);
const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const samePoint = (a, b, eps = 0.25) => d2(a, b) <= eps;

export const PLAN_POLICIES = ['earliestFinish', 'nearest', 'radiusPriority'];

function tandemShares(load) {
  const points = load.liftPoints ?? [[-Math.max(load.size[0], load.size[2]) * 0.4, 0],
    [Math.max(load.size[0], load.size[2]) * 0.4, 0]];
  const cog = load.cog ?? [0, 0];
  const inverse = points.map((p) => 1 / Math.max(1e-6, Math.hypot(p[0] - cog[0], (p[1] ?? 0) - (cog[1] ?? 0))));
  const total = inverse[0] + inverse[1];
  return inverse.map((v) => load.mass * v / total);
}

/** 탠덤 부재 1건의 크레인쌍 후보. 각 크레인은 분담 하중으로 기존 셋업 판정을 재사용한다. */
export function tandemCandidates(scenario, lift, craneStates, options = {}) {
  if (!lift.tandem || craneStates.length < 2) return [];
  const shares = tandemShares(lift);
  const points = lift.liftPoints ?? [[-Math.max(lift.size[0], lift.size[2]) * 0.4, 0],
    [Math.max(lift.size[0], lift.size[2]) * 0.4, 0]];
  const out = [];
  for (let a = 0; a < craneStates.length; a++) {
    for (let b = a + 1; b < craneStates.length; b++) {
      const states = [craneStates[a], craneStates[b]];
      const setups = states.map((state, i) => {
        const part = {
          ...lift,
          tandem: false,
          mass: shares[i],
          pos: [lift.pos[0] + points[i][0], lift.pos[1], lift.pos[2] + (points[i][1] ?? 0)],
          target: [lift.target[0] + points[i][0], lift.target[1], lift.target[2] + (points[i][1] ?? 0)],
        };
        return setupCandidates(state.spec, part, scenario, state.pos, options)[0] ?? null;
      });
      if (setups.every(Boolean)) out.push({
        craneStates: states,
        craneIds: states.map((s) => s.spec.id),
        setups,
        shares,
        move: setups[0].path.distance + setups[1].path.distance,
      });
    }
  }
  return out;
}

export function validatePlanningScenario(scenario) {
  const errors = [];
  const craneIds = new Set();
  const loadIds = new Set();
  for (const [i, c] of (scenario.cranes ?? []).entries()) {
    if (!c.id) errors.push(`cranes[${i}].id 누락`);
    if (craneIds.has(c.id)) errors.push(`중복 crane id: ${c.id}`);
    craneIds.add(c.id);
  }
  for (const [i, l] of (scenario.loads ?? []).entries()) {
    if (!l.id) errors.push(`loads[${i}].id 누락`);
    if (!l.target && !l.route?.length) errors.push(`${l.id ?? i}: target 또는 route 누락`);
    if (loadIds.has(l.id)) errors.push(`중복 load id: ${l.id}`);
    loadIds.add(l.id);
  }
  for (const l of scenario.loads ?? []) {
    for (const dep of l.dependsOn ?? []) {
      if (!loadIds.has(dep)) errors.push(`${l.id}: 존재하지 않는 선행 작업 ${dep}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map((scenario.loads ?? []).map((l) => [l.id, l]));
  const visit = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) if (visit(dep)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const id of loadIds) {
    if (visit(id)) {
      errors.push(`선행 작업 순환: ${id}`);
      break;
    }
  }
  return { valid: errors.length === 0, errors };
}

/** 단일 목표와 다단계 route를 거시 계획이 소비하는 개별 리프트 작업으로 정규화한다. */
function planningLifts(scenario) {
  const stagedIds = scenario.loads
    .filter((load) => (load.route?.length ?? 0) > 1)
    .map((load) => `${load.id}@0`);
  return scenario.loads.flatMap((load) => {
    const legs = load.route?.length
      ? load.route
      : [{ target: load.target, elev: load.targetElev ?? 0 }];
    let from = [...load.pos];
    if (from.length === 2) from = [from[0], (load.elev ?? 0) + load.size[1] / 2, from[1]];
    else from[1] = (load.elev ?? (from[1] - load.size[1] / 2)) + load.size[1] / 2;
    return legs.map((leg, stage) => {
      const targetElev = leg.elev ?? 0;
      const targetPos = [leg.target[0], targetElev + load.size[1] / 2, leg.target[1]];
      const jobId = `${load.id}@${stage}`;
      const prior = stage > 0 ? [`${load.id}@${stage - 1}`] : [];
      const erectionBarrier = stage > 0 ? stagedIds.filter((id) => id !== `${load.id}@0`) : [];
      const finalDeps = stage === legs.length - 1
        ? (load.dependsOn ?? []).map((id) => {
          const dep = scenario.loads.find((item) => item.id === id);
          return `${id}@${Math.max(0, (dep?.route?.length ?? 1) - 1)}`;
        })
        : [];
      const lift = {
        ...load,
        id: jobId,
        loadId: load.id,
        jobId,
        stage,
        stages: legs.length,
        pos: [...from],
        target: [...targetPos],
        targetElev,
        dependsOn: [...new Set([...prior, ...erectionBarrier, ...finalDeps])],
        arriveTime: stage === 0 ? (load.arriveTime ?? 0) : 0,
      };
      from = [...targetPos];
      return lift;
    });
  });
}

function siteZones(scenario) {
  return scenario.restrictedZones ?? scenario.noFlyZones ?? [];
}

function obstacleZones(scenario) {
  return (scenario.obstacles ?? []).map((obstacle) => {
    const pos = xz(obstacle.pos);
    const size = obstacle.size ?? [1, 1, 1];
    return {
      id: `obstacle:${obstacle.id ?? 'unknown'}`,
      min: [pos[0] - size[0] / 2, pos[1] - size[2] / 2],
      max: [pos[0] + size[0] / 2, pos[1] + size[2] / 2],
      kind: 'obstacle',
    };
  });
}

function fixedCraneZones(scenario, activeSpec) {
  return scenario.cranes
    .filter((spec) => spec.id !== activeSpec.id && (spec.planning?.movable ?? spec.type !== 'tower') === false)
    .map((spec) => {
      const pos = xz(spec.basePos);
      const other = spec.geometry.bodyRadius ?? Math.max(spec.geometry.bodyWidth ?? 2, spec.geometry.bodyLength ?? 2) / 2;
      return {
        id: `fixed-crane:${spec.id}`,
        min: [pos[0] - other, pos[1] - other],
        max: [pos[0] + other, pos[1] + other],
        kind: 'fixedCrane',
      };
    });
}

function truckZones(scenario) {
  // 반입 트럭 도킹 풋프린트 — 하역 베이는 셋업·주행 회피 대상 (시간 무관 예약)
  return (scenario.trucks ?? deriveTrucks(scenario)).map((spec) =>
    new Truck(spec).dockZone(0.5),
  );
}

/** 이동/셋업 검증에 사용하는 모든 평면 금지영역. */
export function planningZones(scenario, activeSpec) {
  return [
    ...siteZones(scenario),
    ...obstacleZones(scenario),
    ...fixedCraneZones(scenario, activeSpec),
    ...truckZones(scenario),
  ];
}

function inBounds(pos, scenario) {
  const site = scenario.site;
  if (!site) return true;
  const minX = site.minX ?? -((site.width ?? 200) / 2);
  const maxX = site.maxX ?? minX + (site.width ?? 200);
  const minZ = site.minZ ?? -((site.depth ?? 200) / 2);
  const maxZ = site.maxZ ?? minZ + (site.depth ?? 200);
  return pos[0] >= minX && pos[0] <= maxX && pos[1] >= minZ && pos[1] <= maxZ;
}

function boomOptions(spec) {
  if (spec.type === 'tower') return [spec.geometry.jibLength];
  return spec.capacityChart?.map((row) => row[0]) ?? [spec.geometry.boomLength];
}

/** 픽업·목표를 함께 도달할 셋업 후보를 V2 방식의 면적 샘플링으로 생성한다. */
export function setupCandidates(spec, lift, scenario, currentPos, opts = {}) {
  const zones = planningZones(scenario, spec);
  const bodyClearance =
    opts.bodyClearance ??
    Math.max(
      spec.geometry.bodyRadius ?? Math.max(spec.geometry.bodyWidth ?? 2, spec.geometry.bodyLength ?? 2) / 2,
      spec.geometry.tailSwingRadius ?? 0,
    );
  const angles = opts.angles ?? 16;
  const rings = opts.rings ?? 5;
  const topK = opts.topK ?? 8;
  const pickup = xz(lift.pos);
  const target = xz(lift.target);
  const center = [(pickup[0] + target[0]) / 2, (pickup[1] + target[1]) / 2];
  const raw = [currentPos, center, pickup, target];

  for (const boomLength of boomOptions(spec)) {
    const [, rMax] = radiusRangeOf(spec, boomLength);
    for (let ring = 1; ring <= rings; ring++) {
      const radius = (rMax * 0.9 * ring) / rings;
      for (let a = 0; a < angles; a++) {
        const th = (2 * Math.PI * a) / angles;
        raw.push([center[0] + radius * Math.cos(th), center[1] + radius * Math.sin(th)]);
      }
    }
  }

  const unique = [];
  const seen = new Set();
  for (const pos of raw) {
    const key = `${pos[0].toFixed(2)},${pos[1].toFixed(2)}`;
    if (seen.has(key) || !inBounds(pos, scenario) || zones.some((z) => pointInZone(pos, z, bodyClearance))) continue;
    seen.add(key);
    unique.push(pos);
  }

  const found = [];
  for (const boomLength of boomOptions(spec)) {
    for (const pos of unique) {
      const configId = spec.configurations?.find((config) => config.boomLength === boomLength)?.id;
      const ev = evaluateSetup(spec, { pos, boomLength, configId }, [lift], scenario);
      if (!ev.feasible) continue;
      const path = shortestPath(currentPos, pos, zones, { clearance: bodyClearance });
      if (!path.ok) continue;
      const detail = ev.lifts[0];
      found.push({
        pos,
        boomLength,
        path,
        sameSetup: samePoint(currentPos, pos),
        pickupRadius: detail.rLoad,
        targetRadius: detail.rTarget,
        actualRadius: Math.max(detail.rLoad, detail.rTarget),
        requiredBoomLength: detail.requiredBoomLength,
        capacityMargin: ev.minCapMargin,
        tippingMargin: ev.minTipMargin,
        groundPressure: ev.maxGroundPressure,
        assemblyTime: ev.assembly?.duration ?? 0,
        assemblyCost: ev.assembly?.cost ?? 0,
      });
    }
  }
  found.sort((a, b) =>
    Number(b.sameSetup) - Number(a.sameSetup) ||
    a.path.distance - b.path.distance ||
    b.capacityMargin - a.capacityMargin ||
    a.boomLength - b.boomLength
  );
  return found.slice(0, topK);
}

/** 사용자가 지정한 단일 셋업 위치·붐 길이를 동일한 규칙으로 평가한다. */
export function evaluateSetupCandidate(spec, lift, scenario, currentPos, pos, boomLength, opts = {}) {
  const setupPos = xz(pos);
  const zones = planningZones(scenario, spec);
  const bodyClearance =
    opts.bodyClearance ??
    Math.max(
      spec.geometry.bodyRadius ?? Math.max(spec.geometry.bodyWidth ?? 2, spec.geometry.bodyLength ?? 2) / 2,
      spec.geometry.tailSwingRadius ?? 0,
    );
  if (!inBounds(setupPos, scenario)) return { feasible: false, reason: '현장 경계 밖 셋업' };
  const blocked = zones.find((zone) => pointInZone(setupPos, zone, bodyClearance));
  if (blocked) return { feasible: false, reason: `셋업 금지영역: ${blocked.id}` };
  const selectedBoom = boomLength ?? boomOptions(spec)[0];
  const evaluation = evaluateSetup(spec, { pos: setupPos, boomLength: selectedBoom }, [lift], scenario);
  if (!evaluation.feasible) return { feasible: false, reason: evaluation.lifts[0]?.reason ?? '셋업 불가' };
  const path = shortestPath(currentPos, setupPos, zones, { clearance: bodyClearance });
  if (!path.ok) return { feasible: false, reason: '셋업 위치까지 이동 경로 없음' };
  const detail = evaluation.lifts[0];
  return {
    feasible: true,
    pos: setupPos,
    boomLength: selectedBoom,
    path,
    sameSetup: samePoint(currentPos, setupPos),
    pickupRadius: detail.rLoad,
    targetRadius: detail.rTarget,
    actualRadius: Math.max(detail.rLoad, detail.rTarget),
    requiredBoomLength: detail.requiredBoomLength,
    capacityMargin: evaluation.minCapMargin,
    tippingMargin: evaluation.minTipMargin,
    groundPressure: evaluation.maxGroundPressure,
    assemblyTime: evaluation.assembly?.duration ?? 0,
    assemblyCost: evaluation.assembly?.cost ?? 0,
  };
}

function phase(events, assignmentId, craneId, loadId, type, start, finish, extra = {}) {
  if (finish <= start + 1e-9) return;
  events.push({ assignmentId, craneId, loadId, type, start, finish, duration: finish - start, ...extra });
}

function overlap(a0, a1, b0, b1) {
  return a0 < b1 - 1e-9 && b0 < a1 - 1e-9;
}

function pointSegmentDistance(p, a, b) {
  const vx = b[0] - a[0];
  const vz = b[1] - a[1];
  const len2 = vx * vx + vz * vz;
  if (len2 <= 1e-12) return d2(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / len2));
  return d2(p, [a[0] + vx * t, a[1] + vz * t]);
}

function segmentSegmentDistance(a, b, c, d) {
  // 교차하면 거리 0. 방향성 부호 조합으로 빠르게 판정한다.
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (
    ((abC >= 0 && abD <= 0) || (abC <= 0 && abD >= 0)) &&
    ((cdA >= 0 && cdB <= 0) || (cdA <= 0 && cdB >= 0))
  ) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}

function pathPointDistance(path, point) {
  if (!path?.length) return Infinity;
  if (path.length === 1) return d2(path[0], point);
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    best = Math.min(best, pointSegmentDistance(point, path[i - 1], path[i]));
  }
  return best;
}

function pathPathDistance(a, b) {
  if (!a?.length || !b?.length) return Infinity;
  if (a.length === 1) return pathPointDistance(b, a[0]);
  if (b.length === 1) return pathPointDistance(a, b[0]);
  let best = Infinity;
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      best = Math.min(best, segmentSegmentDistance(a[i - 1], a[i], b[j - 1], b[j]));
    }
  }
  return best;
}

function conflictWith(assign, existing, opts) {
  const baseDist = d2(assign.setupPos, existing.setupPos);
  const hard =
    overlap(assign.liftStart, assign.liftFinish, existing.liftStart, existing.liftFinish) &&
    baseDist < assign.actualRadius + existing.actualRadius + (opts.hardClearance ?? 0);
  const softRadiusA = assign.workingRadius;
  const softRadiusB = existing.workingRadius;
  const soft =
    overlap(assign.liftStart, assign.liftFinish, existing.liftStart, existing.liftFinish) &&
    baseDist < softRadiusA + softRadiusB + (opts.softClearance ?? 0);
  return { hard, soft, baseDist };
}

export function candidateOutcome(scenario, craneState, lift, completed, assignments, setup, opts = {}) {
  const spec = craneState.spec;
  const planning = spec.planning ?? {};
  const movable = planning.movable ?? spec.type !== 'tower';
  if (!movable && !samePoint(craneState.pos, setup.pos)) {
    return { feasible: false, reason: '고정식 크레인은 셋업 위치를 변경할 수 없음' };
  }
  const depFinish = Math.max(0, ...(lift.dependsOn ?? []).map((id) => completed.get(id)?.liftFinish ?? -Infinity));
  if (!Number.isFinite(depFinish)) return { feasible: false, blocked: true, reason: '선행 작업 미완료' };

  const same = samePoint(craneState.pos, setup.pos);
  const teardownTime = same || craneState.jobs === 0 ? 0 : (planning.teardownTime ?? 300);
  const travelSpeed = Math.max(0.01, planning.travelSpeed ?? 1.5);
  const travelTime = same ? 0 : setup.path.distance / travelSpeed;
  const setupTime =
    (same && craneState.jobs > 0 ? 0 : (planning.setupTime ?? (spec.type === 'tower' ? 0 : 600))) +
    (setup.assemblyTime ?? 0);
  const liftDuration = lift.duration ?? scenario.planning?.defaultLiftDuration ?? 1200;

  const initialAvailable = craneState.available;
  let spatialWait = 0;
  let teardownStart = initialAvailable;
  let teardownFinish = teardownStart + teardownTime;
  let travelStart = teardownFinish;
  let travelFinish = travelStart + travelTime;
  let setupStart = travelFinish;
  let setupFinish = setupStart + setupTime;
  let liftStart = Math.max(setupFinish, lift.arriveTime ?? 0, depFinish);
  liftStart = Math.max(liftStart, opts.notBefore?.[`${spec.id}:${lift.id}`] ?? 0);
  let liftFinish = liftStart + liftDuration;
  let hardConflicts = [];

  // 다른 크레인의 셋업 점유구역과 이동/셋업 시간이 겹치면 작업 전체를 뒤로 민다.
  const ownBody = spec.geometry.bodyRadius ?? Math.max(spec.geometry.bodyWidth ?? 2, spec.geometry.bodyLength ?? 2) / 2;
  for (let pass = 0; pass < assignments.length + 1; pass++) {
    const conflicts = assignments.map((a) => {
      if (a.craneId === spec.id) return null;
      const otherSpec = scenario.cranes.find((c) => c.id === a.craneId);
      const otherBody = otherSpec?.geometry.bodyRadius ??
        Math.max(otherSpec?.geometry.bodyWidth ?? 2, otherSpec?.geometry.bodyLength ?? 2) / 2;
      const clearance = ownBody + otherBody + (opts.setupClearance ?? 1);
      const setupHit =
        overlap(setupStart, liftFinish, a.setupStart, a.liftFinish) &&
        d2(setup.pos, a.setupPos) < clearance;
      const travelHit =
        travelTime > 0 &&
        overlap(travelStart, travelFinish, a.setupStart, a.liftFinish) &&
        pathPointDistance(setup.path.path, a.setupPos) < clearance;
      const travelTravelHit =
        travelTime > 0 &&
        a.travelTime > 0 &&
        overlap(travelStart, travelFinish, a.travelStart, a.travelFinish) &&
        pathPathDistance(setup.path.path, a.movePath) < clearance;
      if (!setupHit && !travelHit && !travelTravelHit) return null;
      return {
        assignment: a,
        waitUntil: setupHit || travelHit ? a.liftFinish : a.travelFinish,
      };
    }).filter(Boolean);
    if (!conflicts.length) break;
    const waitUntil = Math.max(...conflicts.map((c) => c.waitUntil));
    spatialWait = Math.max(spatialWait, waitUntil - initialAvailable);
    teardownStart = initialAvailable + spatialWait;
    teardownFinish = teardownStart + teardownTime;
    travelStart = teardownFinish;
    travelFinish = travelStart + travelTime;
    setupStart = travelFinish;
    setupFinish = setupStart + setupTime;
    liftStart = Math.max(setupFinish, lift.arriveTime ?? 0, depFinish);
    liftStart = Math.max(liftStart, opts.notBefore?.[`${spec.id}:${lift.id}`] ?? 0);
    liftFinish = liftStart + liftDuration;
  }

  // hard 간섭은 안전하게 신규 양중을 뒤로 미룬다.
  for (let pass = 0; pass < assignments.length + 1; pass++) {
    const provisional = {
      setupPos: setup.pos,
      actualRadius: setup.actualRadius,
      workingRadius: planning.workingRadius ?? radiusRangeOf(spec, setup.boomLength)[1],
      liftStart,
      liftFinish,
    };
    const clashes = assignments
      .filter((a) => a.craneId !== spec.id)
      .map((a) => ({ a, c: conflictWith(provisional, a, opts) }))
      .filter((x) => x.c.hard);
    if (!clashes.length) break;
    hardConflicts = clashes.map((x) => x.a.assignmentId);
    liftStart = Math.max(liftStart, ...clashes.map((x) => x.a.liftFinish));
    liftFinish = liftStart + liftDuration;
  }

  const result = {
    feasible: true,
    assignmentId: `${spec.id}:${lift.jobId ?? lift.id}`,
    craneId: spec.id,
    loadId: lift.loadId ?? lift.id,
    jobId: lift.jobId ?? lift.id,
    stage: lift.stage ?? 0,
    stages: lift.stages ?? 1,
    pickupPos: [...lift.pos],
    targetPos: [...lift.target],
    setupPos: setup.pos,
    fromPos: craneState.pos,
    boomLength: setup.boomLength,
    movePath: setup.path.path,
    directMove: setup.path.directDistance,
    move: setup.path.distance,
    detourDistance: setup.path.detourDistance,
    sameSetup: same,
    pickupRadius: setup.pickupRadius,
    targetRadius: setup.targetRadius,
    actualRadius: setup.actualRadius,
    requiredBoomLength: setup.requiredBoomLength,
    capacityMargin: setup.capacityMargin,
    workingRadius: planning.workingRadius ?? radiusRangeOf(spec, setup.boomLength)[1],
    teardownStart, teardownFinish, travelStart, travelFinish,
    setupStart, setupFinish, liftStart, liftFinish,
    teardownTime, travelTime, setupTime, liftDuration,
    assemblyCost: setup.assemblyCost ?? 0,
    spatialWait,
    hardConflicts,
    softConflicts: [],
  };
  result.softConflicts = assignments
    .filter((a) => a.craneId !== spec.id && conflictWith(result, a, opts).soft)
    .map((a) => a.assignmentId);
  return result;
}

function candidateKey(policy, out) {
  if (policy === 'nearest') return [out.move, out.liftFinish, out.softConflicts.length, -out.capacityMargin];
  if (policy === 'radiusPriority') return [out.sameSetup ? 0 : 1, out.liftFinish, out.move, out.softConflicts.length];
  return [out.liftFinish, out.softConflicts.length, out.sameSetup ? 0 : 1, out.move, -out.capacityMargin];
}

function compareKey(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (Math.abs(d) > 1e-9) return d;
  }
  return 0;
}

/** RL 없이 결정론적으로 전체 계획을 생성한다. */
export function generateMacroPlan(scenario, options = {}) {
  const check = validatePlanningScenario(scenario);
  if (!check.valid) throw new Error(check.errors.join('; '));
  const policy = options.policy ?? 'earliestFinish';
  if (!PLAN_POLICIES.includes(policy)) throw new Error(`지원하지 않는 정책: ${policy}`);

  const craneStates = scenario.cranes.map((spec) => ({
    spec,
    pos: xz(spec.basePos ?? [0, 0, 0]),
    available: 0,
    jobs: 0,
  }));
  const laydown = evaluateLaydown(scenario.loads ?? [], scenario.laydown);
  if (!laydown.feasible) {
    return {
      policy, assignments: [], events: [], makespan: 0, completed: 0,
      total: planningLifts(scenario).length,
      failed: [{ loadId: null, reason: `야적장 용량 부족 (${laydown.reason})` }],
      hardConflicts: 0, softConflicts: 0, perCrane: [], laydown,
    };
  }
  const rehandleDuration = scenario.laydown?.rehandleDuration ?? 0;
  const rehandleCount = laydown.rehandles.reduce((sum, item) => sum + item.count, 0);
  if (craneStates[0] && rehandleCount > 0) {
    craneStates[0].available = rehandleCount * rehandleDuration;
  }
  const lifts = planningLifts(scenario);
  if (lifts.length > 0 && lifts.every((lift) => lift.tandem)) {
    return generateTandemMacroPlan(scenario, lifts, craneStates, options);
  }
  const remaining = new Map(lifts.map((l) => [l.jobId, l]));
  const completed = new Map();
  const assignments = [];
  const failed = [];
  let guard = 0;

  while (remaining.size && guard++ < lifts.length * 4) {
    const ready = [...remaining.values()].filter((l) =>
      (l.dependsOn ?? []).every((id) => completed.has(id))
    );
    if (!ready.length) break;
    const choices = [];
    for (const lift of ready) {
      for (const craneState of craneStates) {
        const setups = setupCandidates(craneState.spec, lift, scenario, craneState.pos, options);
        for (const setup of setups) {
          const out = candidateOutcome(scenario, craneState, lift, completed, assignments, setup, options);
          if (out.feasible) choices.push({ out, craneState, lift, key: candidateKey(policy, out) });
        }
      }
    }
    if (!choices.length) {
      for (const lift of ready) {
        failed.push({ loadId: lift.id, reason: '모든 크레인·셋업 후보에서 실행 불가' });
        remaining.delete(lift.id);
      }
      continue;
    }
    choices.sort((a, b) => compareKey(a.key, b.key) || a.lift.id.localeCompare(b.lift.id) || a.out.craneId.localeCompare(b.out.craneId));
    const best = choices[0];
    best.out.setupAlternatives = choices
      .filter((choice) => choice.out.craneId === best.out.craneId && choice.lift.id === best.lift.id)
      .slice(0, 5)
      .map((choice) => ({
        pos: choice.out.setupPos,
        boomLength: choice.out.boomLength,
        move: choice.out.move,
        capacityMargin: choice.out.capacityMargin,
      }));
    assignments.push(best.out);
    completed.set(best.lift.jobId, best.out);
    remaining.delete(best.lift.jobId);
    best.craneState.pos = best.out.setupPos;
    best.craneState.available = best.out.liftFinish;
    best.craneState.jobs += 1;
  }

  for (const lift of remaining.values()) failed.push({ loadId: lift.id, reason: '선행 작업 미완료 또는 계획 데드락' });

  const events = [];
  if (rehandleCount > 0 && craneStates[0]) {
    phase(events, 'laydown:rehandle', craneStates[0].spec.id, null, 'rehandle',
      0, rehandleCount * rehandleDuration, { count: rehandleCount });
  }
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

  const makespan = Math.max(0, ...craneStates.map((c) => c.available));
  const perCrane = craneStates.map((state) => {
    const own = events.filter((e) => e.craneId === state.spec.id);
    const busyTime = own.filter((e) => e.type !== 'waiting').reduce((s, e) => s + e.duration, 0);
    return {
      craneId: state.spec.id,
      jobs: assignments.filter((a) => a.craneId === state.spec.id).length,
      busyTime,
      idleTime: Math.max(0, makespan - busyTime),
      travelDistance: assignments.filter((a) => a.craneId === state.spec.id).reduce((s, a) => s + a.move, 0),
      setupChanges: assignments.filter((a) => a.craneId === state.spec.id && !a.sameSetup).length,
    };
  });

  return {
    policy,
    assignments,
    events,
    makespan,
    completed: assignments.length,
    total: lifts.length,
    failed,
    hardConflicts: assignments.reduce((s, a) => s + a.hardConflicts.length, 0),
    softConflicts: assignments.reduce((s, a) => s + a.softConflicts.length, 0),
    perCrane,
    laydown,
    rehandleCount,
  };
}

function generateTandemMacroPlan(scenario, lifts, craneStates, options) {
  const assignments = [];
  const events = [];
  const failed = [];
  for (const lift of lifts) {
    const candidates = tandemCandidates(scenario, lift, craneStates, options)
      .sort((a, b) => {
        const af = Math.max(...a.craneStates.map((s) => s.available)) + a.move;
        const bf = Math.max(...b.craneStates.map((s) => s.available)) + b.move;
        return af - bf || a.craneIds.join(':').localeCompare(b.craneIds.join(':'));
      });
    const best = candidates[0];
    if (!best) {
      failed.push({ loadId: lift.loadId, reason: '탠덤 크레인쌍·셋업 후보 없음' });
      continue;
    }
    const duration = lift.duration ?? scenario.planning?.defaultLiftDuration ?? 1200;
    const ready = best.craneStates.map((state, i) => {
      const planning = state.spec.planning ?? {};
      const travel = best.setups[i].path.distance / Math.max(0.01, planning.travelSpeed ?? 1.5);
      return state.available + travel + (planning.setupTime ?? 600);
    });
    const liftStart = Math.max(...ready, lift.arriveTime ?? 0);
    const liftFinish = liftStart + duration;
    const assignmentId = `${best.craneIds.join('+')}:${lift.jobId}`;
    const cranePlans = best.craneStates.map((state, i) => {
      const setup = best.setups[i];
      const planning = state.spec.planning ?? {};
      const travelTime = setup.path.distance / Math.max(0.01, planning.travelSpeed ?? 1.5);
      const travelStart = state.available;
      const travelFinish = travelStart + travelTime;
      const setupStart = travelFinish;
      const setupFinish = setupStart + (planning.setupTime ?? 600);
      return {
        craneId: state.spec.id, fromPos: [...state.pos], setupPos: [...setup.pos],
        movePath: setup.path.path, boomLength: setup.boomLength,
        travelStart, travelFinish, setupStart, setupFinish,
      };
    });
    const assignment = {
      assignmentId, tandem: true, craneIds: [...best.craneIds], craneId: best.craneIds[0],
      loadId: lift.loadId, jobId: lift.jobId, stage: lift.stage, stages: lift.stages,
      pickupPos: [...lift.pos], targetPos: [...lift.target], loadShares: [...best.shares],
      liftPoints: lift.liftPoints, cranePlans, liftStart, liftFinish, liftDuration: duration,
      hardConflicts: [], softConflicts: [],
    };
    assignments.push(assignment);
    for (const plan of cranePlans) {
      phase(events, assignmentId, plan.craneId, lift.loadId, 'travel', plan.travelStart, plan.travelFinish,
        { path: plan.movePath, tandem: true });
      phase(events, assignmentId, plan.craneId, lift.loadId, 'setup', plan.setupStart, plan.setupFinish,
        { tandem: true });
      phase(events, assignmentId, plan.craneId, lift.loadId, 'waiting', plan.setupFinish, liftStart,
        { tandem: true });
      phase(events, assignmentId, plan.craneId, lift.loadId, 'lift', liftStart, liftFinish,
        { tandem: true, partnerIds: best.craneIds.filter((id) => id !== plan.craneId) });
    }
    best.craneStates.forEach((state, i) => {
      state.pos = [...best.setups[i].pos];
      state.available = liftFinish;
      state.jobs += 1;
    });
  }
  const makespan = Math.max(0, ...craneStates.map((s) => s.available));
  return {
    policy: options.policy ?? 'earliestFinish', assignments, events,
    makespan, completed: assignments.length, total: lifts.length, failed,
    hardConflicts: 0, softConflicts: 0,
    perCrane: craneStates.map((state) => ({
      craneId: state.spec.id, jobs: state.jobs,
      busyTime: events.filter((e) => e.craneId === state.spec.id && e.type !== 'waiting')
        .reduce((sum, e) => sum + e.duration, 0),
      idleTime: 0,
      travelDistance: assignments.reduce((sum, a) => {
        const plan = a.cranePlans.find((p) => p.craneId === state.spec.id);
        return sum + (plan ? pathLength(plan.movePath) : 0);
      }, 0),
      setupChanges: state.jobs,
    })),
  };
}

function pathLength(path) {
  let total = 0;
  for (let i = 1; i < (path?.length ?? 0); i++) total += d2(path[i - 1], path[i]);
  return total;
}
