import { evaluateSetup } from '../plan/SetupPlanner.js';
import { buildScenario } from './scenario.js';

const inside = (p, site) => {
  if (!site) return true;
  const minX = site.minX ?? -(site.width ?? 100) / 2;
  const minZ = site.minZ ?? -(site.depth ?? 100) / 2;
  return p[0] >= minX && p[0] <= minX + (site.width ?? 100) &&
    p[1] >= minZ && p[1] <= minZ + (site.depth ?? 100);
};

const overlap = (a, b) =>
  Math.abs(a.pos[0] - b.pos[0]) < (a.size[0] + b.size[0]) / 2 &&
  Math.abs(a.pos[1] - b.pos[1]) < (a.size[2] + b.size[2]) / 2;

const inZone = (p, zone) =>
  p[0] >= zone.min[0] && p[0] <= zone.max[0] &&
  p[1] >= zone.min[1] && p[1] <= zone.max[1];

function issue(kind, id, code, message, severity = 'error') {
  return { kind, id, code, message, severity };
}

/**
 * 편집 중 빠른 타당성 검사.
 * 전체 시간축 대신 현재 셋업의 닫힌식 판정과 정적 배치 오류만 검사한다.
 */
export function validateScenarioQuick(descriptor) {
  const issues = [];
  const scenario = buildScenario(descriptor);
  const site = descriptor.site;

  for (const crane of descriptor.cranes) {
    if (!inside(crane.pos, site)) {
      issues.push(issue('crane', crane.id, 'site-boundary', '크레인이 현장 경계 밖에 있습니다.'));
    }
  }

  for (const load of descriptor.loads) {
    if (!inside(load.pos, site)) {
      issues.push(issue('load', load.id, 'site-boundary', '양중물이 현장 경계 밖에 있습니다.'));
    }
    if (!inside(load.target, site)) {
      issues.push(issue('target', load.id, 'site-boundary', '목표 위치가 현장 경계 밖에 있습니다.'));
    }
    const pickupZone = descriptor.noFlyZones.find((zone) => inZone(load.pos, zone));
    const targetZone = descriptor.noFlyZones.find((zone) => inZone(load.target, zone));
    if (pickupZone) {
      issues.push(issue('load', load.id, 'no-fly-zone', `픽업 위치가 제한구역 ${pickupZone.id} 내부입니다.`));
    }
    if (targetZone) {
      issues.push(issue('target', load.id, 'no-fly-zone', `목표 위치가 제한구역 ${targetZone.id} 내부입니다.`));
    }

    const rawLoad = scenario.loads.find((item) => item.id === load.id);
    const simLoad = {
      ...rawLoad,
      targetHeight: rawLoad.targetHeight ?? rawLoad.targetElev,
    };
    const evaluations = scenario.cranes.map((spec) =>
      evaluateSetup(
        spec,
        { pos: [spec.basePos[0], spec.basePos[2]], boomLength: spec.geometry.boomLength },
        [simLoad],
        scenario,
      ),
    );
    if (scenario.cranes.length === 0) {
      issues.push(issue('load', load.id, 'no-crane', '배치된 크레인이 없습니다.'));
    } else if (!evaluations.some((result) => result.feasible)) {
      const reasons = [...new Set(evaluations.flatMap((result) =>
        result.lifts.map((lift) => lift.reason).filter(Boolean),
      ))];
      issues.push(issue(
        'load', load.id, 'lift-infeasible',
        `현재 셋업에서 인양 불가: ${reasons.slice(0, 2).join(' / ') || '타당한 크레인 없음'}`,
      ));
      issues.push(issue('target', load.id, 'lift-infeasible', '현재 셋업에서 목표까지 도달할 수 없습니다.'));
    }
  }

  for (const obstacle of descriptor.obstacles) {
    if (!inside(obstacle.pos, site)) {
      issues.push(issue('obstacle', obstacle.id, 'site-boundary', '장애물이 현장 경계 밖에 있습니다.'));
    }
  }
  for (let i = 0; i < descriptor.obstacles.length; i++) {
    for (let j = i + 1; j < descriptor.obstacles.length; j++) {
      const a = descriptor.obstacles[i];
      const b = descriptor.obstacles[j];
      if (!overlap(a, b)) continue;
      issues.push(issue('obstacle', a.id, 'overlap', `장애물 ${b.id}와 겹칩니다.`));
      issues.push(issue('obstacle', b.id, 'overlap', `장애물 ${a.id}와 겹칩니다.`));
    }
  }
  for (const crane of descriptor.cranes) {
    for (const obstacle of descriptor.obstacles) {
      const radius = crane.spec?.geometry?.bodyRadius ?? 3.5;
      if (Math.abs(crane.pos[0] - obstacle.pos[0]) < radius + obstacle.size[0] / 2 &&
          Math.abs(crane.pos[1] - obstacle.pos[1]) < radius + obstacle.size[2] / 2) {
        issues.push(issue('crane', crane.id, 'obstacle-overlap', `장애물 ${obstacle.id}와 본체가 겹칩니다.`));
      }
    }
  }
  return issues;
}
