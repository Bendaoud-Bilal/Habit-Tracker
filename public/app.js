/* ============================================================
   HABIT TRACKER — APPLICATION LOGIC (Offline-First + Notion Sync)
   ------------------------------------------------------------
   Architecture:
   - localStorage is the source of truth for the UI. All reads and
     writes go through local state first (instant, works offline).
   - Notion is an eventually-consistent mirror. When online, changes
     are synced to Notion via the Express backend in the background.
   - A sync queue (pendingChanges) tracks unsynced local writes. The
     queue flushes automatically on reconnect and periodically.
   - Custom modal/toast system replaces native confirm()/alert()
     so the UI works inside Notion embed iframes (which suppress
     native dialogs).
   ============================================================ */

(function () {
  'use strict';

  // ── Constants ───────────────────────────────────────────────
  const STORAGE_KEY = 'habitTrackerOffline';
  const HABIT_EMOJIS = ['💤', '😌', '📱', '✍️', '💧', '💻', '💪', '📖', '🚶', '📋', '✨', '🔥', '🚀', '🧠', '🌿'];
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const STREAK_MILESTONES = [
    { name: 'First Streak', targetDays: 20, reward: '🎯 Amazing start! You\'ve built a solid foundation.' },
    { name: 'Consistency Master', targetDays: 30, reward: '🔥 One month strong! You\'re unstoppable.' },
    { name: 'Habit Warrior', targetDays: 50, reward: '💪 50 days of excellence! You\'re a legend.' },
    { name: 'Discipline Champion', targetDays: 60, reward: '⚡ 60 days! Nothing can stop you now.' },
    { name: 'Elite Performer', targetDays: 75, reward: '👑 75 days! You\'re in the top 1%.' },
    { name: 'Transformation Complete', targetDays: 90, reward: '💎 90 days! You\'ve transformed your life.' },
    { name: 'Century Club', targetDays: 100, reward: '🏆 100+ Days! Absolute legend status!' },
  ];

  const SYNC_RETRY_INTERVAL = 60_000; // 60s periodic retry

  // ── State ───────────────────────────────────────────────────
  let state = {
    habits: [],            // { name: string, weight: number }
    entries: {},           // key: 'YYYY-MM-DD' → { habits: [bool×N], notes: string, lastEditedTime: string|null }
    currentMonth: new Date().getMonth(),
    currentYear: new Date().getFullYear(),
    pendingChanges: [],    // sync queue: { id, type, date, habitIndex?, checked?, notes?, clientTimestamp, status }
    lastSyncedAt: null,    // ISO timestamp of last successful full pull from Notion
    conflictLog: [],       // { date, field, localValue, remoteValue, resolution, resolvedAt }
  };

  let charts = { trend: null, donut: null, bar: null };
  let loaded = false;
  let editingHabitIdx = null;
  let flushing = false;
  let syncRetryTimer = null;

  // ── Initialization ──────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    // Register service worker for PWA / offline app-shell caching
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(err =>
        console.warn('SW registration failed:', err)
      );
    }

    // Load local data first (instant render), then sync remote
    loadLocal();
    renderAll();
    setupListeners();

    // Background sync: fetch latest from Notion
    await syncFromRemote();

    // Set up connectivity listeners and periodic retry
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    syncRetryTimer = setInterval(() => {
      if (navigator.onLine && state.pendingChanges.length > 0) {
        flushPendingChanges();
      }
    }, SYNC_RETRY_INTERVAL);
  });

  // ── Custom Modal (replaces native confirm/alert) ────────────
  /**
   * Shows a glassmorphism modal in the DOM. Works inside Notion
   * embed iframes where native confirm()/alert() are suppressed.
   *
   * @param {Object} opts - { icon?, title, body, buttons: [{ label, value, className? }] }
   * @returns {Promise<string>} The `value` of the button clicked
   */
  function showModal({ icon, title, body, buttons }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'custom-modal-overlay';
      overlay.innerHTML = `
        <div class="custom-modal">
          ${icon ? `<span class="custom-modal-icon">${icon}</span>` : ''}
          <div class="custom-modal-title">${title}</div>
          <div class="custom-modal-body">${body}</div>
          <div class="custom-modal-actions">
            ${buttons.map(b =>
              `<button class="custom-modal-btn ${b.className || ''}" data-value="${b.value}">${b.label}</button>`
            ).join('')}
          </div>
        </div>
      `;

      overlay.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-value]');
        if (btn) {
          overlay.classList.remove('visible');
          setTimeout(() => { overlay.remove(); resolve(btn.dataset.value); }, 200);
        }
      });

      // Close on overlay background click (outside modal)
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.classList.remove('visible');
          setTimeout(() => { overlay.remove(); resolve('cancel'); }, 200);
        }
      });

      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('visible'));
    });
  }

  // ── Toast Notifications ─────────────────────────────────────
  const TOAST_ICONS = {
    info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌', conflict: '⚡'
  };

  function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${TOAST_ICONS[type] || 'ℹ️'}</span>
      <span class="toast-msg">${message}</span>
      <button class="toast-dismiss" aria-label="Dismiss">×</button>
    `;

    toast.querySelector('.toast-dismiss').addEventListener('click', () => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 250);
    });

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));

    if (duration > 0) {
      setTimeout(() => {
        if (toast.parentNode) {
          toast.classList.remove('visible');
          setTimeout(() => toast.remove(), 250);
        }
      }, duration);
    }
  }

  // ── LocalStorage (persistence layer) ────────────────────────
  function save() {
    try {
      const toSave = {
        habits: state.habits,
        entries: state.entries,
        pendingChanges: state.pendingChanges,
        lastSyncedAt: state.lastSyncedAt,
        conflictLog: state.conflictLog,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch (err) {
      console.error('Failed to save to localStorage:', err);
    }
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed.habits) state.habits = parsed.habits;
      if (parsed.entries) state.entries = parsed.entries;
      if (parsed.pendingChanges) state.pendingChanges = parsed.pendingChanges;
      if (parsed.lastSyncedAt) state.lastSyncedAt = parsed.lastSyncedAt;
      if (parsed.conflictLog) state.conflictLog = parsed.conflictLog;
      loaded = state.habits.length > 0;
      if (loaded) {
        setSyncStatus(
          `Loaded from cache${state.lastSyncedAt ? ` · last synced ${formatTimeAgo(state.lastSyncedAt)}` : ''}`,
          'ok'
        );
      }
    } catch (err) {
      console.error('Failed to load from localStorage:', err);
    }
  }

  // ── Remote Sync (Notion via backend) ────────────────────────
  async function syncFromRemote() {
    if (!navigator.onLine) {
      setSyncStatus(
        `Offline — showing cached data${state.lastSyncedAt ? ` from ${formatTimeAgo(state.lastSyncedAt)}` : ''}`,
        'offline'
      );
      renderSyncBadge();
      return;
    }

    setSyncStatus('Syncing with Notion…', null);
    try {
      const res = await fetch('/api/data');
      if (!res.ok) {
        const body = await safeJson(res);
        throw new Error((body && body.error) || `Request failed (${res.status})`);
      }
      const data = await res.json();

      const remoteHabits = data.habitNames.map((name, i) => ({
        name,
        weight: (data.habitWeights && typeof data.habitWeights[i] === 'number') ? data.habitWeights[i] : 1,
      }));

      const remoteEntries = {};
      for (const e of data.entries) {
        remoteEntries[e.date] = {
          habits: e.habits,
          notes: e.notes || '',
          lastEditedTime: e.lastEditedTime || null,
        };
      }

      // Merge remote data with local state (handles conflicts)
      mergeRemoteData(remoteHabits, remoteEntries);

      state.lastSyncedAt = new Date().toISOString();
      loaded = true;
      save();
      renderAll();

      const pendingCount = state.pendingChanges.length;
      if (pendingCount > 0) {
        setSyncStatus(`Synced with Notion · ${pendingCount} local change(s) pending`, 'warning');
        // Flush pending changes now that we're online
        flushPendingChanges();
      } else {
        setSyncStatus(`Synced with Notion · ${data.entries.length} day(s) loaded`, 'ok');
      }
    } catch (err) {
      console.error('Failed to sync from Notion:', err);
      if (loaded) {
        setSyncStatus(
          `Couldn't reach Notion — showing cached data${state.lastSyncedAt ? ` from ${formatTimeAgo(state.lastSyncedAt)}` : ''}`,
          'warning'
        );
      } else {
        setSyncStatus(`Couldn't reach Notion: ${err.message}`, 'error');
      }
    }
    renderSyncBadge();
  }

  // ── Merge Remote Data + Conflict Detection (Phase 4) ────────
  function mergeRemoteData(remoteHabits, remoteEntries) {
    // Always take the latest habit list from Notion (schema is authoritative)
    state.habits = remoteHabits;

    // Build a set of dates with pending local changes
    const pendingDates = new Map();
    for (const change of state.pendingChanges) {
      if (!pendingDates.has(change.date)) {
        pendingDates.set(change.date, []);
      }
      pendingDates.get(change.date).push(change);
    }

    // Merge entries
    for (const [date, remote] of Object.entries(remoteEntries)) {
      const local = state.entries[date];

      if (!pendingDates.has(date)) {
        // No pending local changes for this date — take remote as-is
        state.entries[date] = remote;
        continue;
      }

      // This date has pending local changes — check for conflicts
      const localLastEdited = local && local.lastEditedTime;
      const remoteLastEdited = remote.lastEditedTime;

      if (!localLastEdited || !remoteLastEdited) {
        // Can't compare timestamps — local changes win (they're queued to sync)
        // Keep local state, just update lastEditedTime for future comparisons
        if (local) {
          state.entries[date] = { ...local, lastEditedTime: remoteLastEdited };
        }
        continue;
      }

      // Compare: has the remote entry been edited since we last synced?
      const localChanges = pendingDates.get(date);
      const remoteEditTime = new Date(remoteLastEdited).getTime();
      const lastSyncTime = state.lastSyncedAt ? new Date(state.lastSyncedAt).getTime() : 0;

      if (remoteEditTime <= lastSyncTime) {
        // Remote hasn't changed since our last sync — local wins, no conflict
        if (local) {
          state.entries[date] = { ...local, lastEditedTime: remoteLastEdited };
        }
        continue;
      }

      // Remote HAS changed independently — conflict!
      // Apply per-field last-write-wins
      for (const change of localChanges) {
        const clientTime = new Date(change.clientTimestamp).getTime();

        if (change.type === 'toggle') {
          if (clientTime >= remoteEditTime) {
            // Local toggle is newer — keep local value (will overwrite remote on flush)
            // No action needed, local state already has this
          } else {
            // Remote is newer — drop this pending change, adopt remote
            state.pendingChanges = state.pendingChanges.filter(c => c.id !== change.id);
            state.conflictLog.push({
              date,
              field: `habits[${change.habitIndex}]`,
              localValue: change.checked,
              remoteValue: remote.habits[change.habitIndex],
              resolution: 'remote-won',
              resolvedAt: new Date().toISOString(),
            });
          }
        } else if (change.type === 'notes') {
          if (clientTime >= remoteEditTime) {
            // Local notes are newer — keep local
          } else {
            // Remote is newer — drop local pending change
            state.pendingChanges = state.pendingChanges.filter(c => c.id !== change.id);
            state.conflictLog.push({
              date,
              field: 'notes',
              localValue: change.notes,
              remoteValue: remote.notes,
              resolution: 'remote-won',
              resolvedAt: new Date().toISOString(),
            });
          }
        }
      }

      // After conflict resolution, build the merged entry:
      // Start from remote, then re-apply any surviving local changes
      const merged = { ...remote };
      const survivingChanges = state.pendingChanges.filter(c => c.date === date);
      for (const change of survivingChanges) {
        if (change.type === 'toggle') {
          merged.habits = [...merged.habits];
          merged.habits[change.habitIndex] = change.checked;
        } else if (change.type === 'notes') {
          merged.notes = change.notes;
        }
      }
      state.entries[date] = merged;
    }

    // Add any local-only dates not in remote (rare, but possible if
    // a new day started while offline and user toggled habits)
    for (const date of Object.keys(state.entries)) {
      if (!remoteEntries[date]) {
        // Keep local-only entry as-is
      }
    }

    // Surface conflicts if any were resolved
    const recentConflicts = state.conflictLog.filter(c => {
      const age = Date.now() - new Date(c.resolvedAt).getTime();
      return age < 60_000; // Show conflicts from the last minute
    });
    if (recentConflicts.length > 0) {
      showToast(
        `${recentConflicts.length} conflict(s) resolved — remote changes were newer`,
        'conflict',
        6000
      );
      renderConflictBanner();
    }

    // Trim old conflict log entries (keep last 50)
    if (state.conflictLog.length > 50) {
      state.conflictLog = state.conflictLog.slice(-50);
    }
  }

  // ── Sync Queue — Flush pending changes to Notion ────────────
  async function flushPendingChanges() {
    if (flushing || !navigator.onLine || state.pendingChanges.length === 0) return;
    flushing = true;

    // Collapse redundant entries before flushing
    state.pendingChanges = collapseQueue(state.pendingChanges);
    save();

    const queue = [...state.pendingChanges];

    for (const change of queue) {
      change.status = 'syncing';
      save();

      try {
        if (change.type === 'toggle') {
          await postToggle(change);
        } else if (change.type === 'notes') {
          await postNotes(change);
        }
        // Success: remove from queue
        state.pendingChanges = state.pendingChanges.filter(c => c.id !== change.id);
        save();
      } catch (err) {
        console.error('Sync failed for change:', change.id, err);
        change.status = 'failed';
        save();
        // Stop on first failure — likely offline again
        break;
      }
    }

    flushing = false;
    renderSyncBadge();

    if (state.pendingChanges.length === 0) {
      setSyncStatus('Synced with Notion', 'ok');
      showToast('All changes synced to Notion', 'success', 3000);
    } else {
      setSyncStatus(`${state.pendingChanges.length} change(s) waiting to sync`, 'warning');
    }
  }

  function collapseQueue(queue) {
    const latestByKey = new Map();
    for (const change of queue) {
      const key = change.type === 'toggle'
        ? `toggle:${change.date}:${change.habitIndex}`
        : `notes:${change.date}`;
      latestByKey.set(key, change);
    }
    return [...latestByKey.values()];
  }

  async function postToggle(change) {
    const entry = getEntry(change.date);
    const weights = state.habits.map(h => h.weight || 1);
    const res = await fetch('/api/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: change.date,
        habitIndex: change.habitIndex,
        checked: change.checked,
        weights,
        habitsAfterToggle: entry.habits,
      }),
    });
    if (!res.ok) {
      const body = await safeJson(res);
      throw new Error((body && body.error) || `Request failed (${res.status})`);
    }
  }

  async function postNotes(change) {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: change.date, notes: change.notes }),
    });
    if (!res.ok) {
      const body = await safeJson(res);
      throw new Error((body && body.error) || `Request failed (${res.status})`);
    }
  }

  // ── Connectivity Listeners ──────────────────────────────────
  function onOnline() {
    showToast('Back online — syncing changes…', 'success', 3000);
    setSyncStatus('Back online — syncing…', null);
    flushPendingChanges().then(() => syncFromRemote());
  }

  function onOffline() {
    setSyncStatus('Offline — changes will sync when you reconnect', 'offline');
    showToast('You\'re offline — changes are saved locally', 'warning', 4000);
    renderSyncBadge();
  }

  // ── Generate a UUID for sync queue entries ──────────────────
  function generateId() {
    return 'xxxx-xxxx-xxxx'.replace(/x/g, () =>
      Math.floor(Math.random() * 16).toString(16)
    );
  }

  // ── Setup Listeners ─────────────────────────────────────────
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
          showToast(`Habit "${name}" updated`, 'success', 3000);
        } else {
          const res = await fetch('/api/habits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, weight }),
          });
          if (!res.ok) throw new Error((await safeJson(res))?.error || 'Failed to add habit.');
          showToast(`Habit "${name}" added`, 'success', 3000);
        }
        nameInput.value = '';
        impInput.value = '1';
        setSyncStatus('Reloading from Notion…', null);
        await syncFromRemote();
        renderAll();
      } catch (err) {
        console.error(err);
        showToast(`Couldn't save habit: ${err.message}`, 'error', 5000);
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

    // Custom modal instead of native confirm() — works in Notion iframes
    const result = await showModal({
      icon: '🗑️',
      title: `Delete "${h.name}"?`,
      body: 'This removes the column and <strong>ALL historical data</strong> for it in Notion — this cannot be undone.',
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Delete', value: 'delete', className: 'danger' },
      ],
    });

    if (result !== 'delete') return;

    try {
      setSyncStatus('Deleting habit in Notion…', null);
      const res = await fetch(`/api/habits/${encodeURIComponent(h.name)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await safeJson(res))?.error || 'Failed to delete habit.');
      if (editingHabitIdx === idx) {
        editingHabitIdx = null;
        document.getElementById('add-habit-btn').textContent = 'Add';
        document.getElementById('new-habit-name').value = '';
      }
      showToast(`Habit "${h.name}" deleted`, 'success', 3000);
      await syncFromRemote();
      renderAll();
    } catch (err) {
      console.error(err);
      showToast(`Couldn't delete habit: ${err.message}`, 'error', 5000);
      setSyncStatus(`Couldn't delete habit: ${err.message}`, 'error');
    }
  };

  // ── Sync Status Banner ──────────────────────────────────────
  function setSyncStatus(text, kind) {
    const banner = document.getElementById('sync-status');
    const textEl = document.getElementById('sync-status-text');
    if (!banner || !textEl) return;
    banner.style.display = 'block';
    banner.classList.remove('ok', 'error', 'warning', 'offline');
    if (kind) banner.classList.add(kind);
    textEl.textContent = text;
  }

  function renderSyncBadge() {
    const slot = document.getElementById('sync-badge');
    if (!slot) return;

    const count = state.pendingChanges.length;
    if (count === 0) {
      slot.innerHTML = '';
      return;
    }

    slot.innerHTML = `
      <span class="sync-badge">
        <span class="pending-dot"></span>
        <span class="pending-count">${count} pending</span>
      </span>
      <button class="sync-retry-btn" onclick="window._retrySync()">Retry now</button>
    `;
  }

  window._retrySync = function () {
    if (navigator.onLine) {
      flushPendingChanges();
    } else {
      showToast('Still offline — will retry when connected', 'warning', 3000);
    }
  };

  function renderConflictBanner() {
    const slot = document.getElementById('conflict-banner-slot');
    if (!slot) return;

    const recent = state.conflictLog.filter(c => {
      const age = Date.now() - new Date(c.resolvedAt).getTime();
      return age < 300_000; // last 5 minutes
    });

    if (recent.length === 0) {
      slot.innerHTML = '';
      return;
    }

    slot.innerHTML = `
      <div class="conflict-banner">
        <span>⚡ ${recent.length} sync conflict(s) resolved (remote was newer)</span>
        <button class="conflict-banner-dismiss" onclick="this.parentElement.remove()">×</button>
      </div>
    `;
  }

  // ── Helpers ─────────────────────────────────────────────────
  async function safeJson(res) {
    try { return await res.json(); } catch (_) { return null; }
  }

  function dateKey(y, m, d) {
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function getEntry(key) {
    if (!state.entries[key]) {
      state.entries[key] = { habits: new Array(state.habits.length).fill(false), notes: '', lastEditedTime: null };
    }
    // Ensure habits array matches current habit count
    const entry = state.entries[key];
    while (entry.habits.length < state.habits.length) {
      entry.habits.push(false);
    }
    return entry;
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

  function formatTimeAgo(isoString) {
    if (!isoString) return 'never';
    const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
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
    renderSyncBadge();
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

  // ── Table Row Generation ────────────────────────────────────
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

  // ── Habit List ──────────────────────────────────────────────
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

  // ── Write-back: Toggle Habit (local-first) ──────────────────
  window.toggleHabit = function (el) {
    const key = el.dataset.date;
    const habitIdx = parseInt(el.dataset.habit, 10);
    const entry = getEntry(key);
    const nextValue = el.checked;

    // Write to local state immediately
    entry.habits[habitIdx] = nextValue;
    save();

    // Update UI instantly (no network round-trip)
    updateRowDisplay(el, entry);
    renderHeatMap();
    renderStreakMilestones();
    updateAnalytics();

    // Queue the change for remote sync
    state.pendingChanges.push({
      id: generateId(),
      type: 'toggle',
      date: key,
      habitIndex: habitIdx,
      checked: nextValue,
      clientTimestamp: new Date().toISOString(),
      status: 'pending',
    });
    save();
    renderSyncBadge();

    // If online, kick off sync in the background
    if (navigator.onLine) {
      flushPendingChanges();
    }
  };

  function updateRowDisplay(el, entry) {
    const dateKeyVal = el.dataset.date;
    const pct = calcPercent(entry.habits);

    // Sync the checkbox across every table it appears in
    document.querySelectorAll(`input.habit-checkbox[data-date="${dateKeyVal}"][data-habit="${el.dataset.habit}"]`)
      .forEach(cb => { if (cb !== el) cb.checked = el.checked; });

    // Sync progress/status on every row for this date
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

  // ── Write-back: Update Notes (local-first) ──────────────────
  window.updateNotes = function (el) {
    const key = el.dataset.date;
    const entry = getEntry(key);
    entry.notes = el.value;
    save();

    // Sync across tables
    document.querySelectorAll(`input.notes-input[data-date="${key}"]`)
      .forEach(input => { if (input !== el) input.value = el.value; });

    // Queue for remote sync
    state.pendingChanges.push({
      id: generateId(),
      type: 'notes',
      date: key,
      notes: el.value,
      clientTimestamp: new Date().toISOString(),
      status: 'pending',
    });
    save();
    renderSyncBadge();

    // If online, kick off sync
    if (navigator.onLine) {
      flushPendingChanges();
    }
  };

})();
