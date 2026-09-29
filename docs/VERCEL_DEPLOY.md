# Desplegar en Vercel (rama `vercel-deploy`)

Esta rama sustituye el backend original (un único proceso Node con estado en
memoria y `db.json` en disco) por funciones serverless (`api/[...all].js`,
`api/cron/*.js`) con [Supabase](https://supabase.com) como base de datos.
El resto de la app (frontend, lógica de negocio, WebAuthn) es la misma.

**Qué NO funciona igual que autoalojado con Docker:**

- **El Coach de IA está deshabilitado.** Depende de spawnear las CLIs de
  Claude Agent SDK / Codex con caché persistente en disco — no existe eso en
  un runtime serverless. `GET /api/config` nunca devuelve `coach`.
- **Los avisos de "fin del descanso" y el recordatorio diario dependen de un
  cron externo**, no de un timer en memoria: llegan con hasta unos minutos de
  margen, no al segundo. En el plan gratuito (Hobby) de Vercel los Cron Jobs
  propios están limitados a una vez al día, así que se dispara desde GitHub
  Actions en vez de `vercel.json` (ver `.github/workflows/cron.yml`) —
  gratis y sin ese límite.

## 1. Variables de entorno en Vercel (Project Settings → Environment Variables)

| Variable | Valor |
|---|---|
| `SUPABASE_URL` | `https://xiaqpfbviyomwttbhbry.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Copiar de Supabase → Project Settings → API → `service_role` (secreto, nunca el `anon`/`publishable`) |
| `SESSION_SECRET` | Generado — ver `AIOS/secrets/credenciales.md` en el vault |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Generados — ver `AIOS/secrets/credenciales.md` |
| `CRON_SECRET` | Generado — ver `AIOS/secrets/credenciales.md`. También va como secret de GitHub Actions (`CRON_SECRET`) |
| `RP_ID` | El dominio final sin `https://`, ej. `opengym.vercel.app` (se sabe **después** del primer deploy) |
| `ORIGIN` | `https://` + el mismo dominio, ej. `https://opengym.vercel.app` |
| `RP_NAME` | `openGym` (opcional, ya es el valor por defecto) |
| `ADMIN_UIDS` | (opcional) tu `uid` una vez registrado el primer perfil, para tener panel de admin |
| `INVITE_ONLY` | (opcional) `1` si quieres registro solo con código de invitación |
| `SESSION_DAYS` | (opcional) por defecto 90 |

`RP_ID`/`ORIGIN` **tienen que coincidir exactamente con el dominio real**: las
passkeys quedan atadas al hostname. Como no se conoce hasta el primer
despliegue, el flujo es: desplegar una vez → copiar el dominio que dé Vercel →
poner `RP_ID`/`ORIGIN` → redeploy.

## 2. Importar el proyecto en Vercel

1. New Project → importar `d4nysj/opengym` desde GitHub.
2. Rama a desplegar: `vercel-deploy` (no `main`, para no mezclarlo con la
   versión Docker del proyecto original).
3. Framework preset: "Other". `vercel.json` ya trae `buildCommand`,
   `outputDirectory` e `installCommand`.
4. Pegar las variables de entorno de la tabla de arriba (menos `RP_ID`/`ORIGIN`,
   que van después).
5. Deploy.
6. Copiar el dominio asignado (`https://<algo>.vercel.app`), rellenar
   `RP_ID`/`ORIGIN` con él, y hacer Redeploy.

## 3. Activar el cron externo (GitHub Actions)

En `github.com/d4nysj/opengym` → Settings → Secrets and variables → Actions:
- `CRON_SECRET`: el mismo valor que en Vercel.
- `OPENGYM_URL`: `https://<tu-dominio>.vercel.app`.

El workflow `.github/workflows/cron.yml` ya está en el repo y se activa solo
en cuanto existan esos dos secrets (corre cada 5 minutos).

## 4. Primer usuario admin, luego cerrar el registro (invite-only)

Hay un huevo-o-gallina: `INVITE_ONLY` bloquea el registro sin código, pero
hasta que existe un admin no hay quien genere códigos. Orden correcto:

1. Despliega con `INVITE_ONLY` sin poner (o en `0`) y entra a la web para
   crear tu perfil (passkey) normalmente — este primer registro queda
   abierto a cualquiera que conozca la URL, así que hazlo cuanto antes tras
   el primer deploy.
2. En Supabase → Table Editor → `users`, copia tu `id`, o ponlo directo en
   la variable de entorno `ADMIN_UIDS` de Vercel (alternativa: marcar
   `admin = true` en esa fila desde el SQL editor de Supabase).
3. Añade `INVITE_ONLY=1` en las variables de entorno de Vercel y redeploy:
   a partir de aquí nadie más puede crear una cuenta sin un código.
4. Desde el panel de admin de la web (`/admin` → Invites), genera un código
   de invitación de un solo uso por cada persona a la que quieras dar
   acceso. Los códigos se pueden revocar mientras no se hayan usado.
