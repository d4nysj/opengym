// Sesiones por cookie firmada (HMAC), igual que el original, pero el secreto
// vive en la variable de entorno SESSION_SECRET (generada una vez) en vez de
// en ./data/secret — no hay disco persistente entre invocaciones serverless.
import crypto from 'node:crypto';
import { getUserById } from './_store.js';

const SECRET = process.env.SESSION_SECRET;
if (!SECRET) throw new Error('Falta SESSION_SECRET en las variables de entorno de Vercel');

const ORIGIN = process.env.ORIGIN || '';
const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';
export const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90);

function sign(payload) {
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verifySig(token) {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch { return null; }
  return payload;
}
const sessionVersion = user => user.sv || 0;

export function makeSession(user) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return sign(user.id + ':' + exp + ':' + sessionVersion(user));
}
export async function readSession(req) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const tok = cookies.gymsid;
  if (!tok) return null;
  const payload = verifySig(tok);
  if (!payload) return null;
  const [uid, exp, ver] = payload.split(':');
  if (!uid || +exp < Date.now()) return null;
  const user = await getUserById(uid);
  if (!user) return null;
  if (user.disabled) return null;
  const claimed = ver === undefined ? 0 : Number(ver);
  if (!Number.isInteger(claimed) || claimed !== sessionVersion(user)) return null;
  return user;
}
export function sessionCookie(user) {
  return `gymsid=${makeSession(user)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
}
export const clearCookie = `gymsid=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;

const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
export const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id));
