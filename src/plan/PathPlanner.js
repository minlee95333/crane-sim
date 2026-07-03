// 거시 계획용 2D 이동 경로 계산.
// 축 규약은 [x,z]. 제한구역은 {min:[x,z], max:[x,z]} 또는
// V2 호환 {x1,y1,x2,y2}를 허용한다.

const EPS = 1e-9;

function zoneRect(zone, clearance = 0) {
  const min = zone.min ?? [zone.x1, zone.y1];
  const max = zone.max ?? [zone.x2, zone.y2];
  return {
    id: zone.id,
    minX: Math.min(min[0], max[0]) - clearance,
    minZ: Math.min(min[1], max[1]) - clearance,
    maxX: Math.max(min[0], max[0]) + clearance,
    maxZ: Math.max(min[1], max[1]) + clearance,
  };
}

export function pointInZone(point, zone, clearance = 0) {
  const r = zoneRect(zone, clearance);
  return point[0] >= r.minX && point[0] <= r.maxX && point[1] >= r.minZ && point[1] <= r.maxZ;
}

function orient(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a, b, p) {
  return (
    Math.abs(orient(a, b, p)) <= EPS &&
    p[0] >= Math.min(a[0], b[0]) - EPS &&
    p[0] <= Math.max(a[0], b[0]) + EPS &&
    p[1] >= Math.min(a[1], b[1]) - EPS &&
    p[1] <= Math.max(a[1], b[1]) + EPS
  );
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS)) &&
      ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))) return true;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

export function segmentBlocked(a, b, zones = [], clearance = 0) {
  for (const zone of zones) {
    const r = zoneRect(zone, clearance);
    if (pointInZone(a, zone, clearance) || pointInZone(b, zone, clearance)) return true;
    const corners = [
      [r.minX, r.minZ], [r.maxX, r.minZ], [r.maxX, r.maxZ], [r.minX, r.maxZ],
    ];
    for (let i = 0; i < 4; i++) {
      if (segmentsIntersect(a, b, corners[i], corners[(i + 1) % 4])) return true;
    }
  }
  return false;
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * 제한구역 모서리를 노드로 삼는 가시성 그래프 최단경로.
 * @returns {{ok:boolean,path:Array<[number,number]>,distance:number,directDistance:number,detourDistance:number}}
 */
export function shortestPath(start, goal, zones = [], opts = {}) {
  const clearance = opts.clearance ?? 1;
  const directDistance = distance(start, goal);
  if (zones.some((z) => pointInZone(start, z, clearance) || pointInZone(goal, z, clearance))) {
    return { ok: false, path: [], distance: Infinity, directDistance, detourDistance: Infinity };
  }
  if (!segmentBlocked(start, goal, zones, clearance)) {
    return { ok: true, path: [start, goal], distance: directDistance, directDistance, detourDistance: 0 };
  }

  const nodes = [start, goal];
  for (const zone of zones) {
    const r = zoneRect(zone, clearance);
    nodes.push(
      [r.minX, r.minZ], [r.maxX, r.minZ],
      [r.maxX, r.maxZ], [r.minX, r.maxZ],
    );
  }

  const edges = Array.from({ length: nodes.length }, () => []);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (segmentBlocked(nodes[i], nodes[j], zones, 0)) continue;
      const d = distance(nodes[i], nodes[j]);
      edges[i].push([j, d]);
      edges[j].push([i, d]);
    }
  }

  const dist = new Array(nodes.length).fill(Infinity);
  const prev = new Array(nodes.length).fill(-1);
  const used = new Array(nodes.length).fill(false);
  dist[0] = 0;
  for (let n = 0; n < nodes.length; n++) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (!used[i] && (u < 0 || dist[i] < dist[u])) u = i;
    }
    if (u < 0 || !Number.isFinite(dist[u])) break;
    if (u === 1) break;
    used[u] = true;
    for (const [v, w] of edges[u]) {
      if (dist[u] + w < dist[v]) {
        dist[v] = dist[u] + w;
        prev[v] = u;
      }
    }
  }
  if (!Number.isFinite(dist[1])) {
    return { ok: false, path: [], distance: Infinity, directDistance, detourDistance: Infinity };
  }
  const indices = [];
  for (let cur = 1; cur >= 0; cur = prev[cur]) {
    indices.push(cur);
    if (cur === 0) break;
  }
  indices.reverse();
  const path = indices.map((i) => nodes[i]);
  return {
    ok: true,
    path,
    distance: dist[1],
    directDistance,
    detourDistance: Math.max(0, dist[1] - directDistance),
  };
}
