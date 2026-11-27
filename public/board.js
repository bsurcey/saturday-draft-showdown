const labels = { ncaaf: 'College football', ncaam: 'College basketball', nfl: 'NFL' };
const $ = (id) => document.getElementById(id);
const nameInput = $('player');
const playerDialog = $('player-dialog');
const confirmPlayer = $('confirm-player');
const weekInput = $('week');
const dayInput = $('game-day');
const time = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit',
});
const dateLabel = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
});
const shortDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', month: 'short', day: 'numeric',
});
const formatDay = (day, formatter = dateLabel) => formatter.format(new Date(day + 'T00:00:00Z'));
const text = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const signed = n => n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0';
const lineLabel = n => n === null ? '—' : n === 0 ? 'PK' : signed(n);
const pointClass = n => n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral';

let board;
let player;
let activeScope = 'mine';
let activeLeague = 'all';
let activeDay;
let updating;
let saving = false;
let saveError = '';
let loadError = '';
let lastRender = '';

function weekLabel(day) {
  const last = new Date(day + 'T00:00:00Z');
  last.setUTCDate(last.getUTCDate() + 6);
  return formatDay(day, shortDate) + ' – ' + shortDate.format(last);
}

function refreshStatus() {
  const lastUpdated = board ? time.format(new Date(board.updatedAt)) : '';
  $('refresh-label').textContent = loadError ? 'Reconnecting…' : lastUpdated ? 'Updated ' + lastUpdated + ' CT' : 'Connecting';
  const feedIssue = board?.errors?.length
    ? 'Some ESPN scores or spreads are delayed. The board will retry automatically.' : '';
  const notice = saveError || loadError || feedIssue;
  $('notice').hidden = !notice;
  $('notice').textContent = notice;
}

function balanceAmount(pair, amount, name) {
  if (!amount) return '<span class="neutral">Even</span>';
  const [winner, loser] = amount > 0 ? [pair.first, pair.second] : [pair.second, pair.first];
  const direction = !name ? '' : name === winner ? 'positive' : 'negative';
  const from = name === loser ? 'You owe ' : loser + ' owes ';
  const to = name === winner ? 'you' : winner;
  return '<span class="' + direction + '">' + text(from + to) + ' <strong class="points">'
    + Math.abs(amount) + '</strong></span>';
}

function renderBalances() {
  const name = activeScope === 'mine' ? player : '';

  const visible = board.pairs.filter(pair => name
    ? [pair.first, pair.second].includes(name)
    : pair.settled || pair.live || pair.games.length);
  if (!visible.length) {
    $('balances').innerHTML = '<p class="empty">Everyone is even. Balances will appear as picks face off.</p>';
    return;
  }

  const open = new Set([...$('balances').querySelectorAll('details[open]')].map(item => item.dataset.pair));
  const rows = visible.map(pair => {
    const other = name === pair.first ? pair.second : pair.first;
    const title = name ? other : pair.first + ' / ' + pair.second;
    const key = pair.first + '-' + pair.second;
    const perspective = name === pair.second ? -1 : 1;
    const details = pair.games.map(game => {
      const mine = perspective === 1 ? game.firstSide : game.firstSide === 'home' ? 'away' : 'home';
      const side = mine === 'home' ? game.home : game.away;
      const line = mine === 'home' ? game.line : -game.line;
      const points = game.points * perspective;
      const amount = game.outcome === 'push' ? (game.state === 'live' ? 'Even live' : 'Push')
        : game.outcome ? signed(points) + (game.state === 'live' ? ' live' : '')
          : 'Pending';
      const owner = name || pair.first;
      return '<li><span>' + text(game.away + ' vs. ' + game.home + ' · ' + owner + ' took ' + side + ' ' + lineLabel(line))
        + '</span><strong class="' + pointClass(points) + '">' + text(amount) + '</strong></li>';
    }).join('');
    return '<details class="balance-item" data-pair="' + key + '"' + (open.has(key) ? ' open' : '') + '>'
      + '<summary class="balance-row"><strong class="pair-title">' + text(title) + '</strong>'
      + balanceAmount(pair, pair.settled, name) + balanceAmount(pair, pair.live, name) + '</summary>'
      + '<div class="balance-details"><p>Starting balance · ' + balanceAmount(pair, pair.starting, name)
      + ' <span> | </span> This week’s results · ' + balanceAmount(pair, pair.week, name) + '</p>'
      + (details ? '<ul>' + details + '</ul>' : '') + '</div></details>';
  }).join('');
  $('balances').innerHTML = '<div class="balance-head"><span>Players</span><span>Owed now</span>'
    + '<span>If games ended now</span></div>' + rows;
}

function renderTeam(game, side, editable, picked) {
  const team = game[side];
  const names = Object.entries(game.picks ?? {}).filter(([, pick]) => pick === side).map(([name]) => name);
  const spread = game.homeLine === null ? null : side === 'home' ? game.homeLine : -game.homeLine;
  const classes = 'team' + (picked === side ? ' selected' : '');
  const content = (team.logo ? '<img class="team-logo" src="' + text(team.logo) + '" alt="" loading="lazy">' : '<span></span>')
    + '<span class="team-name">' + (team.rank ? '<small>' + team.rank + '</small>' : '') + text(team.name)
    + (names.length ? '<span class="side-players">' + names.map(text).join(', ') + '</span>' : '') + '</span>'
    + '<span class="score">' + (['live', 'final'].includes(game.state) ? text(team.score ?? '') : '') + '</span>'
    + '<span class="spread">' + lineLabel(spread) + '</span>';
  if (!editable) return '<div class="' + classes + '">' + content + '</div>';
  return '<button class="' + classes + '" type="button" data-side="' + side + '" data-game="' + game.id
    + '" aria-pressed="' + (picked === side) + '"' + (saving ? ' disabled' : '') + '>' + content + '</button>';
}

function renderGame(game) {
  const picked = game.picks?.[player];
  const open = game.timeKnown && game.state === 'pre' && Date.parse(game.start) > Date.now()
    && board.currentWeek === board.week;
  const editable = !!player && open && game.homeLine !== null;
  const opponents = picked ? Object.values(game.picks).filter(pick => pick !== picked).length : 0;
  let state = game.detail;
  if (game.state === 'pre') state = game.timeKnown ? time.format(new Date(game.start)) + ' CT' : 'Time TBD';
  if (game.state === 'live') state = state || 'Live';
  if (game.state === 'final') state = state || 'Final';
  if (game.state === 'void') state = state || 'Canceled';
  if (game.state === 'postponed') state = state || 'Postponed';
  const timing = [state, game.networks?.join(' / ')].filter(Boolean).join(' · ');
  const status = picked ? opponents + (opponents === 1 ? ' opponent' : ' opponents') + ' · '
    + opponents * board.stake + ' pts' : game.lockedAt ? 'Line locked' : game.homeLine === null ? 'Spread unavailable' : 'Current line';
  return '<article class="game"><div class="game-meta ' + (game.state === 'live' ? 'live' : '') + '">'
    + '<strong>' + labels[game.league] + '</strong><span>' + text(timing) + '</span></div>'
    + '<div class="teams">' + renderTeam(game, 'away', editable, picked) + renderTeam(game, 'home', editable, picked) + '</div>'
    + '<div class="game-bottom"><span>' + status + (picked && game.lockedAt ? ' · Line locked' : '') + '</span>'
    + (picked && editable ? '<button type="button" class="clear" data-game="' + game.id + '" data-side="clear"'
      + (saving ? ' disabled' : '') + '>Clear pick</button>' : '') + '</div></article>';
}

function renderGames() {
  const matches = board.games.filter(game => activeLeague === 'all' || game.league === activeLeague);
  const days = [...new Set(matches.map(game => game.day))].sort();
  if (!activeDay) activeDay = days.includes(board.today) ? board.today : 'all';
  if (!days.includes(activeDay) && activeDay !== 'all') activeDay = 'all';
  dayInput.innerHTML = '<option value="all">All days</option>' + days.map(day =>
    '<option value="' + day + '">' + formatDay(day) + '</option>').join('');
  dayInput.value = activeDay;
  const groups = Map.groupBy(matches.filter(game => activeDay === 'all' || game.day === activeDay), game => game.day);
  $('games').innerHTML = [...groups].map(([day, games]) => '<h3 class="game-day-title">' + formatDay(day)
    + '</h3><div class="game-grid">' + games.map(renderGame).join('') + '</div>').join('')
    || '<p class="empty">No matchups on this board yet.</p>';
}

function render({ force = false } = {}) {
  refreshStatus();
  if (!board) return;
  const signature = JSON.stringify([board.week, board.history, board.games, board.pairs, saving]);
  if (!force && signature === lastRender) return;
  lastRender = signature;

  const focused = document.activeElement;
  const focusedButton = focused.dataset.game && focused.dataset.side
    ? [...$('games').querySelectorAll('button[data-game]')].find(button => button === focused) : null;
  const focusedPair = focused.parentElement?.dataset.pair;
  $('week-label').textContent = (board.week === board.currentWeek ? 'This week · ' : '') + weekLabel(board.week);
  weekInput.disabled = false;
  weekInput.innerHTML = board.history.map(week => '<option value="' + week + '">'
    + (week === board.currentWeek ? 'This week' : weekLabel(week)) + '</option>').join('');
  weekInput.value = board.week;
  $('balances').ariaBusy = 'false';
  $('games').ariaBusy = 'false';

  renderBalances();
  renderGames();
  $('ranks').innerHTML = '<table class="rank-table"><thead><tr><th scope="col">Player</th><th scope="col">Owed net</th>'
    + '<th scope="col">Live net</th></tr></thead><tbody>' + board.standings.map(row => '<tr><th scope="row">'
    + text(row.name) + '</th><td class="points ' + pointClass(row.settled) + '">' + signed(row.settled)
    + '</td><td class="points ' + pointClass(row.live) + '">' + signed(row.live) + '</td></tr>').join('')
    + '</tbody></table>';
  if (focusedButton) {
    const { game, side } = focusedButton.dataset;
    $('games').querySelector('[data-game="' + game + '"][data-side="' + side + '"]')?.focus({ preventScroll: true });
  }
  if (focusedPair) {
    $('balances').querySelector('[data-pair="' + focusedPair + '"] > summary')?.focus({ preventScroll: true });
  }
}

async function readResponse(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    const error = new Error(body?.error || 'The board is temporarily unavailable.');
    error.status = response.status;
    throw error;
  }
  return body;
}

async function load() {
  if (!player) return;
  if (updating) return updating;
  updating = (async () => {
    const week = weekInput.value;
    try {
      const current = board?.currentWeek === week;
      const query = week && !current ? '?week=' + encodeURIComponent(week) : '';
      const next = await readResponse(await fetch('/api/board' + query, { cache: 'no-store' }));
      if (weekInput.value !== week) return;
      if (board?.week !== next.week) activeDay = undefined;
      board = next;
      loadError = '';
      render();
    } catch (err) {
      loadError = err.message;
      refreshStatus();
      if (!board) {
        $('balances').ariaBusy = 'false';
        $('games').ariaBusy = 'false';
        $('balances').innerHTML = '<p class="empty">Waiting for the shared balances. Retrying shortly…</p>';
        $('games').innerHTML = '<p class="empty">Waiting for the matchup board…</p>';
      }
    }
  })();
  try { await updating; } finally { updating = undefined; }
}

function setSegment(selector, name, value) {
  for (const button of document.querySelectorAll(selector)) {
    button.setAttribute('aria-pressed', String(button.dataset[name] === value));
  }
}

function showBoard(name) {
  player = name;
  $('player-name').textContent = name;
  $('identity').hidden = false;
  $('identity-status').hidden = true;
  $('board-content').hidden = false;
  $('board-footer').hidden = false;
  if (playerDialog.open) playerDialog.close();
  render({ force: true });
  load();
}

async function checkIdentity() {
  const retry = $('retry-identity');
  retry.hidden = true;
  $('identity-message').textContent = 'Checking this browser…';
  try {
    const identity = await readResponse(await fetch('/api/player', { cache: 'no-store' }));
    if (identity.player) {
      showBoard(identity.player);
      return;
    }
    player = undefined;
    $('identity').hidden = true;
    $('identity-status').hidden = true;
    $('board-content').hidden = true;
    $('board-footer').hidden = true;
    nameInput.length = 1;
    for (const name of identity.players) nameInput.add(new Option(name, name));
    nameInput.value = '';
    confirmPlayer.disabled = true;
    confirmPlayer.textContent = 'Continue';
    $('player-error').hidden = true;
    if (!playerDialog.open) playerDialog.showModal();
  } catch (error) {
    player = undefined;
    $('identity').hidden = true;
    $('board-content').hidden = true;
    $('board-footer').hidden = true;
    if (playerDialog.open) playerDialog.close();
    $('identity-status').hidden = false;
    $('identity-message').textContent = error.message;
    retry.hidden = false;
  }
}

playerDialog.addEventListener('cancel', event => event.preventDefault());
$('retry-identity').addEventListener('click', checkIdentity);
nameInput.addEventListener('change', () => {
  confirmPlayer.disabled = !nameInput.value;
  confirmPlayer.textContent = nameInput.value ? 'Continue as ' + nameInput.value : 'Continue';
  $('player-error').hidden = true;
});

$('player-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (confirmPlayer.disabled) return;
  const name = nameInput.value;
  const errorMessage = $('player-error');
  nameInput.disabled = true;
  confirmPlayer.disabled = true;
  errorMessage.hidden = true;
  try {
    const identity = await readResponse(await fetch('/api/player', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player: name }),
    }));
    showBoard(identity.player);
  } catch (error) {
    errorMessage.textContent = error.message;
    errorMessage.hidden = false;
  } finally {
    nameInput.disabled = false;
    confirmPlayer.disabled = !nameInput.value;
  }
});

weekInput.addEventListener('change', async () => {
  const pending = updating;
  if (pending) await pending;
  await load();
});

dayInput.addEventListener('change', () => {
  activeDay = dayInput.value;
  if (board) renderGames();
});

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  const { scope, league } = button.dataset;
  if (scope) {
    activeScope = scope;
    setSegment('[data-scope]', 'scope', scope);
    if (board) renderBalances();
  }
  if (league) {
    activeLeague = league;
    setSegment('[data-league]', 'league', league);
    if (board) renderGames();
  }
});

$('games').addEventListener('click', async event => {
  const button = event.target.closest('button[data-game]');
  if (!button || saving) return;
  const game = board.games.find(item => item.id === button.dataset.game);
  if (!game || !player) return;
  saveError = '';
  saving = true;
  render({ force: true });
  try {
    await readResponse(await fetch('/api/board', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player, id: game.id, day: game.day, home: game.home.id, away: game.away.id, line: game.homeLine,
        side: button.dataset.side === 'clear' ? null : button.dataset.side,
      }),
    }));
  } catch (err) {
    saveError = err.message;
    if (err.status === 401 || err.status === 403) await checkIdentity();
  } finally {
    if (updating) await updating;
    await load();
    saving = false;
    render({ force: true });
  }
});

checkIdentity();
setInterval(() => { if (!saving) load(); }, 25000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !saving) load(); });
