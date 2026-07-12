'use strict';

/**
 * notion.js
 * ------------------------------------------------------------------
 * All Notion-specific logic lives here: talking to the API, figuring
 * out the real shape of the user's database, and converting between
 * Notion's page format and the {habits, entries} shape app.js expects.
 *
 * Nothing in this file trusts property types by assumption — on
 * startup we call databases.retrieve() and read the *actual* schema,
 * because guessing wrong (e.g. treating a Select as free text) causes
 * Notion to either reject writes or silently create new dropdown
 * options rather than throwing a clear error.
 * ------------------------------------------------------------------
 */

const { Client } = require('@notionhq/client');

const HABIT_NAMES = [
  '7h Sleep', 'Meditation', 'No Scrolling', 'Journaling', '2L Water',
  '8h Deep Work', 'Gym', '20 min Read', '1h Walk', 'Daily AWS Dose'
];

const KNOWN_NON_HABIT_PROPS = new Set(['Date', 'Progress', 'Status', 'Notes']);

let notion = null;
let schemaCache = null;

function getClient() {
  if (!notion) {
    if (!process.env.NOTION_TOKEN) {
      throw new Error('NOTION_TOKEN is not set. Copy .env.example to .env and fill it in.');
    }
    notion = new Client({ auth: process.env.NOTION_TOKEN });
  }
  return notion;
}

async function loadSchema() {
  if (schemaCache) return schemaCache;

  const client = getClient();
  const dbId = process.env.NOTION_DATABASE_ID;
  if (!dbId) {
    throw new Error('NOTION_DATABASE_ID is not set. Copy .env.example to .env and fill it in.');
  }

  const db = await client.databases.retrieve({ database_id: dbId });
  const props = db.properties;

  const habitProps = [];
  let dateProp = null;
  let progressProp = null;
  let statusProp = null;
  let notesProp = null;

  for (const [name, def] of Object.entries(props)) {
    if (name === 'Date' && def.type === 'date') {
      dateProp = { name, type: def.type };
    } else if (name === 'Progress') {
      progressProp = { name, type: def.type };
    } else if (name === 'Status') {
      statusProp = { name, type: def.type };
      if (def.type === 'select' && def.select && Array.isArray(def.select.options)) {
        statusProp.options = def.select.options.map(o => o.name);
      }
    } else if (name === 'Notes') {
      notesProp = { name, type: def.type };
    } else if (def.type === 'checkbox' && !KNOWN_NON_HABIT_PROPS.has(name)) {
      habitProps.push({ name, type: def.type });
    }
  }

  if (!dateProp) {
    throw new Error(
      "Could not find a 'Date' property of type Date on the database. " +
      "Check the property name matches exactly (case-sensitive)."
    );
  }
  if (habitProps.length === 0) {
    throw new Error(
      'No checkbox properties found besides Date/Progress/Status/Notes. ' +
      'Habit columns must be Notion Checkbox properties.'
    );
  }

  habitProps.sort((a, b) => {
    const ai = HABIT_NAMES.indexOf(a.name);
    const bi = HABIT_NAMES.indexOf(b.name);
    if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  schemaCache = { dbId, dateProp, progressProp, statusProp, notesProp, habitProps };
  return schemaCache;
}

function invalidateSchemaCache() {
  schemaCache = null;
}

function extractDateValue(page, dateProp) {
  const val = page.properties[dateProp.name];
  return val && val.date && val.date.start ? val.date.start.slice(0, 10) : null;
}

function extractNotesValue(page, notesProp) {
  if (!notesProp) return '';
  const val = page.properties[notesProp.name];
  if (!val) return '';
  if (val.type === 'rich_text') {
    return (val.rich_text || []).map(t => t.plain_text).join('');
  }
  if (val.type === 'title') {
    return (val.title || []).map(t => t.plain_text).join('');
  }
  return '';
}

async function fetchAllEntries() {
  const client = getClient();
  const schema = await loadSchema();
  const { dbId, dateProp, notesProp, habitProps } = schema;

  const entries = [];
  let cursor = undefined;

  do {
    const res = await client.databases.query({
      database_id: dbId,
      start_cursor: cursor,
      page_size: 100,
      sorts: [{ property: dateProp.name, direction: 'ascending' }],
    });

    for (const page of res.results) {
      const date = extractDateValue(page, dateProp);
      if (!date) continue;

      const habits = habitProps.map(hp => {
        const val = page.properties[hp.name];
        return !!(val && val.checkbox);
      });

      entries.push({
        pageId: page.id,
        date,
        habits,
        notes: extractNotesValue(page, notesProp),
      });
    }

    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return {
    habitNames: habitProps.map(hp => hp.name),
    entries,
  };
}

async function setHabitValue({ date, habitIndex, checked }) {
  const client = getClient();
  const schema = await loadSchema();
  const { dbId, dateProp, habitProps } = schema;

  const habitProp = habitProps[habitIndex];
  if (!habitProp) {
    throw new Error(`No habit at index ${habitIndex}`);
  }

  const existing = await findPageByDate(date);

  if (existing) {
    await client.pages.update({
      page_id: existing.id,
      properties: {
        [habitProp.name]: { checkbox: checked },
      },
    });
    return existing.id;
  }

  const properties = {
    [dateProp.name]: { date: { start: date } },
    [habitProp.name]: { checkbox: checked },
  };
  const created = await client.pages.create({
    parent: { database_id: dbId },
    properties,
  });
  return created.id;
}

async function updateNotesValue({ date, notes }) {
  const client = getClient();
  const schema = await loadSchema();
  const { dbId, dateProp, notesProp } = schema;

  if (!notesProp || notesProp.type !== 'rich_text') {
    throw new Error("Notes property must be a Notion 'Text' (rich_text) property to write to it.");
  }

  const existing = await findPageByDate(date);
  const richText = { rich_text: [{ text: { content: notes.slice(0, 2000) } }] };

  if (existing) {
    await client.pages.update({
      page_id: existing.id,
      properties: { [notesProp.name]: richText },
    });
    return existing.id;
  }

  const created = await client.pages.create({
    parent: { database_id: dbId },
    properties: {
      [dateProp.name]: { date: { start: date } },
      [notesProp.name]: richText,
    },
  });
  return created.id;
}

async function updateComputedFields({ date, percent, statusText }) {
  const schema = await loadSchema();
  const { progressProp, statusProp, dateProp, dbId } = schema;

  const properties = {};

  if (progressProp && progressProp.type === 'number') {
    properties[progressProp.name] = { number: percent / 100 };
  }
  if (statusProp && statusProp.type === 'rich_text') {
    properties[statusProp.name] = { rich_text: [{ text: { content: statusText } }] };
  }

  if (Object.keys(properties).length === 0) return;

  const client = getClient();
  const existing = await findPageByDate(date);
  if (!existing) return;

  await client.pages.update({ page_id: existing.id, properties });
}

async function findPageByDate(date) {
  const client = getClient();
  const schema = await loadSchema();
  const { dbId, dateProp } = schema;

  const res = await client.databases.query({
    database_id: dbId,
    filter: {
      property: dateProp.name,
      date: { equals: date },
    },
    page_size: 1,
  });

  return res.results[0] || null;
}

async function addHabit(habitName) {
  const client = getClient();
  const schema = await loadSchema();
  const { dbId } = schema;

  const trimmed = (habitName || '').trim();
  if (!trimmed) {
    throw new Error('Habit name cannot be empty.');
  }
  if (KNOWN_NON_HABIT_PROPS.has(trimmed)) {
    throw new Error(`"${trimmed}" is a reserved column name (Date/Progress/Status/Notes).`);
  }
  if (schema.habitProps.some(h => h.name === trimmed)) {
    throw new Error(`A habit named "${trimmed}" already exists.`);
  }

  await client.databases.update({
    database_id: dbId,
    properties: {
      [trimmed]: { checkbox: {} },
    },
  });

  invalidateSchemaCache();
  return loadSchema();
}

async function renameHabit(oldName, newName) {
  const client = getClient();
  const schema = await loadSchema();
  const { dbId } = schema;

  const trimmedNew = (newName || '').trim();
  if (!trimmedNew) {
    throw new Error('New habit name cannot be empty.');
  }
  if (KNOWN_NON_HABIT_PROPS.has(trimmedNew)) {
    throw new Error(`"${trimmedNew}" is a reserved column name (Date/Progress/Status/Notes).`);
  }
  const existing = schema.habitProps.find(h => h.name === oldName);
  if (!existing) {
    throw new Error(`No habit named "${oldName}" found.`);
  }
  if (schema.habitProps.some(h => h.name === trimmedNew)) {
    throw new Error(`A habit named "${trimmedNew}" already exists.`);
  }

  await client.databases.update({
    database_id: dbId,
    properties: {
      [oldName]: { name: trimmedNew },
    },
  });

  invalidateSchemaCache();
  return loadSchema();
}

async function deleteHabit(habitName) {
  const client = getClient();
  const schema = await loadSchema();
  const { dbId } = schema;

  const existing = schema.habitProps.find(h => h.name === habitName);
  if (!existing) {
    throw new Error(`No habit named "${habitName}" found.`);
  }
  if (schema.habitProps.length === 1) {
    throw new Error('Cannot delete the last remaining habit.');
  }

  await client.databases.update({
    database_id: dbId,
    properties: {
      [habitName]: null,
    },
  });

  invalidateSchemaCache();
  return loadSchema();
}

module.exports = {
  loadSchema,
  invalidateSchemaCache,
  fetchAllEntries,
  setHabitValue,
  updateNotesValue,
  updateComputedFields,
  addHabit,
  renameHabit,
  deleteHabit,
};
