// 시나리오 에디터 ↔ 시뮬레이터 브리지.
// 에디터는 "간결한 descriptor"를 다루고, buildScenario가 이를 sim-ready 시나리오로 해석한다.
// descriptor는 직렬화(JSON)·역직렬화가 되므로 저장/불러오기의 정본 포맷이다.

import { CRAWLER_100T, TOWER_8T } from '../../data/cranes.js';
import { radiusRangeOf } from '../plan/SetupPlanner.js';

export const CRANE_BASES = { crawler: CRAWLER_100T, tower: TOWER_8T };

/** descriptor.crane → 크레인 스펙 (base 스프레드 + 위치·붐 오버라이드) */
export function craneSpecOf(c) {
  const base = c.spec ? structuredClone(c.spec) : (CRANE_BASES[c.base] ?? CRAWLER_100T);
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
      ...structuredClone(l),
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
      targetYaw: l.targetYaw ?? undefined,
      tandem: l.tandem || undefined,
      liftPoints: l.liftPoints,
      slingHeight: l.slingHeight,
      blockUnsafeSling: l.blockUnsafeSling,
      resourceRequirements: l.resourceRequirements,
      erectionOrder: l.erectionOrder,
    })),
    obstacles: desc.obstacles.map((o) => ({
      ...structuredClone(o), id: o.id, pos: [o.pos[0], 0, o.pos[1]], size: o.size,
    })),
    noFlyZones: desc.noFlyZones.map((z) => ({ id: z.id, min: [...z.min], max: [...z.max] })),
  };
  if (desc.rigging && (desc.rigging.rigTime || desc.rigging.derigTime || desc.rigging.trialLiftTime)) {
    scenario.rigging = { ...desc.rigging };
  }
  if (desc.ground?.bearingCapacity) scenario.ground = { bearingCapacity: desc.ground.bearingCapacity };
  if (desc.wind?.maxOperating || desc.wind?.speed) scenario.wind = { ...desc.wind };
  for (const key of [
    'site', 'powerLines', 'heightLimits', 'weather', 'shifts', 'resources',
    'laydown', 'groundZones', 'logistics', 'planning', 'scoring', 'agents', 'trucks',
  ]) {
    if (desc[key] != null) scenario[key] = structuredClone(desc[key]);
  }
  return scenario;
}

/** sim-ready 시나리오 → 편집 가능한 descriptor */
export function descriptorFromScenario(scenario, name = '사용자 시나리오') {
  const descriptor = {
    name,
    cranes: (scenario.cranes ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      base: c.type === 'tower' ? 'tower' : 'crawler',
      spec: structuredClone(c),
      pos: [c.basePos[0], c.basePos[2]],
      ...(c.type !== 'tower' && c.geometry?.boomLength
        ? { boomLength: c.geometry.boomLength }
        : {}),
      ...(c.physics?.sway ? { sway: true } : {}),
    })),
    loads: (scenario.loads ?? []).map((l) => ({
      ...structuredClone(l),
      pos: [l.pos[0], l.pos[2]],
      target: l.target ? [...l.target] : [l.pos[0], l.pos[2]],
    })),
    obstacles: (scenario.obstacles ?? []).map((o) => ({
      ...structuredClone(o),
      pos: [o.pos[0], o.pos[2]],
    })),
    noFlyZones: structuredClone(scenario.noFlyZones ?? []),
  };
  for (const key of [
    'rigging', 'ground', 'wind', 'site', 'powerLines', 'heightLimits', 'weather',
    'shifts', 'resources', 'laydown', 'groundZones', 'logistics', 'planning',
    'scoring', 'agents', 'trucks',
  ]) {
    if (scenario[key] != null) descriptor[key] = structuredClone(scenario[key]);
  }
  return descriptor;
}

export function validateDescriptor(desc) {
  const errors = [];
  if (!desc || typeof desc !== 'object') return { valid: false, errors: ['JSON 객체가 필요합니다.'] };
  for (const key of ['cranes', 'loads', 'obstacles', 'noFlyZones']) {
    if (!Array.isArray(desc[key])) errors.push(`${key} 배열이 필요합니다.`);
  }
  const ids = new Set();
  for (const item of [...(desc.cranes ?? []), ...(desc.loads ?? [])]) {
    if (!item.id) errors.push('크레인·부재 id가 필요합니다.');
    else if (ids.has(item.id)) errors.push(`중복 id: ${item.id}`);
    else ids.add(item.id);
  }
  for (const load of desc.loads ?? []) {
    if (!Array.isArray(load.pos) || load.pos.length !== 2) errors.push(`${load.id}: pos는 [x,z]`);
    if (!Array.isArray(load.target) || load.target.length !== 2) errors.push(`${load.id}: target은 [x,z]`);
    if (!(load.mass > 0)) errors.push(`${load.id}: mass는 양수`);
    for (const dep of load.dependsOn ?? []) {
      if (!(desc.loads ?? []).some((candidate) => candidate.id === dep)) errors.push(`${load.id}: 없는 선행 ${dep}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function parseDescriptor(text) {
  let descriptor;
  try {
    descriptor = JSON.parse(text);
  } catch (error) {
    return { valid: false, errors: [`JSON 구문 오류: ${error.message}`], descriptor: null };
  }
  return { ...validateDescriptor(descriptor), descriptor };
}

function nextId(items, prefix) {
  const used = new Set(items.map((item) => item.id));
  let index = 1;
  while (used.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

/** 편집기 기본 객체 추가. 수치는 descriptor에 노출되어 이후 자유 조정한다. */
export function addDescriptorObject(desc, kind) {
  if (kind === 'crane') {
    const item = { id: nextId(desc.cranes, 'crane'), base: 'crawler', pos: [0, 0], boomLength: 40 };
    desc.cranes.push(item);
    return item;
  }
  if (kind === 'load') {
    const item = {
      id: nextId(desc.loads, 'load'), name: '새 양중물', size: [3, 1.5, 3],
      mass: 5, pos: [5, 0], target: [15, 0],
    };
    desc.loads.push(item);
    return item;
  }
  if (kind === 'obstacle') {
    const item = { id: nextId(desc.obstacles, 'obstacle'), pos: [0, 0], size: [6, 4, 6] };
    desc.obstacles.push(item);
    return item;
  }
  if (kind === 'noFlyZone') {
    const item = { id: nextId(desc.noFlyZones, 'zone'), min: [-5, -5], max: [5, 5] };
    desc.noFlyZones.push(item);
    return item;
  }
  throw new Error(`지원하지 않는 객체 종류: ${kind}`);
}

export function removeDescriptorObject(desc, kind, id) {
  const collection = kind === 'noFlyZone' ? desc.noFlyZones : desc[`${kind}s`];
  const index = collection.findIndex((item) => item.id === id);
  if (index >= 0) collection.splice(index, 1);
  if (kind === 'load') {
    for (const load of desc.loads) {
      if (load.dependsOn) load.dependsOn = load.dependsOn.filter((dependency) => dependency !== id);
    }
  }
  return index >= 0;
}

export function updateDescriptorObject(desc, kind, id, values) {
  const collection = kind === 'noFlyZone' ? desc.noFlyZones : desc[`${kind}s`];
  const item = collection.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`객체 없음: ${kind}:${id}`);
  const x = Number(values.x);
  const z = Number(values.z);
  const w = Math.max(0.1, Number(values.width));
  const h = Math.max(0.1, Number(values.height));
  const d = Math.max(0.1, Number(values.depth));
  if (kind === 'noFlyZone') {
    item.min = [x - w / 2, z - d / 2];
    item.max = [x + w / 2, z + d / 2];
  } else {
    item.pos = [x, z];
    if (kind === 'load' || kind === 'obstacle') item.size = [w, h, d];
    if (kind === 'load') item.mass = Math.max(0.1, Number(values.mass));
  }
  return item;
}

export function updateDescriptorEnvironment(desc, values) {
  const numeric = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const width = Math.max(10, Number(values.width));
  const depth = Math.max(10, Number(values.depth));
  desc.site = { ...(desc.site ?? {}), width, depth, minX: -width / 2, minZ: -depth / 2 };
  desc.wind = {
    ...(desc.wind ?? {}),
    speed: Math.max(0, Number(values.windSpeed)),
    dir: (numeric(values.windDirection, 0) * Math.PI) / 180,
    maxOperating: Math.max(0.1, numeric(values.maxOperatingWind, 15)),
    gust: {
      amp: Math.max(0, numeric(values.gustPercent, 0)) / 100,
      period: Math.max(1, numeric(values.gustPeriod, 20)),
    },
  };
  desc.ground = {
    ...(desc.ground ?? {}), bearingCapacity: Math.max(0.1, Number(values.bearingCapacity)),
  };
  const minX = -width / 2 + 3;
  const maxX = width / 2 - 3;
  const minZ = -depth / 2 + 3;
  const maxZ = depth / 2 - 3;
  const workerCount = Math.max(0, Math.floor(numeric(values.workerCount, 0)));
  const vehicleCount = Math.max(0, Math.floor(numeric(values.vehicleCount, 0)));
  desc.agents = {
    seed: desc.agents?.seed ?? 20260706,
    dangerRadius: Math.max(0.5, numeric(values.dangerRadius, 5)),
    workers: workerCount ? [{
      count: workerCount,
      area: { min: [minX, minZ], max: [maxX, maxZ] },
      speed: [Math.max(0.1, numeric(values.workerSpeed, 1.1) * 0.8), Math.max(0.1, numeric(values.workerSpeed, 1.1) * 1.2)],
      idle: [2, 6],
    }] : [],
    vehicles: vehicleCount ? [{
      count: vehicleCount,
      route: [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]],
      speed: Math.max(0.1, numeric(values.vehicleSpeed, 2.2)),
    }] : [],
  };
  return desc;
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
    site: { width: 100, depth: 80, minX: -50, minZ: -40 },
    powerLines: [],
    heightLimits: [],
    weather: null,
    shifts: [],
    resources: [],
    laydown: { slots: [] },
    groundZones: [],
    logistics: { assemblyArea: [30, 20], assistCranes: 0 },
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
