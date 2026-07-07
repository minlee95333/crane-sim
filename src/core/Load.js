// 1층: 코어 — 인양 부재(Load).
// 상태: pending(반입 전) → ground(대기) → rigging(줄걸이 작업) → hooked(매달림)
//       → derigging(해체 작업) → ground(재배치·다음 여정) | placed(최종 안착)
// rigTime/derigTime이 0이면 rigging/derigging을 건너뛰고 즉시 전이 (기존 동작).
// arriveTime > 0이면 반입 전(pending)으로 시작 — World가 시간 도달 시 ground로 전환.
//
// 여정(route): 부재는 여러 단계 목표를 순서대로 거친다 (T2-⑤ 확장).
//   예) 트럭 적재함(elev 1.35) → [하역] 야적장(elev 0) → [건립] 기둥 위(elev 6)
//   route: [{ target:[x,z], elev? }, ...]  — 마지막 단계 안착 시에만 'placed'.
//   레거시 target:[x,z]는 route 1단계로 정규화된다.
// elev: 부재 바닥의 초기 높이 (트럭 적재함 등, 기본 0 = 지면)

export class Load {
  /**
   * @param {Object} def { id, name, size:[w,h,d](m), mass(t), pos:[x,y,z], elev?(m),
   *                       target?:[x,z], route?:[{target:[x,z], elev?}, ...],
   *                       rigTime?(s), derigTime?(s), arriveTime?(s),
   *                       dependsOn?: [loadId], maxWind?(m/s),
   *                       shape?(렌더 형상 태그), windArea?(수풍면적 m²),
   *                       tandem?(boolean), liftPoints?([[x,z],[x,z]]), cog?([x,z]),
   *                       targetYaw?(rad), slingHeight?(m), minSlingAngle?(rad), blockUnsafeSling? }
   */
  constructor(def) {
    this.id = def.id;
    this.name = def.name ?? def.id;
    this.size = def.size; // [w, h, d]
    this.mass = def.mass; // t
    this.shape = def.shape ?? null; // 렌더 형상 태그 (h-beam/pipe/rebar/tank/…) — 코어는 데이터만 운반
    this.windArea = def.windArea ?? null; // 수풍면적 (m², null = 크기에서 유도) (T2-⑦)
    this.tandem = def.tandem === true;
    const halfSpan = Math.max(this.size[0], this.size[2]) * 0.4;
    this.liftPoints = def.liftPoints
      ? def.liftPoints.map((p) => [...p])
      : [[-halfSpan, 0], [halfSpan, 0]];
    this.cog = def.cog ? [def.cog[0], def.cog[1] ?? def.cog[2] ?? 0] : [0, 0];
    this.tandemCraneIds = null;
    this.targetYaw = def.targetYaw ?? null;
    this.yawTolerance = def.yawTolerance ?? Math.PI / 18;
    this.slingHeight = def.slingHeight ?? null;
    this.minSlingAngle = def.minSlingAngle ?? null;
    this.blockUnsafeSling = def.blockUnsafeSling ?? false;
    this.resourceRequirements = { ...(def.resourceRequirements ?? {}) };
    this.erectionOrder = def.erectionOrder ?? null;
    this.placementError = null;
    this.placementYawError = null;
    this.pos = [...def.pos]; // 중심 좌표. y는 바닥고(elev) + h/2로 정규화
    this.elev = def.elev ?? 0; // 초기 바닥 높이 (트럭 적재함 등)
    this.pos[1] = this.elev + this.size[1] / 2;
    // 여정 정규화: route 우선, 없으면 레거시 target 1단계
    this.route = def.route
      ? def.route.map((leg) => ({ target: [...leg.target], elev: leg.elev ?? 0 }))
      : def.target
        ? [{ target: [...def.target], elev: def.targetElev ?? 0 }]
        : [];
    this.stage = 0; // 현재 여정 단계 인덱스
    this.rigTime = def.rigTime ?? 0; // 줄걸이 소요 (s)
    this.derigTime = def.derigTime ?? 0; // 해체 소요 (s)
    this.timer = 0; // rigging/derigging 남은 시간 (s)
    this.arriveTime = def.arriveTime ?? 0; // 현장 반입 시각 (s)
    this.dependsOn = def.dependsOn ? [...def.dependsOn] : []; // 시공순서: 최종 안착에만 적용
    this.maxWind = def.maxWind ?? null; // 부재별 작업한계풍속 (m/s, null=현장 기본)
    this.state = this.arriveTime > 0 ? 'pending' : 'ground';
    this.hookedBy = null; // craneId
    this.stageChangedAt = null;
    this.yardedAt = null; // 첫 여정(트럭→야적) 완료 시각 — 이후 건립에서도 유지

    // 매달림 거동 옵션 상태 (크레인 스펙 physics 플래그가 켠 경우에만 World가 갱신)
    this.yaw = 0; // 부재 요 회전각 (rad, 0 = 축 정렬) — physics.loadYaw (T3-⑨ 전 단계)
    this.yawVel = 0;
    this._yawOffset = 0; // 픽업 시점의 (yaw − slewAngle) — 상대 자세 유지용
    this.sway = null; // 이중진자 2단(후크→부재) — physics.doublePendulum 시 attach에서 생성 (T3-⑩)
  }

  /** 현재 여정 단계의 목표 [x, z] (여정 없으면 null) */
  get target() {
    return this.route[this.stage]?.target ?? null;
  }

  /** 현재 여정 단계의 목표 바닥 높이 (m) */
  get targetElev() {
    return this.route[this.stage]?.elev ?? 0;
  }

  /** 마지막 여정 단계인가 — 시공순서(dependsOn)는 이 단계에만 적용 */
  get finalLeg() {
    return this.stage >= this.route.length - 1;
  }

  /** 다음 여정 단계로 진행. 마지막이었으면 false */
  advanceStage() {
    if (this.finalLeg) return false;
    this.stage += 1;
    return true;
  }

  get topY() {
    return this.pos[1] + this.size[1] / 2;
  }

  get bottomY() {
    return this.pos[1] - this.size[1] / 2;
  }

  getState() {
    return {
      id: this.id,
      name: this.name,
      size: [...this.size],
      mass: this.mass,
      shape: this.shape,
      windArea: this.windArea,
      yaw: this.yaw,
      pos: [...this.pos],
      target: this.target ? [...this.target] : null,
      targetElev: this.targetElev,
      route: this.route.map((leg) => ({ target: [...leg.target], elev: leg.elev })),
      stage: this.stage,
      stages: this.route.length,
      state: this.state,
      hookedBy: this.hookedBy,
      tandem: this.tandem,
      liftPoints: this.liftPoints.map((p) => [...p]),
      cog: [...this.cog],
      tandemCraneIds: this.tandemCraneIds ? [...this.tandemCraneIds] : null,
      targetYaw: this.targetYaw,
      yawTolerance: this.yawTolerance,
      placementError: this.placementError,
      placementYawError: this.placementYawError,
      sling: this.sling ? { ...this.sling } : null,
      resourceRequirements: { ...this.resourceRequirements },
      erectionOrder: this.erectionOrder,
      rigRemain: this.state === 'rigging' || this.state === 'derigging' ? this.timer : 0,
      rigTime: this.rigTime,
      derigTime: this.derigTime,
      arriveTime: this.arriveTime,
      stageChangedAt: this.stageChangedAt,
      yardedAt: this.yardedAt,
      dependsOn: [...this.dependsOn],
    };
  }
}
