# US Midterm Election 2026 App

Dashboard + Vizrt Shared Memory push service for broadcast graphics.

## What it does

1. **Dashboard (Electron)** — displays live US Midterm 2026 election results (Senate, House, Governor) with per-state breakdowns. *(UI beyond monitor is phase 2.)*
2. **Vizrt SHM push service** — watches the result TXT files, parses them, and pushes every field into the Viz Engine shared-memory map over TCP so on-air graphics update in real time.

## Architecture

```
 +----------------+     +-----------------+     +----------------+
 |  TXT files     | --> |  PushService    | --> |  Viz Engine    |
 |  (polled)      |     |  parse+diff     | TCP |  MAIN*VIZ_COMM |
 +----------------+     |  +keymap        | :6100   *MAP        |
                        +--------+--------+     +----------------+
                                 |
                                 v
                        +-----------------+
                        |  Electron UI    |
                        |  monitor+status |
                        +-----------------+
```

All wiring goes through `src/shared/pushService.js`. The Electron main process and the standalone `npm run push` CLI share the same service.

## File layout

```
package.json             npm scripts, deps
config.json              Viz Engine host/port, file paths, key prefix
src/
  main/
    main.js              Electron main process
    preload.js           contextBridge (IPC → renderer)
  renderer/
    index.html / renderer.js / styles.css
  shared/
    parser.js            semicolon TXT parser
    vizshm.js            Viz Engine TCP client (null-terminated command framing)
    keymap.js            election data → SHM key entries (+ diff)
    pushService.js       orchestrates watch → parse → diff → push
  test/
    mockVizEngine.js     stand-in Viz Engine for local testing
    parser.test.js
    vizshm.test.js
```

## Install

```
npm install
```

## Run

### Full app (Electron UI + push service)

```
npm start
```

### Push service only (headless)

```
npm run push
```

### Local testing without Vizrt

In one terminal, start the mock engine:
```
npm run mock-viz
```
It listens on `127.0.0.1:6100` (default in `config.json`) and logs every SHM SET it receives.

In another terminal:
```
npm run push
```
Edit one of the `.txt` files — the service debounces for 500ms then pushes the diff.

### Unit tests

```
npm test
```

## Configuration (`config.json`)

| Field | Purpose |
| --- | --- |
| `vizEngine.host` / `port` | Viz Engine command port (default 6100). |
| `vizEngine.reconnectIntervalMs` | Retry interval when socket closes. |
| `vizEngine.commandTimeoutMs` | Per-command timeout before the request rejects. |
| `dataSource.mode` | `file` = polling TXT. (`api`, `manual` to be added in phase 2.) |
| `dataSource.fileDir` | Directory containing the 5 TXT files. |
| `dataSource.files.*` | File names for each dataset. |
| `dataSource.watchDebounceMs` | Debounce after the watcher fires before pushing. |
| `shm.keyPrefix` | Prefix every SHM key with this string (default `ELECTION2026`). |
| `shm.pushOnlyChanged` | When `true`, only push entries whose value changed since last push. |
| `shm.logCommands` | Emit every TCP command as an event (for debug). |

## SHM key convention

```
<PREFIX>_GOV_ALL_<FIELD>           e.g. ELECTION2026_GOV_ALL_GOP_SEATS       (int)
<PREFIX>_GOV_<STATE>_<FIELD>       e.g. ELECTION2026_GOV_FL_GOP_CANDIDATE    (string)
<PREFIX>_HOUSE_ALL_<FIELD>         e.g. ELECTION2026_HOUSE_ALL_DEM_SEATS     (int)
<PREFIX>_HOUSE_<STATE>_<FIELD>     e.g. ELECTION2026_HOUSE_CA_GOP_SEATS      (int)
<PREFIX>_SENATE_ALL_<FIELD>        e.g. ELECTION2026_SENATE_ALL_REMAINING_SEATS (int)
```

List fields (e.g. `StatesWonByGOP`) are emitted twice: as a comma-joined string and as a `_COUNT` int companion so templates can read either.

Field-level type mapping is in `src/shared/keymap.js` — `INT_FIELDS`, `PERCENT_FIELDS`, and everything else defaults to string.

## Viz protocol notes

Each command is framed as:
```
<cmdId> <command>\0
```
The shared memory map is addressed as `MAIN*VIZ_COMMUNICATION*MAP`. Example wire format for one push:
```
42 MAIN*VIZ_COMMUNICATION*MAP SET_INT_ELEMENT "ELECTION2026_GOV_ALL_GOP_SEATS" 16\0
```
Success reply: `42 0\0`. Error reply starts with `ERROR` and the client rejects that command's promise.

## Roadmap

- Phase 1 (current) — Vizrt SHM push, monitor UI, file-based data source.
- Phase 2 — Full dashboard views (Senate/House/Governor tabs, state drill-down), manual override form, API data source.
- Phase 3 — Scene/template management (trigger `STAGE*DIRECTOR*@START`), role-based UI, audit log.
