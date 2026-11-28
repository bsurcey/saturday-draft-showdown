export const players = ['Brad', 'Jeff', 'Jason', 'Lay', 'Craig', 'Herb', 'Todd', 'Dave', 'Jayme'];
export const stake = 20;

const calendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
});
const centralHour = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', hour: '2-digit', hourCycle: 'h23',
});

export const dayOf = (date) => calendar.format(new Date(date));

export function shiftDay(day, days) {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function slateDay(date) {
  const day = dayOf(date);
  return Number(centralHour.format(date)) < 4 ? shiftDay(day, -1) : day;
}

export function weekOf(date) {
  const day = dayOf(date);
  const weekday = new Date(day + 'T00:00:00Z').getUTCDay();
  return shiftDay(day, -((weekday + 3) % 7));
}

export function result(game, homeLine) {
  if (game.state === 'void') return 'push';
  if (!['live', 'final'].includes(game.state)) return null;
  if (![game.home.score, game.away.score, homeLine].every(Number.isFinite)) return null;
  const margin = game.home.score - game.away.score + homeLine;
  return margin === 0 ? 'push' : margin > 0 ? 'home' : 'away';
}

export function alignGame(game, original) {
  if (!game) return null;
  if (game.home.id === original.home.id && game.away.id === original.away.id) return game;
  if (game.home.id !== original.away.id || game.away.id !== original.home.id) return null;
  return {
    ...game, home: game.away, away: game.home,
    homeLine: game.homeLine === null ? null : -game.homeLine,
  };
}

export function gameView(entry, games) {
  return entry.final ?? alignGame(games.get(entry.game.id), entry.game)
    ?? { ...entry.game, state: 'unknown', detail: 'Score update unavailable' };
}

export function groupStats(entries, games) {
  const stats = Object.fromEntries(players.map(name => [name, {
    name, games: 0, underdogs: 0, underdogWins: 0, favorites: 0, favoriteWins: 0,
    home: 0, homeWins: 0, road: 0, roadWins: 0,
  }]));
  let totalWagers = 0;

  for (const entry of entries) {
    const picks = Object.entries(entry.picks ?? {})
      .filter(([name, side]) => stats[name] && ['home', 'away'].includes(side));
    const home = picks.filter(([, side]) => side === 'home');
    const away = picks.filter(([, side]) => side === 'away');
    if (!home.length || !away.length) continue;

    totalWagers += home.length * away.length;
    const outcome = entry.final ? result(gameView(entry, games), entry.line) : null;

    for (const [name, side] of picks) {
      const row = stats[name];
      const won = outcome && outcome !== 'push' && outcome === side;
      row.games += 1;

      if (side === 'home') {
        row.home += 1;
        if (won) row.homeWins += 1;
      } else {
        row.road += 1;
        if (won) row.roadWins += 1;
      }

      const favorite = entry.line < 0 ? 'home' : entry.line > 0 ? 'away' : null;
      if (side === favorite) {
        row.favorites += 1;
        if (won) row.favoriteWins += 1;
      } else if (favorite) {
        row.underdogs += 1;
        if (won) row.underdogWins += 1;
      }
    }
  }

  return { totalWagers, totalDollars: totalWagers * stake, players: Object.values(stats) };
}

export function transactionHistory(entries, games) {
  const transactions = [];
  for (const entry of entries) {
    if (!entry.final) continue;
    const game = gameView(entry, games);
    const outcome = result(game, entry.line);
    if (!outcome) continue;
    const homePlayers = Object.entries(entry.picks ?? {})
      .filter(([name, side]) => players.includes(name) && side === 'home').map(([name]) => name);
    const awayPlayers = Object.entries(entry.picks ?? {})
      .filter(([name, side]) => players.includes(name) && side === 'away').map(([name]) => name);
    const homeAmount = outcome === 'push' ? 0 : outcome === 'home' ? stake : -stake;
    for (const homePlayer of homePlayers) {
      for (const awayPlayer of awayPlayers) {
        transactions.push({
          id: `${game.id}:${homePlayer}:${awayPlayer}`,
          league: game.id.split(':')[0], start: game.start, day: game.day ?? dayOf(game.start),
          away: game.away.abbr, home: game.home.abbr, line: entry.line,
          homePlayer, awayPlayer, homeAmount,
        });
      }
    }
  }
  return transactions.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

export function summarize(entries, games, week, { includeTrend = false } = {}) {
  const pairs = [];
  const standings = Object.fromEntries(players.map(name => [name, { name, settled: 0, live: 0 }]));
  const changesByPlayer = includeTrend ? Object.fromEntries(players.map(name => [name, new Map()])) : null;
  players.forEach((first, i) => {
    players.slice(i + 1).forEach(second => {
      const pair = { first, second, starting: 0, week: 0, settled: 0, live: 0, games: [] };
      for (const entry of entries) {
        if (entry.week > week || !entry.picks[first] || !entry.picks[second]
          || entry.picks[first] === entry.picks[second]) continue;
        const game = gameView(entry, games);
        const outcome = result(game, entry.line);
        const points = !outcome || outcome === 'push' ? 0 : outcome === entry.picks[first] ? stake : -stake;
        if (entry.final && entry.week < week) pair.starting += points;
        if (entry.final && entry.week === week) pair.week += points;
        if (changesByPlayer && entry.final && outcome) {
          const day = game.day ?? dayOf(game.start);
          const firstChanges = changesByPlayer[first];
          const secondChanges = changesByPlayer[second];
          firstChanges.set(day, (firstChanges.get(day) ?? 0) + points);
          secondChanges.set(day, (secondChanges.get(day) ?? 0) - points);
        }
        if (!entry.final && outcome) pair.live += points;
        if (entry.week === week || !entry.final) {
          pair.games.push({
            id: game.id, start: game.start, away: game.away.abbr, home: game.home.abbr,
            firstSide: entry.picks[first], line: entry.line, state: game.state, outcome, points,
          });
        }
      }
      pair.games.sort((a, b) => b.start.localeCompare(a.start));
      pair.settled = pair.starting + pair.week;
      pair.live += pair.settled;
      pairs.push(pair);
      standings[first].settled += pair.settled;
      standings[first].live += pair.live;
      standings[second].settled -= pair.settled;
      standings[second].live -= pair.live;
    });
  });
  if (changesByPlayer) {
    for (const [name, changes] of Object.entries(changesByPlayer)) {
      let total = 0;
      standings[name].trend = [...changes.keys()].sort().map(day => {
        total += changes.get(day);
        return { day, total };
      });
    }
  }
  return { pairs, standings: Object.values(standings).sort((a, b) => b.live - a.live || a.name.localeCompare(b.name)) };
}
