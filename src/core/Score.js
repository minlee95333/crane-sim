// 플레이 완료 채점 순수 계산. UI와 Recorder는 이 결과만 소비한다.

export function calculateScore(state, config = {}) {
  const targets = state.loads.filter((load) => load.target);
  if (!targets.length || !targets.every((load) => load.state === 'placed')) return null;
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const positionError = mean(targets.map((load) => load.placementError ?? 0));
  const yawError = mean(targets.map((load) => Math.abs(load.placementYawError ?? 0)));
  const safety = state.safety ?? {};
  const holds = (safety.agentHoldTime ?? 0) + (safety.tandemHoldTime ?? 0);
  const violations = (safety.collisionCount ?? 0) + (safety.violationCount ?? 0) +
    (safety.craneClashCount ?? 0) + (safety.siteRuleViolationCount ?? 0);
  const parTime = Math.max(1, config.parTime ?? state.time);
  const timePenalty = Math.max(0, state.time - parTime) / parTime * 20;
  const positionPenalty = Math.min(30, positionError * 15);
  const yawPenalty = Math.min(20, yawError * (180 / Math.PI));
  const safetyPenalty = violations * (config.violationPenalty ?? 12) +
    holds * (config.holdPenaltyPerSecond ?? 0.1);
  const value = Math.max(0, Math.min(100,
    100 - timePenalty - positionPenalty - yawPenalty - safetyPenalty));
  return {
    value,
    stars: Math.max(1, Math.min(5, Math.ceil(value / 20))),
    time: state.time,
    parTime,
    positionError,
    yawError,
    violations,
    holdTime: holds,
    penalties: { time: timePenalty, position: positionPenalty, yaw: yawPenalty, safety: safetyPenalty },
  };
}
