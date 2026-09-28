// Cliente de Supabase para el backend serverless de Vercel.
// Usa siempre la service_role key: la autorización de usuario final la hace
// esta misma capa (cookie firmada), no Postgres RLS — por eso las tablas
// tienen RLS activado pero sin policies (bloqueadas para anon/publishable).
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en las variables de entorno de Vercel');
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false }
});
