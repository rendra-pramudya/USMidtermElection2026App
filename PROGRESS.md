# US Midterm Election 2026 App — Progress Log

Last updated: 2026-04-22 (rev 2)

---

## Overview

A Node.js + Electron app that watches semicolon-delimited election data files and pushes every field to a Vizrt Viz Engine 5.x via Shared Memory (TCP). Also serves a live web dashboard.

**Viz Engine target:** `localhost:6100`, path `MAIN*VIZ_COMMUNICATION*MAP`

---

## Phase 1 — Vizrt SHM Push Service ✅ DONE

### What was built
- `src/shared/parser.js` — parses the 5 semicolon-delimited TXT files into structured objects
- `src/shared/keymap.js` — maps parsed fields to SHM keys using the convention `ELECTION2026_<SCOPE>_<STATE>_<FIELD>`
- `src/shared/vizshm.js` — TCP client to Viz Engine; handles `SET_STRING_ELEMENT`, `SET_INTEGER_ELEMENT`, `SET_DOUBLE_ELEMENT`, `SET_BOOLEAN_ELEMENT`, plus CREATE/DELETE/HAS_ELEMENT
- `src/shared/pushService.js` — watches files with chokidar, debounces 500ms, diffs on change, pushes only changed keys

### Push modes (`config.json` → `shm.pushMode`)
| Mode | Description |
|------|-------------|
| `fields` | 1 key per parsed field (~1170 keys total) |
| `files` | 5 blob keys (raw TXT content, newlines encoded as pipe `\|`) |
| `hybrid` | Both fields and blobs simultaneously |

**Key encoding note:** Newlines in blob values are sent as `|` (pipe). Viz templates must split on `|` to reconstruct lines. Tab characters collapse to space.

### Unit tests
19/19 tests passing (`npm test`)

---

## Phase 1b — Hybrid Push + Blob Keys ✅ DONE

- 1170 per-field keys + 5 blob keys = **1175 keys total**, all accepted by Viz Engine
- Blob key names: `ELECTION2026_GOVERNOR_ALL`, `ELECTION2026_GOVERNOR_BY_STATE`, `ELECTION2026_HOUSE_ALL`, `ELECTION2026_HOUSE_BY_STATE`, `ELECTION2026_SENATE_ALL`
- End-to-end verified: SenateAll.txt (2 lines) → 2 pipes in wire payload

---

## Phase 2a — Electron Dashboard UI ✅ DONE

Replaces the original monitor-only Electron UI with a full election dashboard.

### Layout
- **Left (48%):** Live US map (`us.svg` from simplemaps.com, free commercial license)
- **Right (52%):** Three tabs — Governor / House / Senate

### Features
- **Map colors** update per active tab: GOP states = red, Dem = blue, Tied = purple, Running/no race = dark
- **Hover tooltip** on any state shows race-specific data (candidates, vote %, result)
- **Scoreboard** at the top of each tab: big seat counts, animated seat bar, majority marker
- **Governor tab:** per-state table with candidates, vote %, precincts in, result badge
- **House tab:** per-state table with GOP/Dem seat counts, remaining, state result
- **Senate tab:** state pills grouped by GOP wins / Dem wins / Running
- **Auto-refresh** every 5 seconds; Viz connection dot updates every 1 second
- **Push to Viz** button still works from the UI

### New IPC channels added
| Channel | Direction | Purpose |
|---------|-----------|---------|
| `get-election-data` | renderer → main | Returns `loadAll()` result as JSON |
| `get-svg` | renderer → main | Returns `us.svg` content as string |

### Files changed
- `src/main/main.js` — added 2 IPC handlers + `fs` / `parser` imports
- `src/main/preload.js` — added `getElectionData` + `getSvg` to contextBridge
- `src/renderer/index.html` — complete redesign (map + tabs layout)
- `src/renderer/styles.css` — complete dark-theme redesign
- `src/renderer/renderer.js` — complete rewrite (map coloring, tab rendering, tooltips)

---

## Phase 2b — Web Dashboard + Combined Server ✅ DONE

Adds a browser-accessible version of the dashboard alongside the Vizrt push service.

### Architecture
Single `server.js` process runs both:
1. Vizrt push service (same `PushService` class as Electron)
2. HTTP server on `http://localhost:3000`

The web page reuses `renderer.js` and `styles.css` verbatim from the Electron renderer — **zero code duplication** — via a fetch-based API adapter shim.

### New files
| File | Purpose |
|------|---------|
| `src/server/server.js` | Combined HTTP server + push service |
| `web/index.html` | Standalone web dashboard HTML |
| `web/api-adapter.js` | Shims `window.api` to use `fetch` instead of Electron IPC |
| `start.bat` | Double-click launcher — starts server + opens browser |

### Server API endpoints
| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/election-data` | All 5 files parsed to JSON |
| GET | `/api/stats` | Viz Engine connection status |
| POST | `/api/push-now` | Triggers manual push |

### How to run
| Method | Command |
|--------|---------|
| Batch file | Double-click `start.bat` |
| npm | `npm run web` |
| Direct | `node src/server/server.js` |
| Electron app | `npm start` |

---

## Data Files

| File | Type | Contents |
|------|------|----------|
| `GovernorAll.txt` | Aggregate | 36 governor races — total seats, GOP/Dem current counts, states won |
| `GovernorByState.txt` | Per-state | 35 states — candidates, vote %, winner |
| `HouseAll.txt` | Aggregate | 435 house seats — GOP/Dem totals, remaining |
| `HouseByState.txt` | Per-state | 50 states — GOP/Dem seats, state result |
| `SenateAll.txt` | Aggregate | 36 senate races — total + holdover counts, states won, running |

All files: semicolon-delimited, header row on line 1, one row per entity from line 2.

---

## Key Conventions

- **SHM key format:** `ELECTION2026_<SCOPE>_<STATE_OR_ALL>_<SCREAMING_SNAKE_FIELD>`
  - e.g. `ELECTION2026_GOVERNOR_BY_STATE_FL_GOP_VOTE_PERCENTAGE`
- **Viz Engine commands:** `SET_INTEGER_ELEMENT` (not `SET_INT_ELEMENT`), `SET_DOUBLE_ELEMENT` with value as quoted string
- **Blob encoding:** newlines → `|`, tabs → space
- **Config file:** `config.json` — viz engine host/port, file paths, push mode, debounce

---

## Phase 2c — Manual Edit Mode ✅ DONE

A toggle switch in the header switches between **Auto** (reads from TXT files every 5 s) and **Manual** (user edits values directly in the dashboard).

### How it works
- **Auto mode** (default): polls `/api/election-data` every 5 seconds, renders read-only tables
- **Manual mode**: stops auto-refresh, re-renders tables with editable `<input>` / `<select>` cells
- On each edit: local `electionData` is patched immediately (map updates instantly), then the override is POSTed to the server which pushes to Viz Engine
- **Clear All Overrides** button resets everything and re-fetches clean file data
- Switching back to Auto calls `clearOverrides` on the server and restarts the 5 s interval

### Override format (server/pushService)
`{ scope: string, key: string, value: any }`
- `scope` = `'governorAll'` | `'houseAll'` | `'senateAll'` | `'governorByState:FL'` | `'houseByState:TX'`
- `key` = field name e.g. `'GopVotePercentage'`, `'GopSeats'`, `'StateWonByGOP'`

### Editable fields by tab
| Tab | What can be edited |
|-----|--------------------|
| Governor | Vote % (GOP/Dem/In), Winner (GOP/Dem/Running dropdown), scoreboard totals |
| House | Seat counts (GOP/Dem/Remaining per state), majority winner dropdown, scoreboard totals |
| Senate | Aggregate counts (GopSeats/DemSeats/CurrentGop/CurrentDem) in scoreboard |

### New API endpoints (web server)
| Method | Path | Action |
|--------|------|--------|
| POST | `/api/field-edit` | Single override + push |
| POST | `/api/field-edits` | Batch overrides + single push |
| POST | `/api/clear-overrides` | Reset all overrides + push clean file data |
| GET | `/api/get-overrides` | List current overrides |

### Files changed
- `src/shared/pushService.js` — added `getDataWithOverrides()` + `getOverrides()`
- `src/main/main.js` — added `field-edit`, `field-edits` IPC; updated `get-election-data` to use overrides; updated `clear-overrides` to trigger push
- `src/main/preload.js` — added `fieldEdit`, `fieldEdits`, updated `clearOverrides`
- `src/server/server.js` — added all new API endpoints; `/api/election-data` now returns merged data
- `web/api-adapter.js` — added `fieldEdit`, `fieldEdits`, proper `clearOverrides`
- `src/renderer/index.html` + `web/index.html` — toggle switch + amber manual-mode banner
- `src/renderer/styles.css` — toggle pill, amber banner, editable cell inputs, score-input, cell-saved/error states
- `src/renderer/renderer.js` — complete rewrite: `manualMode` flag, `setMode()`, `handleCellEdit()`, `handleWinnerChange()`, `editNum()`, `editScoreNum()`, `editWinner()`, `attachEditHandlers()`

---

## Phase 2d — Manual Edit Push Bug Fix ✅ DONE

### Problem
In Manual mode, editing a value in the dashboard did not update the Viz Engine.

**Root cause:** `config.json` has `"pushMode": "files"`. The Viz templates read the five raw TXT blobs (not individual per-field keys). When a field edit was stored as an override and `pushNow()` was called, the code skipped the entire field-entries block (because `wantFields` was `false` for `pushMode='files'`), and the file blobs were read straight from disk — bypassing overrides entirely.

An intermediate fix that made overrides push as 1170 individual per-field keys did not help, because the templates never read those keys.

### Correct fix
Overrides are now serialized back into the same semicolon-delimited TXT format used by the data files and pushed as the five blob keys — identical wire format to a normal file-change push.

**New function: `buildFileEntriesFromDataset(dataset, dataSourceCfg, prefix)`** in `src/shared/keymap.js`
- Reads column headers from the original files (to preserve field order)
- Serializes the overridden in-memory dataset row-by-row back to `Field1;Field2;...` format
- Emits entries with `type: 'string-raw'` under the same 5 blob keys as `buildFileEntries`

**`_triggerPush` flow (updated):**
| Condition | What is pushed |
|-----------|---------------|
| `pushMode='files'`, no overrides | Raw file bytes (fast path, unchanged) |
| `pushMode='files'`, overrides active | Re-serialized blobs from overridden dataset |
| `pushMode='hybrid'` | Both per-field keys AND blobs (overridden or raw) |
| `forceFields=true` (clear-overrides) | Per-field keys from clean file data + raw blobs |

**`clearOverrides` push** passes `forceFields=true` (in both `server.js` and `main.js`) so Viz keys are explicitly reset to file values after clearing.

### Files changed
- `src/shared/keymap.js` — added `serializeRow` helper + `buildFileEntriesFromDataset`; exports updated; added `require('./parser')` for header reading
- `src/shared/pushService.js` — `_triggerPush` restructured to load dataset only when needed; file blobs now routed through `buildFileEntriesFromDataset` when overrides are active; `pushNow` and `_triggerPush` accept `forceFields` param
- `src/server/server.js` — `clear-overrides` endpoint passes `forceFields=true`
- `src/main/main.js` — `clear-overrides` IPC handler passes `forceFields=true`

---

## What's Next (Phase 3 ideas)

- [ ] SenateByState data file + editable state pills for senate winner
- [ ] Live API data source (replace TXT files with an election API)
- [ ] State click → drill-down detail panel
- [ ] Historical trend / seat change sparklines
- [ ] Multi-monitor: push different data sets to different Viz Engine scenes
