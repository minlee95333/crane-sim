// 3층: 렌더 — 화면 고정 보조 위젯 (DOM/Canvas 2D). 상태를 받아 표시만 한다.
//
// 구성: 하중률 게이지(반경→정격 곡선 + 현재 작업점), 미니맵(탑뷰), 후크 거리 라벨
// (월드→스크린 투영), 상태 배너(홀드>리미터>리깅>풍속), 풍향 위젯.
// DOM이 없는 환경(Node 테스트)에서는 전체 no-op. 라벨·배너·조준 정보는 라이브 조작
// 전용(live), 미니맵·게이지는 계획 재생 관찰에도 유용하므로 항상 표시.
import * as THREE from 'three';
import { PALETTE } from './LoadView.js';

const _v = new THREE.Vector3();

const css = (n) => `#${n.toString(16).padStart(6, '0')}`;

/** 코어가 계산한 전도 안전율의 표시 색상. */
export function stabilityColor(factor) {
  if (factor < 1.0) return '#e04a34';
  if (factor < 1.33) return '#e0a53a';
  return '#3ecf6e';
}

/** 월드 목표를 화면 가장자리 화살표 위치·각도로 투영한다. 화면 안이면 null. */
export function projectEdgeArrow(pos, camera, width, height, rightInset = 368) {
  const p = new THREE.Vector3(pos[0], pos[1], pos[2]).project(camera);
  const behind = p.z > 1;
  let dx = behind ? -p.x : p.x;
  let dy = behind ? p.y : -p.y;
  if (!behind && p.z >= -1 && Math.abs(p.x) <= 0.9 && Math.abs(p.y) <= 0.9) return null;
  if (Math.abs(dx) + Math.abs(dy) < 1e-9) dy = -1;
  const maxX = Math.max(width - rightInset - 28, 28);
  const cx = Math.min(width / 2, maxX / 2);
  const cy = height / 2;
  const sx = Math.max(cx - 24, 1);
  const sy = Math.max(cy - 24, 1);
  const scale = 1 / Math.max(Math.abs(dx) / sx, Math.abs(dy) / sy);
  return {
    x: Math.min(Math.max(cx + dx * scale, 24), maxX),
    y: Math.min(Math.max(cy + dy * scale, 24), height - 24),
    angle: Math.atan2(dy, dx),
  };
}

/** 중앙 배너 우선순위 선택. */
export function selectBanner(state, activeCrane, crane, live, nfz) {
  if (!live) return { html: null, cls: '' };
  const rigging = state.loads.find(
    (l) => l.hookedBy === activeCrane && (l.state === 'rigging' || l.state === 'derigging'),
  );
  if ((state.safety?.agentHolds ?? []).includes(activeCrane)) {
    return { html: '⛔ 지상 인원·장비 접근 — 작업 일시정지', cls: 'danger' };
  }
  if (crane.extra?.limiterActive) {
    return { html: '⚠ 모멘트 리미터 작동 — 반경을 줄이세요', cls: 'danger' };
  }
  if (nfz?.near) {
    return { html: `⚠ 금지구역 접근 (${nfz.distance.toFixed(1)}m) — 경로를 변경하세요`, cls: 'danger' };
  }
  if (rigging) {
    const total = rigging.state === 'rigging' ? rigging.rigTime : rigging.derigTime;
    const pct = total > 0 ? Math.round((1 - rigging.rigRemain / total) * 100) : 0;
    return {
      html: `🔧 ${rigging.state === 'rigging' ? '줄걸이' : '해체'} 작업 중 ${pct}% <span class="ov-progress"><span style="width:${pct}%"></span></span>`,
      cls: 'work',
    };
  }
  if (state.wind?.maxOperating && state.wind.speed > state.wind.maxOperating) {
    return {
      html: `⛔ 풍속 초과 (${state.wind.speed.toFixed(1)} > ${state.wind.maxOperating} m/s) — 작업 중지`,
      cls: 'danger',
    };
  }
  return { html: null, cls: '' };
}

export class ScreenWidgets {
  /** @param {HTMLElement|null} container #overlay */
  constructor(container) {
    this.ok = typeof document !== 'undefined' && !!container;
    this.enabled = true;
    if (!this.ok) return;
    this.container = container;
    container.innerHTML = `
      <div class="ov-gauge"><canvas width="196" height="136"></canvas></div>
      <div class="ov-side">
        <div class="ov-wind" hidden><span class="ov-wind-arrow">➤</span><span class="ov-wind-text"></span></div>
        <div class="ov-minimap"><canvas width="208" height="164"></canvas></div>
      </div>
      <div class="ov-banner" hidden></div>
      <div class="ov-label" hidden></div>
      <div class="ov-target-arrow" hidden>➤</div>
      <div class="ov-onboard" hidden></div>
    `;
    this.gaugeCanvas = container.querySelector('.ov-gauge canvas');
    this.mapCanvas = container.querySelector('.ov-minimap canvas');
    this.windBox = container.querySelector('.ov-wind');
    this.windArrow = container.querySelector('.ov-wind-arrow');
    this.windText = container.querySelector('.ov-wind-text');
    this.banner = container.querySelector('.ov-banner');
    this.label = container.querySelector('.ov-label');
    this.targetArrow = container.querySelector('.ov-target-arrow');
    this.onboard = container.querySelector('.ov-onboard');
    this._onboardUntil = 0;
    this._lastBanner = null;
    this._lastLabel = null;
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.ok) this.container.style.display = on ? '' : 'none';
    return on;
  }

  /**
   * @param {Object} state world.getState()
   * @param {number} activeCrane
   * @param {THREE.Camera} camera 거리 라벨 투영·미니맵 시야 부채꼴용
   * @param {Object} opts core 질의 결과와 라이브 표시 상태
   */
  update(state, activeCrane, camera, {
    spec = null,
    scenario = null,
    live = true,
    preview = null,
    release = null,
    nfz = null,
    guidance = null,
    planNote = null,
  } = {}) {
    if (!this.ok || !this.enabled) return;
    const crane = state.cranes?.[activeCrane];
    if (!crane) return;
    this.#drawGauge(crane, spec, live);
    this.#drawMinimap(state, activeCrane, camera, scenario);
    this.#updateWind(state);
    this.#updateBanner(state, activeCrane, crane, live, nfz, planNote);
    this.#updateLabel(state, crane, camera, live, preview, release);
    this.#updateTargetArrow(camera, live, guidance);
    // 온보딩 카드 만료 (wall-clock — 배속 무관한 순수 연출)
    if (this.onboard && !this.onboard.hidden && Date.now() > this._onboardUntil) {
      this.onboard.hidden = true;
    }
  }

  /** 시나리오 로드 시 목표·조작 요약 카드 — 6초 후 자동 소멸 (Tier3) */
  showOnboarding(entry) {
    if (!this.ok || !entry) return;
    this.onboard.innerHTML =
      `<strong>${entry.name}</strong><span>${entry.desc ?? ''}</span>` +
      `<em>화살표 선회·기복 / Q·E 권상 / WASD 주행 / Space 픽업 / H 보조UI</em>`;
    this.onboard.hidden = false;
    this._onboardUntil = Date.now() + 6000;
  }

  // ── 하중률 게이지: 반경→정격 곡선 위 현재 작업점 ──
  #drawGauge(crane, spec, live) {
    const ctx = this.gaugeCanvas.getContext('2d');
    const W = this.gaugeCanvas.width;
    const H = this.gaugeCanvas.height;
    ctx.clearRect(0, 0, W, H);
    // 현재 붐길이 기준 정격 행 (2D 정격표는 최근접 붐길이 행)
    let rows = spec?.loadChart ?? [];
    if (spec?.capacityChart?.length) {
      const boom = crane.extra?.boomLength ?? spec.geometry?.boomLength;
      let bestRow = spec.capacityChart[0];
      for (const row of spec.capacityChart) {
        if (Math.abs(row[0] - boom) < Math.abs(bestRow[0] - boom)) bestRow = row;
      }
      rows = bestRow[1];
    }
    if (!rows.length) return;
    const rMin = rows[0][0];
    const rMax = rows[rows.length - 1][0];
    const capMax = Math.max(...rows.map(([, c]) => c));
    const px = (r) => 34 + ((r - rMin) / (rMax - rMin)) * (W - 44);
    const py = (c) => H - 26 - (c / capMax) * (H - 44);
    // 축·곡선
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.strokeRect(34, 12, W - 44, H - 38);
    ctx.beginPath();
    rows.forEach(([r, c], i) => (i === 0 ? ctx.moveTo(px(r), py(c)) : ctx.lineTo(px(r), py(c))));
    ctx.strokeStyle = '#7fa8cc';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    // 픽앤캐리 감격 곡선 (주행 인양 중 유효 정격 — 코어 getCapacity와 동일 계수)
    if (crane.extra?.carryDerated) {
      const factor = crane.extra.pickCarryFactor ?? 0.66;
      ctx.beginPath();
      rows.forEach(([r, c], i) => (i === 0 ? ctx.moveTo(px(r), py(c * factor)) : ctx.lineTo(px(r), py(c * factor))));
      ctx.strokeStyle = '#e0a53a';
      ctx.setLineDash([5, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffcf7a';
      ctx.font = '10px Consolas, monospace';
      ctx.fillText(`캐리 감격 ×${factor}`, W - 92, 10);
    }
    // 현재 하중 수평선
    const ratio = Number.isFinite(crane.loadRatio) ? crane.loadRatio : 1.2;
    const danger = crane.loadMass > 0 && ratio >= 1;
    const warn = crane.loadMass > 0 && ratio >= 0.8;
    if (crane.loadMass > 0) {
      ctx.strokeStyle = danger ? '#e04a34' : warn ? '#e0a53a' : '#3ecf6e';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(34, py(crane.loadMass));
      ctx.lineTo(W - 10, py(crane.loadMass));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // 현재 작업점 (반경, 정격)
    const cx = px(Math.min(Math.max(crane.radius, rMin), rMax));
    ctx.fillStyle = danger ? '#e04a34' : warn ? '#e0a53a' : '#8fd8a8';
    ctx.beginPath();
    ctx.arc(cx, py(crane.capacity), 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, 12);
    ctx.lineTo(cx, H - 26);
    ctx.stroke();
    ctx.setLineDash([]);
    // 코어가 산출한 정격 한계 반경 — UI는 x좌표로 투영만 한다.
    if (live && Number.isFinite(crane.limitRadius)) {
      const lx = px(Math.min(Math.max(crane.limitRadius, rMin), rMax));
      ctx.strokeStyle = '#e04a34';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(lx, 12);
      ctx.lineTo(lx, H - 26);
      ctx.stroke();
      ctx.fillStyle = '#ff8a76';
      ctx.textAlign = 'center';
      ctx.fillText('한계', lx, H - 29);
      ctx.textAlign = 'left';
    }
    // 라벨
    ctx.fillStyle = '#c8d2dc';
    ctx.font = '10px Consolas, monospace';
    ctx.fillText(`R ${crane.radius.toFixed(1)}m`, 34, H - 13);
    ctx.fillText(`정격 ${crane.capacity.toFixed(1)}t`, 96, H - 13);
    if (crane.loadMass > 0) {
      ctx.fillStyle = danger ? '#ff8a76' : warn ? '#ffcf7a' : '#9fe8b8';
      ctx.fillText(`하중 ${crane.loadMass.toFixed(1)}t (${(ratio * 100).toFixed(0)}%)`, 34, 10);
    } else {
      ctx.fillText('무부하', 34, 10);
    }
    // 전도 안전율: 계산은 코어 World.stabilityPreview만 담당하고 렌더는 값·색만 표시
    if (Number.isFinite(crane.stabilityFactor)) {
      const color = stabilityColor(crane.stabilityFactor);
      ctx.fillStyle = color;
      ctx.fillRect(34, H - 25, W - 44, 5);
      ctx.fillStyle = color;
      ctx.textAlign = 'right';
      ctx.fillText(`전도 SF ${crane.stabilityFactor.toFixed(2)}`, W - 10, 22);
      ctx.textAlign = 'left';
    }
    ctx.save();
    ctx.translate(10, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = 'rgba(200,210,220,0.6)';
    ctx.fillText('t', 0, 0);
    ctx.restore();
  }

  // ── 미니맵 (탑뷰): x→우, z→하 ──
  #drawMinimap(state, activeCrane, camera, scenario) {
    const ctx = this.mapCanvas.getContext('2d');
    const W = this.mapCanvas.width;
    const H = this.mapCanvas.height;
    ctx.clearRect(0, 0, W, H);
    // 범위: site 우선, 없으면 개체 바운딩
    const site = scenario?.site;
    let minX;
    let maxX;
    let minZ;
    let maxZ;
    if (site) {
      minX = site.minX ?? -(site.width ?? 100) / 2;
      maxX = minX + (site.width ?? 100);
      minZ = site.minZ ?? -(site.depth ?? 100) / 2;
      maxZ = minZ + (site.depth ?? 100);
    } else {
      const xs = [];
      const zs = [];
      for (const c of state.cranes) {
        xs.push(c.basePos[0]);
        zs.push(c.basePos[2]);
      }
      for (const l of state.loads) {
        xs.push(l.pos[0]);
        zs.push(l.pos[2]);
        if (l.target) {
          xs.push(l.target[0]);
          zs.push(l.target[1]);
        }
      }
      minX = Math.min(...xs, -30) - 8;
      maxX = Math.max(...xs, 30) + 8;
      minZ = Math.min(...zs, -30) - 8;
      maxZ = Math.max(...zs, 30) + 8;
    }
    const pad = 8;
    const scale = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxZ - minZ));
    const ox = (W - (maxX - minX) * scale) / 2;
    const oz = (H - (maxZ - minZ) * scale) / 2;
    const mx = (x) => ox + (x - minX) * scale;
    const mz = (z) => oz + (z - minZ) * scale;

    // 현장 경계
    ctx.strokeStyle = 'rgba(160,175,190,0.5)';
    ctx.strokeRect(mx(minX), mz(minZ), (maxX - minX) * scale, (maxZ - minZ) * scale);
    // 금지구역·장애물
    for (const z of state.noFlyZones ?? []) {
      ctx.fillStyle = 'rgba(216,64,42,0.25)';
      ctx.fillRect(mx(z.min[0]), mz(z.min[1]), (z.max[0] - z.min[0]) * scale, (z.max[1] - z.min[1]) * scale);
    }
    for (const o of state.obstacles ?? []) {
      ctx.fillStyle = 'rgba(140,148,158,0.55)';
      ctx.fillRect(mx(o.pos[0] - o.size[0] / 2), mz(o.pos[2] - o.size[2] / 2), o.size[0] * scale, o.size[2] * scale);
    }
    // 트럭
    for (const t of state.trucks ?? []) {
      if (!t.visible) continue;
      ctx.fillStyle = 'rgba(74,127,181,0.8)';
      ctx.fillRect(mx(t.pos[0]) - 2.5, mz(t.pos[1]) - 4, 5, 8);
    }
    // 부재·목표 (LoadView 팔레트 공유)
    state.loads.forEach((l, i) => {
      const color = css(PALETTE[i % PALETTE.length]);
      if (l.target && l.state !== 'placed') {
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(mx(l.target[0]), mz(l.target[1]), 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (l.state === 'pending') return;
      ctx.fillStyle = l.state === 'placed' ? 'rgba(200,208,216,0.5)' : color;
      ctx.fillRect(mx(l.pos[0]) - 2, mz(l.pos[2]) - 2, 4, 4);
    });
    // 에이전트
    for (const a of state.agents ?? []) {
      ctx.fillStyle = a.kind === 'vehicle' ? '#e0a53a' : '#f0e13a';
      ctx.beginPath();
      ctx.arc(mx(a.pos[0]), mz(a.pos[1]), a.kind === 'vehicle' ? 2.6 : 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
    // 크레인: 본체 + 붐 방위선 + 테일
    state.cranes.forEach((c, i) => {
      const active = i === activeCrane;
      const x = mx(c.basePos[0]);
      const z = mz(c.basePos[2]);
      const bx = Math.cos(c.slewAngle);
      const bz = Math.sin(c.slewAngle);
      ctx.strokeStyle = active ? '#3ecf6e' : 'rgba(217,161,26,0.9)';
      ctx.lineWidth = active ? 2 : 1.3;
      ctx.beginPath();
      ctx.moveTo(x - bx * 4, z - bz * 4); // 테일
      ctx.lineTo(x + bx * c.radius * scale, z + bz * c.radius * scale); // 붐(반경 스케일)
      ctx.stroke();
      ctx.fillStyle = active ? '#3ecf6e' : '#d9a11a';
      ctx.beginPath();
      ctx.arc(x, z, active ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1;
    });
    // 카메라 시야 부채꼴
    if (camera) {
      camera.getWorldDirection(_v);
      const yaw = Math.atan2(_v.z, _v.x);
      const cx = mx(camera.position.x);
      const cz = mz(camera.position.z);
      ctx.fillStyle = 'rgba(233,238,245,0.14)';
      ctx.beginPath();
      ctx.moveTo(cx, cz);
      ctx.arc(cx, cz, 20, yaw - 0.45, yaw + 0.45);
      ctx.closePath();
      ctx.fill();
    }
  }

  #updateWind(state) {
    const wind = state.wind;
    this.windBox.hidden = !wind;
    if (!wind) return;
    // 미니맵 좌표계(x→우, z→하)와 동일 기준 — dir(rad)을 그대로 회전
    this.windArrow.style.transform = `rotate(${wind.dir ?? 0}rad)`;
    const over = wind.maxOperating && wind.speed > wind.maxOperating;
    this.windArrow.style.color = over ? '#e04a34' : wind.speed > (wind.maxOperating ?? Infinity) * 0.8 ? '#e0a53a' : '#8fc8e8';
    this.windText.textContent = `${wind.speed.toFixed(1)}m/s${wind.maxOperating ? ` / ${wind.maxOperating}` : ''}`;
  }

  // ── 상태 배너: 우선순위 1개만 (홀드 > 리미터 > NFZ 접근 > 리깅 > 풍속) ──
  #updateBanner(state, activeCrane, crane, live, nfz, planNote = null) {
    // 계획 재생 중에는 활성 계획 이벤트 주석이 배너를 대신한다 (Tier3)
    const { html, cls } =
      !live && planNote
        ? { html: `▶ ${planNote}`, cls: 'work' }
        : selectBanner(state, activeCrane, crane, live, nfz);
    if (html !== this._lastBanner) {
      this._lastBanner = html;
      this.banner.hidden = !html;
      if (html) {
        this.banner.innerHTML = html;
        this.banner.className = `ov-banner ${cls}`;
      }
    } else if (html && html.includes('ov-progress')) {
      this.banner.innerHTML = html; // 진행 바는 매 프레임 갱신
    }
  }

  #updateTargetArrow(camera, live, guidance) {
    if (!live || !camera || !guidance?.pos) {
      this.targetArrow.hidden = true;
      return;
    }
    const edge = projectEdgeArrow(guidance.pos, camera, window.innerWidth, window.innerHeight);
    this.targetArrow.hidden = !edge;
    if (!edge) return;
    this.targetArrow.style.left = `${edge.x}px`;
    this.targetArrow.style.top = `${edge.y}px`;
    this.targetArrow.style.transform = `translate(-50%, -50%) rotate(${edge.angle}rad)`;
    this.targetArrow.className = `ov-target-arrow ${guidance.kind}`;
  }

  // ── 후크/부재 거리 라벨 (월드→스크린 투영) ──
  #updateLabel(state, crane, camera, live, preview, release) {
    let text = null;
    let anchor = null;
    let cls = '';
    if (live && camera) {
      if (release?.held?.target) {
        text = release.onTarget
          ? release.canRelease
            ? '안착 가능 — Space'
            : `내리세요 · 바닥까지 ${release.bottomGap.toFixed(1)}m`
          : `목표까지 ${release.err.toFixed(1)}m`;
        cls = release.onTarget && release.canRelease ? 'ok' : release.onTarget ? 'near' : '';
        anchor = [release.held.pos[0], release.held.pos[1] + release.held.size[1] / 2 + 1.2, release.held.pos[2]];
      } else if (!release && preview?.load) {
        text = preview.ok
          ? '픽업 가능 — Space'
          : `수평 ${preview.horiz.toFixed(1)}m${preview.horizOk ? '' : '✕'} · 수직 ${preview.vert.toFixed(1)}m${preview.vertOk ? '' : '✕'}`;
        cls = preview.ok ? 'ok' : preview.horizOk ? 'near' : '';
        anchor = crane.hookPos;
      }
    }
    if (!text) {
      if (this._lastLabel !== null) {
        this._lastLabel = null;
        this.label.hidden = true;
      }
      return;
    }
    _v.set(anchor[0], anchor[1], anchor[2]).project(camera);
    if (_v.z > 1) {
      this.label.hidden = true;
      this._lastLabel = null;
      return;
    }
    // 대시보드(우측 368px)와 화면 밖으로 침범하지 않게 클램프
    const x = Math.min(((_v.x + 1) / 2) * window.innerWidth, window.innerWidth - 560);
    const y = Math.max(((-_v.y + 1) / 2) * window.innerHeight, 40);
    this.label.style.left = `${x + 14}px`;
    this.label.style.top = `${y - 10}px`;
    if (text !== this._lastLabel) {
      this._lastLabel = text;
      this.label.hidden = false;
      this.label.textContent = text;
      this.label.className = `ov-label ${cls}`;
    }
  }
}
