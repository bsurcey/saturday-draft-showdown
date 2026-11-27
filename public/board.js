const labels = { ncaaf: 'College football', ncaam: 'College basketball', nfl: 'NFL' };
const $ = (id) => document.getElementById(id);
const nameInput = $('player');
const playerDialog = $('player-dialog');
const confirmPlayer = $('confirm-player');
const weekInput = $('week');
const historyBalances = $('history-balances');
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
const signedMoney = n => n > 0 ? '+$' + n : n < 0 ? '−$' + Math.abs(n) : '$0';
const lineLabel = n => n === null ? '—' : n === 0 ? 'PK' : signed(n);
const pointClass = n => n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral';

let board;
let player;
let activeScope = 'mine';
let activeGameView = 'all';
let activeLeague = 'all';
let activeDay = 'auto';
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
    + '$' + Math.abs(amount) + '</strong></span>';
}

function renderBalances({ pairs = board.pairs, target = $('balances'), name = activeScope === 'mine' ? player : '', archived = false } = {}) {
  const visible = pairs.filter(pair => name
    ? [pair.first, pair.second].includes(name)
    : pair.settled || pair.live || pair.games.length);
  if (!visible.length) {
    target.innerHTML = archived ? '<p class="empty">No head-to-head results for this week.</p>'
      : '<p class="empty">Everyone is even. Balances will appear as picks face off.</p>';
    return;
  }

  const open = new Set([...target.querySelectorAll('details[open]')].map(item => item.dataset.pair));
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
        : game.outcome ? signedMoney(points) + (game.state === 'live' ? ' live' : '')
          : 'Pending';
      const owner = name || pair.first;
      return '<li><span>' + text(game.away + ' vs. ' + game.home + ' · ' + owner + ' took ' + side + ' ' + lineLabel(line))
        + '</span><strong class="' + pointClass(points) + '">' + text(amount) + '</strong></li>';
    }).join('');
    return '<details class="balance-item" data-pair="' + key + '"' + (open.has(key) ? ' open' : '') + '>'
      + '<summary class="balance-row"><strong class="pair-title">' + text(title) + '</strong>'
      + balanceAmount(pair, pair.settled, name) + balanceAmount(pair, archived ? pair.week : pair.live, name) + '</summary>'
      + '<div class="balance-details"><p>Starting balance · ' + balanceAmount(pair, pair.starting, name)
      + ' <span> | </span> Week’s results · ' + balanceAmount(pair, pair.week, name) + '</p>'
      + (details ? '<ul>' + details + '</ul>' : '') + '</div></details>';
  }).join('');
  target.innerHTML = '<div class="balance-head"><span>Players</span>'
    + (archived ? '<span>Settled total</span><span>Week’s results</span>' : '<span>Owed now</span><span>Live net</span>')
    + '</div>' + rows;
}

function renderHistoryOptions() {
  const weeks = board.history.filter(week => week !== board.currentWeek);
  const key = weeks.join(',');
  if (weekInput.dataset.weeks === key) return;
  const selected = weekInput.value;
  weekInput.dataset.weeks = key;
  weekInput.disabled = !weeks.length;
  weekInput.replaceChildren(new Option('Choose a week', ''), ...weeks.map(week => new Option(weekLabel(week), week)));
  if (weeks.includes(selected)) {
    weekInput.value = selected;
  } else {
    historyBalances.textContent = '';
    historyBalances.append(Object.assign(document.createElement('p'), {
      className: 'empty',
      textContent: weeks.length ? 'Choose a week, then open a player matchup to see the games behind the balance.'
        : 'Past weeks will appear here once there’s a previous week with picks.',
    }));
  }
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

function opponentCount(picks, name) {
  const side = picks?.[name];
  if (!side) return 0;
  const opposite = side === 'home' ? 'away' : 'home';
  return Object.values(picks).filter(pick => pick === opposite).length;
}

function hasOpposingPicks(picks) {
  const sides = new Set(Object.values(picks ?? {}));
  return sides.has('home') && sides.has('away');
}

function belongsOnActiveBoard(game) {
  const hasStarted = game.state !== 'pre'
    || (game.timeKnown && Date.parse(game.start) <= Date.now());
  return !hasStarted || hasOpposingPicks(game.picks);
}

function renderGame(game) {
  const picked = game.picks?.[player];
  const open = game.timeKnown && game.state === 'pre' && Date.parse(game.start) > Date.now()
    && board.currentWeek === board.week;
  const editable = !!player && open && game.homeLine !== null;
  const opponents = opponentCount(game.picks, player);
  let state = game.detail;
  if (game.state === 'pre') state = game.timeKnown ? time.format(new Date(game.start)) + ' CT' : 'Time TBD';
  if (game.state === 'live') state = state || 'Live';
  if (game.state === 'final') state = state || 'Final';
  if (game.state === 'void') state = state || 'Canceled';
  if (game.state === 'postponed') state = state || 'Postponed';
  const timing = [state, game.networks?.join(' / ')].filter(Boolean).join(' · ');
  const status = picked ? opponents + (opponents === 1 ? ' opponent' : ' opponents') + ' · '
    + '$' + opponents * board.stake : game.lockedAt ? 'Line locked' : game.homeLine === null ? 'Spread unavailable' : 'Current line';
  return '<article class="game"><div class="game-meta ' + (game.state === 'live' ? 'live' : '') + '">'
    + '<strong>' + labels[game.league] + '</strong><span>' + text(timing) + '</span></div>'
    + '<div class="teams">' + renderTeam(game, 'away', editable, picked) + renderTeam(game, 'home', editable, picked) + '</div>'
    + '<div class="game-bottom"><span>' + status + (picked && game.lockedAt ? ' · Line locked' : '') + '</span>'
    + (picked && editable ? '<button type="button" class="clear" data-game="' + game.id + '" data-side="clear"'
      + (saving ? ' disabled' : '') + '>Clear pick</button>' : '') + '</div></article>';
}

function renderGames() {
  const myGames = activeGameView === 'mine';
  $('game-filters').hidden = myGames;
  let matches;
  if (myGames) {
    matches = board.games.filter(game => opponentCount(game.picks, player) > 0);
  } else {
    const leagueGames = board.games.filter(game => belongsOnActiveBoard(game)
      && (activeLeague === 'all' || game.league === activeLeague));
    const days = [...new Set(leagueGames.map(game => game.day))].sort();
    const displayDay = board.displayDay ?? board.today;
    const automatic = activeDay === 'auto';
    const defaultDay = days.includes(displayDay) ? displayDay : 'all';
    const selectedDay = automatic ? defaultDay : activeDay;
    if (!automatic && activeDay !== 'all' && !days.includes(activeDay)) {
      days.push(activeDay);
      days.sort();
    }
    const defaultLabel = defaultDay === 'all' ? 'All days' : formatDay(defaultDay);
    dayInput.innerHTML = '<option value="auto">Auto · ' + defaultLabel + '</option>'
      + '<option value="all">All days</option>' + days.map(day =>
      '<option value="' + day + '">' + formatDay(day) + '</option>').join('');
    dayInput.value = activeDay;
    matches = leagueGames.filter(game => selectedDay === 'all' || game.day === selectedDay
      || (automatic && game.day < displayDay && game.state === 'live'));
  }
  const groups = Map.groupBy(matches, game => game.day);
  $('games').innerHTML = [...groups].map(([day, games]) => '<h3 class="game-day-title">' + formatDay(day)
    + '</h3><div class="game-grid">' + games.map(renderGame).join('') + '</div>').join('')
    || (myGames ? '<p class="empty">None of your picks have an opponent this week.</p>'
      : '<p class="empty">No matchups on this board yet.</p>');
}

function settlementPlan(standings) {
  const debtors = standings.filter(row => row.settled < 0)
    .map(row => ({ name: row.name, remaining: -row.settled }))
    .sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name));
  const creditors = standings.filter(row => row.settled > 0)
    .map(row => ({ name: row.name, remaining: row.settled }))
    .sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name));
  let best;

  function search(transfers) {
    if (best && transfers.length >= best.length) return;
    const debtor = debtors.find(item => item.remaining > 0);
    if (!debtor) {
      best = transfers;
      return;
    }
    const triedAmounts = new Set();
    for (const creditor of creditors) {
      if (!creditor.remaining || triedAmounts.has(creditor.remaining)) continue;
      triedAmounts.add(creditor.remaining);
      const amount = Math.min(debtor.remaining, creditor.remaining);
      debtor.remaining -= amount;
      creditor.remaining -= amount;
      search([...transfers, { from: debtor.name, to: creditor.name, amount }]);
      debtor.remaining += amount;
      creditor.remaining += amount;
    }
  }

  search([]);
  return best ?? [];
}

function renderSettlements() {
  const plan = settlementPlan(board.standings);
  $('settlements').innerHTML = plan.length
    ? '<ol class="settlement-list">' + plan.map(payment => '<li><span><strong>' + text(payment.from)
      + '</strong> pays <strong>' + text(payment.to) + '</strong></span><strong class="points">$'
      + payment.amount + '</strong></li>').join('') + '</ol>'
    : '<p class="empty">No payments needed. Everyone is even.</p>';
}

function render({ force = false } = {}) {
  refreshStatus();
  if (!board) return;
  const signature = JSON.stringify([board.week, board.displayDay, board.history, board.games, board.pairs, saving]);
  if (!force && signature === lastRender) return;
  lastRender = signature;

  const focused = document.activeElement;
  const focusedButton = focused.dataset.game && focused.dataset.side
    ? [...$('games').querySelectorAll('button[data-game]')].find(button => button === focused) : null;
  const focusedPair = focused.parentElement?.dataset.pair;
  renderHistoryOptions();
  $('balances').ariaBusy = 'false';
  $('games').ariaBusy = 'false';

  renderBalances();
  renderGames();
  renderSettlements();
  $('ranks').innerHTML = '<table class="rank-table"><thead><tr><th scope="col">Player</th><th scope="col">Owed net</th>'
    + '<th scope="col">Live net</th></tr></thead><tbody>' + board.standings.map(row => '<tr><th scope="row">'
    + text(row.name) + '</th><td class="points ' + pointClass(row.settled) + '">' + signedMoney(row.settled)
    + '</td><td class="points ' + pointClass(row.live) + '">' + signedMoney(row.live) + '</td></tr>').join('')
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
    try {
      const next = await readResponse(await fetch('/api/board', { cache: 'no-store' }));
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

let historyRequest;
weekInput.addEventListener('change', async () => {
  historyRequest?.abort();
  const week = weekInput.value;
  if (!week) {
    historyBalances.innerHTML = '<p class="empty">Choose a week, then open a player matchup to see the games behind the balance.</p>';
    return;
  }
  const request = new AbortController();
  historyRequest = request;
  historyBalances.innerHTML = '<p class="empty" role="status">Loading balances for this week…</p>';
  try {
    const past = await readResponse(await fetch('/api/board?week=' + encodeURIComponent(week), {
      cache: 'no-store', signal: request.signal,
    }));
    if (request.signal.aborted || weekInput.value !== week) return;
    if (past.week !== week) throw new Error('Week unavailable');
    renderBalances({ pairs: past.pairs, target: historyBalances, name: '', archived: true });
  } catch {
    if (request.signal.aborted || weekInput.value !== week) return;
    historyBalances.innerHTML = '<p class="empty" role="status">Could not load this week. Choose it again to retry.</p>';
    weekInput.value = '';
  }
});

dayInput.addEventListener('change', () => {
  activeDay = dayInput.value;
  if (board) renderGames();
});

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  const { scope, league, gameView } = button.dataset;
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
  if (gameView) {
    activeGameView = gameView;
    setSegment('[data-game-view]', 'gameView', gameView);
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
