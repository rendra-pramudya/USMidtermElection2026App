'use strict';

const fs = require('fs');
const path = require('path');
const { parseFile } = require('./parser');

/**
 * Key mapping layer: election data objects -> flat array of Vizrt SHM entries.
 *
 * Naming convention (override via config.shm.keyPrefix):
 *   <PREFIX>_GOV_ALL_<FIELD>
 *   <PREFIX>_GOV_<STATE>_<FIELD>
 *   <PREFIX>_HOUSE_ALL_<FIELD>
 *   <PREFIX>_HOUSE_<STATE>_<FIELD>
 *   <PREFIX>_SENATE_ALL_<FIELD>
 *
 * Each entry: { key, value, type }   type in {'string','int','double','string-raw'}.
 *
 * Design notes:
 *   - Vizrt graphics templates usually bind to fixed string/int keys, so numeric
 *     fields are pushed as int or double explicitly rather than string, which
 *     lets the designer use arithmetic/bar-chart expressions without casting.
 *   - List fields (e.g. StatesWonByGOP) are joined with ',' so templates can
 *     ticker through them as a string.
 *   - Null values are normalised to '' (string), 0 (int), or 0 (double).
 */

const PERCENT_FIELDS = new Set([
  'TotalVotePercentage',
  'GopVotePercentage',
  'DemVotePercentage',
  'OthVotePercentage'
]);

const INT_FIELDS = new Set([
  'TotalSeats', 'CurrentGop', 'CurrentDem',
  'HoldoverGop', 'HoldoverDem',
  'GopSeats', 'DemSeats', 'OthersSeats', 'RemainingSeats',
  'GopDiff', 'DemDiff',
  'GopVoteCount', 'DemVoteCount', 'OthVoteCount'
]);

/** snake_case SCREAMING form for a camel/PascalCase field name. */
function toScreamingSnake(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase()
    .replace(/^_+|_+$/g, '');
}

function entryForField(keyBase, field, value) {
  const k = `${keyBase}_${toScreamingSnake(field)}`;

  if (value === null || value === undefined) {
    if (INT_FIELDS.has(field)) return { key: k, value: 0, type: 'int' };
    if (PERCENT_FIELDS.has(field)) return { key: k, value: 0, type: 'double' };
    return { key: k, value: '', type: 'string' };
  }

  if (Array.isArray(value)) {
    // list field -> comma-joined string + count companion
    return [
      { key: k, value: value.join(','), type: 'string' },
      { key: `${k}_COUNT`, value: value.length, type: 'int' }
    ];
  }

  if (INT_FIELDS.has(field)) {
    return { key: k, value: Number(value) || 0, type: 'int' };
  }
  if (PERCENT_FIELDS.has(field)) {
    return { key: k, value: Number(value) || 0, type: 'double' };
  }
  return { key: k, value: String(value), type: 'string' };
}

function expandRow(keyBase, row) {
  const out = [];
  if (!row) return out;
  for (const [field, value] of Object.entries(row)) {
    const r = entryForField(keyBase, field, value);
    if (Array.isArray(r)) out.push(...r);
    else out.push(r);
  }
  return out;
}

/**
 * Build SHM entries for the full election dataset.
 * @param {object} dataset - output of parser.loadAll()
 * @param {string} prefix - configured keyPrefix
 * @returns {Array<{key:string,value:any,type:string}>}
 */
function buildEntries(dataset, prefix) {
  const P = prefix || 'ELECTION2026';
  const entries = [];

  if (dataset.governorAll) {
    entries.push(...expandRow(`${P}_GOV_ALL`, dataset.governorAll));
  }
  for (const [state, row] of Object.entries(dataset.governorByState || {})) {
    entries.push(...expandRow(`${P}_GOV_${state}`, row));
  }

  if (dataset.houseAll) {
    entries.push(...expandRow(`${P}_HOUSE_ALL`, dataset.houseAll));
  }
  for (const [state, row] of Object.entries(dataset.houseByState || {})) {
    entries.push(...expandRow(`${P}_HOUSE_${state}`, row));
  }

  if (dataset.senateAll) {
    entries.push(...expandRow(`${P}_SENATE_ALL`, dataset.senateAll));
  }

  return entries;
}

/**
 * Hybrid-mode helper: read each configured TXT file raw and emit one SHM entry
 * per file whose value is the entire file contents. Keys are
 *   <PREFIX>_<FILENAME-IN-SCREAMING-SNAKE>
 * e.g. "governorByState" -> "ELECTION2026_GOVERNOR_BY_STATE".
 *
 * Emits entries with type "string-raw" so VizShmClient preserves newlines
 * (encoded as the 2-char literal "\n"). Missing files produce empty entries
 * rather than throwing, so the template always has keys to bind to.
 *
 * @param {object} dataSourceCfg   config.dataSource
 * @param {string} prefix          config.shm.keyPrefix
 * @returns {Array<{key:string,value:string,type:'string-raw'}>}
 */
function buildFileEntries(dataSourceCfg, prefix) {
  const P = prefix || 'ELECTION2026';
  const out = [];
  if (!dataSourceCfg || !dataSourceCfg.files) return out;
  const dir = path.resolve(dataSourceCfg.fileDir || '.');
  for (const [logicalName, fileName] of Object.entries(dataSourceCfg.files)) {
    const key = `${P}_${toScreamingSnake(logicalName)}`;
    const full = path.resolve(dir, fileName);
    let content = '';
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch (_) {
      content = '';
    }
    out.push({ key, value: content, type: 'string-raw' });
  }
  return out;
}

/**
 * Compute the diff between two entry arrays. Only returns entries whose value
 * or type differs from `prev`. Used to avoid pushing unchanged keys to Viz.
 */
function diffEntries(prev, next) {
  const prevMap = new Map(prev.map(e => [e.key, e]));
  const out = [];
  for (const n of next) {
    const p = prevMap.get(n.key);
    if (!p || p.type !== n.type || p.value !== n.value) {
      out.push(n);
    }
  }
  return out;
}

/**
 * Serialize one row object back to a semicolon-delimited string using the
 * given header order. Inverse of the parser — used to rebuild file blobs
 * from an in-memory dataset that has overrides applied.
 */
function serializeRow(headers, row) {
  return headers.map(h => {
    const v = row[h];
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.join(',');
    return String(v);
  }).join(';');
}

/**
 * Like buildFileEntries but serializes from an in-memory (overridden) dataset
 * instead of reading raw file bytes. The output format is identical to the
 * TXT files so Viz templates that parse the blob see the edited values.
 *
 * Headers are read from the original files to preserve column order.
 * Falls back to empty content if a file is missing.
 *
 * @param {object} dataset       - output of loadAll() with overrides applied
 * @param {object} dataSourceCfg - config.dataSource
 * @param {string} prefix        - config.shm.keyPrefix
 * @returns {Array<{key:string,value:string,type:'string-raw'}>}
 */
function buildFileEntriesFromDataset(dataset, dataSourceCfg, prefix) {
  const P = prefix || 'ELECTION2026';
  const out = [];
  if (!dataSourceCfg || !dataSourceCfg.files) return out;
  const dir = path.resolve(dataSourceCfg.fileDir || '.');
  const files = dataSourceCfg.files;

  const sections = [
    { name: 'governorAll',     file: files.governorAll,     isAll: true  },
    { name: 'governorByState', file: files.governorByState, isAll: false },
    { name: 'houseAll',        file: files.houseAll,        isAll: true  },
    { name: 'houseByState',    file: files.houseByState,    isAll: false },
    { name: 'senateAll',       file: files.senateAll,       isAll: true  },
  ];

  for (const { name, file, isAll } of sections) {
    if (!file) continue;
    const key = `${P}_${toScreamingSnake(name)}`;
    const data = dataset[name];
    let content = '';
    try {
      const filePath = path.resolve(dir, file);
      const { headers } = parseFile(filePath);
      if (isAll) {
        content = data ? headers.join(';') + '\n' + serializeRow(headers, data) : '';
      } else {
        const rows = data ? Object.values(data) : [];
        content = headers.join(';') + '\n' + rows.map(r => serializeRow(headers, r)).join('\n');
      }
    } catch (_) {
      content = '';
    }
    out.push({ key, value: content, type: 'string-raw' });
  }
  return out;
}

module.exports = {
  buildEntries,
  buildFileEntries,
  buildFileEntriesFromDataset,
  diffEntries,
  expandRow,
  entryForField,
  serializeRow,
  toScreamingSnake,
  INT_FIELDS,
  PERCENT_FIELDS
};
