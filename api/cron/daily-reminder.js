// Sustituye el setInterval de 10s del original que recorría los usuarios
// comprobando su hora local. Aquí un llamador externo pega cada pocos
// minutos (ver .github/workflows/cron.yml); con esa granularidad el aviso
// puede llegar unos minutos después de la hora exacta configurada, no al segundo.
import { listUsers, usersWithPush, getState, setLastReminder } from '../_store.js';
import { sendPush } from '../_push.js';

function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return S.week?.[wd] || null;
}
function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    const date = `${g('year')}-${g('month')}-${g('day')}`;
    return { date, hhmm: `${g('hour')}:${g('minute')}`, weekday: new Date(date + 'T12:00:00Z').getUTCDay() };
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    res.writeHead(401); return res.end();
  }
  const pushSet = await usersWithPush();
  const users = (await listUsers()).filter(u => pushSet.has(u.id));
  let fired = 0;
  for (const user of users) {
    const S = await getState(user.id);
    if (!S?.reminder?.on) continue;
    const now = userNow(S.reminder.tz || 'UTC');
    if (!now) continue;
    // Ventana de tolerancia: el cron externo no pega al segundo exacto como el setInterval
    // original, así que se compara por minuto exacto una sola vez al día (lastReminder evita duplicados).
    if (S.reminder.time !== now.hhmm) continue;
    if (user.last_reminder === now.date) continue;
    if ((S.workouts || []).some(w => w.d === now.date)) continue;
    const rid = effectiveRoutineId(S, now.date);
    if (!rid) continue;
    const routine = (S.routines || []).find(r => r.id === rid);
    await setLastReminder(user.id, now.date);
    await sendPush(user.id, {
      title: routine ? `${routine.emoji || '🏋️'} ${routine.name} today` : 'Workout planned today',
      body: "It's on your plan — let's go 💪",
      tag: 'day-reminder'
    });
    fired++;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, fired }));
}
