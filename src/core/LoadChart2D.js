// 1층: 코어 — 2차원 정격하중표 (붐길이 × 작업반경) (SIM_DESIGN T1-②, P5).
//
// 실제 크레인 정격표는 붐 구성(길이)마다 별도의 반경→하중 곡선을 가진다.
// 크롤러의 격자붐 길이는 조립 시 결정되는 값 — 즉 "계획 변수"다.
// 표 형식: [[boomLen, [[radius, cap], ...]], ...] (붐길이 오름차순)
//
// 보간: 반경 방향은 LoadChart(1D 선형), 붐길이 방향도 선형.
// 표 밖 붐길이는 가장 가까운 행으로 클램프(보수적 외삽 방지).

import { LoadChart } from './LoadChart.js';

export class LoadChart2D {
  /** @param {Array<[number, Array<[number, number]>]>} chart [[boomLen, points], ...] */
  constructor(chart) {
    if (!chart?.length) throw new Error('LoadChart2D: empty chart');
    this.rows = [...chart]
      .sort((a, b) => a[0] - b[0])
      .map(([len, pts]) => ({ len, chart: new LoadChart(pts) }));
  }

  /**
   * @param {number} boomLen 붐길이 (m)
   * @param {number} radius 작업반경 (m)
   * @returns {number} 정격하중 (t)
   */
  capacityAt(boomLen, radius) {
    const rows = this.rows;
    if (boomLen <= rows[0].len) return rows[0].chart.capacityAt(radius);
    if (boomLen >= rows[rows.length - 1].len) return rows[rows.length - 1].chart.capacityAt(radius);
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i];
      const b = rows[i + 1];
      if (boomLen >= a.len && boomLen <= b.len) {
        const t = (boomLen - a.len) / (b.len - a.len);
        return a.chart.capacityAt(radius) * (1 - t) + b.chart.capacityAt(radius) * t;
      }
    }
    return 0;
  }

  /** 사용 가능한 붐길이 옵션 (계획 변수 후보) */
  get boomLengths() {
    return this.rows.map((r) => r.len);
  }
}
