'use strict';

/**
 * server.js
 * ------------------------------------------------------------------
 * Thin Express layer. All Notion-specific logic lives in notion.js —
 * this file just wires HTTP routes to it and keeps the Notion token
 * server-side only. The token is read from process.env (via dotenv),
 * never sent to the browser, never embedded in any response.
 * ------------------------------------------------------------------
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const notion = require('./notion');
const weights = require('./weights');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ──────────────────────────────────────────────────────
// Mirrors the percent/status logic already in app.js, so values we
// write back to Notion (when Progress/Status are plain fields rather
// than Formula/Select) match exactly what the UI displays.
function calcPercent(habitsArr, weights) {
  let maxScore = 0;
  let actualScore = 0;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i] || 1;
    maxScore += w;
    if (habitsArr[i]) actualScore += w;
  }
  if (maxScore === 0) return 0;
  return Math.round((actualScore / maxScore) * 100);
}

function getStatusText(pct) {
  if (pct === 0) return 'Start logging';
  if (pct <= 30) return 'Keep pushing';
  if (pct <= 60) return 'Getting there';
  if (pct <= 80) return 'Great work';
  if (pct < 100) return 'Almost perfect';
  return 'Perfect day!';
}

function sendError(res, status, message, err) {
  if (err) console.error(message, err);
  res.status(status).json({ error: message });
}

// ── Routes ───────────────────────────────────────────────────────

/**
 * GET /api/data
 * Fetches everything from Notion and reshapes it into the
 * {habits, entries} JSON the frontend already knows how to render
 * (same shape data/habits.json used to provide, minus weights —
 * Notion has no native "habit weight" concept, so weights default
 * to 1 here; see the note in public/app.js for how that's handled).
 */
app.get('/api/data', async (req, res) => {
  try {
    const { habitNames, entries } = await notion.fetchAllEntries();
    res.json({
      habitNames,
      habitWeights: habitNames.map(name => weights.getWeight(name)),
      entries: entries.map(e => ({
        date: e.date,
        habits: e.habits,
        notes: e.notes,
        lastEditedTime: e.lastEditedTime || null,
      })),
    });
  } catch (err) {
    sendError(res, 500, 'Failed to load data from Notion. Check NOTION_TOKEN, NOTION_DATABASE_ID, and that the integration is connected to this database.', err);
  }
});

/**
 * POST /api/toggle
 * body: { date: 'YYYY-MM-DD', habitIndex: number, checked: boolean, weights: number[] }
 * Flips one habit checkbox for one day, creating the Notion page if
 * that date doesn't have one yet. weights[] is passed from the
 * client so the server can (optionally) recompute Progress/Status
 * without needing its own copy of habit weights.
 */
app.post('/api/toggle', async (req, res) => {
  const { date, habitIndex, checked, weights, habitsAfterToggle } = req.body || {};

  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return sendError(res, 400, 'Invalid or missing date (expected YYYY-MM-DD).');
  }
  if (typeof habitIndex !== 'number' || habitIndex < 0) {
    return sendError(res, 400, 'Invalid or missing habitIndex.');
  }
  if (typeof checked !== 'boolean') {
    return sendError(res, 400, 'Invalid or missing checked (expected boolean).');
  }

  try {
    await notion.setHabitValue({ date, habitIndex, checked });

    // Best-effort sync of Progress/Status if those are plain
    // Number/Text fields rather than Formula/Select. If they ARE
    // Formula/Select, updateComputedFields() is a no-op — see
    // notion.js for why we never write to a Select automatically.
    if (Array.isArray(habitsAfterToggle) && Array.isArray(weights)) {
      const pct = calcPercent(habitsAfterToggle, weights);
      await notion.updateComputedFields({ date, percent: pct, statusText: getStatusText(pct) });
    }

    res.json({ ok: true });
  } catch (err) {
    sendError(res, 500, 'Failed to update Notion.', err);
  }
});

/**
 * POST /api/notes
 * body: { date: 'YYYY-MM-DD', notes: string }
 */
app.post('/api/notes', async (req, res) => {
  const { date, notes } = req.body || {};

  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return sendError(res, 400, 'Invalid or missing date (expected YYYY-MM-DD).');
  }
  if (typeof notes !== 'string') {
    return sendError(res, 400, 'Invalid or missing notes (expected string).');
  }

  try {
    await notion.updateNotesValue({ date, notes });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 500, 'Failed to update notes in Notion.', err);
  }
});

/**
 * POST /api/habits
 * body: { name: string, weight: number }
 * Adds a new habit: creates a Checkbox property in Notion, then
 * records its weight locally (Notion has no weight concept).
 */
app.post('/api/habits', async (req, res) => {
  const { name, weight } = req.body || {};

  if (typeof name !== 'string' || !name.trim()) {
    return sendError(res, 400, 'Invalid or missing habit name.');
  }
  const w = typeof weight === 'number' ? weight : 1;

  try {
    await notion.addHabit(name.trim());
    weights.setWeight(name.trim(), w);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 400, err.message, err);
  }
});

/**
 * PUT /api/habits/:name
 * body: { newName?: string, weight?: number }
 * Renames a habit in Notion (if newName given) and/or updates its
 * local weight. :name is URL-encoded by the client.
 */
app.put('/api/habits/:name', async (req, res) => {
  const oldName = decodeURIComponent(req.params.name);
  const { newName, weight } = req.body || {};

  try {
    let finalName = oldName;
    if (typeof newName === 'string' && newName.trim() && newName.trim() !== oldName) {
      await notion.renameHabit(oldName, newName.trim());
      weights.renameWeight(oldName, newName.trim());
      finalName = newName.trim();
    }
    if (typeof weight === 'number') {
      weights.setWeight(finalName, weight);
    }
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 400, err.message, err);
  }
});

/**
 * DELETE /api/habits/:name
 * Removes the habit's Checkbox property from Notion (and all its
 * historical data — irreversible) plus its local weight entry.
 */
app.delete('/api/habits/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name);

  try {
    await notion.deleteHabit(name);
    weights.deleteWeight(name);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 400, err.message, err);
  }
});

/**
 * GET /api/health
 * Quick way to confirm the server can actually reach Notion and the
 * schema looks sane, without loading the whole dataset. Useful for
 * checking setup before pointing the UI at it.
 */
app.get('/api/health', async (req, res) => {
  try {
    const schema = await notion.loadSchema();
    res.json({
      ok: true,
      habitsFound: schema.habitProps.map(h => h.name),
      progressPropertyType: schema.progressProp ? schema.progressProp.type : null,
      statusPropertyType: schema.statusProp ? schema.statusProp.type : null,
      notesPropertyType: schema.notesProp ? schema.notesProp.type : null,
    });
  } catch (err) {
    sendError(res, 500, err.message, err);
  }
});

app.listen(PORT, () => {
  console.log(`Habit Tracker backend running at http://localhost:${PORT}`);
  console.log(`Check http://localhost:${PORT}/api/health to verify your Notion connection.`);
});
