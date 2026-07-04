// 1층: 코어 — 시드 고정 PRNG (mulberry32).
// 전역 Math.random 금지 규약의 단일 원천: "랜덤" 거동(지상 인원 배회 등)도
// 시나리오 시드에서 유도해 같은 시드 = 같은 궤적 (리플레이·테스트·RL 재현성).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
