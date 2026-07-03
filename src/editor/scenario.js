// 시나리오 에디터 ↔ 시뮬레이터 브리지.
// 에디터는 "간결한 descriptor"를 다루고, buildScenario가 이를 sim-ready 시나리오로 해석한다.
// descriptor는 직렬화(JSON)·역직렬화가 되므로 저장/불러오기의 정본 포맷이다.

import { CRAWLER_100T, TOWER_8T } from '../../data/cranes.js';
import { radiusRangeOf } from '../plan/SetupPlanner.js';

export const CRANE_BASES = { crawler: CRAWLER_100T, tower: TOWER_8T };

/** descriptor.crane → 크레인 스펙 (base 스프레드 + 위치·붐 오버라이드) */
export function craneSpecOf(c) {
  const base = CRANE_BASES[c.base] ?? CRAWLER_100T;
  const spec = { ...base, id: c.id, name: c.name ?? base.name, basePos: [c.pos[0], 0, c.pos[1]] };
  if (c.base === 'crawler' && c.boomLength) {
    spec.geometry = { ...base.geometry, boomLength: c.boomLength };
  }
  if (c.sway) spec.physics = { sway: true };
  return spec;
}

/** 크레인 도달 반경 [min, max] (에디터 링 표시용) */
export function craneReach(c) {
  const base = CRANE_BASES[c.base] ?? CRAWLER_100T;
  const boomLength = c.base === 'crawler' ? c.boomLength ?? base.geometry.boomLength : base.geometry.jibLength;
  return radiusRangeOf(base, boomLength);
}

/** descriptor → sim-ready 시나리오 */
export function buildScenario(desc) {
  const scenario = {
    cranes: desc.cranes.map(craneSpecOf),
    loads: desc.loads.map((l) => ({
      id: l.id,
      name: l.name ?? l.id,
      size: l.size ?? [3, 1.5, 3],
      mass: l.mass,
      pos: [l.pos[0], 0, l.pos[1]],
      target: [l.target[0], l.target[1]],
      rigTime: l.rigTime || undefined,
      derigTime: l.derigTime || undefined,
      arriveTime: l.arriveTime || undefined,
      dependsOn: l.dependsOn?.length ? l.dependsOn : undefined,
      maxWind: l.maxWind || undefined,
    })),
    obstacles: desc.obstacles.map((o) => ({ id: o.id, pos: [o.pos[0], 0, o.pos[1]], size: o.size })),
    noFlyZones: desc.noFlyZones.map((z) => ({ id: z.id, min: [...z.min], max: [...z.max] })),
  };
  if (desc.rigging && (desc.rigging.rigTime || desc.rigging.derigTime || desc.rigging.trialLiftTime)) {
    scenario.rigging = { ...desc.rigging };
  }
  if (desc.ground?.bearingCapacity) scenario.ground = { bearingCapacity: desc.ground.bearingCapacity };
  if (desc.wind?.maxOperating || desc.wind?.speed) scenario.wind = { ...desc.wind };
  return scenario;
}

/** 빈 descriptor */
export function emptyDescriptor() {
  return {
    name: '새 시나리오',
    cranes: [],
    loads: [],
    obstacles: [],
    noFlyZones: [],
    rigging: { rigTime: 0, derigTime: 0, trialLiftTime: 0 },
    ground: { bearingCapacity: 0 },
    wind: { speed: 0, maxOperating: 0 },
  };
}

/** descriptor → 프로젝트에 붙여넣을 JS 스니펫 */
export function toJS(desc) {
  const json = JSON.stringify(desc, null, 2);
  return (
    "import { buildScenario } from './src/editor/scenario.js';\n\n" +
    `// ${desc.name}\n` +
    `export const scenario = buildScenario(${json});\n`
  );
}
