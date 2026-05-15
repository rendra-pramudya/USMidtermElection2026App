'use strict';

/**
 * SimulationService — generates fake election-night results by ticking
 * vote counts up from 0% toward a randomised final outcome, then writing
 * updated .txt files that the PushService file-watcher picks up automatically.
 *
 * Usage:
 *   const sim = new SimulationService(config.dataSource);
 *   sim.start();   sim.stop();   sim.reset();   sim.setSpeed(2);
 *   sim.getStatus() → { running, speed, initialized, governor, senate, house }
 */

const fs           = require('fs');
const path         = require('path');
const EventEmitter = require('events');
const { parseByStateFile } = require('./parser');

// 33 Senate Class-2 seats up in 2026
const SENATE_STATES = [
  'AL','AK','AR','CO','DE','GA','HI','ID','IL','IN',
  'KS','KY','LA','MA','ME','MI','MN','MT','NC','ND',
  'NH','NM','OH','OR','PA','SC','SD','TN','TX','UT',
  'VA','VT','WA',
];

const SENATE_HOLDOVER_GOP = 33;
const SENATE_HOLDOVER_DEM = 34;

class SimulationService extends EventEmitter {
  constructor(dataSourceCfg) {
    super();
    this._cfg     = dataSourceCfg;
    this._timer   = null;
    this._speed   = 1;
    this._running = false;
    this._gov     = null;
    this._house   = null;
    this._senate  = null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  start() {
    if (this._running) return;
    if (!this._gov) this._init();
    this._running = true;
    this._schedule();
    this.emit('status', this._status());
  }

  stop() {
    this._running = false;
    this._clearTimer();
    this.emit('status', this._status());
  }

  reset() {
    this.stop();
    this._gov = this._house = this._senate = null;
    this._init();
    this._writeAll();
    this.emit('status', this._status());
  }

  setSpeed(speed) {
    this._speed = Math.max(0.25, Math.min(20, +speed || 1));
    if (this._running) { this._clearTimer(); this._schedule(); }
    this.emit('status', this._status());
  }

  getStatus() { return this._status(); }

  // ── Scheduling ─────────────────────────────────────────────────────────────

  _clearTimer() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  _schedule() {
    const ms = Math.round(2500 / this._speed);
    this._timer = setTimeout(() => {
      this._tick();
      if (this._running && !this._isDone()) this._schedule();
      else {
        this._running = false;
        this._clearTimer();
        this.emit('status', this._status());
      }
    }, ms);
  }

  _isDone() {
    return (
      Object.values(this._gov).every(r => r.called) &&
      Object.values(this._house).every(s => s.remaining === 0) &&
      this._senate.running.length === 0
    );
  }

  // ── Tick ──────────────────────────────────────────────────────────────────

  _tick() {
    this._tickGov();
    this._tickHouse();
    this._tickSenate();
    this._writeAll();
    this.emit('tick', this._status());
  }

  _tickGov() {
    const open = Object.values(this._gov).filter(r => !r.called);
    if (!open.length) return;
    for (const race of this._sample(open, rnd(2, 5))) {
      race.pct = Math.min(100, race.pct + rnd(3, 10));
      this._callGov(race);
    }
  }

  _callGov(race) {
    const margin  = Math.abs(race.gopPct - race.demPct);
    const callAt  = margin > 12 ? 55 : margin > 6 ? 72 : 88;
    if (race.pct < callAt && race.pct < 99) return;
    race.called = race.gopPct >= race.demPct && race.gopPct >= race.othPct ? 'GOP'
                : race.demPct >= race.gopPct && race.demPct >= race.othPct ? 'Dem'
                : 'Oth';
  }

  _tickHouse() {
    const open = Object.values(this._house).filter(s => s.remaining > 0);
    if (!open.length) return;
    for (const st of this._sample(open, rnd(4, 9))) {
      const n = Math.min(st.remaining, rnd(1, 3));
      for (let i = 0; i < n; i++) {
        const rGop = st.tGop - st.gop;
        const rDem = st.tDem - st.dem;
        const tot  = rGop + rDem;
        if (tot <= 0) { st.remaining--; continue; }
        if (Math.random() < rGop / tot) st.gop++;
        else st.dem++;
        st.remaining--;
      }
    }
  }

  _tickSenate() {
    const { running, races } = this._senate;
    if (!running.length) return;
    for (const code of this._sample([...running], rnd(1, 3))) {
      const r      = races[code];
      r.pct        = Math.min(100, r.pct + rnd(8, 22));
      const margin = Math.abs(r.gopPct - r.demPct);
      const callAt = margin > 12 ? 55 : margin > 6 ? 72 : 88;
      if (r.pct < callAt) continue;
      r.called = r.gopPct > r.demPct ? 'GOP' : 'Dem';
      if (r.called === 'GOP') this._senate.gopSeats++;
      else this._senate.demSeats++;
      this._senate.running = this._senate.running.filter(s => s !== code);
    }
  }

  _sample(arr, n) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = 0 | (Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, Math.min(n, arr.length));
  }

  // ── Initialise ─────────────────────────────────────────────────────────────

  _init() {
    this._gov    = this._initGov();
    this._house  = this._initHouse();
    this._senate = this._initSenate();
  }

  _resolve(key) {
    return path.resolve(this._cfg.fileDir || '.', this._cfg.files[key]);
  }

  _initGov() {
    const out = {};
    try {
      const data = parseByStateFile(this._resolve('governorByState'));
      for (const [code, row] of Object.entries(data)) {
        const maxV   = (row.GopVoteCount || 0) + (row.DemVoteCount || 0) + (row.OthVoteCount || 0) || 500_000;
        const hasOth = !!(row.OthCandidate && row.OthCandidate.trim());
        const gopWins = Math.random() > 0.5;
        const margin  = 2 + Math.random() * 18;
        const othPct  = hasOth ? r1(1 + Math.random() * 4) : 0;
        let gopPct, demPct;
        if (gopWins) {
          gopPct = r1(50 + margin / 2 - othPct / 2);
          demPct = r1(100 - gopPct - othPct);
        } else {
          demPct = r1(50 + margin / 2 - othPct / 2);
          gopPct = r1(100 - demPct - othPct);
        }
        out[code] = {
          code,
          gopName:  row.GopCandidate || 'GOP Candidate',
          demName:  row.DemCandidate || 'Dem Candidate',
          othName:  row.OthCandidate  || '',
          othParty: row.OthCandidateParty || '',
          maxV, gopPct, demPct, othPct,
          pct: 0, called: '',
        };
      }
    } catch (e) {
      console.error('[sim] governor init:', e.message);
    }
    return out;
  }

  _initHouse() {
    const out = {};
    try {
      const data = parseByStateFile(this._resolve('houseByState'));
      for (const [code, row] of Object.entries(data)) {
        const total = row.TotalSeats || 1;
        const tGop  = Math.round(total * (0.28 + Math.random() * 0.44));
        const tDem  = total - tGop;
        out[code] = { code, total, tGop, tDem, gop: 0, dem: 0, remaining: total };
      }
    } catch (e) {
      console.error('[sim] house init:', e.message);
    }
    return out;
  }

  _initSenate() {
    const races = {};
    for (const code of SENATE_STATES) {
      const gopWins = Math.random() > 0.5;
      const margin  = 2 + Math.random() * 20;
      let gopPct, demPct;
      if (gopWins) {
        gopPct = r1(50 + margin / 2);
        demPct = r1(100 - gopPct);
      } else {
        demPct = r1(50 + margin / 2);
        gopPct = r1(100 - demPct);
      }
      races[code] = { gopPct, demPct, pct: 0, called: '' };
    }
    return {
      holdoverGop: SENATE_HOLDOVER_GOP,
      holdoverDem: SENATE_HOLDOVER_DEM,
      gopSeats: 0,
      demSeats: 0,
      running: [...SENATE_STATES],
      races,
    };
  }

  // ── File writing ──────────────────────────────────────────────────────────

  _writeAll() {
    this._writeGov();
    this._writeHouse();
    this._writeSenate();
  }

  _writeGov() {
    const ts     = nowStr();
    const allH   = 'TotalSeats;CurrentGop;CurrentDem;HoldoverGop;HoldoverDem;GopSeats;DemSeats;OthersSeats;RemainingSeats;GopDiff;DemDiff;StatesWonByGOP;StatesWonByDem;StatesWonByOthers;RunningStates;Timestamp';
    const byH    = 'StateCode;TotalVotePercentage;GopCandidate;DemCandidate;OthCandidate;OthCandidateParty;GopVotePercentage;DemVotePercentage;OthVotePercentage;GopVoteCount;DemVoteCount;OthVoteCount;StateWonByGOP;StateWonByDem;StateWonByOthers;Timestamp';
    const byRows = [byH];
    const wonGOP = [], wonDem = [], wonOth = [], running = [];

    for (const r of Object.values(this._gov)) {
      const totalV = Math.round(r.maxV * r.pct / 100);
      const gopV   = Math.round(totalV * r.gopPct / 100);
      const othV   = Math.round(totalV * r.othPct / 100);
      const demV   = Math.max(0, totalV - gopV - othV);
      const gP = totalV > 0 ? r2(gopV / totalV * 100) : 0;
      const dP = totalV > 0 ? r2(demV / totalV * 100) : 0;
      const oP = totalV > 0 ? r2(othV / totalV * 100) : 0;

      if      (r.called === 'GOP') wonGOP.push(r.code);
      else if (r.called === 'Dem') wonDem.push(r.code);
      else if (r.called === 'Oth') wonOth.push(r.code);
      else if (r.pct > 0)         running.push(r.code);

      byRows.push([
        r.code, r2(r.pct),
        r.gopName, r.demName, r.othName, r.othParty,
        gP, dP, oP, gopV, demV, othV,
        r.called === 'GOP' ? r.code : '',
        r.called === 'Dem' ? r.code : '',
        r.called === 'Oth' ? r.code : '',
        ts,
      ].join(';'));
    }

    const total = Object.keys(this._gov).length;
    const gS = wonGOP.length, dS = wonDem.length, oS = wonOth.length;
    const allRow = [total, gS, dS, 0, 0, gS, dS, oS, total - gS - dS - oS,
      '', '', wonGOP.join(','), wonDem.join(','), wonOth.join(','), running.join(','), ts].join(';');

    fs.writeFileSync(this._resolve('governorAll'),    [allH,  allRow].join('\n') + '\n');
    fs.writeFileSync(this._resolve('governorByState'), byRows.join('\n') + '\n');
  }

  _writeHouse() {
    const ts     = nowStr();
    const allH   = 'TotalSeats;CurrentGop;CurrentDem;GopSeats;DemSeats;OthersSeats;RemainingSeats;GopDiff;DemDiff;StatesWonByGOP;StatesWonByDem;StatesWonByOthers;StateTied;RunningStates;Timestamp';
    const byH    = 'StateCode;TotalSeats;GopSeats;DemSeats;OthersSeats;RemainingSeats;StateWonByGOP;StateWonByDem;StateWonByOthers;StateTied;Timestamp';
    const byRows = [byH];
    const wonGOP = [], wonDem = [], tied = [], running = [];
    let gopTot = 0, demTot = 0, remTot = 0;

    for (const s of Object.values(this._house)) {
      gopTot += s.gop; demTot += s.dem; remTot += s.remaining;
      const done   = s.remaining === 0;
      const swGOP  = done && s.gop > s.dem  ? s.code : '';
      const swDem  = done && s.dem > s.gop  ? s.code : '';
      const stTied = done && s.gop === s.dem ? s.code : '';

      if (done) {
        if      (s.gop > s.dem)  wonGOP.push(s.code);
        else if (s.dem > s.gop)  wonDem.push(s.code);
        else                     tied.push(s.code);
      } else if (s.gop > 0 || s.dem > 0) running.push(s.code);

      byRows.push([s.code, s.total, s.gop, s.dem, 0, s.remaining,
        swGOP, swDem, '', stTied, ts].join(';'));
    }

    const allRow = [435, gopTot, demTot, gopTot, demTot, 0, remTot, '', '',
      wonGOP.join(','), wonDem.join(','), '', tied.join(','), running.join(','), ts].join(';');

    fs.writeFileSync(this._resolve('houseAll'),    [allH,  allRow].join('\n') + '\n');
    fs.writeFileSync(this._resolve('houseByState'), byRows.join('\n') + '\n');
  }

  _writeSenate() {
    const ts = nowStr();
    const { holdoverGop, holdoverDem, gopSeats, demSeats, running, races } = this._senate;
    const wonGOP = Object.entries(races).filter(([, r]) => r.called === 'GOP').map(([c]) => c);
    const wonDem = Object.entries(races).filter(([, r]) => r.called === 'Dem').map(([c]) => c);
    const header = 'TotalSeats;CurrentGop;CurrentDem;HoldoverGop;HoldoverDem;GopSeats;DemSeats;OthersSeats;RemainingSeats;GopDiff;DemDiff;StatesWonByGOP;StatesWonByDem;StatesWonByOthers;StateTied;RunningStates;Timestamp';
    const row    = [
      SENATE_STATES.length,
      holdoverGop + gopSeats, holdoverDem + demSeats,
      holdoverGop, holdoverDem,
      gopSeats, demSeats, 0, running.length,
      '', '',
      wonGOP.join(','), wonDem.join(','), '', '',
      running.join(','), ts,
    ].join(';');
    fs.writeFileSync(this._resolve('senateAll'), [header, row].join('\n') + '\n');
  }

  // ── Status ────────────────────────────────────────────────────────────────

  _status() {
    const govV   = this._gov    ? Object.values(this._gov)   : [];
    const houseV = this._house  ? Object.values(this._house) : [];
    const sen    = this._senate;

    return {
      running:     this._running,
      speed:       this._speed,
      initialized: !!this._gov,
      governor: {
        called: govV.filter(r => r.called).length,
        total:  govV.length,
      },
      senate: {
        called: sen ? (sen.gopSeats + sen.demSeats) : 0,
        total:  sen ? SENATE_STATES.length : 0,
      },
      house: {
        called: houseV.reduce((a, s) => a + s.total - s.remaining, 0),
        total:  houseV.reduce((a, s) => a + s.total, 0),
      },
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function rnd(min, max) { return min + (Math.random() * (max - min + 1) | 0); }
function r1(n)         { return Math.round(n * 10)  / 10;  }
function r2(n)         { return Math.round(n * 100) / 100; }
function nowStr()      { return new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }); }

module.exports = { SimulationService };
