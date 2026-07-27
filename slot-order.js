'use strict';

/**
 * slot-order.js
 * ------------------------------------------------------------------
 * Notion checkbox properties have no concept of "display order" — the
 * schema order is arbitrary and can't be relied on for a user-defined
 * sequence. To let users arrange their habits in a preferred slot
 * order (1, 2, 3…) via drag-and-drop, we store slot positions
 * server-side in a small JSON file, keyed by habit name — same
 * approach as weights.js and emoji-store.js.
 *
 * Each stored value is a 0-indexed integer representing the habit's
 * position in the ordered list (left→right, top→bottom in the UI).
 * Habits with no stored position sort last (treated as Infinity).
 *
 * This file is the single source of truth for slot order. It survives
 * server restarts and Notion schema reloads. When a habit is renamed
 * or deleted via the CRUD routes, this file is updated to match —
 * mirroring exactly what weights.js and emoji-store.js do.
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const SLOT_ORDER_PATH = path.join(__dirname, 'slot-order.json');

function loadSlotOrder() {
  try {
    const raw = fs.readFileSync(SLOT_ORDER_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {}; // file doesn't exist yet, or is corrupt — default to empty
  }
}

function saveSlotOrder(order) {
  fs.writeFileSync(SLOT_ORDER_PATH, JSON.stringify(order, null, 2), 'utf8');
}

/**
 * Get the slot position for a habit. Returns Infinity if the habit
 * has no stored position (unordered habits sort last).
 */
function getOrder(habitName) {
  const order = loadSlotOrder();
  return typeof order[habitName] === 'number' ? order[habitName] : Infinity;
}

/**
 * Set one habit's slot position.
 */
function setOrder(habitName, position) {
  const order = loadSlotOrder();
  order[habitName] = position;
  saveSlotOrder(order);
}

/**
 * Accepts an ordered array of habit names and writes positions 0..N-1.
 * This is the primary entry point for drag-and-drop reorder: the
 * frontend sends the full ordered list, and we overwrite all positions
 * at once.
 */
function bulkSetOrder(orderedNames) {
  const order = loadSlotOrder();
  for (let i = 0; i < orderedNames.length; i++) {
    order[orderedNames[i]] = i;
  }
  saveSlotOrder(order);
}

/**
 * Rename a habit's slot-order entry (used when a Notion property is renamed).
 */
function renameOrder(oldName, newName) {
  const order = loadSlotOrder();
  if (Object.prototype.hasOwnProperty.call(order, oldName)) {
    order[newName] = order[oldName];
    delete order[oldName];
    saveSlotOrder(order);
  }
}

/**
 * Remove a habit's slot-order entry and re-compact remaining positions
 * so there are no gaps (e.g. if habit at position 2 of 5 is deleted,
 * positions become 0,1,2,3 instead of 0,1,3,4).
 */
function deleteOrder(habitName) {
  const order = loadSlotOrder();
  if (Object.prototype.hasOwnProperty.call(order, habitName)) {
    delete order[habitName];

    // Re-compact: sort remaining entries by position and re-assign 0..N-1
    const sorted = Object.entries(order)
      .sort((a, b) => a[1] - b[1]);
    const compacted = {};
    for (let i = 0; i < sorted.length; i++) {
      compacted[sorted[i][0]] = i;
    }
    saveSlotOrder(compacted);
  }
}

/**
 * Get the next available slot position (for newly added habits).
 */
function getNextPosition() {
  const order = loadSlotOrder();
  const positions = Object.values(order).filter(v => typeof v === 'number');
  return positions.length > 0 ? Math.max(...positions) + 1 : 0;
}

module.exports = {
  getOrder,
  setOrder,
  bulkSetOrder,
  renameOrder,
  deleteOrder,
  getNextPosition,
  loadSlotOrder,
};
