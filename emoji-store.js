'use strict';

/**
 * emoji-store.js
 * ------------------------------------------------------------------
 * Notion checkbox properties have no concept of "icon" — a checkbox is
 * just true/false, same limitation weights.js already documents for
 * habit importance. To let each habit carry a user-chosen OpenMoji
 * icon, we store emoji assignments server-side in a small JSON file,
 * keyed by habit name (which must match the Notion checkbox property
 * name exactly) — same approach, same file shape, same lifecycle hooks
 * as weights.js.
 *
 * Each stored value is an OpenMoji hexcode (e.g. "1F525"), not the raw
 * emoji character. Hexcodes are unambiguous 1:1 keys into the local
 * icon set at public/assets/openmoji/<hexcode>.png and into
 * public/emoji-catalog.json, whereas comparing emoji *characters* can
 * be fragile (variation selectors, ZWJ sequences, normalization). The
 * emoji character is still recorded for a human glancing at the file,
 * but the hexcode is what the app actually reads and compares by.
 *
 * This file is the single source of truth for habit emoji. It survives
 * server restarts and Notion schema reloads. When a habit is renamed
 * or deleted via the CRUD routes, this file is updated to match —
 * mirroring exactly what weights.js does for weight.
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const EMOJI_STORE_PATH = path.join(__dirname, 'emoji.json');

function loadEmojiMap() {
  try {
    const raw = fs.readFileSync(EMOJI_STORE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {}; // file doesn't exist yet, or is corrupt — default to empty
  }
}

function saveEmojiMap(map) {
  fs.writeFileSync(EMOJI_STORE_PATH, JSON.stringify(map, null, 2), 'utf8');
}

/**
 * Get the { hexcode, emoji } for a habit name. Returns null if the
 * habit has no assigned icon yet (e.g. a habit that existed before
 * this feature shipped, or one created by adding a Notion checkbox
 * column directly rather than through the app's Add Habit form).
 * Callers should fall back to a generic default icon in that case —
 * see DEFAULT_HEXCODE below.
 */
function getEmoji(habitName) {
  const map = loadEmojiMap();
  const entry = map[habitName];
  return entry && entry.hexcode ? entry : null;
}

/** Set (or overwrite) the icon for a habit name. */
function setEmoji(habitName, hexcode, emojiChar) {
  const map = loadEmojiMap();
  map[habitName] = { hexcode, emoji: emojiChar };
  saveEmojiMap(map);
}

/** Rename a habit's icon entry (used when a Notion property is renamed). */
function renameEmoji(oldName, newName) {
  const map = loadEmojiMap();
  if (Object.prototype.hasOwnProperty.call(map, oldName)) {
    map[newName] = map[oldName];
    delete map[oldName];
    saveEmojiMap(map);
  }
}

/** Remove a habit's icon entry (used when a Notion property is deleted). */
function deleteEmoji(habitName) {
  const map = loadEmojiMap();
  if (Object.prototype.hasOwnProperty.call(map, habitName)) {
    delete map[habitName];
    saveEmojiMap(map);
  }
}

/**
 * True if `hexcode` is already claimed by a DIFFERENT habit than
 * `excludeHabitName`. Used to enforce "a habit must be a unique
 * (name, icon) combination" — see the route layer in server.js for
 * exactly how name and icon uniqueness are combined.
 *
 * excludeHabitName lets a PUT (edit) request keep its own current
 * icon without tripping over itself.
 */
function isEmojiTakenByAnotherHabit(hexcode, excludeHabitName) {
  const map = loadEmojiMap();
  for (const [habitName, entry] of Object.entries(map)) {
    if (habitName === excludeHabitName) continue;
    if (entry && entry.hexcode === hexcode) return habitName;
  }
  return null;
}

// Fallback icon (sparkles) for any habit that predates this feature or
// was added directly in Notion. Matches the "✨" fallback already used
// in the old HABIT_EMOJIS cycling logic in app.js, so existing habits
// don't visually jump to something unrelated the first time this ships.
const DEFAULT_HEXCODE = '2728';
const DEFAULT_EMOJI = '✨';

module.exports = {
  getEmoji,
  setEmoji,
  renameEmoji,
  deleteEmoji,
  isEmojiTakenByAnotherHabit,
  loadEmojiMap,
  DEFAULT_HEXCODE,
  DEFAULT_EMOJI,
};
