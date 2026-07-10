/* ============================================================
   MERGED HABIT TRACKER — APPLICATION LOGIC
   CRUD follows source template + dynamic habits + Chart.js
   ============================================================ */

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────
  const STORAGE_KEY = 'mergedHabitTracker';
  const HABIT_EMOJIS = ['💤', '😌', '📱', '✍️', '💧', '💻', '💪', '📖', '🚶', '📋', '✨', '🔥', '🚀', '🧠', '🌿'];
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // ── State ─────────────────────────────────────────────────
  let state = {
    habits: [],           // { name: string, weight: number }
    entries: {},          // key: 'YYYY-MM-DD' → { habits: [bool×N], notes: string }
    streaks: [],
    currentMonth: new Date().getMonth(),
    currentYear: new Date().getFullYear(),
  };

  let charts = {
    trend: null,
    donut: null,
    bar: null
  };

  let editingHabitIdx = null;

  // ── Bootstrap ─────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    await loadData();
    setupListeners();
    renderAll();
  });

  function setupListeners() {
    const form = document.getElementById('add-habit-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const nameInput = document.getElementById('new-habit-name');
        const impInput = document.getElementById('new-habit-importance');
        if (nameInput.value.trim()) {
          if (editingHabitIdx !== null) {
            updateHabit(editingHabitIdx, nameInput.value.trim(), parseFloat(impInput.value));
            editingHabitIdx = null;
            document.getElementById('add-habit-btn').textContent = 'Add';
          } else {
            addHabit(nameInput.value.trim(), parseFloat(impInput.value));
          }
          nameInput.value = '';
          impInput.value = '1';
        }
      });
    }
  }

  // ── Data Loading & Saving ─────────────────────────────────
  async function loadData() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        
        // Migrate old format (habitNames) to new format (habits array of objects)
        if (parsed.habitNames && !parsed.habits) {
          state.habits = parsed.habitNames.map(name => ({ name, weight: 1 }));
        } else {
          state.habits = parsed.habits || [];
        }
        
        state.entries = parsed.entries || {};
        state.streaks = parsed.streaks || [];
        
        // Ensure all entries have arrays of the right length
        const numHabits = state.habits.length;
        for (const key in state.entries) {
          while (state.entries[key].habits.length < numHabits) {
            state.entries[key].habits.push(false);
          }
        }
        return;
      } catch (_) { /* fall through to JSON files */ }
    }

    // Load from JSON seed files
    try {
      const [habitsRes, streaksRes] = await Promise.all([
        fetch('data/habits.json'),
        fetch('data/streaks.json'),
      ]);
      const habitsData = await habitsRes.json();
      const streaksData = await streaksRes.json();

      state.habits = habitsData.habitNames.map(name => ({ name, weight: 1 }));
      state.streaks = streaksData.milestones;

      state.entries = {};
      for (const e of habitsData.entries) {
        state.entries[e.date] = { habits: e.habits, notes: e.notes || '' };
      }

      save();
    } catch (err) {
      console.error('Failed to load seed data:', err);
      state.habits = [
        {name: '7h Sleep', weight: 1}, {name: 'Meditation', weight: 1}, 
        {name: 'No Scrolling', weight: 1}, {name: 'Journaling', weight: 1}, 
        {name: '2L Water', weight: 1}, {name: '8h Deep Work', weight: 1}, 
        {name: 'Gym', weight: 1}, {name: '20 min Read', weight: 1}, 
        {name: '1h Walk', weight: 1}, {name: 'Daily AWS Dose', weight: 1}
      ];
      state.entries = {};
      state.streaks = [];
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      habits: state.habits,
      entries: state.entries,
      streaks: state.streaks,
    }));
  }

  // ── Add/Update/Delete Habit ───────────────────────────────
  function addHabit(name, weight) {
    state.habits.push({ name, weight });
    const newIdx = state.habits.length - 1;
    
    // Pad all existing entries with 'false' for the new habit
    for (const key in state.entries) {
      state.entries[key].habits[newIdx] = false;
    }
    
    save();
    renderAll(); // Rebuild tables with new column
  }

  function updateHabit(idx, name, weight) {
    state.habits[idx] = { name, weight };
    save();
    renderAll();
  }

  window.editHabit = function(idx) {
    editingHabitIdx = idx;
    const h = state.habits[idx];
    document.getElementById('new-habit-name').value = h.name;
    document.getElementById('new-habit-importance').value = h.weight;
    document.getElementById('add-habit-btn').textContent = 'Save';
    document.getElementById('new-habit-name').focus();
  };

  window.deleteHabit = function(idx) {
    if (confirm('Are you sure you want to delete this habit? All historical data for it will be lost.')) {
      state.habits.splice(idx, 1);
      
      // Remove from all existing entries
      for (const key in state.entries) {
        state.entries[key].habits.splice(idx, 1);
      }
      
      // Reset form if currently editing the deleted habit
      if (editingHabitIdx === idx) {
         editingHabitIdx = null;
         document.getElementById('add-habit-btn').textContent = 'Add';
         document.getElementById('new-habit-name').value = '';
         document.getElementById('new-habit-importance').value = '1';
      } else if (editingHabitIdx !== null && editingHabitIdx > idx) {
         editingHabitIdx--; // Adjust index if a previous habit was deleted
      }
      
      save();
      renderAll();
    }
  };

  // ── Helpers ───────────────────────────────────────────────
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
      if (habitsArr[i]) {
        actualScore += w;
      }
    }
    if (maxScore === 0) return 0;
    return Math.round((actualScore / maxScore) * 100);
  }

  function getHeatLevel(pct) {
    if (pct === 0) return 0;
    if (pct <= 20) return 1;   // red
    if (pct <= 40) return 2;   // orange
    if (pct <= 60) return 3;   // yellow
    if (pct <= 84) return 4;   // blue
    return 5;                   // green
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

  // ── Render All ────────────────────────────────────────────
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
        thead.innerHTML = `
          <th>Date</th>
          <th>Progress</th>
          ${ths}
          <th>Status</th>
          <th>Notes</th>
        `;
      }
    };
    renderHeader('week-table');
    renderHeader('month-table');
  }

  // ── Month Navigation ──────────────────────────────────────
  window.prevMonth = function () {
    state.currentMonth--;
    if (state.currentMonth < 0) {
      state.currentMonth = 11;
      state.currentYear--;
    }
    renderMonthNav();
    renderMonthOverview();
    renderHeatMap();
    updateAnalytics();
  };

  window.nextMonth = function () {
    state.currentMonth++;
    if (state.currentMonth > 11) {
      state.currentMonth = 0;
      state.currentYear++;
    }
    renderMonthNav();
    renderMonthOverview();
    renderHeatMap();
    updateAnalytics();
  };

  function renderMonthNav() {
    const label = document.getElementById('month-label');
    if (label) {
      label.textContent = `${MONTHS[state.currentMonth]} ${state.currentYear}`;
    }
  }

  // ── Overviews ─────────────────────────────────────────────
  function generateTableRow(dKey, displayDate, isToday) {
    const entry = getEntry(dKey);
    const pct = calcPercent(entry.habits);

    let html = `<tr class="${isToday ? 'today-row' : ''}">`;
    html += `<td style="${isToday ? 'color: var(--accent-purple); font-weight: 700;' : ''}">${displayDate}</td>`;

    html += `<td class="progress-cell"><div class="progress-bar-mini">
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span class="progress-text">${pct}%</span>
    </div></td>`;

    for (let h = 0; h < state.habits.length; h++) {
      html += `<td><input type="checkbox" class="habit-checkbox" 
        ${entry.habits[h] ? 'checked' : ''} 
        data-date="${dKey}" data-habit="${h}" 
        onchange="window.toggleHabit(this)"></td>`;
    }

    html += `<td><span class="daily-status ${getStatusClass(pct)}">${getStatusText(pct)}</span></td>`;
    html += `<td><input type="text" class="notes-input" value="${entry.notes.replace(/"/g, '&quot;')}" 
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

  // ── Habit List ────────────────────────────────────────────
  function renderHabitList() {
    const container = document.getElementById('habit-list-grid');
    if (!container) return;

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

  // ── Heat Map ──────────────────────────────────────────────
  function renderHeatMap() {
    const container = document.getElementById('heatmap-grid');
    if (!container) return;

    const year = state.currentYear;
    const month = state.currentMonth;
    const days = daysInMonth(year, month);
    const firstDay = new Date(year, month, 1).getDay(); // 0=Sun

    let html = '<div class="heatmap-week-label"></div>';
    for (const dl of DAYS_SHORT) html += `<div class="heatmap-day-label">${dl}</div>`;

    let currentWeek = 1;
    html += `<div class="heatmap-week-label">W${currentWeek}</div>`;

    for (let i = 0; i < firstDay; i++) {
      html += '<div class="heatmap-cell empty"></div>';
    }

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
    for (let i = lastDayOfWeek + 1; i < 7; i++) {
      html += '<div class="heatmap-cell empty"></div>';
    }

    container.innerHTML = html;
  }

  // ── Streak Milestones ─────────────────────────────────────
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

    container.innerHTML = state.streaks.map(m => {
      const statusIcon = m.status === 'achieved' ? '✅' : m.status === 'in-progress' ? '🎯' : '🔒';
      const statusLabel = m.status === 'achieved' ? 'Achieved' : m.status === 'in-progress' ? 'In Progress' : 'Locked';
      return `<div class="milestone-row ${m.status}">
        <div class="milestone-name">${m.name}</div>
        <div class="milestone-target">${m.targetDays} days</div>
        <div class="milestone-status ${m.status}">${statusIcon} ${statusLabel}</div>
        <div class="milestone-date">${m.dateAchieved || '—'}</div>
        <div class="milestone-reward">${m.reward}</div>
      </div>`;
    }).join('');
  }

  // ── Analytics (Chart.js) ──────────────────────────────────
  function updateAnalytics() {
    if (typeof Chart === 'undefined') return;
    
    Chart.defaults.color = '#9898a6';
    Chart.defaults.font.family = "'Inter', sans-serif";

    // 1. Trend Line Chart (Last 14 days)
    const trendCtx = document.getElementById('chart-trend');
    if (trendCtx) {
      const labels = [];
      const data = [];
      const d = new Date();
      d.setDate(d.getDate() - 13);
      for (let i = 0; i < 14; i++) {
        const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate());
        labels.push(`${d.getMonth()+1}/${d.getDate()}`);
        data.push(calcPercent(getEntry(key).habits));
        d.setDate(d.getDate() + 1);
      }

      if (charts.trend) charts.trend.destroy();
      charts.trend = new Chart(trendCtx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Completion %',
            data,
            borderColor: '#a78bfa',
            backgroundColor: 'rgba(167, 139, 250, 0.1)',
            fill: true,
            tension: 0.4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { title: { display: true, text: 'Last 14 Days Trend', color: '#e8e8ed' } },
          scales: { y: { min: 0, max: 100 } }
        }
      });
    }

    // 2. Donut Chart (Current month completed vs missed)
    const donutCtx = document.getElementById('chart-donut');
    if (donutCtx) {
      let maxScore = 0;
      let actualScore = 0;
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
        data: {
          labels: ['Completed', 'Missed'],
          datasets: [{
            data: [actualScore, missed],
            backgroundColor: ['#34d399', 'rgba(239, 68, 68, 0.5)'],
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { title: { display: true, text: 'Overall Month Completion', color: '#e8e8ed' } }
        }
      });
    }

    // 3. Bar Chart (Individual Habit Performance this month)
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
        data: {
          labels,
          datasets: [{
            label: 'Completion %',
            data: percentages,
            backgroundColor: '#60a5fa',
            borderRadius: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { title: { display: true, text: 'Habit Performance (This Month)', color: '#e8e8ed' } },
          scales: { y: { min: 0, max: 100 } }
        }
      });
    }
  }

  // ── CRUD Operations ───────────────────────────────────────
  window.toggleHabit = function (el) {
    const key = el.dataset.date;
    const habitIdx = parseInt(el.dataset.habit);
    const entry = getEntry(key);
    entry.habits[habitIdx] = el.checked;
    save();

    // Partial re-render for speed
    const tr = el.closest('tr');
    if (tr) {
      const pct = calcPercent(entry.habits);
      const fill = tr.querySelector('.progress-fill');
      const text = tr.querySelector('.progress-text');
      if (fill) fill.style.width = pct + '%';
      if (text) text.textContent = pct + '%';
      const status = tr.querySelector('.daily-status');
      if (status) {
        status.className = `daily-status ${getStatusClass(pct)}`;
        status.textContent = getStatusText(pct);
      }
    }

    renderHeatMap();
    renderStreakMilestones();
    updateAnalytics(); // Instant real-time updates for charts
  };

  window.updateNotes = function (el) {
    const key = el.dataset.date;
    const entry = getEntry(key);
    entry.notes = el.value;
    save();
  };

  window.resetData = function () {
    if (confirm('Reset all habit data? This cannot be undone.')) {
      localStorage.removeItem(STORAGE_KEY);
      location.reload();
    }
  };

})();
