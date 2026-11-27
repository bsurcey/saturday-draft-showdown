import { deviceCookie, devicePlayer, deviceToken, openDevices } from '../lib/device.mjs';
import { players } from '../lib/ledger.mjs';

function json(body, status = 200, token) {
  const headers = { 'Cache-Control': 'no-store' };
  if (token) headers['Set-Cookie'] = deviceCookie(token);
  return Response.json(body, { status, headers });
}

export function makePlayerHandler(openStore = openDevices) {
  return async request => {
    const token = deviceToken(request);
    try {
      if (request.method === 'GET') {
        const player = await devicePlayer(openStore(), token);
        return json({ player, players }, 200, token ?? crypto.randomUUID());
      }
      if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
        return json({ error: 'Send the player name as JSON.' }, 415);
      }
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) return json({ error: 'Invalid origin.' }, 403);
      if (!token) return json({ error: 'Enable cookies for this site, then reload to choose your name.' }, 400);
      const body = await request.json().catch(() => null);
      if (!players.includes(body?.player)) return json({ error: 'Choose your name to continue.' }, 400);

      const store = openStore();
      const { modified } = await store.set(token, body.player, { onlyIfNew: true });
      const player = modified ? body.player : await devicePlayer(store, token);
      if (player !== body.player) {
        return json({ player, error: 'This browser already has a player. Reload to continue.' }, 409);
      }
      return json({ player }, 200, token);
    } catch (error) {
      console.error('Fripp player:', error);
      return json({ error: 'Player lookup is temporarily unavailable. Please try again.' }, 503);
    }
  };
}

export default makePlayerHandler();
