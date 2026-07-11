'use strict';

/**
 * weights.js
 * ------------------------------------------------------------------
 * Notion checkbox properties have no concept of "importance" — a
 * checkbox is just true/false. To keep the High(2x)/Normal(1x)/
 * Low(0.5x) weighting feature from the original localStorage app,
 * we store weights server-side in a small JSON file, keyed by habit
 * name (which must match the Notion checkbox property name exactly).
 *
 * This file is the single source of truth for weights. It survives
 * server restarts and Notion schema reloads. When a habit is renamed
 * or deleted via the CRUD routes, this file is updated to match.
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const WEIGHTS_PATH = path.join(__dirname, 'weights.json');

function loadWeights() {
  try {
    const raw = fs.readFileSync(WEIGHTS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {}; // file doesn't exist yet, or is corrupt — default to empty
  }
}

function saveWeights(weights) {
  fs.writeFileSync(WEIGHTS_PATH, JSON.stringify(weights, null, 2), 'utf8');
}

/** Get the weight for a habit name, defaulting to 1 (Normal) if unset. */
function getWeight(habitName) {
  const weights = loadWeights();
  return typeof weights[habitName] === 'number' ? weights[habitName] : 1;
}

/** Set (or overwrite) the weight for a habit name. */
function setWeight(habitName, weight) {
  const weights = loadWeights();
  weights[habitName] = weight;
  saveWeights(weights);
}

/** Rename a habit's weight entry (used when a Notion property is renamed). */
function renameWeight(oldName, newName) {
  const weights = loadWeights();
  if (Object.prototype.hasOwnProperty.call(weights, oldName)) {
    weights[newName] = weights[oldName];
    delete weights[oldName];
    saveWeights(weights);
  }
}

/** Remove a habit's weight entry (used when a Notion property is deleted). */
function deleteWeight(habitName) {
  const weights = loadWeights();
  if (Object.prototype.hasOwnProperty.call(weights, habitName)) {
    delete weights[habitName];
    saveWeights(weights);
  }
}

module.exports = { getWeight, setWeight, renameWeight, deleteWeight, loadWeights };
