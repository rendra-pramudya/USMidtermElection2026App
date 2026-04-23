'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const STATE_NAMES = {
  AL:'Alabama',    AK:'Alaska',        AZ:'Arizona',       AR:'Arkansas',
  CA:'California', CO:'Colorado',      CT:'Connecticut',   DE:'Delaware',
  FL:'Florida',    GA:'Georgia',       HI:'Hawaii',        ID:'Idaho',
  IL:'Illinois',   IN:'Indiana',       IA:'Iowa',          KS:'Kansas',
  KY:'Kentucky',   LA:'Louisiana',     ME:'Maine',         MD:'Maryland',
  MA:'Massachusetts', MI:'Michigan',   MN:'Minnesota',     MS:'Mississippi',
  MO:'Missouri',   MT:'Montana',       NE:'Nebraska',      NV:'Nevada',
  NH:'New Hampshire', NJ:'New Jersey', NM:'New Mexico',    NY:'New York',
  NC:'North Carolina', ND:'North Dakota', OH:'Ohio',       OK:'Oklahoma',
  OR:'Oregon',     PA:'Pennsylvania',  RI:'Rhode Island',  SC:'South Carolina',
  SD:'South Dakota', TN:'Tennessee',   TX:'Texas',         UT:'Utah',
  VT:'Vermont',    VA:'Virginia',      WA:'Washington',    WV:'West Virginia',
  WI:'Wisconsin',  WY:'Wyoming'
};

const PARTY_COLORS = {
  gop:     '#e84040',
  dem:     '#3b82f6',
  tied:    '#a855f7',
  running: '#253a55',
  none:    '#111e30',
};

// ── App State ─────────────────────────────────────────────────────────────────
let electionData      = null;
let currentTab        = 'governor';
let mapHoverReady     = false;
let manualMode        = false;
let dataIntervalId    = null;

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function init() {
  initTabNav();
  initModeToggle();
  initPushBtn();
  await loadAndInjectSvg();
  await refreshElectionData();

  dataIntervalId = setInterval(refreshElectionData, 5000);
  setInterval(refreshVizStats, 1000);
}

// ── SVG ───────────────────────────────────────────────────────────────────────
async function loadAndInjectSvg() {
  const svgText = await window.api.getSvg();
  const container = document.getElementById('map-container');
  if (!svgText) {
    container.innerHTML = '<div class="loading-text">us.svg not found</div>';
    return;
  }
  container.innerHTML = svgText;

  const svg = container.querySelector('svg');
  if (svg) {
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.width  = '100%';
    svg.style.height = '100%';
    const rootStyle = svg.getAttribute('style') || '';
    svg.setAttribute('style', rootStyle.replace(/fill\s*:\s*none\s*;?/, ''));
  }

  container.querySelectorAll('[data-id]').forEach(el => {
    el.style.fill       = PARTY_COLORS.none;
    el.style.cursor     = 'pointer';
    el.style.transition = 'filter 0.1s, fill 0.3s';
  });
}

// ── Data Refresh ──────────────────────────────────────────────────────────────
async function refreshElectionData() {
  try {
    const data = await window.api.getElectionData();
    electionData = data;
    if (data) {
      updateMap();
      renderAllTabs(data);
      if (!mapHoverReady) { setupMapHover(); mapHoverReady = true; }
    }
  } catch (e) {
    console.error('get-election-data failed:', e);
  }
}

// ── Mode Toggle ───────────────────────────────────────────────────────────────
function initModeToggle() {
  const toggle = document.getElementById('mode-toggle');
  const banner = document.getElementById('manual-banner');
  const clearBtn = document.getElementById('clear-overrides-btn');

  toggle.addEventListener('change', () => {
    setMode(toggle.checked ? 'manual' : 'auto');
  });

  clearBtn.addEventListener('click', async () => {
    clearBtn.textContent = 'Clearing…';
    clearBtn.disabled = true;
    try {
      await window.api.clearOverrides();
      // Fetch fresh data (now without overrides)
      const data = await window.api.getElectionData();
      electionData = data;
      if (data) { updateMap(); renderAllTabs(data); }
    } finally {
      clearBtn.textContent = 'Clear All Overrides';
      clearBtn.disabled = false;
    }
  });
}

function setMode(mode) {
  manualMode = (mode === 'manual');

  // Update toggle knob
  const toggle = document.getElementById('mode-toggle');
  if (toggle) toggle.checked = manualMode;

  // Update label colours
  const labelAuto   = document.getElementById('mode-label-auto');
  const labelManual = document.getElementById('mode-label-manual');
  if (labelAuto)   labelAuto.classList.toggle('dim',  manualMode);
  if (labelManual) labelManual.classList.toggle('dim', !manualMode);

  // Banner
  const banner = document.getElementById('manual-banner');
  if (banner) banner.classList.toggle('hidden', !manualMode);

  if (manualMode) {
    // Stop auto refresh — user is driving
    clearInterval(dataIntervalId);
    dataIntervalId = null;
    // Re-render tables with editable inputs
    if (electionData) renderAllTabs(electionData);
  } else {
    // Clear server overrides (fire-and-forget, user has chosen auto)
    window.api.clearOverrides().catch(() => {});
    // Restart auto refresh
    refreshElectionData().then(() => {
      dataIntervalId = setInterval(refreshElectionData, 5000);
    });
  }
}

// ── Manual Edit Helpers ───────────────────────────────────────────────────────

/**
 * Apply a single field edit: update local electionData, refresh map, POST to server.
 * scope = 'governorAll' | 'governorByState:FL' | 'houseAll' | 'houseByState:TX' | 'senateAll'
 * key   = field name, e.g. 'GopVotePercentage'
 * value = new value (already cast to correct type)
 */
async function handleCellEdit(scope, key, value, inputEl) {
  // 1. Patch local data immediately (drives map update)
  const [scopeName, stateCode] = scope.split(':');
  if (stateCode) {
    if (electionData[scopeName] && electionData[scopeName][stateCode]) {
      electionData[scopeName][stateCode][key] = value;
    }
  } else if (electionData[scopeName]) {
    electionData[scopeName][key] = value;
  }

  // 2. Redraw map with updated data
  updateMap();

  // 3. Visual saving state
  if (inputEl) { inputEl.classList.add('cell-saving'); inputEl.classList.remove('cell-saved', 'cell-error'); }

  // 4. POST to server → push to Viz
  try {
    await window.api.fieldEdit({ scope, key, value });
    if (inputEl) {
      inputEl.classList.remove('cell-saving');
      inputEl.classList.add('cell-saved');
      setTimeout(() => inputEl.classList.remove('cell-saved'), 1200);
      // Mark row as edited
      const row = inputEl.closest('tr');
      if (row) row.classList.add('row-edited');
    }
  } catch (e) {
    console.error('fieldEdit failed:', e);
    if (inputEl) { inputEl.classList.remove('cell-saving'); inputEl.classList.add('cell-error'); }
  }
}

/**
 * Handle winner select change (sets StateWonByGOP + StateWonByDem together).
 * party = 'gop' | 'dem' | '' (running)
 */
async function handleWinnerChange(scope, stateCode, party, selectEl) {
  const [scopeName] = scope.split(':');
  const row = electionData[scopeName]?.[stateCode];
  if (row) {
    row.StateWonByGOP = party === 'gop' ? stateCode : '';
    row.StateWonByDem = party === 'dem' ? stateCode : '';
  }
  updateMap();

  if (selectEl) selectEl.disabled = true;
  try {
    await window.api.fieldEdits([
      { scope, key: 'StateWonByGOP', value: party === 'gop' ? stateCode : '' },
      { scope, key: 'StateWonByDem', value: party === 'dem' ? stateCode : '' },
    ]);
    if (selectEl) {
      const tr = selectEl.closest('tr');
      if (tr) tr.classList.add('row-edited');
    }
  } catch (e) {
    console.error('fieldEdits failed:', e);
  } finally {
    if (selectEl) selectEl.disabled = false;
  }
}

/** Attach change/blur handlers to all .cell-input and .cell-select elements in the DOM. */
function attachEditHandlers() {
  document.querySelectorAll('.cell-input').forEach(input => {
    // Remove existing listeners by cloning (safe for dynamically rendered content)
    const fresh = input.cloneNode(true);
    input.parentNode.replaceChild(fresh, input);

    fresh.addEventListener('change', () => {
      const scope = fresh.dataset.scope;
      const key   = fresh.dataset.field;
      const type  = fresh.dataset.type || 'string';
      let value   = fresh.value;
      if (type === 'double') value = parseFloat(value) || 0;
      if (type === 'int')    value = parseInt(value, 10) || 0;
      handleCellEdit(scope, key, value, fresh);
    });

    fresh.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') fresh.blur();
      if (e.key === 'Escape') { fresh.value = fresh.dataset.orig || fresh.value; fresh.blur(); }
    });
  });

  document.querySelectorAll('.cell-select').forEach(sel => {
    const fresh = sel.cloneNode(true);
    sel.parentNode.replaceChild(fresh, sel);

    fresh.addEventListener('change', () => {
      const scope     = fresh.dataset.scope;
      const stateCode = fresh.dataset.state;
      handleWinnerChange(scope, stateCode, fresh.value, fresh);
    });
  });
}

// ── Map Coloring ──────────────────────────────────────────────────────────────
function computeStateColors(tab, data) {
  const colors = {};
  if (tab === 'governor') {
    for (const [state, info] of Object.entries(data.governorByState || {})) {
      colors[state] = info.StateWonByGOP ? 'gop'
                    : info.StateWonByDem  ? 'dem'
                    : 'running';
    }
  } else if (tab === 'house') {
    for (const [state, info] of Object.entries(data.houseByState || {})) {
      colors[state] = info.StateWonByGOP ? 'gop'
                    : info.StateWonByDem  ? 'dem'
                    : info.StateTied      ? 'tied'
                    : 'running';
    }
  } else if (tab === 'senate') {
    const all = data.senateAll || {};
    for (const s of (all.StatesWonByGOP || [])) colors[s] = 'gop';
    for (const s of (all.StatesWonByDem || [])) colors[s] = 'dem';
    for (const s of (all.StateTied      || [])) colors[s] = 'tied';
    for (const s of (all.RunningStates  || [])) colors[s] = 'running';
  }
  return colors;
}

function updateMap() {
  if (!electionData) return;
  const stateColors = computeStateColors(currentTab, electionData);
  document.querySelectorAll('#map-container [data-id]').forEach(el => {
    el.style.fill = PARTY_COLORS.none;
  });
  for (const [state, party] of Object.entries(stateColors)) {
    const el = document.getElementById(state);
    if (el) el.style.fill = PARTY_COLORS[party] || PARTY_COLORS.none;
  }
}

// ── Map Hover / Tooltip ───────────────────────────────────────────────────────
function setupMapHover() {
  const tooltip = document.getElementById('tooltip');
  document.addEventListener('mousemove', (e) => {
    let x = e.clientX + 14, y = e.clientY - 50;
    if (x + 250 > window.innerWidth)  x = e.clientX - 260;
    if (y < 0) y = e.clientY + 14;
    tooltip.style.left = x + 'px';
    tooltip.style.top  = y + 'px';
  });
  document.querySelectorAll('#map-container [data-id]').forEach(el => {
    const state = el.getAttribute('data-id') || el.id;
    el.addEventListener('mouseenter', () => {
      tooltip.innerHTML = buildTooltip(state);
      tooltip.classList.remove('hidden');
      el.style.filter = 'brightness(1.5) saturate(1.2)';
    });
    el.addEventListener('mouseleave', () => {
      tooltip.classList.add('hidden');
      el.style.filter = '';
    });
  });
}

function buildTooltip(state) {
  const name = STATE_NAMES[state] || state;
  let html = `<div class="tooltip-state">${name}</div>`;
  if (!electionData) return html;

  if (currentTab === 'governor') {
    const info = (electionData.governorByState || {})[state];
    if (info) {
      html += tRow('GOP', `${info.GopCandidate || '—'}  ${fmt(info.GopVotePercentage)}%`, 'gop');
      html += tRow('Dem', `${info.DemCandidate || '—'}  ${fmt(info.DemVotePercentage)}%`, 'dem');
      if (info.OthCandidate) html += tRow('Oth', `${info.OthCandidate}  ${fmt(info.OthVotePercentage)}%`, 'dim');
      html += tRow('Precincts', `${fmt(info.TotalVotePercentage)}% in`);
      const res = info.StateWonByGOP ? '<span style="color:#e84040">● GOP Win</span>'
                : info.StateWonByDem  ? '<span style="color:#3b82f6">● Dem Win</span>'
                : '<span style="color:#516278">● Running</span>';
      html += `<div class="tooltip-result">${res}</div>`;
    } else {
      html += '<div class="tooltip-none">No governor race this cycle</div>';
    }
  } else if (currentTab === 'house') {
    const info = (electionData.houseByState || {})[state];
    if (info) {
      html += tRow('Total seats', info.TotalSeats);
      html += tRow('GOP', info.GopSeats, 'gop');
      html += tRow('Dem', info.DemSeats, 'dem');
      if (info.RemainingSeats > 0) html += tRow('Remaining', info.RemainingSeats);
      const res = info.StateWonByGOP ? '<span style="color:#e84040">● GOP Majority</span>'
                : info.StateWonByDem  ? '<span style="color:#3b82f6">● Dem Majority</span>'
                : info.StateTied      ? '<span style="color:#a855f7">● Tied</span>'
                : '<span style="color:#516278">● Running</span>';
      html += `<div class="tooltip-result">${res}</div>`;
    }
  } else if (currentTab === 'senate') {
    const all  = electionData.senateAll || {};
    const gop  = all.StatesWonByGOP || [];
    const dem  = all.StatesWonByDem || [];
    const run  = all.RunningStates  || [];
    const tied = all.StateTied      || [];
    if      (gop.includes(state))  html += '<div class="tooltip-result"><span style="color:#e84040">● GOP Win</span></div>';
    else if (dem.includes(state))  html += '<div class="tooltip-result"><span style="color:#3b82f6">● Dem Win</span></div>';
    else if (tied.includes(state)) html += '<div class="tooltip-result"><span style="color:#a855f7">● Tied</span></div>';
    else if (run.includes(state))  html += '<div class="tooltip-result"><span style="color:#516278">● Running</span></div>';
    else html += '<div class="tooltip-none">No Senate race this cycle</div>';
  }
  return html;
}

function tRow(label, value, party) {
  const color = party === 'gop' ? '#e84040' : party === 'dem' ? '#3b82f6' : '#8ea3be';
  return `<div class="tooltip-row"><span class="tooltip-label">${label}</span><span style="color:${color}">${value}</span></div>`;
}
function fmt(v) { return v != null ? v : '—'; }

// ── Tab Navigation ────────────────────────────────────────────────────────────
function initTabNav() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(el =>
    el.classList.toggle('hidden', el.id !== 'content-' + tab));
  updateMap();
  // Re-attach edit handlers for the newly-visible tab
  if (manualMode) attachEditHandlers();
}

// ── Tab Rendering ─────────────────────────────────────────────────────────────
function renderAllTabs(data) {
  renderGovernorTab(data);
  renderHouseTab(data);
  renderSenateTab(data);
  if (manualMode) attachEditHandlers();
}

// ── Editable cell/score helpers ───────────────────────────────────────────────
function editNum(scope, field, value, type = 'int', extraClass = '') {
  if (!manualMode) return `${value ?? '—'}`;
  const orig = value ?? 0;
  return `<input class="cell-input${extraClass ? ' ' + extraClass : ''}" type="number"
    value="${orig}" data-orig="${orig}"
    data-scope="${scope}" data-field="${field}" data-type="${type}"
    step="${type === 'double' ? '0.01' : '1'}" min="0">`;
}

function editScoreNum(scope, field, value, cls) {
  if (!manualMode) return `${value ?? '—'}`;
  const orig = value ?? 0;
  return `<input class="score-input" type="number"
    value="${orig}" data-orig="${orig}"
    data-scope="${scope}" data-field="${field}" data-type="int"
    style="color:inherit">`;
}

function editWinner(scope, stateCode, wonByGOP, wonByDem) {
  if (!manualMode) return resultBadge(wonByGOP, wonByDem, null);
  const val = wonByGOP ? 'gop' : wonByDem ? 'dem' : '';
  return `<select class="cell-select" data-scope="${scope}" data-state="${stateCode}">
    <option value="gop" ${val === 'gop' ? 'selected' : ''}>GOP Win</option>
    <option value="dem" ${val === 'dem' ? 'selected' : ''}>Dem Win</option>
    <option value=""    ${val === ''    ? 'selected' : ''}>Running</option>
  </select>`;
}

function editHouseWinner(scope, stateCode, wonByGOP, wonByDem, tied) {
  if (!manualMode) return resultBadge(wonByGOP, wonByDem, tied);
  const val = wonByGOP ? 'gop' : wonByDem ? 'dem' : tied ? 'tied' : '';
  return `<select class="cell-select" data-scope="${scope}" data-state="${stateCode}">
    <option value="gop"  ${val === 'gop'  ? 'selected' : ''}>GOP Majority</option>
    <option value="dem"  ${val === 'dem'  ? 'selected' : ''}>Dem Majority</option>
    <option value="tied" ${val === 'tied' ? 'selected' : ''}>Tied</option>
    <option value=""     ${val === ''     ? 'selected' : ''}>Running</option>
  </select>`;
}

// ── Governor Tab ──────────────────────────────────────────────────────────────
function renderGovernorTab(data) {
  const all     = data.governorAll     || {};
  const byState = data.governorByState || {};
  const el      = document.getElementById('content-governor');

  const gopTotal = all.CurrentGop ?? 0;
  const demTotal = all.CurrentDem ?? 0;
  const rows = Object.entries(byState).sort(([a], [b]) => a.localeCompare(b));

  el.innerHTML = `
    <div class="scoreboard">
      <div class="score-grid">
        <div class="score-side">
          <div class="score-label">Republican</div>
          <div class="score-num gop">${editScoreNum('governorAll', 'CurrentGop', gopTotal, 'gop')}</div>
          <div class="score-sub">${all.GopSeats ?? 0} won this cycle</div>
        </div>
        <div class="score-center-col">
          <div class="score-total-label">Governorships</div>
          <div class="score-total-num">50</div>
          <div class="seat-bar">
            <div class="seat-bar-gop" style="width:${pct(gopTotal, 50)}%"></div>
            <div class="seat-bar-dem" style="width:${pct(demTotal, 50)}%"></div>
          </div>
          <div class="score-majority-line">26 for majority</div>
        </div>
        <div class="score-side">
          <div class="score-label">Democrat</div>
          <div class="score-num dem">${editScoreNum('governorAll', 'CurrentDem', demTotal, 'dem')}</div>
          <div class="score-sub">${all.DemSeats ?? 0} won this cycle</div>
        </div>
      </div>
      <div class="score-meta">
        ${all.TotalSeats ?? 0} races this cycle
        &nbsp;·&nbsp; ${(all.StatesWonByGOP || []).length} GOP wins
        &nbsp;·&nbsp; ${(all.StatesWonByDem || []).length} Dem wins
        &nbsp;·&nbsp; ${(all.RunningStates  || []).length} running
      </div>
    </div>

    <div class="states-section">
      <div class="section-header">Results by State${manualMode ? ' — click values to edit' : ''}</div>
      <div class="table-wrap">
        <table class="states-table">
          <thead>
            <tr>
              <th>State</th>
              <th>GOP Candidate</th>
              <th>Dem Candidate</th>
              <th>GOP%</th>
              <th>Dem%</th>
              <th>In%</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(([code, info]) => {
              const scope = `governorByState:${code}`;
              return `<tr>
                <td><span class="state-code">${code}</span><span class="state-name">${STATE_NAMES[code] || ''}</span></td>
                <td class="candidate" title="${info.GopCandidate || ''}">${info.GopCandidate || '—'}</td>
                <td class="candidate" title="${info.DemCandidate || ''}">${info.DemCandidate || '—'}</td>
                <td class="pct-cell gop-text">${editNum(scope, 'GopVotePercentage', info.GopVotePercentage, 'double')}${manualMode ? '' : '%'}</td>
                <td class="pct-cell dem-text">${editNum(scope, 'DemVotePercentage', info.DemVotePercentage, 'double')}${manualMode ? '' : '%'}</td>
                <td class="pct-cell dim">${editNum(scope, 'TotalVotePercentage', info.TotalVotePercentage, 'double')}${manualMode ? '' : '%'}</td>
                <td>${editWinner(scope, code, info.StateWonByGOP, info.StateWonByDem)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ── House Tab ─────────────────────────────────────────────────────────────────
function renderHouseTab(data) {
  const all     = data.houseAll     || {};
  const byState = data.houseByState || {};
  const el      = document.getElementById('content-house');

  const gopSeats = all.GopSeats ?? 0;
  const demSeats = all.DemSeats ?? 0;
  const total    = all.TotalSeats ?? 435;
  const rows = Object.entries(byState).sort(([a], [b]) => a.localeCompare(b));

  el.innerHTML = `
    <div class="scoreboard">
      <div class="score-grid">
        <div class="score-side">
          <div class="score-label">Republican</div>
          <div class="score-num gop">${editScoreNum('houseAll', 'GopSeats', gopSeats, 'gop')}</div>
          <div class="score-sub">${signedDiff(all.GopDiff)} vs prior</div>
        </div>
        <div class="score-center-col">
          <div class="score-total-label">House Seats</div>
          <div class="score-total-num">${total}</div>
          <div class="seat-bar">
            <div class="seat-bar-gop" style="width:${pct(gopSeats, total)}%"></div>
            <div class="seat-bar-dem" style="width:${pct(demSeats, total)}%"></div>
          </div>
          <div class="score-majority-line">218 for majority</div>
        </div>
        <div class="score-side">
          <div class="score-label">Democrat</div>
          <div class="score-num dem">${editScoreNum('houseAll', 'DemSeats', demSeats, 'dem')}</div>
          <div class="score-sub">${signedDiff(all.DemDiff)} vs prior</div>
        </div>
      </div>
      <div class="score-meta">
        ${all.RemainingSeats ?? 0} seats undecided
        &nbsp;·&nbsp; ${(all.StatesWonByGOP || []).length} states GOP majority
        &nbsp;·&nbsp; ${(all.StatesWonByDem || []).length} states Dem majority
      </div>
    </div>

    <div class="states-section">
      <div class="section-header">Seats by State${manualMode ? ' — click values to edit' : ''}</div>
      <div class="table-wrap">
        <table class="states-table">
          <thead>
            <tr>
              <th>State</th>
              <th>Total</th>
              <th>GOP</th>
              <th>Dem</th>
              <th>Remaining</th>
              <th>State Result</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(([code, info]) => {
              const scope = `houseByState:${code}`;
              return `<tr>
                <td><span class="state-code">${code}</span><span class="state-name">${STATE_NAMES[code] || ''}</span></td>
                <td class="dim">${info.TotalSeats}</td>
                <td class="gop-text">${editNum(scope, 'GopSeats', info.GopSeats, 'int')}</td>
                <td class="dem-text">${editNum(scope, 'DemSeats', info.DemSeats, 'int')}</td>
                <td class="dim">${editNum(scope, 'RemainingSeats', info.RemainingSeats || 0, 'int')}</td>
                <td>${editHouseWinner(scope, code, info.StateWonByGOP, info.StateWonByDem, info.StateTied)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ── Senate Tab ────────────────────────────────────────────────────────────────
function renderSenateTab(data) {
  const all = data.senateAll || {};
  const el  = document.getElementById('content-senate');

  const gopTotal = all.CurrentGop ?? 0;
  const demTotal = all.CurrentDem ?? 0;
  const others   = all.OthersSeats ?? 0;
  const gopWon  = all.StatesWonByGOP || [];
  const demWon  = all.StatesWonByDem || [];
  const running = all.RunningStates  || [];
  const tied    = all.StateTied      || [];

  el.innerHTML = `
    <div class="scoreboard">
      <div class="score-grid">
        <div class="score-side">
          <div class="score-label">Republican</div>
          <div class="score-num gop">${editScoreNum('senateAll', 'CurrentGop', gopTotal, 'gop')}</div>
          <div class="score-sub">${all.HoldoverGop ?? 0} holdover + ${editNum('senateAll','GopSeats', all.GopSeats ?? 0,'int')} won</div>
        </div>
        <div class="score-center-col">
          <div class="score-total-label">Senate Seats</div>
          <div class="score-total-num">100</div>
          <div class="seat-bar">
            <div class="seat-bar-gop" style="width:${pct(gopTotal, 100)}%"></div>
            <div class="seat-bar-dem" style="width:${pct(demTotal + others, 100)}%"></div>
          </div>
          <div class="score-majority-line">51 for majority</div>
        </div>
        <div class="score-side">
          <div class="score-label">Democrat${others > 0 ? ' + Ind' : ''}</div>
          <div class="score-num dem">${editScoreNum('senateAll', 'CurrentDem', demTotal, 'dem')}</div>
          <div class="score-sub">${all.HoldoverDem ?? 0} holdover + ${editNum('senateAll','DemSeats', all.DemSeats ?? 0,'int')} won</div>
        </div>
      </div>
      <div class="score-meta">
        ${all.TotalSeats ?? 0} seats contested this cycle &nbsp;·&nbsp; ${running.length} running
      </div>
    </div>

    <div class="states-section">
      <div class="section-header">Won by Republican (${gopWon.length})</div>
      <div class="states-grid">
        ${gopWon.length > 0
          ? gopWon.map(s => `<span class="state-pill gop" title="${STATE_NAMES[s] || s}">${s}</span>`).join('')
          : '<span class="dim-text">None called yet</span>'}
      </div>
    </div>

    <div class="states-section">
      <div class="section-header">Won by Democrat (${demWon.length})</div>
      <div class="states-grid">
        ${demWon.length > 0
          ? demWon.map(s => `<span class="state-pill dem" title="${STATE_NAMES[s] || s}">${s}</span>`).join('')
          : '<span class="dim-text">None called yet</span>'}
      </div>
    </div>

    ${running.length > 0 ? `
    <div class="states-section">
      <div class="section-header">Still Running (${running.length})</div>
      <div class="states-grid">
        ${running.map(s => `<span class="state-pill running" title="${STATE_NAMES[s] || s}">${s}</span>`).join('')}
      </div>
    </div>` : ''}

    ${tied.length > 0 ? `
    <div class="states-section">
      <div class="section-header">Tied (${tied.length})</div>
      <div class="states-grid">
        ${tied.map(s => `<span class="state-pill running" title="${STATE_NAMES[s] || s}">${s}</span>`).join('')}
      </div>
    </div>` : ''}
  `;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function pct(value, total) {
  if (!value || !total) return 0;
  return Math.min(100, (value / total) * 100).toFixed(2);
}
function signedDiff(v) { return v == null ? '—' : (v >= 0 ? '+' : '') + v; }

function resultBadge(wonByGOP, wonByDem, tied) {
  if (wonByGOP) return '<span class="badge gop">GOP</span>';
  if (wonByDem) return '<span class="badge dem">Dem</span>';
  if (tied)     return '<span class="badge tied">Tied</span>';
  return '<span class="badge running">Running</span>';
}

// ── Viz Engine Stats ──────────────────────────────────────────────────────────
async function refreshVizStats() {
  try {
    const s = await window.api.getStats();
    if (!s) return;
    const dot  = document.getElementById('conn-dot');
    const text = document.getElementById('conn-text');
    dot.className  = 'conn-dot ' + (s.connected ? 'ok' : 'bad');
    text.textContent = s.connected ? 'Viz connected' : 'Viz disconnected';
  } catch { /* ignore */ }
}

function initPushBtn() {
  document.getElementById('push-btn').addEventListener('click', () => {
    window.api.pushNow();
  });
}

// ── Go ────────────────────────────────────────────────────────────────────────
init();
