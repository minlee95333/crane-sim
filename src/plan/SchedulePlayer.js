// 거시 계획 이벤트를 3D 뷰용 상태로 변환한다.
// 상세 붐 동작 전 단계로, TRAVEL은 크레인 베이스를 경로 보간하고
// LIFT는 양중물을 픽업→목표로 결정론적으로 보간한다.

import { Truck, deriveTrucks } from '../core/Truck.js';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const HOOK_CLEARANCE = 0.6;

function pathPosition(path, t) {
  if (!path?.length) return [0, 0];
  if (path.length === 1) return path[0];
  const lengths = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    lengths.push(d);
    total += d;
  }
  let target = clamp01(t) * total;
  for (let i = 0; i < lengths.length; i++) {
    if (target <= lengths[i] || i === lengths.length - 1) {
      const u = lengths[i] > 0 ? target / lengths[i] : 0;
      return [lerp(path[i][0], path[i + 1][0], u), lerp(path[i][1], path[i + 1][1], u)];
    }
    target -= lengths[i];
  }
  return path[path.length - 1];
}

export class SchedulePlayer {
  constructor(scenario, result) {
    this.scenario = scenario;
    this.result = result;
    this.time = 0;
    this.playing = false;
    this.speed = 300;
    // 트럭: 코어 닫힌식으로 재생 시각의 상태를 재계산 (물리 실행과 동일 규칙)
    this.trucks = (scenario.trucks ?? deriveTrucks(scenario)).map((s) => new Truck(s));
  }

  toggle() {
    if (this.time >= this.result.makespan) this.time = 0;
    this.playing = !this.playing;
  }

  reset() {
    this.time = 0;
    this.playing = false;
  }

  setSpeed(speed) {
    this.speed = Math.max(1, Number(speed) || 1);
  }

  seek(time) {
    this.time = Math.max(0, Math.min(this.result.makespan, Number(time) || 0));
  }

  update(dt) {
    if (!this.playing) return;
    this.time = Math.min(this.result.makespan, this.time + dt * this.speed);
    if (this.time >= this.result.makespan) this.playing = false;
  }

  stateAt(baseState, time = this.time) {
    const state = structuredClone(baseState);
    state.time = time;
    const craneIndex = new Map(this.scenario.cranes.map((c, i) => [c.id, i]));
    const loadIndex = new Map(state.loads.map((l, i) => [l.id, i]));
    const activeCranes = new Set();

    for (const assignment of this.result.assignments) {
      if (assignment.tandem) {
        for (const plan of assignment.cranePlans) {
          const ci = craneIndex.get(plan.craneId);
          const crane = state.cranes[ci];
          let pos = plan.fromPos;
          if (time >= plan.travelFinish) pos = plan.setupPos;
          else if (time >= plan.travelStart && plan.travelFinish > plan.travelStart) {
            pos = pathPosition(plan.movePath, (time - plan.travelStart) / (plan.travelFinish - plan.travelStart));
          } else continue;
          const dx = pos[0] - crane.basePos[0];
          const dz = pos[1] - crane.basePos[2];
          crane.basePos = [pos[0], crane.basePos[1], pos[1]];
          crane.hookPos = [crane.hookPos[0] + dx, crane.hookPos[1], crane.hookPos[2] + dz];
        }
        continue;
      }
      const ci = craneIndex.get(assignment.craneId);
      if (ci == null) continue;
      const crane = state.cranes[ci];
      let pos = assignment.fromPos;
      if (time >= assignment.travelFinish) pos = assignment.setupPos;
      else if (time >= assignment.travelStart && assignment.travelFinish > assignment.travelStart) {
        pos = pathPosition(
          assignment.movePath,
          (time - assignment.travelStart) / (assignment.travelFinish - assignment.travelStart),
        );
      } else if (time < assignment.travelStart) {
        continue;
      }
      const old = crane.basePos;
      const dx = pos[0] - old[0];
      const dz = pos[1] - old[2];
      crane.basePos = [pos[0], old[1], pos[1]];
      crane.hookPos = [crane.hookPos[0] + dx, crane.hookPos[1], crane.hookPos[2] + dz];
    }

    for (const assignment of this.result.assignments) {
      const li = loadIndex.get(assignment.loadId);
      if (li == null) continue;
      const load = state.loads[li];
      const def = this.scenario.loads.find((l) => l.id === assignment.loadId);
      if (!def) continue;
      const from = assignment.pickupPos ?? def.pos;
      const target2 = assignment.targetPos ?? def.target;
      if (!target2) continue;
      const to = target2.length === 3 ? target2 : [target2[0], from[1], target2[1]];
      const hookOffset = (load.size?.[1] ?? 1) / 2 + HOOK_CLEARANCE;
      if (assignment.tandem) {
        const t = clamp01((time - assignment.liftStart) / assignment.liftDuration);
        if (time >= assignment.liftFinish) {
          load.pos = [...to];
          load.state = 'placed';
        } else if (time >= assignment.liftStart) {
          const safeY = Math.max(from[1], to[1]) + 12;
          const u = t < 0.3 ? 0 : t < 0.7 ? (t - 0.3) / 0.4 : 1;
          const y = t < 0.3 ? lerp(from[1], safeY, t / 0.3) :
            t < 0.7 ? safeY : lerp(safeY, to[1], (t - 0.7) / 0.3);
          load.pos = [lerp(from[0], to[0], u), y, lerp(from[2], to[2], u)];
          load.state = 'hooked';
          const points = assignment.liftPoints ?? [[-4, 0], [4, 0]];
          assignment.cranePlans.forEach((plan, i) => {
            const crane = state.cranes[craneIndex.get(plan.craneId)];
            activeCranes.add(plan.craneId);
            this.#aimCraneAtPoint(crane, { ...assignment, craneId: plan.craneId, boomLength: plan.boomLength }, [
              load.pos[0] + points[i][0], load.pos[1] + hookOffset, load.pos[2] + (points[i][1] ?? 0),
            ]);
          });
        }
        continue;
      }
      const pickupHook = [from[0], from[1] + hookOffset, from[2]];
      const targetHook = [to[0], to[1] + hookOffset, to[2]];
      if (time >= assignment.liftFinish) {
        load.pos = [...to];
        load.state = assignment.stage >= assignment.stages - 1 ? 'placed' : 'ground';
        load.stage = Math.min(assignment.stage + 1, assignment.stages - 1);
        load.stageChangedAt = assignment.liftFinish;
        if (assignment.stage === 0 && assignment.stages > 1) load.yardedAt = assignment.liftFinish;
      } else if (time >= assignment.liftStart) {
        activeCranes.add(assignment.craneId);
        const t = clamp01((time - assignment.liftStart) / assignment.liftDuration);
        const crane = state.cranes[craneIndex.get(assignment.craneId)];
        const safeY = Math.max(from[1], to[1]) + 12;

        if (t < 0.15) {
          // 후크 접근: 양중물은 지상에 있고 후크만 현재 위치에서 부드럽게 이동한다.
          this.#parkCrane(crane, this.scenario.cranes[craneIndex.get(assignment.craneId)]);
          const parkedHook = [...crane.hookPos];
          const u = t / 0.15;
          load.pos = [...from];
          load.state = 'ground';
          this.#aimCraneAtPoint(crane, assignment, [
            lerp(parkedHook[0], pickupHook[0], u),
            lerp(parkedHook[1], pickupHook[1], u),
            lerp(parkedHook[2], pickupHook[2], u),
          ]);
        } else if (t < 0.35) {
          // 부착 후 안전 높이까지 권상.
          const u = (t - 0.15) / 0.2;
          load.pos = [from[0], lerp(from[1], safeY, u), from[2]];
          load.state = 'hooked';
          this.#aimCraneAtPoint(crane, assignment, [
            load.pos[0], load.pos[1] + hookOffset, load.pos[2],
          ]);
        } else if (t < 0.7) {
          // 안전 높이에서 목표 상부로 이송.
          const u = (t - 0.35) / 0.35;
          load.pos = [lerp(from[0], to[0], u), safeY, lerp(from[2], to[2], u)];
          load.state = 'hooked';
          this.#aimCraneAtPoint(crane, assignment, [
            load.pos[0], load.pos[1] + hookOffset, load.pos[2],
          ]);
        } else if (t < 0.9) {
          // 목표 위치로 권하.
          const u = (t - 0.7) / 0.2;
          load.pos = [to[0], lerp(safeY, to[1], u), to[2]];
          load.state = 'hooked';
          this.#aimCraneAtPoint(crane, assignment, [
            load.pos[0], load.pos[1] + hookOffset, load.pos[2],
          ]);
        } else {
          // 안착·해제 구간.
          load.pos = [...to];
          load.state = assignment.stage >= assignment.stages - 1 ? 'placed' : 'ground';
          load.stage = Math.min(assignment.stage + 1, assignment.stages - 1);
          load.stageChangedAt = assignment.liftFinish;
          if (assignment.stage === 0 && assignment.stages > 1) load.yardedAt = assignment.liftFinish;
          this.#aimCraneAtPoint(crane, assignment, targetHook);
        }
      } else if ((assignment.stage ?? 0) === 0 && time < (def.arriveTime ?? 0)) {
        load.pos = [...from];
        load.state = 'pending';
      } else if ((load.stage ?? 0) === (assignment.stage ?? 0)) {
        load.pos = [...from];
        load.state = 'ground';
      }
    }
    for (let i = 0; i < state.cranes.length; i++) {
      const spec = this.scenario.cranes[i];
      if (!activeCranes.has(spec.id)) this.#parkCrane(state.cranes[i], spec);
    }
    // 트럭: 재생 부재 상태(yardedAt 등)에서 출차 시각을 유도해 시각 t의 스냅샷으로 교체
    state.trucks = this.trucks.map((t) => t.snapshot(time, t.departAtFrom(state.loads)));
    state.lastEvent = this.currentEvent(time);
    return state;
  }

  #parkCrane(crane, spec) {
    const [bx, by, bz] = crane.basePos;
    const angle = this.result.parkSlewAngles?.[spec.id] ?? spec.planning?.parkSlewAngle ?? 0;
    crane.slewAngle = angle;
    if (spec.type === 'tower') {
      const radius = spec.geometry.trolleyMin ?? 2.5;
      const hookY = by + Math.max(2, spec.geometry.mastHeight - 10);
      crane.radius = radius;
      crane.extra.trolleyPos = radius;
      crane.extra.ropeLength = spec.geometry.mastHeight + by - hookY;
      crane.hookPos = [bx + radius * Math.cos(angle), hookY, bz + radius * Math.sin(angle)];
      crane.hookHeight = hookY;
      return;
    }
    const boomLength = crane.extra.boomLength ?? spec.geometry.boomLength;
    const boomAngle = spec.limits.boomAngleMax;
    const radius = (spec.geometry.pivotOffset ?? 0) + boomLength * Math.cos(boomAngle);
    const tipY = by + spec.geometry.pivotHeight + boomLength * Math.sin(boomAngle);
    const hookY = Math.max(by + 2, tipY - Math.max(spec.limits.ropeMin, 5));
    crane.radius = radius;
    crane.extra.boomAngle = boomAngle;
    crane.extra.boomTipY = tipY - by;
    crane.extra.ropeLength = tipY - hookY;
    crane.hookPos = [bx + radius * Math.cos(angle), hookY, bz + radius * Math.sin(angle)];
    crane.hookHeight = hookY;
  }

  #aimCraneAtPoint(crane, assignment, hookPos) {
    if (!crane) return;
    const spec = this.scenario.cranes.find((c) => c.id === assignment.craneId);
    if (!spec) return;
    const [bx, by, bz] = crane.basePos;
    const dx = hookPos[0] - bx;
    const dz = hookPos[2] - bz;
    const horizontal = Math.hypot(dx, dz);
    const hookY = hookPos[1];
    crane.slewAngle = Math.atan2(dz, dx);
    crane.hookPos = [...hookPos];
    crane.hookHeight = hookY;

    if (spec.type === 'tower') {
      const trolleyMin = spec.geometry.trolleyMin ?? 2.5;
      const trolleyPos = Math.max(trolleyMin, Math.min(spec.geometry.jibLength, horizontal));
      crane.radius = trolleyPos;
      crane.extra.trolleyPos = trolleyPos;
      crane.extra.ropeLength = Math.max(
        spec.limits.ropeMin ?? 0,
        spec.geometry.mastHeight + by - hookY,
      );
      return;
    }

    const boomLength = assignment.boomLength ?? spec.geometry.boomLength;
    const pivotOffset = spec.geometry.pivotOffset ?? 0;
    const boomHorizontal = Math.max(0, Math.min(boomLength, horizontal - pivotOffset));
    const boomAngle = Math.acos(boomHorizontal / boomLength);
    const boomTipY = by + spec.geometry.pivotHeight + boomLength * Math.sin(boomAngle);
    crane.radius = pivotOffset + boomHorizontal;
    crane.extra.boomAngle = boomAngle;
    crane.extra.boomLength = boomLength;
    crane.extra.boomTipY = boomTipY - by;
    crane.extra.ropeLength = Math.max(spec.limits.ropeMin ?? 0, boomTipY - hookY);
  }

  currentEvent(time = this.time) {
    const active = this.result.events.filter((e) => time >= e.start && time < e.finish);
    if (!active.length) return '계획 대기';
    return active.map((e) => `${e.craneId} ${e.type}${e.loadId ? ` ${e.loadId}` : ''}`).join(' · ');
  }
}
