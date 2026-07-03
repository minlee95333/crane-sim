export class Dashboard {
  constructor(root, scenarios, handlers) {
    this.root = root;
    this.scenarios = scenarios;
    this.handlers = handlers;
    this.command = { slew: 0, luff: 0, hoist: 0 };
    this.render();
    this.bind();
  }

  render() {
    this.root.innerHTML = `
      <header class="dash-head">
        <h1 class="dash-title">Crane Control</h1>
        <p class="dash-subtitle"><span class="status-dot" data-status-dot></span><span data-status>시뮬레이션 실행 중</span></p>
      </header>

      <section class="dash-section">
        <label class="dash-label" for="scenario-select">시나리오</label>
        <select class="dash-select" id="scenario-select">
          ${this.scenarios.map((s, i) => `<option value="${i}">${s.name}</option>`).join('')}
        </select>
        <div class="dash-row" style="margin-top:8px">
          <button class="dash-btn" data-action="pause">⏸ 일시정지</button>
          <button class="dash-btn warn" data-action="reset">↺ 초기화</button>
        </div>
      </section>

      <section class="dash-section">
        <span class="dash-label">시뮬레이션 속도</span>
        <div class="speed-grid">
          ${[1, 5, 10, 20].map((v) => `<button class="dash-btn" data-speed="${v}">×${v}</button>`).join('')}
        </div>
      </section>

      <section class="dash-section">
        <label class="dash-label" for="crane-select">제어 크레인</label>
        <select class="dash-select" id="crane-select"></select>
      </section>

      <section class="dash-section">
        <span class="dash-label">수동 제어 · 누르고 있는 동안 작동</span>
        <div class="control-grid">
          <button class="dash-btn" data-control="slew" data-value="-1">↶ 좌선회</button>
          <button class="dash-btn" data-control="slew" data-value="1">↷ 우선회</button>
          <button class="dash-btn" data-control="luff" data-value="-1">붐 올림 / 안쪽</button>
          <button class="dash-btn" data-control="luff" data-value="1">붐 내림 / 바깥</button>
          <button class="dash-btn" data-control="hoist" data-value="1">↑ 권상</button>
          <button class="dash-btn" data-control="hoist" data-value="-1">↓ 권하</button>
        </div>
        <button class="dash-btn primary" data-action="attach" style="width:100%;margin-top:8px">픽업 / 해제</button>
      </section>

      <section class="dash-section">
        <span class="dash-label">실시간 상태</span>
        <div class="metrics">
          <div class="metric"><div class="metric-name">시간</div><div class="metric-value" data-metric="time">0.0 s</div></div>
          <div class="metric"><div class="metric-name">작업 반경</div><div class="metric-value" data-metric="radius">-</div></div>
          <div class="metric"><div class="metric-name">후크 높이</div><div class="metric-value" data-metric="hook">-</div></div>
          <div class="metric"><div class="metric-name">하중률</div><div class="metric-value" data-metric="load">-</div></div>
          <div class="metric"><div class="metric-name">완료</div><div class="metric-value" data-metric="progress">0 / 0</div></div>
          <div class="metric"><div class="metric-name">안전 상태</div><div class="metric-value safe" data-metric="safety">정상</div></div>
        </div>
      </section>

      <section class="dash-section">
        <span class="dash-label">전체 양중 계획</span>
        <div class="dash-row">
          <select class="dash-select" id="plan-policy">
            <option value="earliestFinish">최단 종료시간</option>
            <option value="radiusPriority">동일 셋업 우선</option>
            <option value="nearest">최단 이동거리</option>
          </select>
          <button class="dash-btn primary" data-action="plan">계획 생성</button>
        </div>
        <button class="dash-btn" data-action="planPlay" data-plan-play disabled style="width:100%;margin-top:8px">▶ 3D 계획 재생</button>
        <div class="dash-row" style="margin-top:8px">
          <select class="dash-select" id="plan-speed" disabled>
            <option value="60">재생 ×60</option>
            <option value="300" selected>재생 ×300</option>
            <option value="600">재생 ×600</option>
          </select>
          <button class="dash-btn" data-action="planReset" data-plan-reset disabled>처음으로</button>
        </div>
        <input class="plan-seek" data-plan-seek type="range" min="0" max="1" value="0" step="1" disabled />
        <div class="plan-summary" data-plan-summary>계획을 생성하면 전체 시간축이 표시됩니다.</div>
        <div class="gantt" data-gantt></div>
        <div class="plan-editor" data-plan-editor></div>
      </section>

      <section class="dash-section">
        <span class="dash-label">기록</span>
        <div class="dash-row">
          <button class="dash-btn" data-action="record">● 기록 시작</button>
          <button class="dash-btn" data-action="replay">▶ 리플레이</button>
        </div>
      </section>

      <section class="dash-section">
        <span class="dash-label">최근 이벤트</span>
        <div class="event-box" data-event>-</div>
      </section>
    `;
  }

  bind() {
    this.root.querySelector('#scenario-select').addEventListener('change', (e) => {
      this.handlers.scenario(Number(e.target.value));
    });
    this.root.querySelector('#crane-select').addEventListener('change', (e) => {
      this.handlers.crane(Number(e.target.value));
    });
    this.root.querySelectorAll('[data-speed]').forEach((button) => {
      button.addEventListener('click', () => this.handlers.speed(Number(button.dataset.speed)));
    });
    this.root.querySelector('#plan-speed').addEventListener('change', (e) => {
      this.handlers.planSpeed?.(Number(e.target.value));
    });
    this.root.querySelector('[data-plan-seek]').addEventListener('input', (e) => {
      this.handlers.planSeek?.(Number(e.target.value));
    });
    this.root.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => this.handlers[button.dataset.action]?.());
    });

    const release = () => {
      this.command = { slew: 0, luff: 0, hoist: 0 };
      this.root.querySelectorAll('[data-control]').forEach((b) => b.classList.remove('is-active'));
    };
    this.root.querySelectorAll('[data-control]').forEach((button) => {
      const press = (e) => {
        e.preventDefault();
        release();
        this.command[button.dataset.control] = Number(button.dataset.value);
        button.classList.add('is-active');
      };
      button.addEventListener('pointerdown', press);
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('pointerleave', release);
    });
    window.addEventListener('pointerup', release);
    window.addEventListener('blur', release);
    this.root.querySelector('[data-plan-editor]').addEventListener('click', (e) => {
      const pick = e.target.closest('[data-plan-pick]');
      if (pick) {
        this.handlers.requestSetupPick?.(Number(pick.dataset.index));
        pick.textContent = '3D 지면 더블클릭…';
        return;
      }
      const button = e.target.closest('[data-plan-move]');
      if (!button || !this.editablePlan) return;
      const index = Number(button.dataset.index);
      const direction = Number(button.dataset.planMove);
      const item = this.editablePlan[index];
      const peers = this.editablePlan
        .map((entry, i) => ({ entry, i }))
        .filter(({ entry }) => entry.craneId === item.craneId);
      const peerAt = peers.findIndex((peer) => peer.i === index);
      const target = peers[peerAt + direction];
      if (!target) return;
      [this.editablePlan[index], this.editablePlan[target.i]] = [this.editablePlan[target.i], this.editablePlan[index]];
      this.handlers.manualPlan?.(this.editablePlan.map((entry) => ({ ...entry })));
    });
    this.root.querySelector('[data-plan-editor]').addEventListener('change', (e) => {
      const setup = e.target.closest('[data-plan-setup]');
      if (setup && this.editablePlan) {
        const index = Number(setup.dataset.index);
        const alternative = this.setupAlternatives?.[index]?.[Number(setup.value)];
        if (!alternative) return;
        this.editablePlan[index].setupPos = [...alternative.pos];
        this.editablePlan[index].boomLength = alternative.boomLength;
        this.handlers.manualPlan?.(this.editablePlan.map((entry) => ({ ...entry })));
        return;
      }
      const select = e.target.closest('[data-plan-crane]');
      if (!select || !this.editablePlan) return;
      this.editablePlan[Number(select.dataset.index)].craneId = select.value;
      delete this.editablePlan[Number(select.dataset.index)].setupPos;
      delete this.editablePlan[Number(select.dataset.index)].boomLength;
      this.handlers.manualPlan?.(this.editablePlan.map((entry) => ({ ...entry })));
    });
  }

  getCommand() {
    return { ...this.command };
  }

  getPlanPolicy() {
    return this.root.querySelector('#plan-policy').value;
  }

  setPlanResult(result) {
    const summary = this.root.querySelector('[data-plan-summary]');
    const gantt = this.root.querySelector('[data-gantt]');
    if (!result) {
      summary.textContent = '계획을 생성하면 전체 시간축이 표시됩니다.';
      gantt.innerHTML = '';
      this.root.querySelector('[data-plan-play]').disabled = true;
      this.root.querySelector('[data-plan-reset]').disabled = true;
      this.root.querySelector('#plan-speed').disabled = true;
      this.root.querySelector('[data-plan-seek]').disabled = true;
      this.root.querySelector('[data-plan-editor]').innerHTML = '';
      this.editablePlan = null;
      return;
    }
    this.root.querySelector('[data-plan-play]').disabled = false;
    this.root.querySelector('[data-plan-reset]').disabled = false;
    this.root.querySelector('#plan-speed').disabled = false;
    const seek = this.root.querySelector('[data-plan-seek]');
    seek.disabled = false;
    seek.max = String(Math.ceil(result.makespan));
    seek.value = '0';
    const minutes = result.makespan / 60;
    const validation = result.validation3D;
    const validationText = validation
      ? validation.valid
        ? ' · 3D 검증 정상'
        : ` · 3D 충돌 ${validation.violations.length}구간`
      : '';
    const repairText = result.repairs?.length ? ` · 자동수정 ${result.repairs.length}회` : '';
    summary.innerHTML =
      `<strong>${result.completed}/${result.total}건 완료 · ${minutes.toFixed(1)}분</strong>` +
      `<span>이동 ${result.perCrane.reduce((s, c) => s + c.travelDistance, 0).toFixed(0)}m · ` +
      `soft 간섭 ${result.softConflicts} · 실패 ${result.failed.length}${repairText}${validationText}</span>` +
      (validation && !validation.valid
        ? `<span class="validation-danger">${Object.entries(validation.byType).map(([type, count]) => `${type} ${count}`).join(' · ')}</span>`
        : '');
    const max = Math.max(1, result.makespan);
    gantt.innerHTML = result.perCrane.map((crane) => {
      const events = result.events.filter((e) => e.craneId === crane.craneId);
      const bars = events.map((e) => {
        const left = (e.start / max) * 100;
        const width = Math.max(0.7, (e.duration / max) * 100);
        return `<span class="gantt-bar ${e.type}" style="left:${left}%;width:${width}%" title="${e.type} · ${e.loadId ?? '최종'} · ${(e.duration / 60).toFixed(1)}분"></span>`;
      }).join('');
      return `<div class="gantt-lane"><span class="gantt-name">${crane.craneId}</span><div class="gantt-track">${bars}</div></div>`;
    }).join('');
    this.editablePlan = (result.manualPlan ?? [...result.assignments]
      .sort((a, b) => a.craneId.localeCompare(b.craneId) || a.liftStart - b.liftStart)
      .map((assignment) => ({
        craneId: assignment.craneId,
        loadId: assignment.loadId,
        setupPos: [...assignment.setupPos],
        boomLength: assignment.boomLength,
      })))
      .map((item) => ({ ...item }));
    this.setupAlternatives = {};
    for (let index = 0; index < this.editablePlan.length; index++) {
      const item = this.editablePlan[index];
      const assignment = result.assignments.find((a) => a.craneId === item.craneId && a.loadId === item.loadId);
      const current = assignment
        ? [{ pos: assignment.setupPos, boomLength: assignment.boomLength, move: assignment.move, capacityMargin: assignment.capacityMargin }]
        : [];
      const alternatives = assignment?.setupAlternatives ?? [];
      this.setupAlternatives[index] = [...current, ...alternatives].filter((candidate, i, all) =>
        all.findIndex((other) =>
          Math.hypot(other.pos[0] - candidate.pos[0], other.pos[1] - candidate.pos[1]) < 0.1 &&
          other.boomLength === candidate.boomLength
        ) === i
      ).slice(0, 5);
    }
    this.#renderPlanEditor(result);
  }

  applySetupPoint(index, pos) {
    if (!this.editablePlan?.[index]) return;
    this.editablePlan[index].setupPos = [...pos];
    this.handlers.manualPlan?.(this.editablePlan.map((entry) => ({ ...entry })));
  }

  showPlanError(message) {
    this.root.querySelector('[data-plan-summary]').innerHTML =
      `<strong class="validation-danger">계획 수정 불가</strong><span>${message}</span>`;
  }

  setPlanPlayback(playing, time = 0, makespan = 0) {
    const button = this.root.querySelector('[data-plan-play]');
    button.textContent = playing
      ? `■ 3D 재생 정지 · ${(time / 60).toFixed(1)}/${(makespan / 60).toFixed(1)}분`
      : `▶ 3D 계획 재생 · ${(time / 60).toFixed(1)}/${(makespan / 60).toFixed(1)}분`;
    this.root.querySelector('[data-plan-seek]').value = String(Math.round(time));
  }

  setScenario(index) {
    this.root.querySelector('#scenario-select').value = String(index);
  }

  setCranes(cranes, active) {
    const select = this.root.querySelector('#crane-select');
    select.innerHTML = cranes
      .map((c, i) => `<option value="${i}">${i + 1}. ${c.name ?? c.type}</option>`)
      .join('');
    select.value = String(active);
  }

  setActiveCrane(index) {
    this.root.querySelector('#crane-select').value = String(index);
  }

  update(state, activeCrane, ui) {
    const crane = state.cranes[activeCrane];
    const safety = state.safety ?? {};
    const targets = state.loads.filter((l) => l.target);
    const placed = targets.filter((l) => l.state === 'placed').length;
    const unsafe =
      (safety.collisionIds?.length ?? 0) > 0 ||
      safety.zoneViolation ||
      (safety.cranePairs ?? []).some((p) => p.clash) ||
      crane.extra.limiterActive;

    this.#text('time', `${state.time.toFixed(1)} s`);
    this.#text('radius', `${crane.radius.toFixed(1)} m`);
    this.#text('hook', `${crane.hookHeight.toFixed(1)} m`);
    this.#text('load', crane.loadMass > 0 ? `${(crane.loadRatio * 100).toFixed(0)} %` : '-');
    this.#text('progress', `${placed} / ${targets.length}`);
    this.#text('safety', unsafe ? '주의' : '정상');
    const safetyEl = this.root.querySelector('[data-metric="safety"]');
    safetyEl.classList.toggle('safe', !unsafe);
    safetyEl.classList.toggle('danger', unsafe);
    this.root.querySelector('[data-event]').textContent = state.lastEvent ?? '-';

    this.root.querySelectorAll('[data-speed]').forEach((button) => {
      button.classList.toggle('is-selected', Number(button.dataset.speed) === ui.speed);
    });
    const pause = this.root.querySelector('[data-action="pause"]');
    pause.textContent = ui.paused ? '▶ 계속' : '⏸ 일시정지';
    const record = this.root.querySelector('[data-action="record"]');
    record.textContent = ui.recording ? '■ 기록 종료' : '● 기록 시작';
    this.root.querySelector('[data-action="replay"]').disabled = !ui.canReplay || ui.recording;

    const dot = this.root.querySelector('[data-status-dot]');
    dot.className = `status-dot${ui.recording ? ' recording' : ui.paused ? ' paused' : ''}`;
    this.root.querySelector('[data-status]').textContent =
      ui.recording ? '작업 기록 중' : ui.playing ? '리플레이 재생 중' : ui.paused ? '일시정지됨' : '시뮬레이션 실행 중';
  }

  #text(name, value) {
    this.root.querySelector(`[data-metric="${name}"]`).textContent = value;
  }

  #renderPlanEditor(result) {
    const root = this.root.querySelector('[data-plan-editor]');
    const craneIds = result.perCrane.map((crane) => crane.craneId);
    root.innerHTML = craneIds.map((craneId) => {
      const jobs = this.editablePlan
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.craneId === craneId);
      return `<div class="queue-lane">
        <div class="queue-title">${craneId}<span>${jobs.length}건</span></div>
        ${jobs.map(({ item, index }, order) => `<div class="queue-item">
          <span class="queue-order">${order + 1}</span>
          <strong>${item.loadId}</strong>
          <select data-plan-crane data-index="${index}">
            ${craneIds.map((id) => `<option value="${id}"${id === item.craneId ? ' selected' : ''}>${id}</option>`).join('')}
          </select>
          <button data-plan-move="-1" data-index="${index}" title="앞으로">↑</button>
          <button data-plan-move="1" data-index="${index}" title="뒤로">↓</button>
          <div class="setup-editor">
            <select data-plan-setup data-index="${index}" title="추천 셋업 후보">
              ${(this.setupAlternatives?.[index] ?? []).map((candidate, candidateIndex) =>
                `<option value="${candidateIndex}">[${candidate.pos.map((v) => v.toFixed(0)).join(',')}] · 붐 ${candidate.boomLength}m · 이동 ${candidate.move.toFixed(0)}m · 여유 ${candidate.capacityMargin.toFixed(1)}t</option>`
              ).join('')}
            </select>
            <button data-plan-pick data-index="${index}">3D에서 셋업 선택</button>
          </div>
        </div>`).join('') || '<div class="queue-empty">배정 없음</div>'}
      </div>`;
    }).join('');
  }
}
