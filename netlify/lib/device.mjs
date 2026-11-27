import { getStore } from '@netlify/blobs';
import { players } from './ledger.mjs';

const cookieName = '__Host-fripp-device';
const tokenPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const maxAge = 60 * 60 * 24 * 365;

export const openDevices = () => getStore({ name: 'fripp-devices', consistency: 'strong' });

export function deviceToken(request) {
  const cookie = request.headers.get('cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(cookieName + '='));
  const token = cookie?.slice(cookieName.length + 1);
  return tokenPattern.test(token ?? '') ? token : null;
}

export function deviceCookie(token) {
  return cookieName + '=' + token + '; Max-Age=' + maxAge + '; Path=/; Secure; HttpOnly; SameSite=Strict';
}

export async function devicePlayer(store, token) {
  if (!token) return null;
  const name = await store.get(token);
  return players.includes(name) ? name : null;
}
