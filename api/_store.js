// Capa de acceso a datos: sustituye el db.json + ficheros de estado del
// server.js original por consultas a Supabase. Cada función es el
// equivalente directo de una operación que en el original era una
// lectura/escritura de memoria o de fichero.
import { supabase } from './_supabase.js';

const row = ({ data, error }) => { if (error) throw error; return data; };
const maybeRow = ({ data, error }) => { if (error && error.code !== 'PGRST116') throw error; return data || null; };

/* ---------- users ---------- */
export async function getUserById(id) {
  return maybeRow(await supabase.from('users').select('*').eq('id', id).maybeSingle());
}
export async function createUser({ id, name, invitedBy }) {
  return row(await supabase.from('users').insert({ id, name, invited_by: invitedBy || null }).select().single());
}
export async function bumpSessionVersion(user) {
  const sv = (user.sv || 0) + 1;
  await supabase.from('users').update({ sv }).eq('id', user.id);
  return sv;
}
export async function setDisabled(id, disabled) {
  await supabase.from('users').update({ disabled }).eq('id', id);
}
export async function setLastReminder(id, dateIso) {
  await supabase.from('users').update({ last_reminder: dateIso }).eq('id', id);
}
export async function listUsers() {
  return row(await supabase.from('users').select('*').order('created', { ascending: true }));
}

/* ---------- webauthn credentials ---------- */
export async function getCredById(id) {
  return maybeRow(await supabase.from('creds').select('*').eq('id', id).maybeSingle());
}
export async function credExists(id) {
  return !!(await getCredById(id));
}
export async function insertCred({ id, userId, publicKey, counter, transports }) {
  await supabase.from('creds').insert({ id, user_id: userId, public_key: publicKey, counter, transports });
}
export async function updateCredCounter(id, counter) {
  await supabase.from('creds').update({ counter }).eq('id', id);
}

/* ---------- invites ---------- */
export async function findValidInvite(code) {
  if (!code) return null;
  return maybeRow(await supabase.from('invites').select('*').eq('code', code).is('used_by', null).eq('revoked', false).maybeSingle());
}
export async function markInviteUsed(code, userId, whenIso) {
  await supabase.from('invites').update({ used_by: userId, used_at: whenIso }).eq('code', code);
}
export async function listInvites() {
  return row(await supabase.from('invites').select('*').order('created', { ascending: false }));
}
export async function createInvite({ code, note, createdBy }) {
  return row(await supabase.from('invites').insert({ code, note: note || null, created_by: createdBy }).select().single());
}
export async function deleteInviteIfUnused(code) {
  const inv = maybeRow(await supabase.from('invites').select('*').eq('code', code).maybeSingle());
  if (!inv) return { ok: false, reason: 'no such code' };
  if (inv.used_by) return { ok: false, reason: 'already used' };
  await supabase.from('invites').delete().eq('code', code);
  return { ok: true };
}

/* ---------- push subscriptions ---------- */
export async function listSubsForUser(userId) {
  return row(await supabase.from('subs').select('*').eq('user_id', userId));
}
export async function hasSubForUser(userId) {
  const { count, error } = await supabase.from('subs').select('id', { count: 'exact', head: true }).eq('user_id', userId);
  if (error) throw error;
  return !!count;
}
export async function upsertSub({ userId, endpoint, keys }) {
  await supabase.from('subs').delete().eq('endpoint', endpoint);
  await supabase.from('subs').insert({ user_id: userId, endpoint, keys });
}
export async function deleteSub(userId, endpoint) {
  await supabase.from('subs').delete().eq('user_id', userId).eq('endpoint', endpoint);
}
export async function deleteSubByEndpoint(endpoint) {
  await supabase.from('subs').delete().eq('endpoint', endpoint);
}
export async function usersWithPush() {
  const subs = row(await supabase.from('subs').select('user_id'));
  return new Set(subs.map(s => s.user_id));
}

/* ---------- per-user app state (routines, workouts, bodyweight...) ---------- */
export async function getState(userId) {
  const r = maybeRow(await supabase.from('user_state').select('state').eq('user_id', userId).maybeSingle());
  return r ? r.state : null;
}
export async function putState(userId, state) {
  await supabase.from('user_state').upsert({ user_id: userId, state, updated: new Date().toISOString() });
}

/* ---------- webauthn challenges (reemplaza el Map en memoria) ---------- */
export async function putChallenge(cid, data) {
  const expires_at = new Date(Date.now() + 5 * 60000).toISOString();
  await supabase.from('webauthn_challenges').insert({ cid, data, expires_at });
}
export async function takeChallenge(cid) {
  const c = maybeRow(await supabase.from('webauthn_challenges').select('*').eq('cid', cid).maybeSingle());
  if (!c) return null;
  await supabase.from('webauthn_challenges').delete().eq('cid', cid);
  if (new Date(c.expires_at).getTime() < Date.now()) return null;
  return c.data;
}

/* ---------- live presence (reemplaza el Map en memoria) ---------- */
const PRESENCE_TTL_MS = 70000;
export async function setPresence(userId, data) {
  await supabase.from('presence').upsert({ user_id: userId, data, updated_at: new Date().toISOString() });
}
export async function clearPresence(userId) {
  await supabase.from('presence').delete().eq('user_id', userId);
}
export async function getPresence(userId) {
  const p = maybeRow(await supabase.from('presence').select('*').eq('user_id', userId).maybeSingle());
  if (!p) return null;
  if (Date.now() - new Date(p.updated_at).getTime() > PRESENCE_TTL_MS) return null;
  return p.data;
}

/* ---------- rest timers (reemplaza setTimeout en memoria; los dispara un cron) ---------- */
export async function scheduleRestTimer(userId, seconds) {
  const fire_at = new Date(Date.now() + seconds * 1000).toISOString();
  await supabase.from('rest_timers').upsert({ user_id: userId, fire_at });
}
export async function cancelRestTimer(userId) {
  await supabase.from('rest_timers').delete().eq('user_id', userId);
}
export async function dueRestTimers() {
  return row(await supabase.from('rest_timers').select('*').lte('fire_at', new Date().toISOString()));
}
export async function deleteRestTimer(userId) {
  await supabase.from('rest_timers').delete().eq('user_id', userId);
}
