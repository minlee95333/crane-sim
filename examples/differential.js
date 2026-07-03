// 차등 시연 (differential demo): "규칙 추정 vs 물리 실행"이 계획 순위를 바꾸는가.
// 실행: node examples/differential.js
//
// S9 (트럭 반입 → 야적장 하역 → 철골 건립) 시나리오:
//   트럭 3대가 부재 11개를 반입 → 크레인 2대가 야적장에 하역 →
//   공정 배리어(전 부재 야적 완료) → 2×2 입체 철골 프레임 건립 (기둥 위 EL+6m 거더 등).
//   하역 공정은 모든 계획이 동일 — 건립 공정의 셋업·배정만 다르다.
//
// 비교 대상:
//   (a) 규칙 추정  — V2 스타일: 정격표·속도한계·선행순서·여정만 아는 폐형식 시간 모델.
//                    간섭·전도안정성·동하중·흔들림·우회를 모른다.
//   (b) 물리 실행  — PlanRunner: 3D 간섭 양보·퇴피, 재배치 주행, 전도/지반, 리깅,
//                    고소 안착, 기시공 충돌체.

import { Simulation } from '../src/sim/Simulation.js';
import { runPlan } from '../src/plan/PlanRunner.js';
import { LoadChart } from '../src/core/LoadChart.js';
import { SCENARIOS } from '../data/scenarios.js';

const scn = SCENARIOS.find((s) => s.id === 'yard-erection').scenario;
const TOTAL = scn.loads.length; // 부재 수 (최종 안착 기준)
const won = (n) => '₩' + Math.round(n).toLocaleString();
const wrap = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

// ──────────────────────────────────────────────────────────────
// (a) 규칙 추정기 — V2 candidate_outcome 스타일 (여정·고도 인지, 물리 무지).
//     아는 것: 정격표(원시 질량), 도달범위, 속도한계 폐형식, 재배치 직선거리,
//              선행·반입 시각, 여정 단계, 목표 고도.
//     모르는 것: 간섭 대기, 전도 안정성, 동하중·후크공제, 흔들림 안정, 경로 우회.
// ──────────────────────────────────────────────────────────────
function ruleEstimate(scenario, plan) {
  const rig = scenario.rigging ?? {};
  const defs = new Map(scenario.loads.map((l) => [l.id, l]));
  // 부재 상태: 현재 위치·바닥고·여정 단계·단계별 완료 시각
  const lstate = new Map(scenario.loads.map((l) => [l.id, {
    pos: [l.pos[0], l.pos[2]],
    elev: l.elev ?? 0,
    stage: 0,
    availAt: l.arriveTime ?? 0, // 이 단계 픽업이 가능해지는 시각
    finalDone: null,
  }]));
  const route = (l) => l.route ?? (l.target ? [{ target: l.target, elev: 0 }] : []);

  const cranes = scenario.cranes.map((spec) => {
    const g = spec.geometry;
    const boomAngle0 = spec.initial?.boomAngle ?? Math.PI / 3;
    return {
      spec,
      chart: new LoadChart(spec.loadChart),
      t: 0,
      jobs: 0,
      pos: [spec.basePos[0], spec.basePos[2]],
      th: spec.initial?.slewAngle ?? 0,
      r: (g.pivotOffset ?? 0) + g.boomLength * Math.cos(boomAngle0),
      hookY: g.pivotHeight + g.boomLength * Math.sin(boomAngle0) - (spec.initial?.ropeLength ?? 10),
    };
  });
  const queues = plan.reduce((qs, a) => (qs[a.craneId].push(a), qs), cranes.map(() => []));
  const heads = cranes.map(() => 0);
  const failed = new Set();
  let placedCount = 0;
  let yardDone = 0; // 전 부재 1단계(야적) 완료 시각

  const allStaged = (s) =>
    scenario.loads.every((l) => route(l).length <= s || lstate.get(l.id).stage >= s);

  for (;;) {
    let pick = -1;
    for (let ci = 0; ci < cranes.length; ci++) {
      if (heads[ci] >= queues[ci].length) continue;
      const a = queues[ci][heads[ci]];
      if (a.awaitStage != null) {
        if (!allStaged(a.awaitStage)) continue; // 배리어 미충족 — 대기
        cranes[ci].t = Math.max(cranes[ci].t, yardDone);
        heads[ci] += 1;
        ci -= 1;
        continue;
      }
      if (a.moveTo) {
        const c = cranes[ci];
        const p = c.spec.planning ?? {};
        c.t += Math.hypot(a.moveTo[0] - c.pos[0], a.moveTo[1] - c.pos[1]) / (p.travelSpeed ?? 1.5);
        c.pos = [...a.moveTo];
        heads[ci] += 1;
        ci -= 1;
        continue;
      }
      const st = lstate.get(a.loadId);
      const l = defs.get(a.loadId);
      const legs = route(l);
      if (st.stage >= legs.length) { heads[ci] += 1; ci -= 1; continue; } // 여정 종료
      const finalLeg = st.stage === legs.length - 1;
      if (failed.has(a.loadId)) { heads[ci] += 1; ci -= 1; continue; }
      if (finalLeg) {
        const deps = l.dependsOn ?? [];
        if (deps.some((d) => failed.has(d))) { // 선행 실패 연쇄
          failed.add(a.loadId);
          heads[ci] += 1;
          ci -= 1;
          continue;
        }
        if (deps.some((d) => lstate.get(d)?.finalDone == null)) continue; // 선행 대기
      }
      if (pick < 0 || cranes[ci].t < cranes[pick].t) pick = ci;
    }
    if (pick < 0) break;
    const c = cranes[pick];
    const a = queues[pick][heads[pick]];
    heads[pick] += 1;
    const l = defs.get(a.loadId);
    const st = lstate.get(a.loadId);
    const legs = route(l);
    const leg = legs[st.stage];
    const finalLeg = st.stage === legs.length - 1;
    const g = c.spec.geometry;
    const L = c.spec.limits;

    // 재배치 (규칙: 직선거리, 우회 모름)
    if (a.setupPos && Math.hypot(a.setupPos[0] - c.pos[0], a.setupPos[1] - c.pos[1]) > 0.5) {
      const p = c.spec.planning ?? {};
      const d = Math.hypot(a.setupPos[0] - c.pos[0], a.setupPos[1] - c.pos[1]);
      c.t += (c.jobs > 0 ? (p.teardownTime ?? 300) : 0) + d / (p.travelSpeed ?? 1.5) +
        (p.setupTime ?? 600);
      c.pos = [...a.setupPos];
      c.r = (g.pivotOffset ?? 0) + g.boomLength * Math.cos(L.boomAngleMax);
      c.hookY = g.pivotHeight + g.boomLength * Math.sin(L.boomAngleMax) - L.ropeMin;
    }

    // 타당성 (규칙: 1D 정격표 × 원시 질량 — 동하중·후크공제·전도 모름)
    const rL = Math.hypot(st.pos[0] - c.pos[0], st.pos[1] - c.pos[1]);
    const rT = Math.hypot(leg.target[0] - c.pos[0], leg.target[1] - c.pos[1]);
    const rMin = (g.pivotOffset ?? 0) + g.boomLength * Math.cos(L.boomAngleMax);
    const rMax = (g.pivotOffset ?? 0) + g.boomLength * Math.cos(L.boomAngleMin);
    if (rL < rMin || rL > rMax || rT < rMin || rT > rMax ||
      c.chart.capacityAt(rL) < l.mass || c.chart.capacityAt(rT) < l.mass) {
      failed.add(a.loadId);
      continue;
    }

    // 사이클 폐형식 (estimateCycleTime과 동일 골격 + 목표 고도)
    const thL = Math.atan2(st.pos[1] - c.pos[1], st.pos[0] - c.pos[0]);
    const thT = Math.atan2(leg.target[1] - c.pos[1], leg.target[0] - c.pos[0]);
    const radial = g.boomLength * 0.8 * L.luffRate;
    const hoist = L.hoistSpeed;
    const topY = st.elev + l.size[1];
    const travelY = Math.max(10, (leg.elev ?? 0) + l.size[1] + 3);
    const rigT = l.rigTime ?? rig.rigTime ?? 0;
    const derigT = l.derigTime ?? rig.derigTime ?? 0;
    const cyc = 1.15 * (
      Math.abs(wrap(thL - c.th)) / L.slewRate + Math.abs(rL - c.r) / radial +
      Math.abs(c.hookY - (topY + 2.5)) / hoist +
      rigT +
      Math.max(0, travelY - (topY + 1.2)) / hoist +
      Math.abs(wrap(thT - thL)) / L.slewRate + Math.abs(rT - rL) / radial +
      Math.max(0, travelY - ((leg.elev ?? 0) + l.size[1])) / hoist + 2 / (0.3 * hoist) +
      derigT + 3.5 / hoist + 8
    );

    const depFinish = finalLeg
      ? Math.max(0, ...(l.dependsOn ?? []).map((d) => lstate.get(d)?.finalDone ?? 0))
      : 0;
    const start = Math.max(c.t, st.availAt, depFinish);
    c.t = start + cyc;
    c.jobs += 1;
    c.th = thT;
    c.r = rT;
    c.hookY = travelY;
    // 부재 상태 갱신: 다음 여정 단계로
    st.pos = [...leg.target];
    st.elev = leg.elev ?? 0;
    st.stage += 1;
    st.availAt = c.t;
    if (st.stage === 1) yardDone = Math.max(yardDone, c.t);
    if (finalLeg) {
      st.finalDone = c.t;
      placedCount += 1;
    }
  }

  return {
    makespan: Math.max(0, ...cranes.map((c) => c.t)),
    placed: placedCount,
    failed: failed.size,
  };
}

// ──────────────────────────────────────────────────────────────
// 계획 5종 — 하역 공정(전 계획 공통) + 배리어 + 건립 공정(계획별 셋업·배정)
// ──────────────────────────────────────────────────────────────
const A = (craneId, loadId, setupPos) => ({ craneId, loadId, ...(setupPos ? { setupPos } : {}) });
// 하역: 남측 트럭 → 크레인0, 북측 트럭 → 크레인1 (초기 셋업 위치에서 — 재배치 없음)
const UNLOAD = [
  A(0, 'C-11'), A(0, 'C-21'), A(0, 'GX-1'), A(0, 'GZ-1'), A(0, 'D-1'),
  A(1, 'C-12'), A(1, 'C-22'), A(1, 'GX-2'), A(1, 'GZ-2'), A(1, 'D-2'), A(1, 'M-1'),
];
const BARRIER = [{ craneId: 0, awaitStage: 1 }, { craneId: 1, awaitStage: 1 }];
// 건립 배정 (남/북 분담 — 셋업 위치만 계획별로 다름)
const erectS = (s1, s2 = s1) => [
  A(0, 'C-11', s1), A(0, 'C-21', s2), A(0, 'GX-1', s2), A(0, 'GZ-1', s2), A(0, 'D-1', s2),
];
const erectN = (s1, s2 = s1) => [
  A(1, 'C-12', s1), A(1, 'C-22', s2), A(1, 'GX-2', s2), A(1, 'GZ-2', s2), A(1, 'D-2', s2),
  A(1, 'M-1', s2),
];

const PLANS = [
  {
    id: 'E',
    name: '이동 최소화',
    desc: '하역 셋업 근처에서 그대로 건립 — 재배치 최소, 원거리 작업',
    plan: [...UNLOAD, ...BARRIER, ...erectS([-6, -12]), ...erectN([-6, 12])],
  },
  {
    id: 'A',
    name: '밀집 병렬',
    desc: '두 크레인이 중앙에 근접 셋업 — 반경 짧음, 작업권 겹침',
    plan: [...UNLOAD, ...BARRIER, ...erectS([-4, -5]), ...erectN([-4, 5])],
  },
  {
    id: 'B',
    name: '분산 병렬',
    desc: '남북으로 이격 셋업 — 반경 다소 김, 작업권 분리',
    plan: [...UNLOAD, ...BARRIER, ...erectS([-3, -10]), ...erectN([-3, 10])],
  },
  {
    id: 'D',
    name: '2단계 재배치',
    desc: '근열 시공 후 원열로 전진 셋업 (크레인당 재배치 2회)',
    plan: [
      ...UNLOAD, ...BARRIER,
      A(0, 'C-11', [-8, -7]), A(0, 'GZ-1', [-8, -7]),
      A(0, 'C-21', [0, -8]), A(0, 'GX-1', [0, -8]), A(0, 'D-1', [0, -8]),
      A(1, 'C-12', [-8, 7]),
      A(1, 'C-22', [0, 8]), A(1, 'GX-2', [0, 8]), A(1, 'GZ-2', [0, 8]),
      A(1, 'D-2', [0, 8]), A(1, 'M-1', [0, 8]),
    ],
  },
  {
    id: 'C',
    name: '단일 크레인',
    desc: '하역은 2대, 건립은 A 혼자 — B는 작업권 밖 퇴피, 간섭 없음',
    plan: [
      ...UNLOAD,
      { craneId: 1, moveTo: [-40, 34] }, // B 퇴피 (A의 선회권 밖)
      { craneId: 0, awaitStage: 1 },
      A(0, 'C-11', [-3, 0]), A(0, 'C-12', [-3, 0]), A(0, 'C-21', [-3, 0]), A(0, 'C-22', [-3, 0]),
      A(0, 'GX-1', [-3, 0]), A(0, 'GX-2', [-3, 0]), A(0, 'GZ-1', [-3, 0]), A(0, 'GZ-2', [-3, 0]),
      A(0, 'D-1', [-3, 0]), A(0, 'D-2', [-3, 0]), A(0, 'M-1', [-3, 0]),
    ],
  },
];

// ──────────────────────────────────────────────────────────────
// 실행 + 리포트
// ──────────────────────────────────────────────────────────────
console.log('══════ 차등 시연: 규칙 추정 vs 물리 실행 (S9 트럭 하역 → 철골 건립) ══════\n');
console.log(`트럭 3대 반입(t=0/300/1200s) → 하역 11건 → 공정 배리어 → 건립 11건 (입체 안착) × 크롤러 2대\n`);

const rows = [];
for (const p of PLANS) {
  const est = ruleEstimate(scn, p.plan);
  const sim = new Simulation(scn);
  const phys = runPlan(sim, p.plan, { maxTotalSteps: 600000 });
  const placed = sim.world.loads.filter((l) => l.state === 'placed').length;
  const waits = phys.cranes.reduce((s, c) => s + c.waitTime, 0);
  const travel = phys.cranes.reduce((s, c) => s + c.travelDistance, 0);
  rows.push({
    id: p.id, name: p.name, desc: p.desc,
    estMakespan: est.makespan, estPlaced: est.placed, estFailed: est.failed,
    physMakespan: phys.makespan, physPlaced: placed,
    success: phys.success, waits, travel,
    clashes: phys.safety.craneClashes, collisions: phys.safety.collisions,
    cost: phys.cost.total, fuel: phys.cost.fuel,
    events: phys.events,
  });
}

// 순위: 완료 수 우선, 동률이면 makespan
const estRank = [...rows].sort((a, b) => (b.estPlaced - a.estPlaced) || (a.estMakespan - b.estMakespan));
const physRank = [...rows].sort((a, b) => (b.physPlaced - a.physPlaced) || (a.physMakespan - b.physMakespan));
rows.forEach((r) => {
  r.estRank = estRank.indexOf(r) + 1;
  r.physRank = physRank.indexOf(r) + 1;
});

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
console.log(pad('계획', 14) + num('규칙 추정', 10) + num('규칙순위', 9) +
  num('물리 실행', 10) + num('물리순위', 9) + num('건립', 7) + num('간섭대기', 9) +
  num('충돌', 5) + num('주행', 7) + num('총비용', 12));
console.log('─'.repeat(95));
for (const r of rows) {
  console.log(
    pad(`${r.id} ${r.name}`, 14) +
    num(`${(r.estMakespan / 60).toFixed(1)}분`, 10) +
    num(`#${r.estRank}${r.estFailed > 0 ? '(탈락' + r.estFailed + ')' : ''}`, 9) +
    num(r.success ? `${(r.physMakespan / 60).toFixed(1)}분` : `미완(${(r.physMakespan / 60).toFixed(0)}분)`, 10) +
    num(`#${r.physRank}`, 9) +
    num(`${r.physPlaced}/${TOTAL}`, 7) +
    num(`${(r.waits / 60).toFixed(1)}분`, 9) +
    num(r.clashes, 5) +
    num(`${r.travel.toFixed(0)}m`, 7) +
    num(won(r.cost), 12),
  );
}

console.log('\n──── 규칙과 물리가 갈린 지점 ────');
for (const r of rows) {
  const notes = [];
  if (r.estFailed === 0 && !r.success) {
    const reasons = [...new Set(r.events.filter((e) => e.type === 'liftFailed').map((e) => e.reason))];
    notes.push(`규칙은 전건 가능 판정 → 물리는 ${TOTAL - r.physPlaced}건 미건립${reasons.length ? ` (${reasons.join(' / ')})` : ''}`);
    const dead = [...new Set(r.events.filter((e) => e.type === 'deadlock').map((e) => e.loadId))];
    if (dead.length) notes.push(`선행 미완 연쇄 데드락: ${dead.join(', ')}`);
  }
  if (r.waits > 60) notes.push(`간섭 대기 ${(r.waits / 60).toFixed(1)}분 — 규칙 추정엔 0분`);
  if (r.collisions > 0) notes.push(`기시공·장애물 충돌 ${r.collisions}회`);
  if (r.estRank !== r.physRank) notes.push(`순위 역전: 규칙 #${r.estRank} → 물리 #${r.physRank}`);
  if (notes.length) console.log(`  [${r.id} ${r.name}] ${notes.join(' | ')}`);
}

const estBest = estRank[0];
const physBest = physRank[0];
console.log('\n──── 결론 ────');
console.log(`  규칙 추정의 최선: ${estBest.id} ${estBest.name} (${(estBest.estMakespan / 60).toFixed(1)}분)`);
console.log(`  물리 실행의 최선: ${physBest.id} ${physBest.name} (${(physBest.physMakespan / 60).toFixed(1)}분, ${physBest.physPlaced}/${TOTAL} 건립)`);
if (estBest !== physBest) {
  console.log(`  → 규칙 기반 스케줄러(V2 방식)는 ${estBest.id}를 선택하지만, 물리 검증은 ${physBest.id}가 정답임을 보인다.`);
  console.log(`    이 격차가 crane-sim을 V2의 ground-truth 오라클로 쓰는 이유다.`);
} else {
  console.log(`  → 이 시나리오에서는 규칙과 물리의 최선이 일치했다 (순위 세부는 위 표 참고).`);
}
