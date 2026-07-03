// 1층: 코어 — 정격하중표(Load Chart).
// 반경 → 정격하중(t)을 선형 보간으로 반환한다.
// 실제 크레인은 (붐길이 × 반경) 2차원 표지만, 우선 반경 1차원으로 시작.
// 표 범위를 벗어나면: 최소 반경 미만 → 첫 값, 최대 반경 초과 → 0 (인양 불가).

export class LoadChart {
  /**
   * @param {Array<[number, number]>} points [반경(m), 정격하중(t)] 오름차순
   */
  constructor(points) {
    if (!points?.length) throw new Error('LoadChart: empty table');
    // 반경 오름차순 보장
    this.points = [...points].sort((a, b) => a[0] - b[0]);
  }

  /** @param {number} radius 작업반경(m) @returns {number} 정격하중(t) */
  capacityAt(radius) {
    const pts = this.points;
    if (radius <= pts[0][0]) return pts[0][1];
    if (radius > pts[pts.length - 1][0]) return 0; // 표 초과 = 인양 불가 (경계는 표값)

    for (let i = 0; i < pts.length - 1; i++) {
      const [r0, c0] = pts[i];
      const [r1, c1] = pts[i + 1];
      if (radius >= r0 && radius <= r1) {
        const t = (radius - r0) / (r1 - r0);
        return c0 + t * (c1 - c0);
      }
    }
    return 0;
  }

  get minRadius() {
    return this.points[0][0];
  }

  get maxRadius() {
    return this.points[this.points.length - 1][0];
  }
}
