import { summarizeSweep, compareTimelines } from './Calibration.js';

function check(label, ok) {
  if (!ok) throw new Error(`FAIL: ${label}`);
  console.log(`  PASS: ${label}`);
}

console.log('--- P8-prep 리포트 ---');
const summary = summarizeSweep([
  { success: true, makespan: 100 },
  { success: true, makespan: 120 },
  { success: false, makespan: null },
]);
check('시드 스윕 평균·실패율', summary.mean === 110 && Math.abs(summary.failureRate - 1 / 3) < 1e-9);
check('시드 스윕 표준편차', summary.stddev === 10);
const comparison = compareTimelines(
  [{ craneId: 'C', loadId: 'L', type: 'lift', start: 10, finish: 20 }],
  [{ craneId: 'C', loadId: 'L', type: 'lift', start: 12, finish: 25 }],
);
check('계획↔실측 시작·종료 지연', comparison[0].startDelta === 2 && comparison[0].finishDelta === 5);
console.log('\nALL PASS');
