// Sustituye el setTimeout en memoria del original (no sobrevive entre
// invocaciones serverless). Un llamador externo (ver .github/workflows/cron.yml)
// pega aquí cada minuto con el header de autorización; dispara los avisos
// de "fin del descanso" que ya tocaban.
import { dueRestTimers, deleteRestTimer } from '../_store.js';
import { sendPush } from '../_push.js';

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    res.writeHead(401); return res.end();
  }
  const due = await dueRestTimers();
  for (const t of due) {
    await sendPush(t.user_id, { title: 'Rest over 💪', body: 'Time for your next set.', tag: 'rest-timer' });
    await deleteRestTimer(t.user_id);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, fired: due.length }));
}
