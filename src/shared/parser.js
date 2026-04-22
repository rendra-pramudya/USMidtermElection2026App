'use strict';

/**
 * Parser for semicolon-delimited election TXT files.
 *
 * Format convention (based on sample data from 2022 midterm):
 *   - First line = header row (field names separated by ';')
 *   - Subsequent lines = data rows
 *   - Empty string means "no value" (null)
 *   - Comma-separated lists appear in fields like "StatesWonByGOP"
 *
 * Exposes one generic parser + five typed helpers, one per file.
 */

const fs = require('fs');
const path = require('path');

const NUMERIC_FIELDS = new Set([
  'TotalSeats', 'CurrentGop', 'CurrentDem',
  'HoldoverGop', 'HoldoverDem',
  'GopSeats', 'DemSeats', 'OthersSeats', 'RemainingSeats',
  'GopDiff', 'DemDiff',
  'TotalVotePercentage',
  'GopVotePercentage', 'DemVotePercentage', 'OthVotePercentage',
  'GopVoteCount', 'DemVoteCount', 'OthVoteCount'
]);

const LIST_FIELDS = new Set([
  'StatesWonByGOP', 'StatesWonByDem', 'StatesWonByOthers',
  'StateTied', 'RunningStates'
]);

/**
 * Parse raw text content into an array of row objects.
 * @param {string} text - raw file content
 * @returns {{headers: string[], rows: object[]}}
 */
function parseText(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = lines[0].split(';').map(h => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(';');
    const row = {};
    for (let c = 0; c < headers.length; c++) {
      const h = headers[c];
      const raw = (cols[c] ?? '').trim();

      if (raw === '') {
        row[h] = null;
        continue;
      }

      if (LIST_FIELDS.has(h)) {
        row[h] = raw.split(',').map(s => s.trim()).filter(Boolean);
        continue;
      }

      if (NUMERIC_FIELDS.has(h)) {
        const n = Number(raw);
        row[h] = Number.isNaN(n) ? raw : n;
        continue;
      }

      row[h] = raw;
    }
    rows.push(row);
  }

  return { headers, rows };
}

/**
 * Parse a file from disk.
 * @param {string} filePath
 * @returns {{headers: string[], rows: object[]}}
 */
function parseFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return parseText(text);
}

/**
 * Parse an "All" type file (single aggregate row).
 * Returns the first row or null.
 */
function parseAllFile(filePath) {
  const { rows } = parseFile(filePath);
  return rows[0] ?? null;
}

/**
 * Parse a "ByState" file — returns a map keyed by state code.
 */
function parseByStateFile(filePath) {
  const { rows } = parseFile(filePath);
  const byState = {};
  for (const row of rows) {
    if (row.StateCode) byState[row.StateCode] = row;
  }
  return byState;
}

/**
 * Load and parse the full election dataset based on config.
 * @param {object} dataSourceCfg - from config.json "dataSource"
 * @returns {{governorAll: object|null, governorByState: object, houseAll: object|null, houseByState: object, senateAll: object|null}}
 */
function loadAll(dataSourceCfg) {
  const dir = dataSourceCfg.fileDir || '.';
  const files = dataSourceCfg.files || {};
  const resolve = (f) => path.resolve(dir, f);

  const result = {
    governorAll: null,
    governorByState: {},
    houseAll: null,
    houseByState: {},
    senateAll: null
  };

  if (files.governorAll && fs.existsSync(resolve(files.governorAll))) {
    result.governorAll = parseAllFile(resolve(files.governorAll));
  }
  if (files.governorByState && fs.existsSync(resolve(files.governorByState))) {
    result.governorByState = parseByStateFile(resolve(files.governorByState));
  }
  if (files.houseAll && fs.existsSync(resolve(files.houseAll))) {
    result.houseAll = parseAllFile(resolve(files.houseAll));
  }
  if (files.houseByState && fs.existsSync(resolve(files.houseByState))) {
    result.houseByState = parseByStateFile(resolve(files.houseByState));
  }
  if (files.senateAll && fs.existsSync(resolve(files.senateAll))) {
    result.senateAll = parseAllFile(resolve(files.senateAll));
  }

  return result;
}

module.exports = {
  parseText,
  parseFile,
  parseAllFile,
  parseByStateFile,
  loadAll,
  NUMERIC_FIELDS,
  LIST_FIELDS
};
