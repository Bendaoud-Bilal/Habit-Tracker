'use strict';

/**
 * server.js
 * ------------------------------------------------------------------
 * Thin Express layer. All Notion-specific logic lives in notion.js —
 * this file just wires HTTP routes to it and keeps the Notion token
 * server-side only. The token is read from process.env (via dotenv),
 * never sent to the browser, never embedded in any response.
 *
 * Habit "weight" (importance) and habit "icon" (OpenMoji emoji) are
 * both concepts Notion checkbox properties have no room for, so both
 * are kept in small local JSON sidecars — weights.js / weights.json
 * and emoji-store.js / emoji.json respectively — keyed by habit name
 * and kept in sync with Notion on every rename/delete. See the
 * comments atop each sidecar module for why.
 * ------------------------------------------------------------------
 */

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const notion = require('./notion');
const weights = require('./weights');
const emojiStore = require('./emoji-store');
const slotOrder = require('./slot-order');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Emoji catalog (server-side copy, for validation) ──────────────
// The client ships its own copy of this file (public/emoji-catalog.json)
// to render the picker, but the server must never trust a hexcode the
// client sends without checking it against the real, known-good list —
// otherwise anyone POSTing to /api/habits could set an arbitrary string
// as a habit's "hexcode", which would then 404 as an <img> src or, worse,
// never render at all with no indication why. Loaded once at boot since
// the catalog is static, curated content that ships with the repo and
// never changes at runtime.
let EMOJI_CATALOG = [];
let VALID_HEXCODES = new Set();
try {
  const raw = fs.readFileSync(path.join(__dirname, 'public', 'emoji-catalog.json'), 'utf8');
  EMOJI_CATALOG = JSON.parse(raw);
  VALID_HEXCODES = new Set(EMOJI_CATALOG.map((e) => e.hexcode));
  console.log(`Loaded emoji catalog: ${EMOJI_CATALOG.length} icons`);
} catch (err) {
  console.error(
    'WARNING: could not load public/emoji-catalog.json — the emoji picker ' +
    'and habit-icon validation will not work until this file is present. ' +
    'Run `node scripts/download-openmoji.js` and confirm the catalog file exists.',
    err.message
  );
}

function catalogEntryFor(hexcode) {
  return EMOJI_CATALOG.find((e) => e.hexcode === hexcode) || null;
}

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

/**
 * Validates a hexcode against the server's own catalog copy. Returns
 * the matching catalog entry on success, or null (with the response
 * already sent) on failure — callers should `return` immediately when
 * this returns null.
 */
function requireValidHexcode(res, hexcode) {
  if (typeof hexcode !== 'string' || !hexcode.trim()) {
    sendError(res, 400, 'Invalid or missing icon (hexcode).');
    return null;
  }
  const entry = catalogEntryFor(hexcode);
  if (!entry) {
    sendError(res, 400, `"${hexcode}" is not a recognized icon. Pick one from the icon picker.`);
    return null;
  }
  return entry;
}

// ── Routes ───────────────────────────────────────────────────────

/**
 * GET /api/data
 * Fetches everything from Notion and reshapes it into the
 * {habits, entries} JSON the frontend already knows how to render
 * (same shape data/habits.json used to provide, minus weights —
 * Notion has no native "habit weight" concept, so weights default
 * to 1 here; see the note in public/app.js for how that's handled).
 * habitEmoji mirrors habitWeights: one entry per habit, in the same
 * order as habitNames, each { hexcode, emoji }. Habits with no
 * stored icon yet (added directly in Notion, or created before this
 * feature existed) fall back to a default sparkle icon rather than
 * leaving a gap in the array.
 */
app.get('/api/data', async (req, res) => {
  try {
    const { habitNames, entries } = await notion.fetchAllEntries();
    res.json({
      habitNames,
      habitWeights: habitNames.map((name) => weights.getWeight(name)),
      habitEmoji: habitNames.map((name) => {
        const stored = emojiStore.getEmoji(name);
        return stored || { hexcode: emojiStore.DEFAULT_HEXCODE, emoji: emojiStore.DEFAULT_EMOJI };
      }),
      habitSlotOrder: habitNames.map((name) => slotOrder.getOrder(name)),
      entries: entries.map((e) => ({
        date: e.date,
        habits: e.habits,
        notes: e.notes,
      })),
    });
  } catch (err) {
    sendError(res, 500, 'Failed to load data from Notion. Check NOTION_TOKEN, NOTION_DATABASE_ID, and that the integration is connected to this database.', err);
  }
});

/**
 * GET /api/emoji-catalog
 * Serves the curated OpenMoji catalog. public/emoji-catalog.json is
 * already statically served by express.static, so the frontend could
 * fetch that directly — this route exists mainly so the picker can
 * confirm it's talking to the same catalog the server validates
 * against, and as a stable place to extend later (e.g. server-side
 * search) without changing the static file's shape.
 */
app.get('/api/emoji-catalog', (req, res) => {
  res.json({ icons: EMOJI_CATALOG });
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
 * body: { name: string, weight: number, hexcode: string }
 * Adds a new habit: creates a Checkbox property in Notion, then
 * records its weight and icon locally (Notion has no weight or icon
 * concept).
 *
 * A habit must be a unique (name, icon) combination. Name uniqueness
 * is already enforced by Notion itself (notion.addHabit throws if a
 * checkbox property with that name exists — see notion.js). Icon
 * uniqueness is enforced here: no two habits may share the same
 * OpenMoji icon, so that a glance at the habit list's icons always
 * identifies a single habit, and so the (name, icon) pair requested
 * by the product spec can never collide with an existing habit's pair
 * even if a future rename made two names momentarily similar.
 */
app.post('/api/habits', async (req, res) => {
  const { name, weight, hexcode } = req.body || {};

  if (typeof name !== 'string' || !name.trim()) {
    return sendError(res, 400, 'Invalid or missing habit name.');
  }
  const w = typeof weight === 'number' ? weight : 1;
  const trimmedName = name.trim();

  const catalogEntry = requireValidHexcode(res, hexcode);
  if (!catalogEntry) return; // response already sent

  const takenBy = emojiStore.isEmojiTakenByAnotherHabit(hexcode, null);
  if (takenBy) {
    return sendError(
      res,
      409,
      `The ${catalogEntry.emoji} icon is already used by "${takenBy}". Each habit needs a unique icon — pick a different one.`
    );
  }

  try {
    await notion.addHabit(trimmedName);
    weights.setWeight(trimmedName, w);
    emojiStore.setEmoji(trimmedName, hexcode, catalogEntry.emoji);
    slotOrder.setOrder(trimmedName, slotOrder.getNextPosition());
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 400, err.message, err);
  }
});

/**
 * PUT /api/habits/:name
 * body: { newName?: string, weight?: number, hexcode?: string }
 * Renames a habit in Notion (if newName given) and/or updates its
 * local weight and/or icon. :name is URL-encoded by the client.
 *
 * If hexcode is provided and differs from the habit's current icon,
 * it's validated against the catalog and checked for uniqueness the
 * same way POST /api/habits does — excluding this habit itself, so
 * saving the form without changing the icon never trips the
 * uniqueness check on its own current value.
 */
app.put('/api/habits/:name', async (req, res) => {
  const oldName = decodeURIComponent(req.params.name);
  const { newName, weight, hexcode } = req.body || {};

  let catalogEntry = null;
  if (typeof hexcode === 'string' && hexcode.trim()) {
    const current = emojiStore.getEmoji(oldName);
    const isChanging = !current || current.hexcode !== hexcode;

    catalogEntry = requireValidHexcode(res, hexcode);
    if (!catalogEntry) return; // response already sent

    if (isChanging) {
      const takenBy = emojiStore.isEmojiTakenByAnotherHabit(hexcode, oldName);
      if (takenBy) {
        return sendError(
          res,
          409,
          `The ${catalogEntry.emoji} icon is already used by "${takenBy}". Each habit needs a unique icon — pick a different one.`
        );
      }
    }
  }

  try {
    let finalName = oldName;
    if (typeof newName === 'string' && newName.trim() && newName.trim() !== oldName) {
      await notion.renameHabit(oldName, newName.trim());
      weights.renameWeight(oldName, newName.trim());
      emojiStore.renameEmoji(oldName, newName.trim());
      slotOrder.renameOrder(oldName, newName.trim());
      finalName = newName.trim();
    }
    if (typeof weight === 'number') {
      weights.setWeight(finalName, weight);
    }
    if (catalogEntry) {
      emojiStore.setEmoji(finalName, catalogEntry.hexcode, catalogEntry.emoji);
    }
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 400, err.message, err);
  }
});

/**
 * DELETE /api/habits/:name
 * Removes the habit's Checkbox property from Notion (and all its
 * historical data — irreversible) plus its local weight and icon
 * entries.
 */
app.delete('/api/habits/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name);

  try {
    await notion.deleteHabit(name);
    weights.deleteWeight(name);
    emojiStore.deleteEmoji(name);
    slotOrder.deleteOrder(name);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 400, err.message, err);
  }
});

/**
 * PUT /api/habits/reorder
 * body: { order: ["habit1", "habit2", ...] }
 * Saves the user-defined slot order immediately. Called on every
 * drag-and-drop reorder in the habit list — no form submission
 * required, the new order persists the instant the drop lands.
 */
app.put('/api/habits/reorder', async (req, res) => {
  const { order } = req.body || {};

  if (!Array.isArray(order) || order.length === 0) {
    return sendError(res, 400, 'Invalid or missing order (expected non-empty array of habit names).');
  }

  // Validate that every name in the order array is a real habit
  try {
    const schema = await notion.loadSchema();
    const knownNames = new Set(schema.habitProps.map((h) => h.name));
    for (const name of order) {
      if (typeof name !== 'string' || !knownNames.has(name)) {
        return sendError(res, 400, `"${name}" is not a recognized habit name.`);
      }
    }
    slotOrder.bulkSetOrder(order);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 500, 'Failed to save habit order.', err);
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
      habitsFound: schema.habitProps.map((h) => h.name),
      progressPropertyType: schema.progressProp ? schema.progressProp.type : null,
      statusPropertyType: schema.statusProp ? schema.statusProp.type : null,
      notesPropertyType: schema.notesProp ? schema.notesProp.type : null,
      emojiCatalogLoaded: EMOJI_CATALOG.length,
    });
  } catch (err) {
    sendError(res, 500, err.message, err);
  }
});

app.listen(PORT, () => {
  console.log(`Habit Tracker backend running at http://localhost:${PORT}`);
  console.log(`Check http://localhost:${PORT}/api/health to verify your Notion connection.`);
});
