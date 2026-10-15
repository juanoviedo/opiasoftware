# Servidor local de OPIA Software

Servidor HTTP de **cero dependencias** escrito sobre la librería estándar de Node.
No hay `npm install`, no hay módulos nativos que compilar y no hay base de datos: los
registros se guardan en JSONL dentro de `server/data/`.

Sirve tres cosas a la vez: el sitio completo, la captura de leads y el panel `/opadmin`.

---

## Requisitos

**Node.js 20 o superior.** Verificado en v20.18.0. No usa nada posterior a Node 18,
así que cualquier versión LTS funciona.

```bash
node --version
```

---

## Arranque

```bash
node server/index.js
```

Salida esperada:

```
  OPIA Software — servidor local
  Sitio:    http://localhost:3000
  Panel:    http://localhost:3000/opadmin
  Datos:    C:\...\opiasoftware\server\data
  Retención: 90 días   Zona: America/Bogota
  Proxy de confianza: no
```

Si el puerto está ocupado el proceso lo dice en español y sale, en vez de volcar una
pila de error. Para cambiarlo: `OPIA_PORT=3100 node server/index.js`.

### Primer arranque: dos cosas obligatorias

**1. Fijar la contraseña del panel.** No hay contraseña por defecto; sin este paso
`/opadmin` muestra el formulario de acceso y nadie puede entrar.

```bash
node server/scripts/set-password.js
```

Usuario por defecto `opia`. Para cambiarlo: `--user nombre`. La contraseña se guarda con
**scrypt** (N=16384, r=8, p=1) y se compara con `timingSafeEqual`.

**2. Poner los IDs de medición.**

```bash
cp server/ads-config.example.json server/ads-config.json
```

Y llenar `ga4Id`, `googleAdsId`, `googleAdsLeadLabel` y `googleAdsContactLabel`. El
archivo está en `.gitignore`: no se sube al repositorio.

Los IDs se **validan contra su patrón** antes de inyectarse (`G-…`, `AW-…`, `GTM-…`). Un
ID mal pegado no rompe el sitio: simplemente no se inyecta la etiqueta. Verificar en las
DevTools que el `<script>` de gtag aparece en el `<head>` después de reiniciar.

---

## Qué sirve y por dónde

| Ruta | Qué hace |
|---|---|
| `/`, `/servicios`, `/contacto`, … | El sitio estático prerenderizado del repositorio |
| `/lp/diagnostico-gratis` | La landing de la pauta (HTML independiente, no carga React) |
| `/__opia/beacon.js` | Registro de visitas, clics de WhatsApp y primer toque UTM |
| `/__opia/conversions.js` | Eventos `Contact` y `Lead` hacia Pixel y Google Ads |
| `/api/track` | POST del beacon |
| `/api/leads` | POST del formulario de la landing |
| `/api/health` | Verificación de que el proceso está vivo |
| `/opadmin` | Panel, protegido por sesión |
| `/api/admin/stats`, `/api/admin/leads` | JSON del panel, protegidos por sesión |

El sitio se resuelve con semántica de `cleanUrls`: `/contacto/` redirige **308** a
`/contacto`, que es la forma canónica que ya declara `sitemap.xml`. Invertir esa
dirección rompería todo el SEO acumulado.

Las etiquetas de medición se inyectan en el `<head>` **al servir**, así que no hace
falta editar los 11 HTML prerenderizados. Esto importa porque el sitio usa
`hydrateRoot` sobre `#root`: cualquier HTML que se escriba a mano dentro de ese
contenedor desaparece en cuanto React hidrata.

---

## Ponerlo en Internet con HTTPS (necesario para pautar)

Ni Meta ni Google Ads aceptan una landing en `http://` ni en una IP. Hace falta un
dominio con certificado válido. **Cloudflare Tunnel** lo resuelve sin abrir puertos en
el router, sin IP pública fija y sin pagar certificado.

### Opción rápida, solo para probar

```bash
cloudflared tunnel --url http://localhost:3000
```

Da una URL del tipo `https://algo-aleatorio.trycloudflare.com`. No requiere cuenta.
**No sirve para producción**: la URL cambia en cada reinicio, y cambiarla rompe la
configuración del dominio del Pixel y las URL finales de los anuncios.

### Opción de producción

Requisitos: cuenta de Cloudflare y `cloudflared` instalado.

```bash
cloudflared tunnel login
cloudflared tunnel create opiasoftware
cloudflared tunnel route dns opiasoftware www.opiasoftware.com
```

Crear `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: opiasoftware
credentials-file: C:\Users\TU_USUARIO\.cloudflared\OPIASOFTWARE.json

ingress:
  - hostname: www.opiasoftware.com
    service: http://localhost:3000
  - hostname: opiasoftware.com
    service: http://localhost:3000
  - service: http_status:404
```

Probar y después instalar como servicio de Windows para que arranque solo:

```bash
cloudflared tunnel run opiasoftware          # prueba en primer plano
cloudflared service install opiasoftware     # servicio persistente
```

Y arrancar el servidor con el proxy activado:

```bash
OPIA_TRUST_PROXY=1 OPIA_PUBLIC_URL=https://www.opiasoftware.com node server/index.js
```

`OPIA_TRUST_PROXY=1` hace que el servidor lea la IP real del visitante en
`CF-Connecting-IP` en vez de ver la IP del túnel en todas las visitas.

> **Activar `trustProxy` solo detrás de un proxy de confianza.** Si se activa con el
> servidor expuesto directamente, cualquiera puede mandar una cabecera `X-Forwarded-For`
> inventada y falsear el país y la ciudad que muestra el panel.

Si el dominio está en otro registrador y no quieres mover los nameservers a Cloudflare,
la alternativa es un registro **CNAME** de `www` apuntando a
`<ID-DEL-TUNEL>.cfargotunnel.com`.

### Lo que cuesta autohospedar, dicho claro

El servidor corre en tu máquina. Eso significa que el sitio se cae cuando la máquina se
apaga, se reinicia por una actualización de Windows, o se va la luz. Para una landing
que está recibiendo tráfico pago, cada minuto caído es dinero gastado en clics que
llegan a un error.

Antes de encender pauta:

- Desactivar suspensión e hibernación en el plan de energía.
- Arranque automático del servicio de `cloudflared` y del proceso Node.
- **Copia de seguridad de `server/data/`** — es la única copia de los leads. El archivo
  está fuera de git a propósito, así que git no lo protege.
- La landing tiene un respaldo: si `/api/leads` no responde, redirige a WhatsApp en vez
  de perder el lead. Funciona, pero no sustituye al servidor arriba.

**Alternativa razonable:** dejar el sitio en Vercel y usar el servidor local solo para
el panel y la analítica. Requiere habilitar CORS con lista de orígenes permitidos en
`/api/leads` y `/api/track`, que **no está implementado** y no conviene improvisar: un
endpoint de leads abierto a cualquier origen es un imán de spam. Si prefieres esta
arquitectura, se implementa con una lista blanca de orígenes.

---

## Configuración

Todo por variable de entorno o por `server/ads-config.json`. Las de publicidad van en el
archivo; las de infraestructura, por entorno.

| Variable | Por defecto | Qué controla |
|---|---|---|
| `OPIA_HOST` | `0.0.0.0` | Interfaz de escucha |
| `OPIA_PORT` | `3000` | Puerto |
| `OPIA_PUBLIC_ROOT` | raíz del repositorio | Qué carpeta se sirve como sitio |
| `OPIA_PUBLIC_URL` | vacío | URL canónica; vacía = sin canonical absoluto |
| `OPIA_TRUST_PROXY` | no | Leer IP real de cabeceras de proxy |
| `OPIA_ADMIN_USER` | `opia` | Usuario del panel |
| `OPIA_SESSION_TTL_MINUTES` | `720` | Duración de la sesión (12 h) |
| `OPIA_RETENTION_DAYS` | `90` | Días antes de purgar visitas y leads |
| `OPIA_TZ` | `America/Bogota` | Zona horaria de los gráficos del panel |
| `OPIA_DATA_DIR` | `server/data` | Dónde se escribe todo |
| `OPIA_TRACK_ENABLED` | `true` | Apagar el registro por completo |
| `OPIA_TRACK_INTERNAL` | `true` | Registrar IPs privadas, marcadas como internas |
| `OPIA_GEO_PRIMARY` | `https://ipwho.is/{ip}` | Proveedor de GeoIP |
| `OPIA_GEO_FALLBACK` | `https://ipapi.co/{ip}/json/` | Proveedor alternativo |
| `OPIA_GEO_MAX_CONCURRENT` | `3` | Peticiones GeoIP simultáneas |
| `OPIA_GEO_CACHE_DAYS` | `30` | Vigencia de la caché local |
| `OPIA_GEO_RETRY_MINUTES` | `60` | Cada cuánto reintentar una IP fallida |

---

## Datos y privacidad

Todo se escribe en `server/data/`, que está en `.gitignore`:

| Archivo | Contenido |
|---|---|
| `visits.jsonl` | Una línea por página vista |
| `leads.jsonl` | Una línea por formulario enviado |
| `geo-cache.json` | Caché de GeoIP, para no repetir consultas |
| `admin.json` | Usuario y hash scrypt de la contraseña |
| `secret.key` | Clave HMAC de las cookies de sesión (permisos 0600) |

La purga corre al arrancar y cada 6 horas, y elimina lo que pase de
`OPIA_RETENTION_DAYS`.

**Las IPs y las ubicaciones son datos personales** bajo la Ley 1581 de 2012 de Colombia.
El panel muestra país, ciudad e ISP, que es lo que hace falta para decisiones de negocio
sin identificar a nadie. El formulario de la landing pide consentimiento explícito, con
la casilla sin marcar por defecto.

`/opadmin` responde con `noindex, nofollow` para que ningún buscador lo indexe.

### GeoIP

Se resuelve por HTTPS contra `ipwho.is`, con `ipapi.co` de respaldo, y **caché local
persistente**. Se eligió así a propósito: evita descargar una base MaxMind de 60 MB y
evita módulos nativos que habría que compilar en Windows. El costo es que la primera
consulta de cada IP depende de que haya Internet; después queda en caché.

`pendingGeo` en `/api/admin/stats` dice cuántas visitas esperan resolución. Si ese
número no baja, el proveedor está fallando o se agotó el límite gratuito.

---

## Verificación rápida

```bash
node server/index.js &
curl -s http://localhost:3000/api/health
curl -sI http://localhost:3000/contacto/ | head -3      # debe dar 308 a /contacto
curl -s -X POST http://localhost:3000/api/leads \
  -H 'Content-Type: application/json' \
  -d '{"name":"Prueba","email":"prueba@example.com","phone":"3001234567",
       "service":"automatizacion","message":"verificacion","consent":true}'
```

El lead de prueba queda en `server/data/leads.jsonl` y se ve en `/opadmin`. Se borra
editando el archivo con el servidor detenido.

---

## Documentación relacionada

- [../marketing/plan-leads/README.md](../marketing/plan-leads/README.md) — índice del
  plan de captación
- [../marketing/plan-leads/05-medicion-presupuesto.md](../marketing/plan-leads/05-medicion-presupuesto.md)
  — qué mide cada fuente y cómo se concilian
