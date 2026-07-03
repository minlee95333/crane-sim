// 계획 계층: V2 연동 오라클 (SIM_DESIGN 4절, P7).
//
// crane-rl-dash-auto-reward V2(Python 거시 스케줄러)가 규칙 기반 duration/타당성
// 추정 대신 이 시뮬레이터를 ground-truth로 쓸 수 있게 하는 두 창구:
//
//  evaluateLift(scenario, craneId, loadId, {mode})
//    → { feasible, blocked, reason, cycleTime, method }
//    mode 'estimate': 분석 근사 (빠름 — 계획 탐색 내부 루프용)
//    mode 'simulate': 물리 완주 (정밀 — 근사 캘리브레이션·최종 검증용)
//
//  exportPlanSpec(scenario)
//    → V2 호환 JSON (좌표 매핑: crane-sim의 지면 x/z → V2의 x/y)
//    V2 쪽은 crane_core/env.py의 reset_layout(cranes, lifts, restricted_zones)에 대응.

import { Simulation } from '../sim/Simulation.js';
import { checkLiftFeasible, estimateCycleTime, runLift } from './AutoPilot.js';

/**
 * 양중 1건 평가 — V2 candidate_outcome의 duration 추정을 대체하는 값.
 * 항상 새 Simulation으로 평가(호출 간 독립·결정론).
 */
export function evaluateLift(scenario, craneId, loadId, opts = {}) {
  const mode = opts.mode ?? 'estimate';
  const sim = new Simulation(scenario);
  const fz = checkLiftFeasible(sim, craneId, loadId);
  if (!fz.feasible) {
    return {
      feasible: false,
      blocked: !!fz.blocked,
      reason: fz.reason,
      cycleTime: null,
      method: mode,
    };
  }
  if (mode === 'simulate') {
    const r = runLift(sim, craneId, loadId);
    return {
      feasible: r.ok,
      blocked: false,
      reason: r.reason,
      cycleTime: r.ok ? r.cycleTime : null,
      collisions: r.collisions,
      violations: r.violations,
      placeError: r.placeError,
      method: 'simulate',
    };
  }
  return {
    feasible: true,
    blocked: false,
    reason: null,
    cycleTime: estimateCycleTime(sim, craneId, loadId),
    method: 'estimate',
  };
}

/**
 * 시나리오를 V2 호환 계획 스펙(JSON)으로 변환.
 * 좌표: crane-sim (x, z 지면) → V2 (x, y 지면).
 */
export function exportPlanSpec(scenario) {
  const cranes = scenario.cranes.map((c, i) => ({
    id: c.id ?? `crane-${i}`,
    type: c.type,
    x: c.basePos?.[0] ?? 0,
    y: c.basePos?.[2] ?? 0,
    boomLen: c.type === 'tower' ? c.geometry.jibLength : c.geometry.boomLength,
    // V2 capacity_curve 형식: [radius, cap] 쌍
    capacityCurve: (c.loadChart ?? []).map(([r, cap]) => [r, cap]),
    // 2D 표가 있으면 함께 (V2 capacity_chart 형식: [boomLen, [[r, cap]...]])
    capacityChart: c.capacityChart ?? null,
    rating: c.rating ?? null,
  }));

  const lifts = (scenario.loads ?? [])
    .filter((l) => l.target)
    .map((l) => ({
      id: l.id,
      x: l.pos[0],
      y: l.pos[2],
      weight: l.mass,
      targetX: l.target[0],
      targetY: l.target[1],
      dependsOn: l.dependsOn ?? [],
      arriveTime: l.arriveTime ?? 0,
      rigTime: l.rigTime ?? scenario.rigging?.rigTime ?? 0,
      derigTime: l.derigTime ?? scenario.rigging?.derigTime ?? 0,
    }));

  // 금지구역 → V2 restricted_zones (x1,y1,x2,y2)
  const restrictedZones = (scenario.noFlyZones ?? []).map((z) => ({
    id: z.id,
    x1: z.min[0],
    y1: z.min[1],
    x2: z.max[0],
    y2: z.max[1],
  }));

  return {
    version: 1,
    source: 'crane-sim',
    coordinateNote: 'crane-sim (x,z) ground plane → (x,y)',
    cranes,
    lifts,
    restrictedZones,
    ground: scenario.ground ?? null,
    wind: scenario.wind ?? null,
  };
}
