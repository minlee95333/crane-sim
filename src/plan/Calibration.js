// P8-prep: 근사↔물리 캘리브레이션과 시드 스윕의 결정론적 리포트.

import { evaluateLift } from './oracle.js';

export function calibrationReport(scenario, cases = []) {
  const rows = cases.map(({ craneId, loadId }) => {
    const estimate = evaluateLift(scenario, craneId, loadId, { mode: 'estimate' });
    const simulate = evaluateLift(scenario, craneId, loadId, { mode: 'simulate' });
    const ratio = estimate.cycleTime && simulate.cycleTime
      ? simulate.cycleTime / estimate.cycleTime
      : null;
    return { craneId, loadId, estimate: estimate.cycleTime, simulate: simulate.cycleTime, ratio,
      feasible: estimate.feasible && simulate.feasible };
  });
  const valid = rows.filter((row) => Number.isFinite(row.ratio));
  const correctionFactor = valid.length
    ? valid.reduce((sum, row) => sum + row.ratio, 0) / valid.length
    : null;
  const mae = valid.length
    ? valid.reduce((sum, row) => sum + Math.abs(row.simulate - row.estimate), 0) / valid.length
    : null;
  return { rows, correctionFactor, mae };
}

export function summarizeSweep(samples) {
  if (!samples.length) return { count: 0, mean: null, stddev: null, min: null, max: null, failureRate: null };
  const successes = samples.filter((sample) => sample.success);
  const values = successes.map((sample) => sample.makespan);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const variance = values.length
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
    : null;
  return {
    count: samples.length,
    mean,
    stddev: variance == null ? null : Math.sqrt(variance),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    failureRate: (samples.length - successes.length) / samples.length,
  };
}

export function compareTimelines(plannedEvents, actualEvents) {
  const actualByKey = new Map(actualEvents.map((event) =>
    [`${event.craneId}:${event.loadId}:${event.type}`, event]));
  return plannedEvents.map((planned) => {
    const actual = actualByKey.get(`${planned.craneId}:${planned.loadId}:${planned.type}`);
    return {
      ...planned,
      actualStart: actual?.start ?? null,
      actualFinish: actual?.finish ?? null,
      startDelta: actual ? actual.start - planned.start : null,
      finishDelta: actual ? actual.finish - planned.finish : null,
    };
  });
}

