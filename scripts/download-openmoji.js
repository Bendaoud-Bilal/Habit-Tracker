#!/usr/bin/env node
'use strict';

/**
 * scripts/download-openmoji.js
 * ------------------------------------------------------------------
 * Downloads the curated set of OpenMoji icons used by the habit-emoji
 * picker and vendors them into public/assets/openmoji/.
 *
 * We do NOT clone the full OpenMoji repo — `git clone --depth 1` of
 * github.com/hfg-gmuend/openmoji is still several hundred MB (thousands
 * of SVGs across every Unicode category, in black/, color/, and font/
 * variants). This app only ever shows a curated list of ~140
 * habit-relevant icons, defined in public/emoji-catalog.json, so we
 * fetch exactly those files by codepoint from a pinned OpenMoji release
 * tag on GitHub's raw CDN.
 *
 * Source:  https://github.com/hfg-gmuend/openmoji
 * License: OpenMoji graphics are CC BY-SA 4.0. A LICENSE.txt with full
 *          attribution is written into the output folder automatically.
 *          Keep it if you redistribute this project.
 *
 * Usage:
 *   node scripts/download-openmoji.js
 *   node scripts/download-openmoji.js --force   (redownload everything)
 *
 * Implemented as plain Node (no jq / no extra npm packages) since the
 * project already requires Node >=18 — this doesn't add a dependency
 * that wasn't already there.
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Pin to a specific tag rather than "master" so re-running this script
// a year from now can't silently start pulling a redesigned icon set.
const OPENMOJI_REF = '16.0.0';
const BASE_URL = `https://raw.githubusercontent.com/hfg-gmuend/openmoji/${OPENMOJI_REF}/color/72x72`;
const FALLBACK_BASE_URL = 'https://raw.githubusercontent.com/hfg-gmuend/openmoji/master/color/72x72';

const REPO_ROOT = path.join(__dirname, '..');
const CATALOG_PATH = path.join(REPO_ROOT, 'public', 'emoji-catalog.json');
const OUT_DIR = path.join(REPO_ROOT, 'public', 'assets', 'openmoji');

const FORCE = process.argv.includes('--force');

function fetchToFile(url, destPath) {
  return new Promise((resolve) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, { headers: { 'User-Agent': 'habit-tracker-openmoji-downloader' } }, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        resolve({ ok: false, status: res.statusCode });
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve({ ok: true, status: 200 }));
      });
    });
    req.on('error', () => {
      file.close();
      fs.unlink(destPath, () => {});
      resolve({ ok: false, status: 0 });
    });
  });
}

async function main() {
  if (!fs.existsSync(CATALOG_PATH)) {
    console.error(`ERROR: catalog not found at ${CATALOG_PATH}`);
    console.error('This file ships with the repo — did you check it out correctly?');
    process.exit(1);
  }

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const hexcodes = [...new Set(catalog.map((e) => e.hexcode))];

  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Reading catalog: ${CATALOG_PATH}`);
  console.log(`Found ${hexcodes.length} icons to fetch (OpenMoji ${OPENMOJI_REF})`);
  console.log(`Target: ${OUT_DIR}\n`);

  let downloaded = 0;
  let skipped = 0;
  const failed = [];

  for (let i = 0; i < hexcodes.length; i++) {
    const hex = hexcodes[i];
    const dest = path.join(OUT_DIR, `${hex}.png`);
    const progress = `[${String(i + 1).padStart(3, ' ')}/${hexcodes.length}]`;

    if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 100) {
      skipped++;
      continue;
    }

    let result = await fetchToFile(`${BASE_URL}/${hex}.png`, dest);

    // Tagged releases occasionally lag a rename/redesign on master; if
    // the pinned tag 404s for a given icon, fall back to master rather
    // than failing the whole run.
    if (!result.ok) {
      result = await fetchToFile(`${FALLBACK_BASE_URL}/${hex}.png`, dest);
    }

    const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    if (!result.ok || size < 100) {
      failed.push(hex);
      console.log(`  ${progress} FAILED  ${hex}`);
    } else {
      downloaded++;
      console.log(`  ${progress} OK      ${hex}`);
    }
  }

  // Attribution file — required by OpenMoji's CC BY-SA 4.0 license.
  fs.writeFileSync(
    path.join(OUT_DIR, 'LICENSE.txt'),
    `Icons in this folder are from OpenMoji (https://openmoji.org),
an open-source emoji and icon project by HfG Schw\u00e4bisch Gm\u00fcnd.

License: CC BY-SA 4.0
https://creativecommons.org/licenses/by-sa/4.0/

Source repository: https://github.com/hfg-gmuend/openmoji
This is a curated subset (see public/emoji-catalog.json), not the
full OpenMoji set, fetched via scripts/download-openmoji.js.

If you redistribute this project, keep this attribution.
`
  );

  console.log(`\nDone. Downloaded: ${downloaded}  Skipped (already present): ${skipped}  Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.log('\nThe following hexcodes failed to download:');
    for (const hex of failed) console.log(`  - ${hex}`);
    console.log('\nCheck your network connection and re-run this script — it will');
    console.log('only retry the missing ones. If a hexcode consistently fails, it');
    console.log('may have been renamed upstream; check https://hfg-gmuend.github.io/openmoji/');
    process.exit(1);
  }

  console.log(`All icons present in ${OUT_DIR}`);
}

main();
