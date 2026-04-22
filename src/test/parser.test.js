'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const parser = require('../shared/parser');
const keymap = require('../shared/keymap');

const ROOT = path.resolve(__dirname, '..', '..');

test('parser parses semicolon-delimited TXT with header row', () => {
  const text = [
    'A;B;C',
    '1;foo;bar',
    '2;;baz'
  ].join('\n');
  const { headers, rows } = parser.parseText(text);
  assert.deepStrictEqual(headers, ['A', 'B', 'C']);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].A, '1');
  assert.strictEqual(rows[1].B, null);
});

test('parser coerces numeric fields', () => {
  const text = 'TotalSeats;GopSeats\n435;212';
  const { rows } = parser.parseText(text);
  assert.strictEqual(rows[0].TotalSeats, 435);
  assert.strictEqual(rows[0].GopSeats, 212);
});

test('parser splits list fields on comma', () => {
  const text = 'StatesWonByGOP\nAL,AR,FL';
  const { rows } = parser.parseText(text);
  assert.deepStrictEqual(rows[0].StatesWonByGOP, ['AL', 'AR', 'FL']);
});

test('parser loads real sample files if present', () => {
  const cfg = {
    fileDir: ROOT,
    files: {
      governorAll: 'GovernorAll.txt',
      governorByState: 'GovernorByState.txt',
      houseAll: 'HouseAll.txt',
      houseByState: 'HouseByState.txt',
      senateAll: 'SenateAll.txt'
    }
  };
  const ds = parser.loadAll(cfg);
  assert.ok(ds.governorAll, 'governorAll should be parsed');
  assert.ok(ds.governorByState.FL, 'FL governor row should exist');
  assert.ok(typeof ds.governorByState.FL.GopVotePercentage === 'number');
});

test('keymap converts field names to SCREAMING_SNAKE', () => {
  assert.strictEqual(keymap.toScreamingSnake('TotalSeats'), 'TOTAL_SEATS');
  assert.strictEqual(keymap.toScreamingSnake('GopVotePercentage'), 'GOP_VOTE_PERCENTAGE');
  assert.strictEqual(keymap.toScreamingSnake('StatesWonByGOP'), 'STATES_WON_BY_GOP');
});

test('keymap entryForField typed correctly', () => {
  const intE = keymap.entryForField('P', 'GopSeats', 212);
  assert.strictEqual(intE.type, 'int');
  assert.strictEqual(intE.value, 212);
  assert.strictEqual(intE.key, 'P_GOP_SEATS');

  const pctE = keymap.entryForField('P', 'GopVotePercentage', 50.51);
  assert.strictEqual(pctE.type, 'double');

  const strE = keymap.entryForField('P', 'GopCandidate', 'Ron DeSantis');
  assert.strictEqual(strE.type, 'string');
});

test('keymap expands list field into list + count', () => {
  const result = keymap.entryForField('P', 'StatesWonByGOP', ['AL', 'FL', 'TX']);
  assert.ok(Array.isArray(result));
  assert.strictEqual(result[0].value, 'AL,FL,TX');
  assert.strictEqual(result[1].key, 'P_STATES_WON_BY_GOP_COUNT');
  assert.strictEqual(result[1].value, 3);
});

test('buildFileEntries emits one string-raw entry per TXT file', () => {
  const cfg = {
    fileDir: ROOT,
    files: {
      governorAll: 'GovernorAll.txt',
      governorByState: 'GovernorByState.txt',
      houseAll: 'HouseAll.txt',
      houseByState: 'HouseByState.txt',
      senateAll: 'SenateAll.txt'
    }
  };
  const entries = keymap.buildFileEntries(cfg, 'ELECTION2026');
  assert.strictEqual(entries.length, 5, 'one entry per configured file');
  const keys = entries.map(e => e.key).sort();
  assert.deepStrictEqual(keys, [
    'ELECTION2026_GOVERNOR_ALL',
    'ELECTION2026_GOVERNOR_BY_STATE',
    'ELECTION2026_HOUSE_ALL',
    'ELECTION2026_HOUSE_BY_STATE',
    'ELECTION2026_SENATE_ALL'
  ]);
  for (const e of entries) {
    assert.strictEqual(e.type, 'string-raw');
    assert.ok(typeof e.value === 'string' && e.value.length > 0, `${e.key} should have content`);
  }
});

test('buildFileEntries tolerates missing files by emitting empty content', () => {
  const cfg = {
    fileDir: ROOT,
    files: { doesNotExist: 'no_such_file_42.txt' }
  };
  const entries = keymap.buildFileEntries(cfg, 'P');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].key, 'P_DOES_NOT_EXIST');
  assert.strictEqual(entries[0].value, '');
  assert.strictEqual(entries[0].type, 'string-raw');
});

test('diffEntries returns only changed entries', () => {
  const prev = [
    { key: 'A', value: 1, type: 'int' },
    { key: 'B', value: 'x', type: 'string' }
  ];
  const next = [
    { key: 'A', value: 1, type: 'int' },
    { key: 'B', value: 'y', type: 'string' },
    { key: 'C', value: 0.5, type: 'double' }
  ];
  const d = keymap.diffEntries(prev, next);
  assert.strictEqual(d.length, 2);
  assert.ok(d.find(e => e.key === 'B'));
  assert.ok(d.find(e => e.key === 'C'));
});
