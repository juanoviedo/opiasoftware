# AGENTS.md

Guía para agentes de IA que trabajen en este repositorio. El repo es **público**: nada de IPs internas, usuarios, tokens ni contraseñas en archivos commiteados.

## El proyecto

Sitio corporativo y de captura de leads de OPIA Software (opiasoftware.com), empresa colombiana de software y marketing. Dos piezas:

1. **Sitio prerenderizado** en la raíz del repo: HTML/CSS/JS ya construidos. No hay build de frontend; se editan directo o se regeneran y se commitean.
2. **Servidor Node sin dependencias** (`server/index.js`): sirve esas páginas, registra visitas y leads propios (JSONL), expone `/opadmin` (panel interno) y `/api/*` (track, leads, login).

Idioma de todo el contenido, mensajes de error y comentarios: español (Colombia). Moneda: COP.

## Comandos

```bash
node server/index.js              # servidor local → http://localhost:3000
node server/scripts/set-password.js        # contraseña del panel /opadmin (interactivo)
node scripts/inject-tags.js       # hornea GA4/Pixel/beacon en los HTML desde server/ads-config.json
python marketing/plan-leads/tools/meta_api.py --validate   # valida credenciales de Meta Marketing API
```

No hay tests automatizados ni linter: verificar con curl (`/api/health`, `/privacidad`, `/lp/diagnostico-gratis`) y revisando el HTML servido.

## Producción

- Corre en **Docker** (`docker-compose.yml`, proyecto `opiasoftware-home`, puerto local 8160 → 3000) sobre un servidor Debian, publicado al mundo por un **túnel de Cloudflare gestionado desde el dashboard** (no existe config.yml local del túnel).
- **Despliegue = `git push origin main`.** Un timer systemd en el servidor ejecuta `deploy-from-github.sh` cada 5 min (fetch + rebuild + health check en `/api/health`). No hay entorno de pruebas: main es producción.
- Datos vivos (visitas, leads, admin, secret.key) en `server/data/`, montado como volumen. Nunca se commitea (retención 90 días).
- Variables del contenedor: `OPIA_TRUST_PROXY=1`, `OPIA_PUBLIC_URL=https://opiasoftware.com`.
- Contraseña del panel: `docker exec -it opiasoftware-home-app-1 node server/scripts/set-password.js` en el servidor.

**Acceso SSH al servidor**: está documentado en `AGENTS.local.md` (ignorado por git; contiene IP y usuario). Si el archivo no existe en tu máquina, pídeselo al usuario.

## Reglas de seguridad

- Secretos ignorados por git: `server/meta-config.json` (credenciales Meta), `server/ads-config.json` (IDs de pauta), `server/data/*` (datos personales, Ley 1581 de 2012).
- Meta Marketing API: las campañas se crean **PAUSED**; `--activate` es el único paso que gasta dinero real.
- El token de acceso de Meta se compartió por chat en el pasado: debe rotarse tras lanzar la campaña.
- Formulario de leads: trampa honeypot (`website`/`url_field`) y consentimiento explícito obligatorio.
- `server/lib/static.js` bloquea por segmento `server`, `scripts`, `plan-leads`, `supabase`: documentación interna y esquemas nunca se sirven públicamente.

## Mapa del repo

- `/` — 13 páginas HTML prerenderizadas, incluidas `/lp/diagnostico-gratis` (landing de campaña) y `/privacidad` (política de datos exigida por Meta).
- `server/` — servidor Node: `index.js` (rutas), `lib/` (config, auth scrypt+HMAC, analytics, geoip, bots, ua, static), `opadmin/` (panel), `public/` (beacon.js, conversions.js), `scripts/` (set-password, hash-password).
- `marketing/plan-leads/` — plan de medios, copys y cliente de Meta Marketing API. Interno, no se sirve.
- `deploy-from-github.sh`, `Dockerfile`, `.dockerignore`, `docker-compose.yml` — despliegue en el Debian.
- `api/`, `supabase/`, `opadmin/` (raíz), `js/` (raíz), `vercel.json` — port abandonado a Vercel+Supabase; producción es el servidor Node. No mantener ni extender.
- `scripts/inject-tags.js` — hornea los tags en el HTML. Limitación conocida: si más adelante se añaden IDs de Google Ads a `server/ads-config.json`, hay que eliminar a mano el bloque `<!-- Google tag -->…<!-- End Google tag -->` de las páginas y volver a hornear; el script no regenera un bloque ya existente.

## Convenciones

- Servidor: Node puro, CommonJS, `'use strict'`, cero dependencias npm.
- Comentarios solo cuando explican el *porqué* (restricciones ocultas, decisiones no obvias), en español.
- El servidor inyecta tags solo si la página no los trae horneados (`ALREADY_INJECTED` en `lib/static.js`): una sola fuente de verdad por página.
