import { dayOf, shiftDay } from './ledger.mjs';

export const leagues = {
  ncaaf: { path: 'football/college-football', group: 80, limit: 10 },
  ncaam: { path: 'basketball/mens-college-basketball', group: 50, limit: 6 },
  nfl: { path: 'football/nfl', limit: Infinity },
};

const followedTeams = {
  ncaam: {
    '2193': 'East Tennessee State',
    '236': 'Chattanooga',
  },
  ncaaf: {
    '2579': 'South Carolina',
    '135': 'Minnesota',
  },
};

export function hasFollowedTeam(game) {
  const teams = followedTeams[game.league];
  return !!teams && (Object.hasOwn(teams, game.home.id) || Object.hasOwn(teams, game.away.id));
}

const base = 'https://site.api.espn.com/apis/site/v2/sports';
const cache = new Map();

function parseLine(value) {
  if (typeof value === 'string' && /^(pk|pick(em)?)$/i.test(value.trim())) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !/^[+−-]?\d+(?:\.\d+)?$/.test(value.trim())) return null;
  return Number(value.trim().replace('−', '-'));
}

function homeSpread(competition) {
  for (const entry of competition.odds ?? []) {
    const home = parseLine(entry.pointSpread?.home?.close?.line);
    const away = parseLine(entry.pointSpread?.away?.close?.line);
    if (home !== null && (away === null || home === -away)) return home;
    if (home === null && away !== null) return -away;
    const spread = parseLine(entry.spread);
    if (spread === null) continue;
    if (spread === 0) return 0;
    if (entry.homeTeamOdds?.favorite === true) return -Math.abs(spread);
    if (entry.awayTeamOdds?.favorite === true) return Math.abs(spread);
  }
  return null;
}

function normalizeTeam(competitor) {
  const team = competitor.team ?? {};
  const rank = Number(competitor.curatedRank?.current);
  const logo = /^[a-z0-9:/_.-]+$/i.test(team.logo ?? '') && team.logo?.startsWith('https://a.espncdn.com/')
    ? team.logo : '';
  return {
    id: String(team.id ?? competitor.id),
    name: team.shortDisplayName ?? team.displayName ?? competitor.id,
    abbr: team.abbreviation ?? team.shortDisplayName ?? competitor.id,
    logo,
    rank: rank > 0 && rank <= 25 ? rank : null,
    score: parseLine(competitor.score),
  };
}

function broadcastNetworks(competition) {
  const names = [
    ...(competition.broadcasts ?? []).flatMap(broadcast => broadcast.names ?? []),
    ...(competition.geoBroadcasts ?? []).map(broadcast => broadcast.media?.shortName || broadcast.media?.name),
  ];
  const unique = new Map();
  for (const name of names) {
    if (typeof name !== 'string' || !name.trim()) continue;
    const label = name.trim();
    if (!unique.has(label.toLowerCase())) unique.set(label.toLowerCase(), label);
  }
  return [...unique.values()];
}

function normalize(league, id, competition, status) {
  const home = competition?.competitors?.find(team => team.homeAway === 'home');
  const away = competition?.competitors?.find(team => team.homeAway === 'away');
  const start = competition?.date;
  if (!home || !away || !Number.isFinite(Date.parse(start)) || !/^\d+$/.test(String(id))) return null;
  const type = status?.type;
  let state = 'unknown';
  if (/CANCEL|FORFEIT|NO_CONTEST/.test(type?.name ?? '')) state = 'void';
  else if (/POSTPON/.test(type?.name ?? '')) state = 'postponed';
  else if (type?.state === 'post' && type.completed) state = 'final';
  else if (type?.state === 'in') state = 'live';
  else if (type?.state === 'pre') state = 'pre';
  return {
    id: league + ':' + id, league, start, day: dayOf(start),
    state, detail: type?.shortDetail ?? type?.detail ?? '',
    homeLine: homeSpread(competition),
    home: normalizeTeam(home), away: normalizeTeam(away),
    timeKnown: competition.timeValid !== false && !/TBD|TBA/i.test(type?.detail ?? ''),
    networks: broadcastNetworks(competition),
  };
}

async function load(key, url, ttl, normalizeResponse) {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expires > now) return cached.promise;
  if (cache.size > 100) {
    for (const [oldKey, entry] of cache) if (entry.expires <= now) cache.delete(oldKey);
  }
  const entry = { expires: now + ttl };
  entry.promise = (async () => {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(6500),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('ESPN returned ' + response.status);
    return normalizeResponse(await response.json());
  })().catch(error => {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  });
  cache.set(key, entry);
  return entry.promise;
}

export function scoreboard(league, day, today = dayOf(Date.now())) {
  const { path, group } = leagues[league];
  const query = new URLSearchParams({ dates: day.replaceAll('-', ''), limit: '250' });
  if (group) query.set('groups', String(group));
  const nearby = day >= shiftDay(today, -1) && day <= shiftDay(today, 1);
  return load(league + '/' + day, base + '/' + path + '/scoreboard?' + query,
    nearby ? 18000 : 180000, data => {
      if (!Array.isArray(data.events)) throw new Error('ESPN scoreboard was incomplete');
      return data.events.map(event => normalize(league, event.id, event.competitions?.[0], event.status)).filter(Boolean);
    });
}

export function summary(game) {
  const id = game.id.split(':')[1];
  return load(game.id, base + '/' + leagues[game.league].path + '/summary?event=' + id,
    45000, data => normalize(game.league, id, data.header?.competitions?.[0], data.header?.competitions?.[0]?.status));
}

export function featured(games) {
  const groups = Map.groupBy(games, game => game.league + '/' + game.day);
  return [...groups.values()].flatMap(group => {
    const limit = leagues[group[0].league].limit;
    return group.sort((a, b) => {
      const rank = game => (game.away.rank ? 50 - game.away.rank : 0) + (game.home.rank ? 50 - game.home.rank : 0);
      return rank(b) - rank(a)
        || Number(b.homeLine !== null) - Number(a.homeLine !== null)
        || Math.abs(a.homeLine ?? 999) - Math.abs(b.homeLine ?? 999)
        || a.start.localeCompare(b.start);
    }).filter((game, position) => position < limit || hasFollowedTeam(game));
  });
}
