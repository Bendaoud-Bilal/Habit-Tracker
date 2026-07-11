/* ============================================================
   HABIT TRACKER — APPLICATION LOGIC (Live Notion Sync)
   ------------------------------------------------------------
   Difference from the original localStorage version:
   - No localStorage read/write anywhere. On load, state comes
     from GET /api/data (which the backend fills from Notion).
   - Every checkbox toggle POSTs to /api/toggle, which writes the
     change straight to the corresponding Notion page.
   - Every notes edit POSTs to /api/notes.
   - Habit add/edit/delete UI is removed: habit columns are
     managed in Notion directly (adding a checkbox property there
     is the equivalent of the old "Add Habit" form), so the
     backend's schema detection just picks them up automatically
     on next load.
   - Notion has no native "habit weight" concept (checkbox
     properties don't carry a numeric weight), so weights default
     to 1 for every habit here. If you want weighted habits back,
     the cleanest option is a small local weights.json the server
     merges in by habit name — ask if you'd like that added.
   ============================================================ */

(function () {
  'use strict';

  const HABIT_EMOJIS = ['💤', '😌', '📱', '✍️', '💧', '💻', '💪', '📖', '🚶', '📋', '✨', '🔥', '🚀', '🧠', '🌿'];
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Hardcoded milestone ladder — same as the old data/streaks.json
  // seed. This is UI-only configuration (not user data), so it's
  // fine to keep it static rather than round-tripping through Notion.
  const STREAK_MILESTONES = [
    { name: 'First Streak', targetDays: 20, reward: '🎯 Amazing start! You\'ve built a solid foundation.' },
    { name: 'Consistency Master', targetDays: 30, reward: '🔥 One month strong! You\'re unstoppable.' },
    { name: 'Habit Warrior', targetDays: 50, reward: '💪 50 days of excellence! You\'re a legend.' },
    { name: 'Discipline Champion', targetDays: 60, reward: '⚡ 60 days! Nothing can stop you now.' },
    { name: 'Elite Performer', targetDays: 75, reward: '👑 75 days! You\'re in the top 1%.' },
    { name: 'Transformation Complete', targetDays: 90, reward: '💎 90 days! You\'ve transformed your life.' },
    { name: 'Century Club', targetDays: 100, reward: '🏆 100+ Days! Absolute legend status!' },
  ];

  let state = {
    habits: [],           // { name: string, weight: number } — weight always 1, see note above
    entries: {},           // key: 'YYYY-MM-DD' → { habits: [bool×N], notes: string }
    currentMonth: new Date().getMonth(),
    currentYear: new Date().getFullYear(),
  };

  let charts = { trend: null, donut: null, bar: null };
  let loaded = false;
  let pendingToggles = 0;
  let editingHabitIdx = null;

  document.addEventListener('DOMContentLoaded', async () => {
    await loadData();
    setupListeners();
    renderAll();
  });

  function setupListeners() {
    const form = document.getElementById('add-habit-form');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('new-habit-name');
      const impInput = document.getElementById('new-habit-importance');
      const name = nameInput.value.trim();
      const weight = parseFloat(impInput.value);
      if (!name) return;

      const btn = document.getElementById('add-habit-btn');
      btn.disabled = true;

      try {
        if (editingHabitIdx !== null) {
          const oldName = state.habits[editingHabitIdx].name;
          const res = await fetch(`/api/habits/${encodeURIComponent(oldName)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newName: name, weight }),
          });
          if (!res.ok) throw new Error((await safeJson(res))?.error || 'Failed to update habit.');
          editingHabitIdx = null;
          btn.textContent = 'Add';
        } else {
          const res = await fetch('/api/habits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, weight }),
          });
          if (!res.ok) throw new Error((await safeJson(res))?.error || 'Failed to add habit.');
        }
        nameInput.value = '';
        impInput.value = '1';
        setSyncStatus('Reloading from Notion…', null);
        await loadData();
        renderAll();
      } catch (err) {
        console.error(err);
        setSyncStatus(`Couldn't save habit: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  window.editHabit = function (idx) {
    editingHabitIdx = idx;
    const h = state.habits[idx];
    document.getElementById('new-habit-name').value = h.name;
    document.getElementById('new-habit-importance').value = h.weight;
    document.getElementById('add-habit-btn').textContent = 'Save';
    document.getElementById('new-habit-name').focus();
  };

  window.deleteHabit = async function (idx) {
    const h = state.habits[idx];
    if (!confirm(`Delete "${h.name}"? This removes the column and ALL historical data for it in Notion — this cannot be undone.`)) {
      return;
    }
    try {
      setSyncStatus('Deleting habit in Notion…', null);
      const res = await fetch(`/api/habits/${encodeURIComponent(h.name)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await safeJson(res))?.error || 'Failed to delete habit.');
      if (editingHabitIdx === idx) {
        editingHabitIdx = null;
        document.getElementById('add-habit-btn').textContent = 'Add';
        document.getElementById('new-habit-name').value = '';
      }
      await loadData();
      renderAll();
    } catch (err) {
      console.error(err);
      setSyncStatus(`Couldn't delete habit: ${err.message}`, 'error');
    }
  };

  // ── Data Loading (Notion via backend) ─────────────────────
  async function loadData() {
    setSyncStatus('Loading from Notion…', null);
    try {
      const res = await fetch('/api/data');
      if (!res.ok) {
        const body = await safeJson(res);
        throw new Error((body && body.error) || `Request failed (${res.status})`);
      }
      const data = await res.json();

      state.habits = data.habitNames.map((name, i) => ({
        name,
        weight: (data.habitWeights && typeof data.habitWeights[i] === 'number') ? data.habitWeights[i] : 1,
      }));
      state.entries = {};
      for (const e of data.entries) {
        state.entries[e.date] = { habits: e.habits, notes: e.notes || '' };
      }

      loaded = true;
      setSyncStatus(`Synced with Notion · ${data.entries.length} day(s) loaded`, 'ok');
    } catch (err) {
      console.error('Failed to load data from Notion:', err);
      loaded = false;
      state.habits = [];
      state.entries = {};
      setSyncStatus(
        `Couldn't reach Notion: ${err.message}. Check that the server is running and .env is configured, then refresh.`,
        'error'
      );
    }
  }

  function setSyncStatus(text, kind) {
    const banner = document.getElementById('sync-status');
    const textEl = document.getElementById('sync-status-text');
    if (!banner || !textEl) return;
    banner.style.display = 'block';
    banner.classList.remove('ok', 'error');
    if (kind) banner.classList.add(kind);
    textEl.textContent = text;
  }

  async function safeJson(res) {
    try { return await res.json(); } catch (_) { return null; }
  }

  // ── Helpers (unchanged math from the original app.js) ─────
  function dateKey(y, m, d) {
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function getEntry(key) {
    if (!state.entries[key]) {
      state.entries[key] = { habits: new Array(state.habits.length).fill(false), notes: '' };
    }
    return state.entries[key];
  }

  function calcPercent(habitsArr) {
    let maxScore = 0;
    let actualScore = 0;
    for (let i = 0; i < state.habits.length; i++) {
      const w = state.habits[i].weight || 1;
      maxScore += w;
      if (habitsArr[i]) actualScore += w;
    }
    if (maxScore === 0) return 0;
    return Math.round((actualScore / maxScore) * 100);
  }

  function getHeatLevel(pct) {
    if (pct === 0) return 0;
    if (pct <= 20) return 1;
    if (pct <= 40) return 2;
    if (pct <= 60) return 3;
    if (pct <= 84) return 4;
    return 5;
  }

  function getStatusClass(pct) {
    if (pct === 0) return 'status-empty';
    if (pct <= 30) return 'status-low';
    if (pct <= 60) return 'status-mid';
    if (pct <= 80) return 'status-good';
    if (pct < 100) return 'status-great';
    return 'status-perfect';
  }

  function getStatusText(pct) {
    if (pct === 0) return '📝 Start logging';
    if (pct <= 30) return '🔴 Keep pushing';
    if (pct <= 60) return '🟡 Getting there';
    if (pct <= 80) return '🔵 Great work';
    if (pct < 100) return '🟢 Almost perfect';
    return '🟣 Perfect day!';
  }

  function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }

  function getWeekDates() {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - dayOfWeek + i);
      dates.push(d);
    }
    return dates;
  }

  // ── Render All ──────────────────────────────────────────────
  function renderAll() {
    updateTableHeaders();
    renderMonthNav();
    renderWeekOverview();
    renderMonthOverview();
    renderHabitList();
    renderHeatMap();
    renderStreakMilestones();
    updateAnalytics();
  }

  function updateTableHeaders() {
    const ths = state.habits.map((h, i) => {
      const emoji = HABIT_EMOJIS[i % HABIT_EMOJIS.length] || '✨';
      const imp = h.weight === 2 ? '<span style="color:var(--accent-purple)">(H)</span>' :
                  h.weight === 0.5 ? '<span style="color:var(--accent-blue)">(L)</span>' : '';
      return `<th>${emoji} ${imp}</th>`;
    }).join('');

    const renderHeader = (id) => {
      const table = document.getElementById(id);
      if (table) {
        const thead = table.querySelector('thead tr');
        thead.innerHTML = `<th>Date</th><th>Progress</th>${ths}<th>Status</th><th>Notes</th>`;
      }
    };
    renderHeader('week-table');
    renderHeader('month-table');
  }

  // ── Month Navigation ────────────────────────────────────────
  window.prevMonth = function () {
    state.currentMonth--;
    if (state.currentMonth < 0) { state.currentMonth = 11; state.currentYear--; }
    renderMonthNav();
    renderMonthOverview();
    renderHeatMap();
    updateAnalytics();
  };

  window.nextMonth = function () {
    state.currentMonth++;
    if (state.currentMonth > 11) { state.currentMonth = 0; state.currentYear++; }
    renderMonthNav();
    renderMonthOverview();
    renderHeatMap();
    updateAnalytics();
  };

  function renderMonthNav() {
    const label = document.getElementById('month-label');
    if (label) label.textContent = `${MONTHS[state.currentMonth]} ${state.currentYear}`;
  }

  // ── Overviews ───────────────────────────────────────────────
  function generateTableRow(dKey, displayDate, isToday) {
    const entry = getEntry(dKey);
    const pct = calcPercent(entry.habits);
    const disabledAttr = loaded ? '' : 'disabled';

    let html = `<tr class="${isToday ? 'today-row' : ''}">`;
    html += `<td style="${isToday ? 'color: var(--accent-purple); font-weight: 700;' : ''}">${displayDate}</td>`;
    html += `<td class="progress-cell"><div class="progress-bar-mini">
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span class="progress-text">${pct}%</span>
    </div></td>`;

    for (let h = 0; h < state.habits.length; h++) {
      html += `<td><input type="checkbox" class="habit-checkbox" ${disabledAttr}
        ${entry.habits[h] ? 'checked' : ''}
        data-date="${dKey}" data-habit="${h}"
        onchange="window.toggleHabit(this)"></td>`;
    }

    html += `<td><span class="daily-status ${getStatusClass(pct)}">${getStatusText(pct)}</span></td>`;
    html += `<td><input type="text" class="notes-input" ${disabledAttr} value="${entry.notes.replace(/"/g, '&quot;')}"
      data-date="${dKey}" placeholder="—" onchange="window.updateNotes(this)"></td>`;
    html += '</tr>';
    return html;
  }

  function renderWeekOverview() {
    const tbody = document.getElementById('week-tbody');
    if (!tbody) return;
    const weekDates = getWeekDates();
    tbody.innerHTML = weekDates.map(d => {
      const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate());
      const display = `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
      const isToday = d.toDateString() === new Date().toDateString();
      return generateTableRow(key, display, isToday);
    }).join('');
  }

  function renderMonthOverview() {
    const tbody = document.getElementById('month-tbody');
    if (!tbody) return;
    const days = daysInMonth(state.currentYear, state.currentMonth);
    const today = new Date();
    let html = '';
    for (let d = 1; d <= days; d++) {
      const key = dateKey(state.currentYear, state.currentMonth, d);
      const display = `${MONTHS[state.currentMonth].slice(0, 3)} ${d}`;
      const isToday = d === today.getDate() && state.currentMonth === today.getMonth() && state.currentYear === today.getFullYear();
      html += generateTableRow(key, display, isToday);
    }
    tbody.innerHTML = html;
  }

  // ── Habit List (read-only — managed in Notion, not here) ──────
  function renderHabitList() {
    const container = document.getElementById('habit-list-grid');
    if (!container) return;

    if (state.habits.length === 0) {
      container.innerHTML = `<div class="habit-list-item">No habits found — add one below, or add a Checkbox column in Notion directly and refresh.</div>`;
      return;
    }

    container.innerHTML = state.habits.map((h, i) => {
      const emoji = HABIT_EMOJIS[i % HABIT_EMOJIS.length] || '✨';
      const badgeClass = h.weight === 2 ? 'high' : (h.weight === 0.5 ? 'low' : '');
      const badgeLabel = h.weight === 2 ? 'High' : (h.weight === 0.5 ? 'Low' : 'Norm');
      return `<div class="habit-list-item">
        <span class="emoji">${emoji}</span>
        <span>${h.name}</span>
        <span class="habit-badge ${badgeClass}">${badgeLabel}</span>
        <div class="habit-actions">
           <button type="button" class="icon-btn edit-btn" onclick="editHabit(${i})" title="Edit">✏️</button>
           <button type="button" class="icon-btn delete-btn" onclick="deleteHabit(${i})" title="Delete">🗑️</button>
        </div>
      </div>`;
    }).join('');
  }

  // ── Heat Map ────────────────────────────────────────────────
  function renderHeatMap() {
    const container = document.getElementById('heatmap-grid');
    if (!container) return;

    const year = state.currentYear;
    const month = state.currentMonth;
    const days = daysInMonth(year, month);
    const firstDay = new Date(year, month, 1).getDay();

    let html = '<div class="heatmap-week-label"></div>';
    for (const dl of DAYS_SHORT) html += `<div class="heatmap-day-label">${dl}</div>`;

    let currentWeek = 1;
    html += `<div class="heatmap-week-label">W${currentWeek}</div>`;

    for (let i = 0; i < firstDay; i++) html += '<div class="heatmap-cell empty"></div>';

    for (let d = 1; d <= days; d++) {
      const key = dateKey(year, month, d);
      const entry = state.entries[key];
      const pct = entry ? calcPercent(entry.habits) : 0;
      const level = getHeatLevel(pct);
      const dayOfWeek = (firstDay + d - 1) % 7;

      if (dayOfWeek === 0 && d > 1) {
        currentWeek++;
        html += `<div class="heatmap-week-label">W${currentWeek}</div>`;
      }

      html += `<div class="heatmap-cell level-${level}"
        data-tooltip="${MONTHS[month].slice(0, 3)} ${d}: ${pct}%">${pct > 0 ? pct : ''}</div>`;
    }

    const lastDayOfWeek = (firstDay + days - 1) % 7;
    for (let i = lastDayOfWeek + 1; i < 7; i++) html += '<div class="heatmap-cell empty"></div>';

    container.innerHTML = html;
  }

  // ── Streak Milestones ──────────────────────────────────────
  function renderStreakMilestones() {
    const container = document.getElementById('milestones-list');
    if (!container) return;

    let streak = 0;
    let d = new Date();
    while (true) {
      const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate());
      const entry = state.entries[key];
      if (!entry || calcPercent(entry.habits) < 100) break;
      streak++;
      d.setDate(d.getDate() - 1);
    }

    const streakEl = document.getElementById('streak-value');
    if (streakEl) streakEl.textContent = streak;

    container.innerHTML = STREAK_MILESTONES.map(m => {
      const status = streak >= m.targetDays ? 'achieved' : (streak > 0 ? 'in-progress' : 'locked');
      const statusIcon = status === 'achieved' ? '✅' : status === 'in-progress' ? '🎯' : '🔒';
      const statusLabel = status === 'achieved' ? 'Achieved' : status === 'in-progress' ? 'In Progress' : 'Locked';
      return `<div class="milestone-row ${status}">
        <div class="milestone-name">${m.name}</div>
        <div class="milestone-target">${m.targetDays} days</div>
        <div class="milestone-status ${status}">${statusIcon} ${statusLabel}</div>
        <div class="milestone-date">—</div>
        <div class="milestone-reward">${m.reward}</div>
      </div>`;
    }).join('');
  }

  // ── Analytics (Chart.js) ────────────────────────────────────
  function updateAnalytics() {
    if (typeof Chart === 'undefined') return;
    Chart.defaults.color = '#9898a6';
    Chart.defaults.font.family = "'Inter', sans-serif";

    const trendCtx = document.getElementById('chart-trend');
    if (trendCtx) {
      const labels = [];
      const data = [];
      const d = new Date();
      d.setDate(d.getDate() - 13);
      for (let i = 0; i < 14; i++) {
        const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate());
        labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
        data.push(calcPercent(getEntry(key).habits));
        d.setDate(d.getDate() + 1);
      }
      if (charts.trend) charts.trend.destroy();
      charts.trend = new Chart(trendCtx, {
        type: 'line',
        data: { labels, datasets: [{ label: 'Completion %', data, borderColor: '#a78bfa', backgroundColor: 'rgba(167, 139, 250, 0.1)', fill: true, tension: 0.4 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { title: { display: true, text: 'Last 14 Days Trend', color: '#e8e8ed' } }, scales: { y: { min: 0, max: 100 } } }
      });
    }

    const donutCtx = document.getElementById('chart-donut');
    if (donutCtx) {
      let maxScore = 0, actualScore = 0;
      const days = daysInMonth(state.currentYear, state.currentMonth);
      for (let d = 1; d <= days; d++) {
        const key = dateKey(state.currentYear, state.currentMonth, d);
        if (state.entries[key]) {
          for (let i = 0; i < state.habits.length; i++) {
            const w = state.habits[i].weight || 1;
            maxScore += w;
            if (state.entries[key].habits[i]) actualScore += w;
          }
        }
      }
      const missed = Math.max(0, maxScore - actualScore);
      if (charts.donut) charts.donut.destroy();
      charts.donut = new Chart(donutCtx, {
        type: 'doughnut',
        data: { labels: ['Completed', 'Missed'], datasets: [{ data: [actualScore, missed], backgroundColor: ['#34d399', 'rgba(239, 68, 68, 0.5)'], borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { title: { display: true, text: 'Overall Month Completion', color: '#e8e8ed' } } }
      });
    }

    const barCtx = document.getElementById('chart-bar');
    if (barCtx) {
      const labels = state.habits.map(h => h.name);
      const data = new Array(state.habits.length).fill(0);
      let daysLogged = 0;
      const days = daysInMonth(state.currentYear, state.currentMonth);
      for (let d = 1; d <= days; d++) {
        const key = dateKey(state.currentYear, state.currentMonth, d);
        if (state.entries[key]) {
          daysLogged++;
          for (let i = 0; i < state.habits.length; i++) {
            if (state.entries[key].habits[i]) data[i]++;
          }
        }
      }
      const percentages = data.map(count => daysLogged ? Math.round((count / daysLogged) * 100) : 0);
      if (charts.bar) charts.bar.destroy();
      charts.bar = new Chart(barCtx, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Completion %', data: percentages, backgroundColor: '#60a5fa', borderRadius: 4 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { title: { display: true, text: 'Habit Performance (This Month)', color: '#e8e8ed' } }, scales: { y: { min: 0, max: 100 } } }
      });
    }
  }

  // ── Write-back to Notion (via backend) ─────────────────────
  window.toggleHabit = async function (el) {
    const key = el.dataset.date;
    const habitIdx = parseInt(el.dataset.habit, 10);
    const entry = getEntry(key);
    const previousValue = entry.habits[habitIdx];
    const nextValue = el.checked;

    // Optimistic UI update — reflect the change immediately, then
    // confirm with Notion. If the write fails, roll the checkbox
    // back and surface why, rather than leaving the UI showing a
    // state Notion doesn't actually have.
    entry.habits[habitIdx] = nextValue;
    updateRowDisplay(el, entry);
    renderHeatMap();
    renderStreakMilestones();
    updateAnalytics();

    pendingToggles++;
    setSyncStatus('Saving to Notion…', null);
    el.disabled = true;

    try {
      const weights = state.habits.map(h => h.weight || 1);
      const res = await fetch('/api/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: key,
          habitIndex: habitIdx,
          checked: nextValue,
          weights,
          habitsAfterToggle: entry.habits,
        }),
      });
      if (!res.ok) {
        const body = await safeJson(res);
        throw new Error((body && body.error) || `Request failed (${res.status})`);
      }
    } catch (err) {
      console.error('Failed to save toggle to Notion:', err);
      // Roll back
      entry.habits[habitIdx] = previousValue;
      el.checked = previousValue;
      updateRowDisplay(el, entry);
      renderHeatMap();
      renderStreakMilestones();
      updateAnalytics();
      setSyncStatus(`Couldn't save to Notion: ${err.message}`, 'error');
    } finally {
      el.disabled = false;
      pendingToggles--;
      if (pendingToggles === 0 && !document.getElementById('sync-status').classList.contains('error')) {
        setSyncStatus('Synced with Notion', 'ok');
      }
    }
  };

  function updateRowDisplay(el, entry) {
    const dateKeyVal = el.dataset.date;
    const pct = calcPercent(entry.habits);

    // Sync the checkbox itself across every table it appears in
    // (week + month can both show the same date at once).
    document.querySelectorAll(`input.habit-checkbox[data-date="${dateKeyVal}"][data-habit="${el.dataset.habit}"]`)
      .forEach(cb => { if (cb !== el) cb.checked = el.checked; });

    // Sync progress/status on every row for this date, not just the
    // row containing the checkbox that was clicked.
    document.querySelectorAll(`tr`).forEach(tr => {
      const marker = tr.querySelector(`input.habit-checkbox[data-date="${dateKeyVal}"]`);
      if (!marker) return;
      const fill = tr.querySelector('.progress-fill');
      const text = tr.querySelector('.progress-text');
      if (fill) fill.style.width = pct + '%';
      if (text) text.textContent = pct + '%';
      const status = tr.querySelector('.daily-status');
      if (status) {
        status.className = `daily-status ${getStatusClass(pct)}`;
        status.textContent = getStatusText(pct);
      }
    });
  }

  window.updateNotes = async function (el) {
    const key = el.dataset.date;
    const entry = getEntry(key);
    const previousNotes = entry.notes;
    entry.notes = el.value;

    document.querySelectorAll(`input.notes-input[data-date="${key}"]`)
      .forEach(input => { if (input !== el) input.value = el.value; });

    el.disabled = true;
    setSyncStatus('Saving notes to Notion…', null);
    try {
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: key, notes: el.value }),
      });
      if (!res.ok) {
        const body = await safeJson(res);
        throw new Error((body && body.error) || `Request failed (${res.status})`);
      }
      setSyncStatus('Synced with Notion', 'ok');
    } catch (err) {
      console.error('Failed to save notes to Notion:', err);
      entry.notes = previousNotes;
      el.value = previousNotes;
      document.querySelectorAll(`input.notes-input[data-date="${key}"]`)
        .forEach(input => { input.value = previousNotes; });
      setSyncStatus(`Couldn't save notes: ${err.message}`, 'error');
    } finally {
      el.disabled = false;
    }
  };

})();
