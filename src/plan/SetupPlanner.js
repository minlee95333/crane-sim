// 계획 계층: SetupPlanner — 셋업 위치·붐길이 평가/추천 (SIM_DESIGN P5).
//
// "이 크레인이 어디에 서고(setup), 어떤 붐 구성으로 조립되는가"는
// 양중 계획의 핵심 결정 변수다. 이 모듈은 시뮬 없이 준정적으로:
//   evaluateSetup : 후보 (위치, 붐길이)가 주어진 양중 목록을 전부 처리 가능한지
//                   (도달·2D 정격·동하중 여유·전도·지반) + 여유 마진 산출
//   suggestSetups : 후보를 링 샘플링으로 생성해 타당한 셋업을 랭킹
//
// V2 env.py의 setup_target(링 탐색)과 같은 역할을 물리 근거로 수행한다.

import { LoadChart } from '../core/LoadChart.js';
import { LoadChart2D } from '../core/LoadChart2D.js';
import { checkStability } from '../core/Stability.js';
import { evaluateAssembly, evaluateOutriggers, heightLimitAt, powerLineClearance } from '../core/SiteRules.js';

/** [x,z] 정규화 ([x,y,z]도 허용) */
const xz = (p) => (p.length === 3 ? [p[0], p[2]] : [p[0], p[1]]);
const dist2d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pickupHeight = (lift) => (lift.pos.length === 3 ? lift.pos[1] : 0);
const targetHeight = (lift) =>
  lift.target.length === 3 ? lift.target[1] : (lift.targetHeight ?? lift.z ?? 0);

/** 스펙+붐길이의 도달 반경 [min, max] */
export function radiusRangeOf(spec, boomLength) {
  if (spec.type === 'tower') return [spec.geometry.trolleyMin ?? 2.5, spec.geometry.jibLength];
  const off = spec.geometry.pivotOffset ?? 0;
  const L = spec.limits;
  return [off + boomLength * Math.cos(L.boomAngleMax), off + boomLength * Math.cos(L.boomAngleMin)];
}

function capacityFnOf(spec, boomLength) {
  if (spec.capacityChart) {
    const chart = new LoadChart2D(spec.capacityChart);
    return (r) => chart.capacityAt(boomLength, r);
  }
  const chart = new LoadChart(spec.loadChart);
  return (r) => chart.capacityAt(r);
}

/**
 * 셋업 후보 평가.
 * @param {Object} spec 크레인 제원
 * @param {{pos:[x,z], boomLength?:number}} setup 후보 셋업
 * @param {Array<{id?, pos, target, mass}>} lifts 처리할 양중 목록
 * @param {{ground?:{bearingCapacity:number}}} [site]
 * @returns {{feasible, boomLength, lifts:[], minCapMargin, minTipMargin, maxGroundPressure}}
 */
export function evaluateSetup(spec, setup, lifts, site = {}) {
  const boomLength = setup.boomLength ?? spec.geometry.boomLength;
  const [rMin, rMax] = radiusRangeOf(spec, boomLength);
  const capAt = capacityFnOf(spec, boomLength);
  const rating = spec.rating ?? {};
  const dyn = rating.dynamicFactor ?? 1.0;
  const deduct = rating.hookBlockMass ?? 0;
  const ground = site.ground ?? null;

  const results = [];
  let minCapMargin = Infinity;
  let minTipMargin = Infinity;
  let maxGroundPressure = 0;
  const assembly = evaluateAssembly(
    spec,
    setup.currentConfig ?? null,
    spec.configurations?.find((c) => c.id === setup.configId) ?? null,
    site.logistics ?? {},
  );
  if (!assembly.feasible) {
    return { feasible: false, boomLength, lifts: [], minCapMargin: 0, minTipMargin: 0,
      maxGroundPressure: 0, assembly, reason: assembly.reason };
  }

  for (const lift of lifts) {
    const rLoad = dist2d(setup.pos, xz(lift.pos));
    const rTarget = dist2d(setup.pos, xz(lift.target));
    const rWorst = Math.max(rLoad, rTarget);
    const pivotHeight = spec.type === 'tower' ? spec.geometry.mastHeight : spec.geometry.pivotHeight;
    const pivotOffset = spec.type === 'tower' ? 0 : (spec.geometry.pivotOffset ?? 0);
    const requiredBoomLength = spec.type === 'tower'
      ? spec.geometry.jibLength
      : Math.max(
          Math.hypot(Math.max(0, rLoad - pivotOffset), Math.max(0, pickupHeight(lift) - pivotHeight)),
          Math.hypot(Math.max(0, rTarget - pivotOffset), Math.max(0, targetHeight(lift) - pivotHeight)),
        );
    const need = lift.mass * dyn;
    const towerHeightLimit = spec.type === 'tower'
      ? spec.geometry.mastHeight - (spec.limits.ropeMin ?? 0)
      : Infinity;

    let feasible = true;
    let reason = null;

    if (Math.max(pickupHeight(lift), targetHeight(lift)) > towerHeightLimit + 1e-6) {
      feasible = false;
      reason = `높이 도달 불가: ${Math.max(pickupHeight(lift), targetHeight(lift)).toFixed(1)}m > 최대 ${towerHeightLimit.toFixed(1)}m`;
    } else if (requiredBoomLength > boomLength + 1e-6) {
      feasible = false;
      reason = `붐 길이 부족: 필요 ${requiredBoomLength.toFixed(1)}m > 구성 ${boomLength}m`;
    } else if (rLoad < rMin || rTarget < rMin) {
      feasible = false;
      reason = `최소 반경(${rMin.toFixed(1)}m) 미만 — 너무 가까움`;
    } else if (rWorst > rMax) {
      feasible = false;
      reason = `도달 불가: r=${rWorst.toFixed(1)}m > 최대 ${rMax.toFixed(1)}m (붐 ${boomLength}m)`;
    } else {
      const capMargin = Math.min(capAt(rLoad), capAt(rTarget)) - deduct - need;
      if (capMargin < 0) {
        feasible = false;
        reason = `정격 부족: 여유 ${capMargin.toFixed(1)}t @r=${rWorst.toFixed(1)}m`;
      } else {
        minCapMargin = Math.min(minCapMargin, capMargin);
        // 안정성(전도/지반)은 현장 지반 조건이 정의된 경우에만 — checkLiftFeasible과 동일 규약
        const st = ground
          ? checkStability({ spec, boomLength, radius: rWorst, loadMass: lift.mass, ground })
          : { skipped: true };
        if (!st.skipped) {
          minTipMargin = Math.min(minTipMargin, st.tippingMargin);
          maxGroundPressure = Math.max(maxGroundPressure, st.groundPressure);
          if (!st.tipOK) {
            feasible = false;
            reason = `전도 여유 부족 (안전율 ${st.tippingMargin.toFixed(2)})`;
          } else if (!st.groundOK) {
            feasible = false;
            reason = `지반 지지력 부족 (${st.groundPressure.toFixed(1)} t/m²)`;
          }
        }
      }
    }
    if (feasible) {
      const points = [
        [lift.pos[0], pickupHeight(lift), lift.pos.length === 3 ? lift.pos[2] : lift.pos[1]],
        [lift.target[0], targetHeight(lift), lift.target.length === 3 ? lift.target[2] : lift.target[1]],
      ];
      const power = points.map((point) => powerLineClearance(point, site.powerLines ?? []))
        .find((item) => !item.safe);
      const height = points.map((point) => heightLimitAt(point, site.heightLimits ?? []))
        .find((item) => !item.safe);
      if (power) {
        feasible = false;
        reason = `전력선 이격 부족: ${power.clearance.toFixed(1)}m < ${power.required}m`;
      } else if (height) {
        feasible = false;
        reason = `고도 제한 초과: 최대 ${height.limit}m`;
      }
    }
    if (feasible) {
      const individual = evaluateOutriggers(spec, {
        pos: setup.pos, loadMass: lift.mass, radius: rWorst,
        defaultBearingCapacity: ground?.bearingCapacity,
      }, site.groundZones ?? []);
      if (!individual.feasible) {
        feasible = false;
        reason = '개별 아웃리거 지지력 부족';
      }
    }
    results.push({ id: lift.id, feasible, reason, rLoad, rTarget, requiredBoomLength });
  }

  return {
    feasible: results.every((r) => r.feasible),
    boomLength,
    lifts: results,
    minCapMargin: Number.isFinite(minCapMargin) ? minCapMargin : 0,
    minTipMargin,
    maxGroundPressure,
    assembly,
  };
}

/**
 * 셋업 후보 추천: 양중 키포인트 무게중심 주위 링 샘플링 → 타당 후보 랭킹.
 * 정렬: 정격 여유(minCapMargin) 큰 순 → 짧은 붐 우선(조립 비용).
 * @returns {Array<{pos, boomLength, score, eval}>} 상위 topN
 */
export function suggestSetups(spec, lifts, site = {}, opts = {}) {
  const angles = opts.angles ?? 16;
  const ringStep = opts.ringStep ?? 4;
  const topN = opts.topN ?? 5;
  const boomLengths =
    opts.boomLengths ??
    (spec.capacityChart ? spec.capacityChart.map((row) => row[0]) : [spec.geometry.boomLength]);

  // 키포인트 무게중심 (모든 픽업·목표 지점)
  const pts = [];
  for (const l of lifts) {
    pts.push(xz(l.pos), xz(l.target));
  }
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;

  const found = [];
  for (const boomLength of boomLengths) {
    const [, rMax] = radiusRangeOf(spec, boomLength);
    const candidates = [[cx, cz]];
    for (let r = ringStep; r <= rMax; r += ringStep) {
      for (let a = 0; a < angles; a++) {
        const th = (2 * Math.PI * a) / angles;
        candidates.push([cx + r * Math.cos(th), cz + r * Math.sin(th)]);
      }
    }
    for (const pos of candidates) {
      const ev = evaluateSetup(spec, { pos, boomLength }, lifts, site);
      if (!ev.feasible) continue;
      found.push({ pos, boomLength, score: ev.minCapMargin, eval: ev });
    }
  }

  found.sort((a, b) => b.score - a.score || a.boomLength - b.boomLength);
  return found.slice(0, topN);
}
