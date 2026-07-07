// P7.15~P7.20 현장 현실 규칙의 순수 계산 모음.
// 모든 함수는 데이터가 없으면 skipped/blocked=false를 반환해 기존 시나리오를 보존한다.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function pointSegmentDistance3(point, a, b) {
  const ab = b.map((v, i) => v - a[i]);
  const ap = point.map((v, i) => v - a[i]);
  const den = ab.reduce((s, v) => s + v * v, 0);
  const t = den > 0 ? clamp(ap.reduce((s, v, i) => s + v * ab[i], 0) / den, 0, 1) : 0;
  return Math.hypot(...point.map((v, i) => v - (a[i] + ab[i] * t)));
}

export function powerLineClearance(point, lines = []) {
  if (!lines.length) return { skipped: true, safe: true, clearance: Infinity, lineId: null };
  let best = { clearance: Infinity, lineId: null, required: 0 };
  for (const line of lines) {
    const clearance = pointSegmentDistance3(point, line.a, line.b);
    if (clearance < best.clearance) {
      best = { clearance, lineId: line.id, required: line.clearance ?? 6 };
    }
  }
  return { skipped: false, ...best, safe: best.clearance >= best.required };
}

export function segmentPowerLineClearance(a, b, lines = [], samples = 24) {
  if (!lines.length) return { skipped: true, safe: true, clearance: Infinity, lineId: null };
  let best = { clearance: Infinity, lineId: null, required: 0 };
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const point = a.map((value, axis) => value + (b[axis] - value) * t);
    const result = powerLineClearance(point, lines);
    if (result.clearance < best.clearance) best = result;
  }
  return best;
}

export function heightLimitAt(point, limits = []) {
  const hit = limits.find((limit) =>
    point[0] >= limit.min[0] && point[0] <= limit.max[0] &&
    point[2] >= limit.min[1] && point[2] <= limit.max[1]);
  if (!hit) return { skipped: true, safe: true, limit: Infinity, zoneId: null };
  return { skipped: false, safe: point[1] <= hit.maxHeight, limit: hit.maxHeight, zoneId: hit.id };
}

function timelineValue(def, time, fallback = 0) {
  if (!def) return fallback;
  if (!def.timeline?.length) return def.value ?? def.speed ?? fallback;
  let value = def.timeline[0][1];
  for (const [at, next] of def.timeline) {
    if (at > time) break;
    value = next;
  }
  return value;
}

export function weatherAt(weather, time) {
  if (!weather) return { blocked: false, reasons: [], rain: 0, lightning: Infinity, visibility: Infinity };
  const rain = timelineValue(weather.rain, time);
  const lightning = timelineValue(weather.lightning, time, Infinity);
  const visibility = timelineValue(weather.visibility, time, Infinity);
  const reasons = [];
  if (rain > (weather.maxRain ?? Infinity)) reasons.push('rain');
  if (lightning < (weather.minLightningDistance ?? 10)) reasons.push('lightning');
  if (visibility < (weather.minVisibility ?? 200)) reasons.push('visibility');
  return { blocked: reasons.length > 0, reasons, rain, lightning, visibility };
}

export function shiftAt(shifts = [], time) {
  if (!shifts.length) return { available: true, shiftId: null };
  const day = 24 * 3600;
  const local = ((time % day) + day) % day;
  const shift = shifts.find((item) => local >= item.start && local < item.end);
  return { available: !!shift, shiftId: shift?.id ?? null };
}

export function resourceAvailability(resources = [], requirements = {}, active = []) {
  const missing = [];
  for (const [type, count] of Object.entries(requirements)) {
    const total = resources.filter((r) => r.type === type).reduce((s, r) => s + (r.count ?? 1), 0);
    const used = active.filter((a) => a.type === type).reduce((s, a) => s + (a.count ?? 1), 0);
    if (total - used < count) missing.push({ type, need: count, available: Math.max(0, total - used) });
  }
  return { available: missing.length === 0, missing };
}

export function evaluateLaydown(loads, yard) {
  if (!yard?.slots?.length) return { skipped: true, feasible: true, placements: [], rehandles: [] };
  const placements = [];
  const stacks = new Map(yard.slots.map((slot) => [slot.id, []]));
  const rehandles = [];
  for (const load of loads) {
    const slot = yard.slots.find((candidate) => {
      const stack = stacks.get(candidate.id);
      return stack.length < (candidate.maxLayers ?? 1) &&
        load.size[0] <= candidate.size[0] && load.size[2] <= candidate.size[1] &&
        load.mass <= (candidate.maxMass ?? Infinity);
    });
    if (!slot) return { skipped: false, feasible: false, reason: `no-slot:${load.id}`, placements, rehandles };
    const stack = stacks.get(slot.id);
    stack.push(load.id);
    placements.push({ loadId: load.id, slotId: slot.id, layer: stack.length - 1 });
  }
  const order = new Map(loads.map((load, i) => [load.id, load.erectionOrder ?? i]));
  for (const stack of stacks.values()) {
    for (let i = 0; i < stack.length; i++) {
      for (let j = i + 1; j < stack.length; j++) {
        if (order.get(stack[i]) < order.get(stack[j])) {
          rehandles.push({ loadId: stack[j], blocking: stack.slice(j + 1), count: stack.length - j - 1 });
        }
      }
    }
  }
  return { skipped: false, feasible: true, placements, rehandles };
}

export function evaluateOutriggers(spec, setup, groundZones = []) {
  const points = spec.outrigger?.points;
  if (!points?.length) return { skipped: true, feasible: true, pads: [] };
  const totalMass = (spec.masses?.base ?? 0) + (spec.masses?.counterweight ?? 0) +
    (setup.loadMass ?? 0);
  const loadMoment = (setup.loadMass ?? 0) * (setup.radius ?? 0);
  const span = Math.max(...points.map((p) => Math.abs(p[0])), 1);
  const pads = points.map((point) => {
    const x = setup.pos[0] + point[0];
    const z = setup.pos[1] + point[1];
    const side = Math.sign(point[0]) || 1;
    const reaction = Math.max(0, totalMass / points.length + side * loadMoment / (points.length * span));
    const zone = groundZones.find((g) => x >= g.min[0] && x <= g.max[0] && z >= g.min[1] && z <= g.max[1]);
    const area = spec.outrigger.padArea ?? 1;
    const pressure = reaction / area;
    const capacity = zone?.bearingCapacity ?? setup.defaultBearingCapacity ?? Infinity;
    return { point: [...point], pos: [x, z], reaction, pressure, capacity, safe: pressure <= capacity };
  });
  return { skipped: false, feasible: pads.every((p) => p.safe), pads };
}

export function evaluateAssembly(spec, fromConfig, toConfig, site = {}) {
  if (!toConfig || fromConfig === toConfig.id) return { required: false, feasible: true, duration: 0, cost: 0 };
  const area = toConfig.assemblyArea ?? [0, 0];
  const available = site.assemblyArea ?? [Infinity, Infinity];
  const feasible = area[0] <= available[0] && area[1] <= available[1] &&
    (toConfig.assistCraneRequired ? (site.assistCranes ?? 0) > 0 : true);
  return {
    required: true,
    feasible,
    duration: toConfig.duration ?? 0,
    cost: toConfig.cost ?? 0,
    trucks: toConfig.trucks ?? 0,
    reason: feasible ? null : 'assembly-logistics',
  };
}
