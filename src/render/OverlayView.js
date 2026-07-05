// 3층: 렌더 — 조작 보조 오버레이 (씬 앵커 마커). 상태·예비판정을 받아 표시만 한다.
//
// 원칙 (P7.11):
// - 판정은 코어 단일 경로: World.attachPreview/releasePreview 결과를 그대로 그린다.
//   여기서 거리·허용을 재계산하지 않는다 (UI 녹색 = 실제 성공 보장).
// - three 도형만 사용 (텍스트·CanvasTexture 금지) — Node 헤드리스 테스트 가능.
// - 라이브 수동 조작 전용: 계획 재생·리플레이(live=false)나 H 토글 OFF 시 전체 숨김.
import * as THREE from 'three';
import { ATTACH_MAX_HORIZ } from '../core/World.js';

const COLOR = {
  idle: 0xb8c2cc, // 회백: 후보 없음/원거리
  near: 0xe0a53a, // 호박: 후보 근접(조건 일부 미충족)
  ok: 0x3ecf6e, // 녹: 지금 조작하면 성공
  danger: 0xe04a34, // 적: 위험(홀드)
};

function flatMat(color, opacity = 0.85) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

function lineMat(color, opacity = 0.8) {
  return new THREE.LineDashedMaterial({
    color,
    transparent: true,
    opacity,
    dashSize: 0.8,
    gapSize: 0.5,
    depthWrite: false,
  });
}

/** 지면 링 (rotation 적용, y는 호출측) */
function ringMesh(rInner, rOuter, mat, segments = 48) {
  const m = new THREE.Mesh(new THREE.RingGeometry(rInner, rOuter, segments), mat);
  m.rotation.x = -Math.PI / 2;
  return m;
}

export class OverlayView {
  constructor() {
    this.root = new THREE.Group();
    this.enabled = true;

    // 상태색 재질 (스왑 공유)
    this.mats = {
      idle: flatMat(COLOR.idle, 0.65),
      near: flatMat(COLOR.near, 0.85),
      ok: flatMat(COLOR.ok, 0.9),
      danger: flatMat(COLOR.danger, 0.9),
    };

    // ── 후크 조준점: 지면 투영 링 + 십자 + 수직 낙하선 ──
    this.reticle = new THREE.Group();
    this.reticleRing = ringMesh(0.34, 0.46, this.mats.idle);
    this.reticle.add(this.reticleRing);
    this.reticleCross = [];
    for (let i = 0; i < 4; i++) {
      const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.07), this.mats.idle);
      tick.rotation.x = -Math.PI / 2;
      tick.rotation.z = (i * Math.PI) / 2;
      const a = (i * Math.PI) / 2;
      tick.position.set(Math.cos(a) * 0.75, 0, Math.sin(a) * 0.75);
      this.reticleCross.push(tick);
      this.reticle.add(tick);
    }
    this.root.add(this.reticle);
    this.dropLine = new THREE.Mesh(
      new THREE.CylinderGeometry(0.015, 0.015, 1, 4, 1, true),
      flatMat(COLOR.idle, 0.3),
    );
    this.root.add(this.dropLine);

    // ── 픽업 가이드: 후보 부재 허용원(수평 조건) + 코너 브래킷 ──
    this.pickupRing = ringMesh(ATTACH_MAX_HORIZ - 0.08, ATTACH_MAX_HORIZ, this.mats.near, 56);
    this.root.add(this.pickupRing);
    this.brackets = [];
    for (let i = 0; i < 4; i++) {
      const bracket = new THREE.Group();
      for (const rot of [0, Math.PI / 2]) {
        const arm = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.08), this.mats.near);
        arm.rotation.x = -Math.PI / 2;
        arm.rotation.z = rot;
        arm.position.set(rot === 0 ? -0.24 : 0, 0, rot === 0 ? 0 : -0.24);
        bracket.add(arm);
      }
      this.brackets.push(bracket);
      this.root.add(bracket);
    }

    // ── 리드라인 (점선): 후크→후보 / 부재→목표 ──
    this.leadGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    this.leadLine = new THREE.Line(this.leadGeo, lineMat(COLOR.near));
    this.root.add(this.leadLine);

    // ── 안착 가이드: 목표 상태 링 + 바닥 간격선 ──
    this.settleRing = ringMesh(1.62, 1.86, this.mats.idle, 56); // PLACE_TOL(1.5)+여유 — SiteView 링 바깥
    this.root.add(this.settleRing);
    this.gapLine = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 1, 4, 1, true),
      this.mats.near,
    );
    this.root.add(this.gapLine);

    // ── 선회 스윕 예고: 정점색 원호 (안전 회록 / 위험 적) ──
    const SWEEP_N = 73; // 72 샘플 + 폐합점
    this.sweepGeo = new THREE.BufferGeometry();
    this.sweepGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SWEEP_N * 3), 3));
    this.sweepGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(SWEEP_N * 3), 3));
    this.sweepLine = new THREE.Line(
      this.sweepGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.root.add(this.sweepLine);
    this.sweepHazards = []; // 위험 샘플 강조 디스크 풀
    for (let i = 0; i < 24; i++) {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.55, 12), this.mats.danger);
      disc.rotation.x = -Math.PI / 2;
      this.sweepHazards.push(disc);
      this.root.add(disc);
    }

    // ── 흔들림 인디케이터: 하중 하부 수평 화살표 (방향=흔들림 벡터) ──
    this.swayArrow = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 5), this.mats.near);
    shaft.rotation.z = -Math.PI / 2; // +x 방향
    shaft.position.x = 0.5;
    this.swayArrow.add(shaft);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.4, 6), this.mats.near);
    head.rotation.z = -Math.PI / 2;
    head.position.x = 1.15;
    this.swayArrow.add(head);
    this.root.add(this.swayArrow);

    // ── 미션 마커: ready=녹 다이아 바운스 / 잠김=회백 정지 (풀 12) ──
    this.missionMarks = [];
    for (let i = 0; i < 12; i++) {
      const mark = new THREE.Mesh(new THREE.OctahedronGeometry(0.4), this.mats.ok);
      this.missionMarks.push(mark);
      this.root.add(mark);
    }

    // ── 위험 반경 링 + 침입자 마커 (역삼각 콘) ──
    this.dangerRing = ringMesh(0.94, 1.0, this.mats.near, 64); // 단위 반경 — scale로 반경 적용
    this.root.add(this.dangerRing);
    this.intruderMarks = [];
    for (let i = 0; i < 4; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.55, 4), this.mats.danger);
      cone.rotation.x = Math.PI; // 역방향 (아래를 가리킴)
      this.intruderMarks.push(cone);
      this.root.add(cone);
    }

    this.#hideAll();
  }

  #hideAll() {
    this.reticle.visible = false;
    this.dropLine.visible = false;
    this.pickupRing.visible = false;
    for (const bracket of this.brackets) bracket.visible = false;
    this.leadLine.visible = false;
    this.settleRing.visible = false;
    this.gapLine.visible = false;
    this.dangerRing.visible = false;
    for (const mark of this.intruderMarks) mark.visible = false;
    this.sweepLine.visible = false;
    for (const disc of this.sweepHazards) disc.visible = false;
    this.swayArrow.visible = false;
    for (const mark of this.missionMarks) mark.visible = false;
  }

  #setReticleMat(mat) {
    this.reticleRing.material = mat;
    for (const tick of this.reticleCross) tick.material = mat;
  }

  /**
   * @param {Object} state world.getState()
   * @param {number} activeCrane
   * @param {Object} opts { live, enabled, preview: attachPreview 결과, release: releasePreview 결과, time }
   */
  update(state, activeCrane, { live = true, enabled = this.enabled, preview = null, release = null, sweep = null, readiness = null, time = null } = {}) {
    this.enabled = enabled;
    const show = live && enabled;
    this.root.visible = show;
    if (!show) return;
    this.#hideAll();

    const crane = state.cranes?.[activeCrane];
    if (!crane) return;
    const hook = crane.hookPos;
    const holding = release != null;

    if (!holding) {
      // ── 빈 후크: 조준점 + 낙하선 + 픽업 가이드 ──
      const mat = preview?.ok ? this.mats.ok : preview?.horizOk ? this.mats.near : this.mats.idle;
      this.reticle.visible = true;
      this.reticle.position.set(hook[0], 0.07, hook[2]);
      this.#setReticleMat(mat);
      this.dropLine.visible = true;
      this.dropLine.material = mat;
      this.dropLine.scale.y = Math.max(hook[1], 0.1);
      this.dropLine.position.set(hook[0], hook[1] / 2, hook[2]);

      if (preview?.load) {
        const l = preview.load;
        const topY = l.pos[1] + l.size[1] / 2;
        const guideMat = preview.ok ? this.mats.ok : this.mats.near;
        this.pickupRing.visible = true;
        this.pickupRing.material = guideMat;
        this.pickupRing.position.set(l.pos[0], topY + 0.06, l.pos[2]);
        // 코너 브래킷 (yaw 반영 — 코어 좌표 규약 회전)
        const cy = Math.cos(l.yaw ?? 0);
        const sy = Math.sin(l.yaw ?? 0);
        const corners = [
          [-l.size[0] / 2, -l.size[2] / 2],
          [l.size[0] / 2, -l.size[2] / 2],
          [l.size[0] / 2, l.size[2] / 2],
          [-l.size[0] / 2, l.size[2] / 2],
        ];
        this.brackets.forEach((bracket, i) => {
          const [dx, dz] = corners[i];
          bracket.visible = true;
          bracket.position.set(
            l.pos[0] + dx * cy - dz * sy,
            topY + 0.08,
            l.pos[2] + dx * sy + dz * cy,
          );
          bracket.rotation.y = -(l.yaw ?? 0) + (i * Math.PI) / 2;
          for (const arm of bracket.children) arm.material = guideMat;
        });
        // 리드라인: 후크 → 후보 상면
        this.#setLead([hook[0], hook[1], hook[2]], [l.pos[0], topY, l.pos[2]], guideMat.color);
      }
      // 미션 마커: 지금 들 수 있는 부재(녹 바운스) vs 선행 잠김(회백)
      if (readiness) {
        readiness.slice(0, this.missionMarks.length).forEach((r, i) => {
          const mark = this.missionMarks[i];
          mark.visible = true;
          mark.material = r.ready ? this.mats.ok : this.mats.idle;
          const bob = r.ready && time != null ? 0.25 * Math.sin(time * 3 + i) : 0;
          mark.position.set(r.pos[0], r.pos[1] + r.size[1] / 2 + 1.7 + bob, r.pos[2]);
          mark.rotation.y = time != null ? time * (r.ready ? 1.2 : 0) : 0;
          mark.scale.setScalar(r.ready ? 1 : 0.65);
        });
      }
    } else {
      // ── 매달림: 안착 가이드 + 리드라인 + 위험 반경 ──
      const held = release.held;
      if (held.target) {
        const [tx, tz] = held.target;
        const elev = held.targetElev ?? 0;
        const mat = release.canRelease && release.onTarget
          ? this.mats.ok
          : release.onTarget
            ? this.mats.near
            : this.mats.idle;
        this.settleRing.visible = true;
        this.settleRing.material = mat;
        this.settleRing.position.set(tx, elev + 0.06, tz);
        this.#setLead(
          [held.pos[0], held.pos[1], held.pos[2]],
          [tx, elev + 0.1, tz],
          mat.color,
        );
      }
      // 바닥 간격선: 부재 바닥 → 지지면
      const bottom = held.pos[1] - held.size[1] / 2;
      const gap = Math.max(release.bottomGap, 0.02);
      this.gapLine.visible = true;
      this.gapLine.material = release.canRelease ? this.mats.ok : this.mats.near;
      this.gapLine.scale.y = gap;
      this.gapLine.position.set(held.pos[0], release.support + gap / 2, held.pos[2]);

      // 선회 스윕 예고: 위험 구간이 있을 때만 표시 (전부 안전하면 시각 소음 방지)
      if (sweep && sweep.samples.some((s) => s.hit)) {
        const positions = this.sweepGeo.getAttribute('position');
        const colors = this.sweepGeo.getAttribute('color');
        const n = sweep.samples.length;
        let hazardIdx = 0;
        for (let i = 0; i <= n; i++) {
          const s = sweep.samples[i % n];
          positions.setXYZ(i, s.x, 0.09, s.z);
          if (s.hit) colors.setXYZ(i, 0.88, 0.29, 0.2);
          else colors.setXYZ(i, 0.55, 0.62, 0.58);
          if (s.hit && i < n && hazardIdx < this.sweepHazards.length) {
            const disc = this.sweepHazards[hazardIdx++];
            disc.visible = true;
            disc.position.set(s.x, 0.1, s.z);
          }
        }
        positions.needsUpdate = true;
        colors.needsUpdate = true;
        this.sweepGeo.computeBoundingSphere();
        this.sweepLine.visible = true;
      }

      // 흔들림 인디케이터: 매달림점(반경 방향 점) 대비 후크의 수평 편차 벡터
      // (합성 상태 가드: basePos·radius 없는 계획 재생 상태에선 생략)
      if (crane.basePos && crane.radius != null && crane.slewAngle != null) {
        const radial = [
          crane.basePos[0] + crane.radius * Math.cos(crane.slewAngle),
          crane.basePos[2] + crane.radius * Math.sin(crane.slewAngle),
        ];
        const dx = hook[0] - radial[0];
        const dz = hook[2] - radial[1];
        const mag = Math.hypot(dx, dz);
        if (mag > 0.05) {
          this.swayArrow.visible = true;
          this.swayArrow.position.set(held.pos[0], held.pos[1] - held.size[1] / 2 - 0.3, held.pos[2]);
          this.swayArrow.rotation.y = -Math.atan2(dz, dx);
          this.swayArrow.scale.setScalar(Math.min(1 + mag * 2.5, 4));
        }
      }

      // 위험 반경 (에이전트 있는 시나리오만)
      if ((state.agents ?? []).length > 0) {
        const radius = state.safety?.dangerRadius ?? 5;
        const holdActive = (state.safety?.agentHolds ?? []).includes(activeCrane);
        this.dangerRing.visible = true;
        this.dangerRing.material = holdActive ? this.mats.danger : this.mats.near;
        const pulse = holdActive && time != null ? 1 + 0.04 * Math.sin(time * 5) : 1;
        this.dangerRing.scale.set(radius * pulse, radius * pulse, 1);
        this.dangerRing.position.set(held.pos[0], 0.05, held.pos[2]);
        // 반경 내 침입자 마커
        let markIndex = 0;
        for (const agent of state.agents) {
          if (markIndex >= this.intruderMarks.length) break;
          const dist = Math.hypot(held.pos[0] - agent.pos[0], held.pos[2] - agent.pos[1]);
          if (dist < radius) {
            const mark = this.intruderMarks[markIndex++];
            mark.visible = true;
            const bob = time != null ? 0.12 * Math.sin(time * 6) : 0;
            mark.position.set(agent.pos[0], 2.5 + bob, agent.pos[1]);
          }
        }
      }
    }
  }

  #setLead(from, to, color) {
    this.leadLine.visible = true;
    const positions = this.leadGeo.getAttribute('position');
    positions.setXYZ(0, from[0], from[1], from[2]);
    positions.setXYZ(1, to[0], to[1], to[2]);
    positions.needsUpdate = true;
    this.leadGeo.computeBoundingSphere();
    this.leadLine.computeLineDistances(); // 점선 갱신 (2점 — 저렴)
    this.leadLine.material.color.set(color);
  }
}
