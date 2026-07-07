// 슬링 기하·장력 순수 계산. 각도는 수평면 기준(rad), 질량·장력은 t-equivalent.

export const DEFAULT_MIN_SLING_ANGLE = Math.PI / 3; // 60°

export function evaluateSling(load, options = {}) {
  const count = Math.max(2, load.liftPoints?.length ?? options.pointCount ?? 4);
  const height = Math.max(0.1, load.slingHeight ?? options.slingHeight ?? 3);
  const halfW = Math.max(0.1, load.size[0] / 2);
  const halfD = Math.max(0.1, load.size[2] / 2);
  const horizontal = load.liftPoints?.length
    ? Math.max(...load.liftPoints.map((p) => Math.hypot(p[0], p[1] ?? 0)))
    : Math.hypot(halfW, halfD);
  const angle = Math.atan2(height, horizontal);
  const minAngle = load.minSlingAngle ?? options.minAngle ?? DEFAULT_MIN_SLING_ANGLE;
  const tensionPerLeg = load.mass / (count * Math.max(Math.sin(angle), 1e-6));
  const warning = angle < minAngle;
  return {
    pointCount: count,
    height,
    horizontal,
    angle,
    minAngle,
    tensionPerLeg,
    totalVertical: tensionPerLeg * count * Math.sin(angle),
    warning,
    blocked: warning && (load.blockUnsafeSling ?? options.blockUnsafeSling ?? false),
  };
}

