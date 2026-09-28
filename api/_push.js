// Notificaciones push (Web Push / VAPID). Las claves VAPID ya no se generan
// y guardan en un fichero al arrancar (no hay "arrancar": son funciones
// serverless) — se generan una vez con scripts/generate-vapid.mjs y se
// guardan como variables de entorno en Vercel.
import webpush from 'web-push';
import { listSubsForUser, deleteSubByEndpoint } from './_store.js';

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const ORIGIN = process.env.ORIGIN || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || (ORIGIN.startsWith('https') ? ORIGIN : 'mailto:admin@localhost');

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

export const vapidPublicKey = VAPID_PUBLIC || null;

export async function sendPush(userId, payload) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return; // Coach/push deshabilitado si faltan las claves
  const subs = await listSubsForUser(userId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async sub => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { urgency: 'high' });
    } catch (e) {
      console.error('push send failed', userId, e.statusCode, e.body || e.message);
      if (e.statusCode === 404 || e.statusCode === 410) await deleteSubByEndpoint(sub.endpoint);
    }
  }));
}
