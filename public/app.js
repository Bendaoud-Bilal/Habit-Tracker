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
     to 1 for every habit here, stored server-side in weights.json.
   - Habit ICONS work the same way: Notion has no icon concept
     either, so each habit's chosen OpenMoji icon is stored
     server-side in emoji.json (see emoji-store.js), and every
     habit must have a unique icon — enforced both here (picker
     greys out already-used icons) and on the server (source of
     truth; see server.js).
   - Icons are rendered from the locally vendored OpenMoji PNGs at
     public/assets/openmoji/<hexcode>.png rather than the raw
     unicode emoji character, so the icon set looks the same for
     every user regardless of OS/browser font — that's the whole
     point of using OpenMoji instead of native emoji.
   ============================================================ */

(function () {
  'use strict';

  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const OPENMOJI_DIR = 'assets/openmoji';
  const EMOJI_PAGE_SIZE = 24; // 6 cols x 4 rows — keeps the picker compact

  // ── State ───────────────────────────────────────────────────
  let state = {
    habits: [],           // { name: string, weight: number, hexcode: string, emoji: string }
    entries: {},           // key: 'YYYY-MM-DD' → { habits: [bool×N], notes: string }
    currentMonth: new Date().getMonth(),
    currentYear: new Date().getFullYear(),
    weekOffsetDays: 0,
    todayDate: new Date(),
  };

  let charts = { trend: null, donut: null, bar: null };
  let loaded = false;
  let pendingToggles = 0;
  let editingHabitIdx = null;

  // Full OpenMoji catalog for the picker: [{ hexcode, emoji, name, category }]
  let emojiCatalog = [];

  document.addEventListener('DOMContentLoaded', async () => {
    setupModal();
    setupListeners();

    // Fetch real time from online to prevent device time cheating
    try {
      const timeRes = await fetch('https://worldtimeapi.org/api/ip');
      if (timeRes.ok) {
        const timeData = await timeRes.json();
        const onlineDate = new Date(timeData.datetime);
        if (!isNaN(onlineDate.getTime())) {
          state.todayDate = onlineDate;
        }
      }
    } catch (e) {
      console.warn("Could not fetch time from worldtimeapi, falling back to local device time", e);
    }
    
    // Sync month overview and heatmap to current real date
    state.currentMonth = state.todayDate.getMonth();
    state.currentYear = state.todayDate.getFullYear();

    await Promise.all([loadEmojiCatalog(), loadData()]);
    renderAll();
  });

  function setupListeners() {
    const form = document.getElementById('add-habit-form');
    if (!form) return;

    const iconTrigger = document.getElementById('icon-picker-trigger');
    if (iconTrigger) {
      iconTrigger.addEventListener('click', async () => {
        const excludeHabitName = editingHabitIdx !== null ? state.habits[editingHabitIdx].name : null;
        const result = await openEmojiPickerModal({ excludeHabitName });
        if (result) {
          setFormIcon(result.hexcode, result.emoji);
        }
      });
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('new-habit-name');
      const impInput = document.getElementById('new-habit-importance');
      const hexInput = document.getElementById('new-habit-hexcode');
      const name = nameInput.value.trim();
      const weight = parseFloat(impInput.value);
      const hexcode = hexInput.value;

      if (!name) return;

      if (!hexcode) {
        // Nudge the person to the picker instead of failing silently —
        // a habit needs an icon, and the picker is the only way to pick one.
        const excludeHabitName = editingHabitIdx !== null ? state.habits[editingHabitIdx].name : null;
        const result = await openEmojiPickerModal({ excludeHabitName });
        if (!result) return; // they cancelled — let them try Add again when ready
        setFormIcon(result.hexcode, result.emoji);
      }

      const finalHexcode = document.getElementById('new-habit-hexcode').value;
      const btn = document.getElementById('add-habit-btn');
      btn.disabled = true;

      try {
        if (editingHabitIdx !== null) {
          const oldName = state.habits[editingHabitIdx].name;
          const res = await fetch(`/api/habits/${encodeURIComponent(oldName)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newName: name, weight, hexcode: finalHexcode }),
          });
          if (!res.ok) throw new Error((await safeJson(res))?.error || 'Failed to update habit.');
          editingHabitIdx = null;
          btn.textContent = 'Add';
        } else {
          const res = await fetch('/api/habits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, weight, hexcode: finalHexcode }),
          });
          if (!res.ok) throw new Error((await safeJson(res))?.error || 'Failed to add habit.');
        }
        resetForm();
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

  function resetForm() {
    document.getElementById('new-habit-name').value = '';
    document.getElementById('new-habit-importance').value = '1';
    setFormIcon('', '');
  }

  function setFormIcon(hexcode, emojiChar) {
    document.getElementById('new-habit-hexcode').value = hexcode;
    const trigger = document.getElementById('icon-picker-trigger');
    const triggerEmoji = document.getElementById('icon-picker-trigger-emoji');
    if (!trigger || !triggerEmoji) return;

    if (hexcode) {
      triggerEmoji.innerHTML = `<img src="${OPENMOJI_DIR}/${hexcode}.png" alt="${escapeHtml(emojiChar || '')}" class="emoji-icon" style="width:18px;height:18px;">`;
      trigger.classList.add('has-selection');
      trigger.title = 'Change icon';
    } else {
      triggerEmoji.textContent = '🙂';
      trigger.classList.remove('has-selection');
      trigger.title = 'Choose an icon';
    }
  }

  window.editHabit = function (idx) {
    editingHabitIdx = idx;
    const h = state.habits[idx];
    document.getElementById('new-habit-name').value = h.name;
    document.getElementById('new-habit-importance').value = h.weight;
    setFormIcon(h.hexcode, h.emoji);
    document.getElementById('add-habit-btn').textContent = 'Save';
    document.getElementById('new-habit-name').focus();
  };

  window.deleteHabit = async function (idx) {
    const h = state.habits[idx];

    const confirmed = await openConfirmModal({
      title: 'Delete this habit?',
      message: `Delete "${h.name}"? This removes the column and ALL historical data for it in Notion — this cannot be undone.`,
      confirmLabel: 'Delete habit',
      danger: true,
    });
    if (!confirmed) return;

    try {
      setSyncStatus('Deleting habit in Notion…', null);
      const res = await fetch(`/api/habits/${encodeURIComponent(h.name)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await safeJson(res))?.error || 'Failed to delete habit.');
      if (editingHabitIdx === idx) {
        editingHabitIdx = null;
        document.getElementById('add-habit-btn').textContent = 'Add';
        resetForm();
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

      state.habits = data.habitNames.map((name, i) => {
        const weight = (data.habitWeights && typeof data.habitWeights[i] === 'number') ? data.habitWeights[i] : 1;
        const emojiEntry = (data.habitEmoji && data.habitEmoji[i]) || {};
        const slotPosition = (data.habitSlotOrder && typeof data.habitSlotOrder[i] === 'number') ? data.habitSlotOrder[i] : Infinity;
        return {
          name,
          weight,
          hexcode: emojiEntry.hexcode || '2728',
          emoji: emojiEntry.emoji || '✨',
          slotPosition,
          notionIndex: i
        };
      });
      state.habits.sort((a, b) => {
        if (a.slotPosition === b.slotPosition) return a.notionIndex - b.notionIndex;
        return a.slotPosition - b.slotPosition;
      });
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

  async function loadEmojiCatalog() {
    try {
      const res = await fetch('/emoji-catalog.json');
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      emojiCatalog = await res.json();
    } catch (err) {
      console.error('Failed to load emoji catalog:', err);
      emojiCatalog = [];
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

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
      if (habitsArr[state.habits[i].notionIndex]) actualScore += w;
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
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(state.todayDate);
      d.setDate(state.todayDate.getDate() + state.weekOffsetDays + i);
      dates.push(d);
    }
    return dates;
  }

  // ── Render All ──────────────────────────────────────────────
  function renderAll() {
    updateTableHeaders();
    renderMonthNav();
    renderWeekNav();
    renderWeekOverview();
    renderMonthOverview();
    renderHabitList();
    renderHeatMap();
    renderStreakMilestones();
    updateAnalytics();
  }

  function updateTableHeaders() {
    const ths = state.habits.map((h, i) => {
      const imp = h.weight === 2 ? '<span style="color:var(--accent-purple)">(H)</span>' :
                  h.weight === 0.5 ? '<span style="color:var(--accent-blue)">(L)</span>' : '';
      return `<th>
        <img src="${OPENMOJI_DIR}/${h.hexcode}.png" alt="${escapeHtml(h.name)}" class="th-emoji-icon" title="${escapeHtml(h.name)}">
        <div class="th-slot-number">${i + 1}</div>
        ${imp}
      </th>`;
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

  // ── Week Navigation ─────────────────────────────────────────
  window.prevWeek = function () {
    state.weekOffsetDays -= 7;
    renderWeekNav();
    renderWeekOverview();
  };

  window.nextWeek = function () {
    state.weekOffsetDays += 7;
    renderWeekNav();
    renderWeekOverview();
  };

  function renderWeekNav() {
    const label = document.getElementById('week-label');
    if (!label) return;
    if (state.weekOffsetDays === 0) {
      label.textContent = 'Next 7 Days';
    } else {
      const d1 = new Date(state.todayDate);
      d1.setDate(d1.getDate() + state.weekOffsetDays);
      const d2 = new Date(d1);
      d2.setDate(d2.getDate() + 6);
      const m1 = MONTHS[d1.getMonth()].slice(0, 3);
      const m2 = MONTHS[d2.getMonth()].slice(0, 3);
      label.textContent = `${m1} ${d1.getDate()} - ${m2} ${d2.getDate()}`;
    }
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
      const notionIdx = state.habits[h].notionIndex;
      html += `<td><input type="checkbox" class="habit-checkbox" ${disabledAttr}
        ${entry.habits[notionIdx] ? 'checked' : ''}
        data-date="${dKey}" data-habit="${notionIdx}"
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
      const isToday = d.toDateString() === state.todayDate.toDateString();
      return generateTableRow(key, display, isToday);
    }).join('');
  }

  function renderMonthOverview() {
    const tbody = document.getElementById('month-tbody');
    if (!tbody) return;
    const days = daysInMonth(state.currentYear, state.currentMonth);
    let html = '';
    for (let d = 1; d <= days; d++) {
      const key = dateKey(state.currentYear, state.currentMonth, d);
      const display = `${MONTHS[state.currentMonth].slice(0, 3)} ${d}`;
      const isToday = d === state.todayDate.getDate() && state.currentMonth === state.todayDate.getMonth() && state.currentYear === state.todayDate.getFullYear();
      html += generateTableRow(key, display, isToday);
    }
    tbody.innerHTML = html;
  }

  // ── Habit List ──────────────────────────────────────────────
  function renderHabitList() {
    const container = document.getElementById('habit-list-grid');
    if (!container) return;

    if (state.habits.length === 0) {
      container.innerHTML = `<div class="habit-list-item">No habits found — add one below, or add a Checkbox column in Notion directly and refresh.</div>`;
      return;
    }

    container.innerHTML = state.habits.map((h, i) => {
      const badgeClass = h.weight === 2 ? 'high' : (h.weight === 0.5 ? 'low' : '');
      const badgeLabel = h.weight === 2 ? 'High' : (h.weight === 0.5 ? 'Low' : 'Norm');
      return `<div class="habit-list-item" draggable="true" data-index="${i}">
        <span class="habit-slot-number">#${i + 1}</span>
        <img src="${OPENMOJI_DIR}/${h.hexcode}.png" alt="${escapeHtml(h.name)} icon" class="emoji-icon">
        <span>${escapeHtml(h.name)}</span>
        <span class="habit-badge ${badgeClass}">${badgeLabel}</span>
        <div class="habit-actions">
           <button type="button" class="icon-btn edit-btn" onclick="editHabit(${i})" title="Edit">✏️</button>
           <button type="button" class="icon-btn delete-btn" onclick="deleteHabit(${i})" title="Delete">🗑️</button>
        </div>
      </div>`;
    }).join('');

    // Setup drag and drop
    const items = container.querySelectorAll('.habit-list-item');
    items.forEach(item => {
      item.addEventListener('dragstart', handleDragStart);
      item.addEventListener('dragover', handleDragOver);
      item.addEventListener('dragleave', handleDragLeave);
      item.addEventListener('drop', handleDrop);
      item.addEventListener('dragend', handleDragEnd);
    });
  }

  let dragSrcEl = null;

  function handleDragStart(e) {
    dragSrcEl = this;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dataset.index);
    this.classList.add('dragging');
  }

  function handleDragOver(e) {
    if (e.preventDefault) e.preventDefault(); // Necessary. Allows us to drop.
    e.dataTransfer.dropEffect = 'move';
    if (dragSrcEl !== this) {
      this.classList.add('drag-over');
    }
    return false;
  }

  function handleDragLeave(e) {
    this.classList.remove('drag-over');
  }

  async function handleDrop(e) {
    if (e.stopPropagation) e.stopPropagation();
    this.classList.remove('drag-over');

    if (dragSrcEl !== this) {
      const fromIndex = parseInt(dragSrcEl.dataset.index, 10);
      const toIndex = parseInt(this.dataset.index, 10);

      // Reorder state array
      const movedHabit = state.habits.splice(fromIndex, 1)[0];
      state.habits.splice(toIndex, 0, movedHabit);

      // Re-render UI immediately
      renderAll();

      // Save new order to backend
      const newOrder = state.habits.map(h => h.name);
      setSyncStatus('Saving new order…', null);
      try {
        const res = await fetch('/api/habits/reorder', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: newOrder }),
        });
        if (!res.ok) throw new Error((await safeJson(res))?.error || 'Failed to save order.');
        setSyncStatus('Order saved locally', 'ok');
      } catch (err) {
        console.error(err);
        setSyncStatus(`Couldn't save order: ${err.message}`, 'error');
        await loadData();
        renderAll();
      }
    }
    return false;
  }

  function handleDragEnd(e) {
    this.classList.remove('dragging');
    document.querySelectorAll('.habit-list-item').forEach(el => el.classList.remove('drag-over'));
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
  const STREAK_MILESTONES = [
    { name: 'First Streak', targetDays: 20, reward: '🎯 Amazing start! You\'ve built a solid foundation.' },
    { name: 'Consistency Master', targetDays: 30, reward: '🔥 One month strong! You\'re unstoppable.' },
    { name: 'Habit Warrior', targetDays: 50, reward: '💪 50 days of excellence! You\'re a legend.' },
    { name: 'Discipline Champion', targetDays: 60, reward: '⚡ 60 days! Nothing can stop you now.' },
    { name: 'Elite Performer', targetDays: 75, reward: '👑 75 days! You\'re in the top 1%.' },
    { name: 'Transformation Complete', targetDays: 90, reward: '💎 90 days! You\'ve transformed your life.' },
    { name: 'Century Club', targetDays: 100, reward: '🏆 100+ Days! Absolute legend status!' },
  ];

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
            if (state.entries[key].habits[state.habits[i].notionIndex]) actualScore += w;
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
            if (state.entries[key].habits[state.habits[i].notionIndex]) data[i]++;
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
      // Get weights in Notion schema order to match habitsAfterToggle
      const weightsInNotionOrder = [];
      state.habits.forEach(h => {
        weightsInNotionOrder[h.notionIndex] = h.weight || 1;
      });

      const res = await fetch('/api/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: key,
          habitIndex: habitIdx,
          checked: nextValue,
          weights: weightsInNotionOrder,
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

  // ════════════════════════════════════════════════════════════
  // SHARED MODAL
  // One popup-window component used for both:
  //   - "confirm" mode: replaces window.confirm() for destructive
  //     actions (delete habit)
  //   - "emoji-picker" mode: paginated OpenMoji icon picker for
  //     Add Habit / Edit Habit
  // Both modes share the exact same overlay/dialog DOM nodes; only
  // the inner content block is swapped, so it's genuinely the same
  // popup window rather than two similar-looking ones.
  // ════════════════════════════════════════════════════════════

  let modalPendingResolve = null;

  function setupModal() {
    const overlay = document.getElementById('modal-overlay');
    if (!overlay) return;

    // Click outside the dialog cancels, same as clicking Cancel.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) resolveModal(getCancelValueForCurrentMode());
    });

    // Escape cancels, same as clicking Cancel.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('open')) {
        resolveModal(getCancelValueForCurrentMode());
      }
    });

    document.getElementById('modal-confirm-cancel').addEventListener('click', () => resolveModal(false));
    document.getElementById('modal-confirm-ok').addEventListener('click', () => resolveModal(true));
    document.getElementById('modal-emoji-cancel').addEventListener('click', () => resolveModal(null));

    document.getElementById('emoji-search').addEventListener('input', (e) => {
      pickerState.query = e.target.value;
      pickerState.page = 0;
      renderEmojiPicker();
    });

    document.getElementById('emoji-page-prev').addEventListener('click', () => {
      if (pickerState.page > 0) {
        pickerState.page--;
        renderEmojiPicker();
      }
    });

    document.getElementById('emoji-page-next').addEventListener('click', () => {
      const totalPages = Math.max(1, Math.ceil(filteredCatalog().length / EMOJI_PAGE_SIZE));
      if (pickerState.page < totalPages - 1) {
        pickerState.page++;
        renderEmojiPicker();
      }
    });
  }

  let currentModalMode = null;

  function getCancelValueForCurrentMode() {
    return currentModalMode === 'confirm' ? false : null;
  }

  function openModalShell(mode) {
    currentModalMode = mode;
    const overlay = document.getElementById('modal-overlay');
    const confirmContent = document.getElementById('modal-confirm-content');
    const emojiContent = document.getElementById('modal-emoji-content');

    confirmContent.hidden = mode !== 'confirm';
    emojiContent.hidden = mode !== 'emoji-picker';

    overlay.classList.add('open');

    // Focus the first sensible interactive element for keyboard users.
    requestAnimationFrame(() => {
      if (mode === 'confirm') {
        document.getElementById('modal-confirm-cancel').focus();
      } else if (mode === 'emoji-picker') {
        document.getElementById('emoji-search').focus();
      }
    });
  }

  function closeModalShell() {
    const overlay = document.getElementById('modal-overlay');
    overlay.classList.remove('open');
    currentModalMode = null;
  }

  function resolveModal(value) {
    const resolve = modalPendingResolve;
    modalPendingResolve = null;
    closeModalShell();
    if (resolve) resolve(value);
  }

  /**
   * Confirm dialog. Resolves true if the person confirmed, false if
   * they cancelled (Cancel button, overlay click, or Escape).
   */
  function openConfirmModal({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      modalPendingResolve = resolve;
      document.getElementById('modal-confirm-title').textContent = title;
      document.getElementById('modal-confirm-message').textContent = message;
      const okBtn = document.getElementById('modal-confirm-ok');
      okBtn.textContent = confirmLabel;
      okBtn.className = danger ? 'btn-modal-danger' : 'btn-modal-secondary';
      openModalShell('confirm');
    });
  }

  // ── Emoji Picker ─────────────────────────────────────────────

  let pickerState = {
    page: 0,
    category: 'All',
    query: '',
    excludeHabitName: null,
  };

  /**
   * Opens the icon picker. Resolves { hexcode, emoji } if the person
   * picked an available icon, or null if they cancelled.
   *
   * excludeHabitName: when editing a habit, pass its current name so
   * its own current icon isn't shown as "taken" by itself.
   */
  function openEmojiPickerModal({ excludeHabitName = null } = {}) {
    return new Promise((resolve) => {
      modalPendingResolve = resolve;
      pickerState = { page: 0, category: 'All', query: '', excludeHabitName };
      renderCategoryChips();
      renderEmojiPicker();
      openModalShell('emoji-picker');
    });
  }

  function computeTakenMap(excludeHabitName) {
    // hexcode -> habit name that's using it (excluding the habit
    // currently being edited, if any)
    const map = new Map();
    for (const h of state.habits) {
      if (excludeHabitName && h.name === excludeHabitName) continue;
      if (h.hexcode) map.set(h.hexcode, h.name);
    }
    return map;
  }

  function filteredCatalog() {
    const q = pickerState.query.trim().toLowerCase();
    return emojiCatalog.filter((e) => {
      if (pickerState.category !== 'All' && e.category !== pickerState.category) return false;
      if (q && !e.name.toLowerCase().includes(q) && !e.category.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function renderCategoryChips() {
    const container = document.getElementById('emoji-category-chips');
    if (!container) return;

    const categories = ['All', ...new Set(emojiCatalog.map((e) => e.category))];
    container.innerHTML = categories.map((cat) => {
      const active = cat === pickerState.category ? 'active' : '';
      return `<button type="button" class="emoji-category-chip ${active}" data-category="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`;
    }).join('');

    container.querySelectorAll('.emoji-category-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        pickerState.category = chip.dataset.category;
        pickerState.page = 0;
        renderCategoryChips();
        renderEmojiPicker();
      });
    });
  }

  function renderEmojiPicker() {
    const grid = document.getElementById('emoji-grid');
    const hint = document.getElementById('emoji-picker-hint');
    const pageLabel = document.getElementById('emoji-page-label');
    const prevBtn = document.getElementById('emoji-page-prev');
    const nextBtn = document.getElementById('emoji-page-next');
    if (!grid) return;

    if (!emojiCatalog.length) {
      grid.innerHTML = `<div class="emoji-grid-empty">Icon set failed to load. Run <code>node scripts/download-openmoji.js</code> and refresh.</div>`;
      pageLabel.textContent = 'Page 0 of 0';
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      hint.textContent = '';
      return;
    }

    const takenMap = computeTakenMap(pickerState.excludeHabitName);
    const results = filteredCatalog();
    const totalPages = Math.max(1, Math.ceil(results.length / EMOJI_PAGE_SIZE));
    pickerState.page = Math.min(pickerState.page, totalPages - 1);

    const start = pickerState.page * EMOJI_PAGE_SIZE;
    const pageItems = results.slice(start, start + EMOJI_PAGE_SIZE);

    if (pageItems.length === 0) {
      grid.innerHTML = `<div class="emoji-grid-empty">No icons match "${escapeHtml(pickerState.query)}".</div>`;
    } else {
      grid.innerHTML = pageItems.map((e) => {
        const takenBy = takenMap.get(e.hexcode);
        const isTaken = !!takenBy;
        const title = isTaken ? `Already used by "${takenBy}"` : e.name;
        return `<div class="emoji-cell ${isTaken ? 'taken' : ''}" data-hexcode="${e.hexcode}" data-emoji="${escapeHtml(e.emoji)}" title="${escapeHtml(title)}" role="button" tabindex="${isTaken ? -1 : 0}">
          <img src="${OPENMOJI_DIR}/${e.hexcode}.png" alt="${escapeHtml(e.name)}" loading="lazy">
        </div>`;
      }).join('');

      grid.querySelectorAll('.emoji-cell:not(.taken)').forEach((cell) => {
        const pick = () => {
          resolveModal({ hexcode: cell.dataset.hexcode, emoji: cell.dataset.emoji });
        };
        cell.addEventListener('click', pick);
        cell.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
          }
        });
      });
    }

    pageLabel.textContent = `Page ${pickerState.page + 1} of ${totalPages}`;
    prevBtn.disabled = pickerState.page === 0;
    nextBtn.disabled = pickerState.page >= totalPages - 1;

    const takenCount = results.filter((e) => takenMap.has(e.hexcode)).length;
    if (takenCount > 0) {
      hint.textContent = `${results.length} icon${results.length === 1 ? '' : 's'} in this view · ${takenCount} already in use by another habit`;
      hint.classList.add('warn');
    } else {
      hint.textContent = `${results.length} icon${results.length === 1 ? '' : 's'} in this view`;
      hint.classList.remove('warn');
    }
  }

})();
