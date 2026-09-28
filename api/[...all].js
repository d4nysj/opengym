// Backend de openGym adaptado a funciones serverless de Vercel.
// Mismo comportamiento que api/server.js (que sigue intacto para quien lo
// autoaloje con Docker), pero:
//  - sin estado en memoria entre peticiones (cada invocación puede caer en
//    una instancia distinta): sesiones/retos/presencia/timers viven en Supabase.
//  - sin el Coach de IA: depende de spawnear CLIs con caché en disco, algo
//    que no existe en un runtime serverless. Deshabilitado en este despliegue.
import crypto from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import * as store from './_store.js';
import { sendPush, vapidPublicKey } from './_push.js';
import { readSession, sessionCookie, clearCookie, isAdmin } from './_session.js';

const RP_ID = process.env.RP_ID || 'localhost';
const ORIGIN = process.env.ORIGIN || 'http://localhost:3000';
const RP_NAME = process.env.RP_NAME || 'openGym';
const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || '');
const b64uToBuf = s => Buffer.from(s, 'base64url');

function json(res, code, obj, extraHeaders) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(JSON.stringify(obj));
}
// Vercel ya parsea el body JSON en req.body para peticiones Content-Type: application/json.
const body = req => (req.body && typeof req.body === 'object') ? req.body : {};

function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return S.week?.[wd] || null;
}

async function requireAdmin(req, res) {
  const user = await readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  if (!isAdmin(user)) { json(res, 403, { error: 'forbidden' }); return null; }
  return user;
}

const routes = {
  'GET /api/health': async (req, res) => {
    const users = await store.listUsers();
    json(res, 200, { ok: true, users: users.length });
  },

  'GET /api/config': async (req, res) => {
    json(res, 200, { invite_only: INVITE_ONLY }); // Coach ausente: no configurado en este despliegue
  },

  'GET /api/me': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } });
  },

  'POST /api/register/options': async (req, res) => {
    const b = body(req);
    const name = String(b.name || '').trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'name required' });
    const code = String(b.code || '').trim().toUpperCase();
    if (INVITE_ONLY && !(await store.findValidInvite(code)))
      return json(res, 403, { error: 'a valid invite code is required' });
    const uid = crypto.randomBytes(12).toString('base64url');
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID: RP_ID,
      userID: Buffer.from(uid), userName: name, userDisplayName: name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: []
    });
    const cid = crypto.randomBytes(16).toString('base64url');
    await store.putChallenge(cid, { challenge: options.challenge, name, uid, code });
    json(res, 200, { cid, options });
  },

  'POST /api/register/verify': async (req, res) => {
    const b = body(req);
    const c = await store.takeChallenge(b.cid);
    if (!c || !c.uid) return json(res, 400, { error: 'challenge expired — try again' });
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: b.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false
      });
    } catch (e) { return json(res, 400, { error: 'verification failed: ' + e.message }); }
    if (!verification.verified) return json(res, 400, { error: 'not verified' });
    const { credential } = verification.registrationInfo;
    if (await store.credExists(credential.id)) return json(res, 409, { error: 'credential already registered' });
    let invite = null;
    if (INVITE_ONLY) {
      invite = await store.findValidInvite(c.code);
      if (!invite) return json(res, 403, { error: 'invite code is no longer valid — ask for a new one' });
    }
    const created = new Date().toISOString();
    const user = await store.createUser({ id: c.uid, name: c.name, invitedBy: invite ? invite.code : null });
    if (invite) await store.markInviteUsed(invite.code, user.id, created);
    await store.insertCred({
      id: credential.id, userId: user.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0,
      transports: b.credential?.response?.transports || []
    });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } }, { 'Set-Cookie': sessionCookie(user) });
  },

  'POST /api/login/options': async (req, res) => {
    const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'preferred', allowCredentials: [] });
    const cid = crypto.randomBytes(16).toString('base64url');
    await store.putChallenge(cid, { challenge: options.challenge });
    json(res, 200, { cid, options });
  },

  'POST /api/login/verify': async (req, res) => {
    const b = body(req);
    const c = await store.takeChallenge(b.cid);
    if (!c) return json(res, 400, { error: 'challenge expired — try again' });
    const cred = await store.getCredById(b.credential?.id);
    if (!cred) return json(res, 404, { error: 'unknown passkey — create a profile first' });
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: b.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false,
        credential: { id: cred.id, publicKey: b64uToBuf(cred.public_key), counter: cred.counter, transports: cred.transports }
      });
    } catch (e) { return json(res, 400, { error: 'verification failed: ' + e.message }); }
    if (!verification.verified) return json(res, 400, { error: 'not verified' });
    await store.updateCredCounter(cred.id, verification.authenticationInfo.newCounter);
    const user = await store.getUserById(cred.user_id);
    if (!user) return json(res, 500, { error: 'user missing' });
    if (user.disabled) return json(res, 403, { error: 'this account has been disabled' });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } }, { 'Set-Cookie': sessionCookie(user) });
  },

  'POST /api/logout': async (req, res) => json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie }),

  'POST /api/logout/all': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await store.bumpSessionVersion(user);
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  'GET /api/data': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const state = await store.getState(user.id);
    json(res, 200, { state });
  },

  'PUT /api/data': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const b = body(req);
    if (!b.state || typeof b.state !== 'object') return json(res, 400, { error: 'state required' });
    delete b.state.active;
    await store.putState(user.id, b.state);
    json(res, 200, { ok: true, ts: b.state._ts || null });
  },

  'GET /api/push/public-key': async (req, res) => json(res, 200, { key: vapidPublicKey }),

  'POST /api/push/subscribe': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const sub = body(req).subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'invalid subscription' });
    await store.upsertSub({ userId: user.id, endpoint: sub.endpoint, keys: sub.keys });
    json(res, 200, { ok: true });
  },

  'POST /api/push/unsubscribe': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await store.deleteSub(user.id, body(req).endpoint);
    json(res, 200, { ok: true });
  },

  'POST /api/push/test': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await sendPush(user.id, { title: 'openGym', body: 'Test notification ✅ — this is what alerts look like.', tag: 'test' });
    json(res, 200, { ok: true });
  },

  // El disparo real ya no es un setTimeout en memoria (no sobrevive entre invocaciones):
  // queda anotado en Supabase y lo dispara el cron de /api/cron/rest-timers.
  'POST /api/push/rest-timer': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const sec = Math.max(1, Math.min(3600, Math.round(+body(req).seconds || 0)));
    if (!sec) return json(res, 400, { error: 'seconds required' });
    await store.scheduleRestTimer(user.id, sec);
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer/cancel': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await store.cancelRestTimer(user.id);
    json(res, 200, { ok: true });
  },

  'POST /api/activity': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const b = body(req);
    if (b.active) {
      await store.setPresence(user.id, {
        name: String(b.name || '').slice(0, 60),
        exIdx: +b.exIdx || 0, exTotal: +b.exTotal || 0,
        setsDone: +b.setsDone || 0, setsTotal: +b.setsTotal || 0,
        startedAt: +b.startedAt || Date.now(), updatedAt: Date.now()
      });
    } else await store.clearPresence(user.id);
    json(res, 200, { ok: true });
  },

  /* ---------- admin dashboard ---------- */
  'GET /api/admin/users': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const users = await store.listUsers();
    const pushSet = await store.usersWithPush();
    const out = [];
    for (const u of users) {
      const S = (await store.getState(u.id)) || {};
      const workouts = S.workouts || [];
      const last = workouts[workouts.length - 1];
      out.push({
        id: u.id, name: u.name, created: u.created || null,
        disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invited_by || null,
        workouts: workouts.length,
        lastWorkout: last ? last.d : null,
        lastSync: S._ts || null,
        hasPush: pushSet.has(u.id),
        live: await store.getPresence(u.id)
      });
    }
    json(res, 200, { users: out, invite_only: INVITE_ONLY, now: Date.now() });
  },

  'GET /api/admin/user': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = await store.getUserById(id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = (await store.getState(u.id)) || {};
    json(res, 200, {
      user: { id: u.id, name: u.name, created: u.created || null, disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invited_by || null },
      unit: S.unit || 'kg',
      lastSync: S._ts || null,
      routines: (S.routines || []).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: (r.ex || []).length })),
      bodyweight: S.bodyweight || [],
      workouts: (S.workouts || []).slice().reverse()
    });
  },

  'POST /api/admin/user/disable': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const b = body(req);
    const u = await store.getUserById(b.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot disable an admin' });
    await store.setDisabled(u.id, !!b.disabled);
    if (b.disabled) await store.clearPresence(u.id);
    json(res, 200, { ok: true, id: u.id, disabled: !!b.disabled });
  },

  'GET /api/admin/invites': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const invites = await store.listInvites();
    const users = await store.listUsers();
    const out = invites.map(i => ({
      ...i, usedByName: i.used_by ? (users.find(u => u.id === i.used_by) || {}).name || null : null
    }));
    json(res, 200, { invites: out, invite_only: INVITE_ONLY });
  },

  'POST /api/admin/invites/new': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const b = body(req);
    let code, existing;
    do {
      code = crypto.randomBytes(8).toString('hex').toUpperCase();
      existing = await store.findValidInvite(code);
    } while (existing);
    const invite = await store.createInvite({ code, note: String(b.note || '').slice(0, 60), createdBy: admin.id });
    json(res, 200, { invite });
  },

  'POST /api/admin/invites/revoke': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const code = String(body(req).code || '').toUpperCase();
    const result = await store.deleteInviteIfUnused(code);
    if (!result.ok) return json(res, result.reason === 'already used' ? 400 : 404, { error: result.reason === 'already used' ? 'already used — cannot revoke' : 'no such code' });
    json(res, 200, { ok: true });
  }
};

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const key = req.method + ' ' + url.pathname;
  const route = routes[key];
  if (!route) return json(res, 404, { error: 'not found' });
  try {
    await route(req, res);
  } catch (e) {
    console.error(key, e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
}
