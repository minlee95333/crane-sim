// 거시 계획의 3D 리플레이를 시간 샘플링해 물리 형상 충돌을 검증한다.

import { checkPair } from '../core/Interference.js';
import { Simulation } from '../sim/Simulation.js';
import { SchedulePlayer } from './SchedulePlayer.js';
import { heightLimitAt, powerLineClearance, segmentPowerLineClearance } from '../core/SiteRules.js';

const TAIL_SIZE = 1.5;

function craneGeometryFromState(spec, state) {
  const [bx, by, bz] = state.basePos;
  const th = state.slewAngle;
  const dir = [Math.cos(th), Math.sin(th)];
  const g = spec.geometry;
  if (spec.type === 'tower') {
    const topY = by + g.mastHeight + 1.4;
    const cjLen = g.counterJibLength ?? g.jibLength * 0.3;
    return {
      segments: [
        { a: [bx, topY, bz], b: [bx + g.jibLength * dir[0], topY, bz + g.jibLength * dir[1]], part: 'jib' },
        { a: [bx, topY, bz], b: [bx - cjLen * dir[0], topY, bz - cjLen * dir[1]], part: 'counterJib' },
      ],
      tail: { pos: [bx - cjLen * dir[0], topY, bz - cjLen * dir[1]], r: TAIL_SIZE },
      body: { pos: [bx, by, bz], radius: g.bodyRadius ?? 1.2, height: g.mastHeight },
    };
  }
  const boomLength = state.extra.boomLength ?? g.boomLength;
  const boomAngle = state.extra.boomAngle;
  const tipRadius = (g.pivotOffset ?? 0) + boomLength * Math.cos(boomAngle);
  const tipY = by + g.pivotHeight + boomLength * Math.sin(boomAngle);
  const tailR = g.tailSwingRadius ?? 4.5;
  return {
    segments: [{
      a: [bx + (g.pivotOffset ?? 0) * dir[0], by + g.pivotHeight, bz + (g.pivotOffset ?? 0) * dir[1]],
      b: [bx + tipRadius * dir[0], tipY, bz + tipRadius * dir[1]],
      part: 'boom',
    }],
    tail: { pos: [bx - tailR * dir[0], by + (g.tailHeight ?? 2.5), bz - tailR * dir[1]], r: TAIL_SIZE },
    body: {
      pos: [bx, by, bz],
      radius: g.bodyRadius ?? Math.max(g.bodyWidth, g.bodyLength) / 2,
      height: g.bodyHeight ?? 3.2,
    },
  };
}

function obstacleBox(obstacle) {
  const [x, y, z] = obstacle.pos;
  const [sx, sy, sz] = obstacle.size;
  return { min: [x - sx / 2, y, z - sz / 2], max: [x + sx / 2, y + sy, z + sz / 2] };
}

function segmentAabb(a, b, box, padding = 0) {
  let tMin = 0;
  let tMax = 1;
  for (let axis = 0; axis < 3; axis++) {
    const min = box.min[axis] - padding;
    const max = box.max[axis] + padding;
    const d = b[axis] - a[axis];
    if (Math.abs(d) < 1e-12) {
      if (a[axis] < min || a[axis] > max) return false;
      continue;
    }
    const inv = 1 / d;
    let t1 = (min - a[axis]) * inv;
    let t2 = (max - a[axis]) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }
  return true;
}

function bodyAabb(body, box) {
  const x = Math.max(box.min[0], Math.min(body.pos[0], box.max[0]));
  const z = Math.max(box.min[2], Math.min(body.pos[2], box.max[2]));
  const horizontal = Math.hypot(body.pos[0] - x, body.pos[2] - z);
  const vertical = body.pos[1] < box.max[1] && body.pos[1] + body.height > box.min[1];
  return vertical && horizontal < body.radius;
}

function sphereAabb(sphere, box) {
  let d2 = 0;
  for (let axis = 0; axis < 3; axis++) {
    const v = sphere.pos[axis];
    const q = Math.max(box.min[axis], Math.min(v, box.max[axis]));
    d2 += (v - q) ** 2;
  }
  return d2 < sphere.r ** 2;
}

function loadAabb(load, box) {
  const half = load.size.map((v) => v / 2);
  return [0, 1, 2].every((axis) =>
    load.pos[axis] + half[axis] > box.min[axis] &&
    load.pos[axis] - half[axis] < box.max[axis]
  );
}

function pointInZone(point, zone) {
  const min = zone.min ?? [zone.x1, zone.y1];
  const max = zone.max ?? [zone.x2, zone.y2];
  return point[0] >= Math.min(min[0], max[0]) && point[0] <= Math.max(min[0], max[0]) &&
    point[2] >= Math.min(min[1], max[1]) && point[2] <= Math.max(min[1], max[1]);
}

function detectAt(scenario, state) {
  const detections = [];
  const geometries = state.cranes.map((crane, i) => craneGeometryFromState(scenario.cranes[i], crane));
  const boxes = (scenario.obstacles ?? []).map((obstacle) => ({ obstacle, box: obstacleBox(obstacle) }));

  for (let i = 0; i < geometries.length; i++) {
    const geometry = geometries[i];
    const craneId = scenario.cranes[i].id;
    for (const { obstacle, box } of boxes) {
      if (bodyAabb(geometry.body, box)) {
        detections.push({ key: `body:${craneId}:${obstacle.id}`, type: 'bodyObstacle', craneId, obstacleId: obstacle.id });
      }
      if (geometry.segments.some((segment) => segmentAabb(segment.a, segment.b, box, 0.5))) {
        detections.push({ key: `boom:${craneId}:${obstacle.id}`, type: 'boomObstacle', craneId, obstacleId: obstacle.id });
      }
      if (sphereAabb(geometry.tail, box)) {
        detections.push({ key: `tail:${craneId}:${obstacle.id}`, type: 'tailObstacle', craneId, obstacleId: obstacle.id });
      }
    }
  }

  for (let a = 0; a < geometries.length; a++) {
    for (let b = a + 1; b < geometries.length; b++) {
      const pair = checkPair(geometries[a], geometries[b]);
      if (pair.clash) {
        const aId = scenario.cranes[a].id;
        const bId = scenario.cranes[b].id;
        detections.push({
          key: `crane:${aId}:${bId}`,
          type: pair.tailContact ? 'tailCrane' : 'boomCrane',
          craneIds: [aId, bId],
          clearance: pair.boomDist,
        });
      }
    }
  }

  const zones = scenario.restrictedZones ?? scenario.noFlyZones ?? [];
  for (const load of state.loads.filter((item) => item.state === 'hooked')) {
    for (const { obstacle, box } of boxes) {
      if (loadAabb(load, box)) {
        detections.push({ key: `load:${load.id}:${obstacle.id}`, type: 'loadObstacle', loadId: load.id, obstacleId: obstacle.id });
      }
    }
    for (const zone of zones) {
      if (pointInZone(load.pos, zone)) {
        detections.push({ key: `zone:${load.id}:${zone.id}`, type: 'loadRestrictedZone', loadId: load.id, zoneId: zone.id });
      }
    }
  }
  state.cranes.forEach((crane, index) => {
    const craneId = scenario.cranes[index].id;
    const geometry = geometries[index];
    const power = [
      powerLineClearance(crane.hookPos, scenario.powerLines ?? []),
      ...geometry.segments.map((segment) =>
        segmentPowerLineClearance(segment.a, segment.b, scenario.powerLines ?? [])),
    ].sort((a, b) => a.clearance - b.clearance)[0];
    if (!power.safe) detections.push({
      key: `power:${craneId}:${power.lineId}`, type: 'powerLineClearance',
      craneId, lineId: power.lineId, clearance: power.clearance,
    });
    const height = [crane.hookPos, ...geometry.segments.flatMap((segment) => [segment.a, segment.b])]
      .map((point) => heightLimitAt(point, scenario.heightLimits ?? []))
      .find((item) => !item.safe) ?? heightLimitAt(crane.hookPos, scenario.heightLimits ?? []);
    if (!height.safe) detections.push({
      key: `height:${craneId}:${height.zoneId}`, type: 'heightLimit',
      craneId, zoneId: height.zoneId,
    });
  });
  return detections;
}

/** 계획 전체를 샘플링하고 연속 충돌을 하나의 시간 구간으로 합친다. */
export function validateSchedule3D(scenario, result, options = {}) {
  const sampleStep = Math.max(0.25, options.sampleStep ?? 5);
  const sim = new Simulation(scenario);
  const player = new SchedulePlayer(scenario, result);
  const baseState = sim.getState();
  const active = new Map();
  const violations = [];
  for (const assignment of result.assignments.filter((a) => a.tandem)) {
    const lifts = result.events.filter((e) =>
      e.assignmentId === assignment.assignmentId && e.type === 'lift');
    const ids = new Set(lifts.map((e) => e.craneId));
    const synchronized = lifts.length === 2 &&
      ids.size === 2 &&
      Math.abs(lifts[0].start - lifts[1].start) < 1e-9 &&
      Math.abs(lifts[0].finish - lifts[1].finish) < 1e-9;
    if (!synchronized || assignment.craneIds?.some((id) => !ids.has(id))) {
      violations.push({
        key: `tandem-sync:${assignment.assignmentId}`,
        type: 'tandemSynchronization',
        loadId: assignment.loadId,
        craneIds: assignment.craneIds,
        start: assignment.liftStart,
        end: assignment.liftFinish,
      });
    }
  }
  let samples = 0;

  for (let time = 0; time <= result.makespan + 1e-9; time += sampleStep) {
    samples += 1;
    const detections = detectAt(scenario, player.stateAt(baseState, Math.min(time, result.makespan)));
    const present = new Set(detections.map((d) => d.key));
    for (const detection of detections) {
      const current = active.get(detection.key);
      if (current) current.end = Math.min(time + sampleStep, result.makespan);
      else active.set(detection.key, { ...detection, start: time, end: Math.min(time + sampleStep, result.makespan) });
    }
    for (const [key, violation] of active) {
      if (!present.has(key)) {
        violations.push(violation);
        active.delete(key);
      }
    }
  }
  violations.push(...active.values());
  const byType = {};
  for (const violation of violations) byType[violation.type] = (byType[violation.type] ?? 0) + 1;
  return {
    valid: violations.length === 0,
    sampleStep,
    samples,
    violations,
    byType,
  };
}
