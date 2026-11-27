import { getStore } from '@netlify/blobs';
import { devicePlayer, deviceToken, openDevices } from '../lib/device.mjs';
import { alignGame, dayOf, gameView, players, result, shiftDay, slateDay, stake, summarize, weekOf } from '../lib/ledger.mjs';
import { featured, leagues, scoreboard, summary } from '../lib/espn.mjs';

const key = 'games-v2';
const isGameId = /^(ncaaf|ncaam|nfl):\d{1,15}$/;
const json = (value, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store' },
});

function fail(message, status) {
  return Object.assign(new Error(message), { status });
}

async function read(store) {
  return await store.getWithMetadata(key, { type: 'json' }) ?? { data: {}, etag: null };
}

async function change(store, update) {
  for (let attempt = 0; attempt < 7; attempt++) {
    const previous = await read(store);
    const next = update(previous.data);
    if (next === previous.data) return next;
    const condition = previous.etag ? { onlyIfMatch: previous.etag } : { onlyIfNew: true };
    const saved = await store.setJSON(key, next, condition);
    if (saved.modified) return next;
  }
  throw fail('Another pick was saved at the same time. Please try again.', 409);
}

async function savePick(request, store, deviceStore, now) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
    throw fail('Send picks as JSON.', 415);
  }
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw fail('Invalid origin.', 403);
  const body = await request.json().catch(() => null);
  if (!body || !isGameId.test(body.id) || !['home', 'away', null].includes(body.side)) {
    throw fail('Choose a matchup and a side.', 400);
  }
  const player = await devicePlayer(deviceStore, deviceToken(request));
  if (!player) throw fail('Confirm your name on this browser before making picks.', 401);
  if (body.player !== player) throw fail('The saved player changed. Check the name before picking again.', 403);

  const currentWeek = weekOf(now);
  const today = dayOf(now);
  const displayDay = slateDay(now);
  const yesterday = shiftDay(today, -1);
  const day = body.day;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < today || day > shiftDay(currentWeek, 6)) {
    throw fail('Picks are closed for this matchup.', 409);
  }
  const league = body.id.split(':')[0];
  const feed = await scoreboard(league, day, today).catch(() => {
    throw fail('The schedule is temporarily unavailable. Please try again.', 503);
  });
  const game = feed.find(event => event.id === body.id && event.day === day);
  if (!game || !game.timeKnown || game.state !== 'pre' || Date.parse(game.start) <= Date.now()) {
    throw fail('Picks are closed for this matchup.', 409);
  }
  const displayGame = alignGame(game, { home: { id: body.home }, away: { id: body.away } });
  if (!displayGame) {
    throw fail('The matchup changed. Check the board and pick again.', 409);
  }

  await change(store, data => {
    if (Date.parse(game.start) <= Date.now()) throw fail('This game has started.', 409);
    const existing = data[game.id];
    if (existing?.final) throw fail('Picks are closed for this matchup.', 409);
    const aligned = existing ? alignGame(displayGame, existing.game) : displayGame;
    if (!aligned) throw fail('The matchup changed. Check the board and pick again.', 409);
    const sameOrder = aligned.home.id === displayGame.home.id;
    const line = existing ? existing.line : aligned.homeLine;
    const side = body.side === null || sameOrder ? body.side : body.side === 'home' ? 'away' : 'home';
    if (side && (!Number.isFinite(body.line) || line === null || line !== (sameOrder ? body.line : -body.line))) {
      throw fail('The spread changed. Check the updated line and pick again.', 409);
    }
    if ((existing?.picks[player] ?? null) === side) return data;
    const picks = { ...existing?.picks };
    if (side) picks[player] = side;
    else delete picks[player];
    const entry = existing ?? { game: aligned, week: currentWeek, line, lockedAt: new Date().toISOString() };
    return { ...data, [game.id]: { ...entry, picks } };
  });

  return json({ saved: true });
}

async function readBoard(request, store, now) {
  const currentWeek = weekOf(now);
  const today = dayOf(now);
  const requestWeek = new URL(request.url).searchParams.get('week');
  const todayFeeds = [];
  if (yesterday < currentWeek) {
    for (const league of Object.keys(leagues)) todayFeeds.push({ day: yesterday, league });
  }
  for (let i = 0; i < 7; i++) {
    const day = shiftDay(currentWeek, i);
    for (const league of Object.keys(leagues)) todayFeeds.push({ day, league });
  }
  const [previous, feeds] = await Promise.all([
    read(store),
    Promise.allSettled(todayFeeds.map(({ league, day }) => scoreboard(league, day, today))),
  ]);

  const feedGames = new Map(feeds.flatMap(feed => feed.status === 'fulfilled'
    ? feed.value.map(game => [game.id, game]) : []));
  const picked = Object.values(previous.data);
  const missing = picked.filter(entry => !entry.final && Object.keys(entry.picks).length
    && !feedGames.has(entry.game.id) && entry.game.start < new Date(now).toISOString())
    .slice(0, 12);
  const recovered = await Promise.allSettled(missing.map(entry => summary(entry.game)));
  for (const feed of recovered) {
    if (feed.status === 'fulfilled' && feed.value) feedGames.set(feed.value.id, feed.value);
  }

  const finals = picked.filter(entry => !entry.final).flatMap(entry => {
    const game = alignGame(feedGames.get(entry.game.id), entry.game);
    return game && (game.state === 'final' || game.state === 'void') && result(game, entry.line)
      ? [[game.id, game]] : [];
  });
  const data = finals.length ? await change(store, latest => {
    const next = { ...latest };
    let modified = false;
    for (const [id, final] of finals) {
      if (!latest[id] || latest[id].final) continue;
      next[id] = { ...latest[id], final };
      modified = true;
    }
    return modified ? next : latest;
  }) : previous.data;

  const entries = Object.values(data);
  const history = [...new Set(entries.map(entry => entry.week).concat(currentWeek))].sort().reverse();
  const week = history.includes(requestWeek) ? requestWeek : currentWeek;
  const board = new Map(week === currentWeek ? featured([...feedGames.values()]
    .filter(game => game.day >= (yesterday < week ? yesterday : week) && game.day <= shiftDay(week, 6)))
    .map(game => [game.id, game]) : []);

  for (const entry of entries) {
    const game = gameView(entry, feedGames);
    const carriesOver = week === currentWeek && (
      board.has(game.id) || game.day === yesterday
      || (!entry.final && game.state === 'live' && game.day < today)
    );
    if (entry.week !== week && !carriesOver) continue;
    const networks = [game.networks, feedGames.get(entry.game.id)?.networks, entry.game.networks]
      .find(list => list?.length) ?? [];
    board.set(entry.game.id, {
      ...game, networks, homeLine: entry.line, lockedAt: entry.lockedAt, picks: entry.picks,
    });
  }

  const games = [...board.values()].sort((a, b) => a.start.localeCompare(b.start));
  const errors = [...new Set(todayFeeds.filter((_, index) => feeds[index].status === 'rejected')
    .map(item => item.league))];
  return json({
    week, currentWeek, today, displayDay, history, games, players, stake, errors, updatedAt: new Date().toISOString(),
    ...summarize(entries, feedGames, week),
  });
}

export function makeBoardHandler(openStore = () => getStore({ name: 'fripp-points', consistency: 'strong' }),
  openDeviceStore = openDevices) {
  return async request => {
    const now = Date.now();
    try {
      if (request.method === 'GET') return await readBoard(request, openStore(), now);
      if (request.method === 'POST') return await savePick(request, openStore(), openDeviceStore(), now);
      return json({ error: 'Method not allowed.' }, 405);
    } catch (error) {
      if (!error.status) console.error('Fripp board:', error);
      return json({ error: error.status ? error.message : 'The shared board is temporarily unavailable.' },
        error.status || 503);
    }
  };
}

export default makeBoardHandler();
