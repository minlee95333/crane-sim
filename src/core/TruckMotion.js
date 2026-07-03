// 트럭 종방향 이동용 결정론적 운동 프로파일.
// 주어진 거리·시간 안에서 가속 → 정속 → 감속하며 시작과 끝 속도는 0이다.

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function truckMotionAt(elapsed, {
  distance,
  duration,
  maxAcceleration = 0.3,
} = {}) {
  const d = Math.max(0, Number(distance) || 0);
  const total = Math.max(1e-6, Number(duration) || 0);
  const accelLimit = Math.max(1e-6, Number(maxAcceleration) || 0);
  const t = clamp(Number(elapsed) || 0, 0, total);

  // d = vmax * (T - vmax/a). 제한 가속도로 해가 없으면 삼각 프로파일을 사용한다.
  const discriminant = total * total - (4 * d) / accelLimit;
  const accelTime = discriminant >= 0
    ? (total - Math.sqrt(discriminant)) / 2
    : total / 2;
  const acceleration = d / Math.max(1e-9, accelTime * (total - accelTime));
  const maxSpeed = acceleration * accelTime;
  const brakeStart = total - accelTime;

  let position;
  let velocity;
  let longitudinalAcceleration;
  let phase;
  if (t < accelTime) {
    position = 0.5 * acceleration * t * t;
    velocity = acceleration * t;
    longitudinalAcceleration = acceleration;
    phase = 'accelerating';
  } else if (t < brakeStart) {
    const accelDistance = 0.5 * acceleration * accelTime * accelTime;
    position = accelDistance + maxSpeed * (t - accelTime);
    velocity = maxSpeed;
    longitudinalAcceleration = 0;
    phase = 'cruising';
  } else if (t < total) {
    const remaining = total - t;
    position = d - 0.5 * acceleration * remaining * remaining;
    velocity = acceleration * remaining;
    longitudinalAcceleration = -acceleration;
    phase = 'braking';
  } else {
    position = d;
    velocity = 0;
    longitudinalAcceleration = 0;
    phase = 'stopped';
  }

  return {
    position: clamp(position, 0, d),
    velocity,
    acceleration: longitudinalAcceleration,
    phase,
    maxSpeed,
    accelTime,
  };
}
