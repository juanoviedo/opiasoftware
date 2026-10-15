# 05 · Medición y presupuesto

Este documento es el que decide si los otros cuatro sirven de algo. La campaña
anterior no falló por el anuncio: falló porque **no había forma de saber qué estaba
pasando.** Sin medición no hay decisiones, solo opiniones.

---

## Tres fuentes, y ninguna es suficiente sola

| Fuente | Para qué es autoridad | Para qué NO sirve |
|---|---|---|
| **Google Ads / Meta** | Cuánto se gastó, qué anuncio lo gastó | Cuántos leads fueron reales |
| **GA4** | Comportamiento, recorrido entre canales, qué páginas se ven | Contar leads con exactitud |
| **`/opadmin` (servidor)** | Cuántos leads llegaron de verdad y de dónde | Cuánto costó cada uno |

Las plataformas se atribuyen a sí mismas. Meta cuenta como conversión un formulario
que alguien abrió y cerró; Google cuenta clics que un bloqueador no registró. Ninguna
miente, pero ambas miden desde su propio interés.

**El servidor es la única fuente que no se puede bloquear.** El lead llega como un
POST a `/api/leads` y se escribe en `server/data/leads.jsonl`. No depende de
JavaScript, de cookies, de que el navegador acepte nada, ni de que la plataforma
quiera contarlo. Por eso:

> **Regla: el servidor manda sobre la cantidad de leads. La plataforma manda sobre el
> gasto. El CPL real sale de dividir una entre el otro, no de leerlo en el panel.**

### La conciliación de los lunes

Cinco minutos, cada semana, antes de tocar nada:

1. Leads según Google Ads + leads según Meta.
2. Leads según `/opadmin` en el mismo periodo.
3. Si la diferencia es mayor al 20 %, hay un problema de medición y **no se toman
   decisiones de presupuesto hasta resolverlo.** Optimizar sobre números rotos es peor
   que no optimizar.

Las tres causas posibles de una discrepancia, en orden de frecuencia:

- **La etiqueta no está disparándose.** Lo más común. Verificar en el Administrador de
  conversiones de Google que la acción aparece como "Registrando conversiones", y en
  el Pixel Helper de Meta que el evento `Lead` llega. Si `server/ads-config.json`
  tiene los IDs vacíos, no se dispara nada y este es exactamente el síntoma.
- **Los IDs de conversión están mal pegados.** `googleAdsLeadLabel` tiene que ser la
  etiqueta de la acción de conversión, no el ID de la conversión completa.
- **Duplicación.** El Pixel del navegador y la API de conversiones contando el mismo
  lead. Se resuelve con `event_id` compartido; mientras no haya CAPI activada, no
  aplica.

---

## Lo que ya está cableado y lo que falta

**Ya funciona**, en el código del sitio:

| Pieza | Archivo | Qué hace |
|---|---|---|
| Beacon propio | `server/public/beacon.js` | Registra página vista, clics de WhatsApp y persiste el primer toque UTM en `sessionStorage` |
| Conversiones | `server/public/conversions.js` | Dispara `Contact` al pulsar WhatsApp y expone `opiaLeadSent()` para el `Lead` |
| Inyección de etiquetas | `server/lib/static.js` | Añade gtag.js y los scripts propios a las 11 páginas sin editarlas |
| Formulario y consentimiento | `lp/diagnostico-gratis/index.html` | POST a `/api/leads`, honeypot, casilla de Ley 1581 |
| Panel | `server/opadmin/index.html` | Visitas, países, ciudades, campañas, franja 10:00-20:00, alertas |
| GeoIP por IP | `server/lib/geoip.js` | Resuelve país, ciudad e ISP con caché local persistente |

El servidor se inyecta en el `<head>` de todas las páginas al servir, así que **no hay
que editar los 11 HTML prerenderizados.** Es importante porque el sitio usa
`hydrateRoot` sobre `#root`: cualquier HTML que se meta a mano dentro de ese contenedor
desaparece en cuanto React hidrata.

**Falta, y sin esto no se mide nada:** los IDs en `server/ads-config.json`.

```json
{
  "ga4Id": "G-XXXXXXXXXX",
  "googleAdsId": "AW-XXXXXXXXX",
  "googleAdsLeadLabel": "XXXXXXXXXXXXXXXX",
  "googleAdsContactLabel": "XXXXXXXXXXXXXXXX",
  "currency": "COP"
}
```

Dónde sacarlos:

- `ga4Id` → Google Analytics → Administrar → Propiedad → **ID de medición**.
- `googleAdsId` y las dos etiquetas → Google Ads → Herramientas → **Administrador de
  conversiones**. El ID empieza por `AW-`; cada acción de conversión tiene su propia
  etiqueta alfanumérica.
- Pixel de Meta → no va en este archivo. El ID (`1096286453264873`) ya está en las 11
  páginas del sitio y en la landing, con un guard que lo desactiva en localhost. Lo que
  sí haría falta para la API de conversiones es el token de acceso, que no va en código.

Validación: el servidor **rechaza** cualquier ID que no cumpla el patrón esperado
(`G-…`, `AW-…`, `GTM-…`). Un ID mal pegado no rompe el sitio, simplemente no se
inyecta. Verificar en las DevTools que aparece el `<script>` de gtag después de
reiniciar.

---

## Atribución: primer toque, no último

El beacon guarda los UTM de la **primera** visita en `sessionStorage` (`opia_ft`) y los
reutiliza en las siguientes. Sin eso, alguien que llega por un anuncio, navega a
`/servicios` y convierte ahí aparece como tráfico directo, que es exactamente lo que
pasó antes: **buena parte de "cero leads" pudo haber sido "cero leads atribuibles".**

Por qué primer toque y no último: en B2B el recorrido tiene varios pasos y el último
clic casi siempre es directo o marca (alguien que ya decidió y escribió la URL).
Atribuir al último toque hace que toda la pauta parezca inútil justo cuando está
funcionando. Primer toque dice quién trajo a la persona, que es la pregunta que hay
que responder para decidir presupuesto.

Las plataformas atribuyen a su propio último toque y van a contradecir esto. Es
esperable y no hay que intentar reconciliarlo: **son modelos distintos respondiendo
preguntas distintas.** La comparación válida es la del total de leads contra el total
de gasto, no la del detalle por campaña.

---

## Cuánto vale un lead

Antes de decidir presupuesto conviene tener este número, porque cambia por completo lo
que significa "caro". Con cifras que hay que ajustar a la realidad de OPIA:

```
Ticket promedio de un primer proyecto        $6,000 USD
Margen bruto                                 60 %
Tasa de cierre sobre lead calificado         15 %

Valor esperado por lead = 6,000 × 0.60 × 0.15 = $540 USD
```

Con un retorno objetivo de 3:1 sobre el gasto de marketing, **se puede pagar hasta
$180 por lead y el negocio sigue siendo rentable.**

Eso reordena las prioridades. El objetivo no es conseguir el lead más barato posible:
es conseguir leads que respondan, a un costo que esté por debajo de lo que valen. Un
lead de $12 que nunca contesta el teléfono es peor que uno de $80 con el que hay
reunión la misma semana. Perseguir el CPL más bajo empuja sistemáticamente hacia
formularios instantáneos y audiencias amplias, que es exactamente donde está la basura.

---

## Escenarios de presupuesto

Cifras mensuales en USD. "Leads útiles" es la estimación honesta: los que justifican
una llamada, no los que registra el panel.

| | **A · Validación** | **B · Recomendado** | **C · Escala** |
|---|---|---|---|
| Google Ads | $750 | $1,350 | $1,800 |
| Meta Ads | — | $215 (solo retargeting) | $860 (prospección + retargeting) |
| TikTok orgánico | $0 (3 h/semana propias) | $0 | $0 |
| **Total** | **$750** | **$1,565** | **$2,660** |
| Leads esperados | 12 - 20 | 35 - 50 | 90 - 120 |
| Leads útiles | 5 - 10 | 15 - 28 | 30 - 55 |
| CPL esperado | $40 - $60 | $30 - $45 | $22 - $30 |

**Hay que arrancar en A.** No es timidez: es que A es el único escenario que permite
aprender algo sin arriesgar el presupuesto de un trimestre entero. La puerta para pasar
a B está en [02-google-ads.md](02-google-ads.md#presupuesto-y-qué-cpl-es-realista-en-latam):
30 conversiones acumuladas y CPL ≤ $70.

Los rangos de leads asumen que la landing convierte entre 3 % y 8 %. Si convierte
menos, ninguna cantidad de presupuesto arregla eso: se multiplica el gasto y se
multiplica nada.

---

## Lo más barato que se puede mejorar no es técnico

Un lead contactado en los primeros cinco minutos tiene muchísimas más probabilidades de
calificar que uno contactado media hora después. El efecto está documentado de forma
repetida en estudios de ventas B2B y es enorme: no es una mejora marginal.

Con leads de $40-$80 cada uno, dejarlos enfriar en una bandeja de entrada es tirar el
presupuesto entero. Lo que hace falta no es software:

1. **Notificación inmediata** al WhatsApp del que va a llamar. El servidor ya recibe el
   POST; añadir un webhook es poco trabajo y cambia más el resultado que cualquier
   ajuste de puja.
2. **Un guion de primer contacto** de tres líneas que mencione el proceso específico que
   la persona escribió en el formulario. Demuestra que se leyó.
3. **Registrar el resultado de cada lead** en una hoja: contactado / reunión / propuesta
   / ganado / perdido y por qué. Sin esto no se puede calcular la tasa de cierre real y
   el número de $540 de más arriba se queda en suposición.

Ese registro es el dato más valioso de todo el sistema y ninguna plataforma lo tiene.

---

## Privacidad: requisito, no detalle

Se está pautando a doce países y capturando datos personales. Aplica la **Ley 1581 de
2012** de Colombia y equivalentes en cada mercado (LGPD en Brasil no aplica acá, pero sí
la LFPDPPP de México y la Ley 25.326 de Argentina).

Lo que ya está resuelto en el código:

- **Casilla de consentimiento explícita** en el formulario de la landing, citando la Ley
  1581. No viene marcada por defecto. Sin eso, los leads son ilegales además de mal
  conseguidos.
- **Aviso de privacidad en el formulario**, con la finalidad concreta del tratamiento.
- **`server/data/` fuera de git** (`.gitignore`), con purga automática a los 90 días
  configurable en `retentionDays`.
- **`/opadmin` con autenticación**, sin contraseña por defecto, y con
  `noindex, nofollow`. Hay que fijar la contraseña con
  `node server/scripts/set-password.js` antes de exponerlo.
- **Las IPs y ubicaciones de los visitantes son datos personales.** El panel muestra
  país, ciudad e ISP: suficiente para decisiones de negocio y sin identificar a nadie.
- **`trustProxy` debe quedar desactivado** salvo que el servidor esté realmente detrás
  de un proxy de confianza. Si se activa sin estarlo, cualquiera puede falsear su
  ubicación mandando una cabecera `X-Forwarded-For` inventada y el panel miente.
- **Las cookies de sesión son `HttpOnly`, `SameSite=Strict` y firmadas con HMAC**, y
  todo lo que el panel renderiza pasa por `textContent`, nunca por `innerHTML`: las
  cadenas de usuario (user-agent, referer, UTM) son justamente el vector de XSS clásico en
  un dashboard.

Para pautar en Meta hace falta además configurar el **evento de dominio** y la
verificación en el Administrador de negocios. Para Google, la política de consentimiento
si se usa en la UE; en LatAm no aplica.

---

## Qué mirar, y cada cuándo

**Cada lunes, 15 minutos:** conciliación de leads, términos de búsqueda nuevos para
negativas, CPL por campaña.

**Cada mes, una hora:** leads útiles contra leads totales, tasa de respuesta, costo por
reunión agendada, y si algún país de los doce no está dando nada (se puede quitar y
repartir su presupuesto).

**Lo que no hay que mirar a diario:** el CPL del día. Con 10 clics diarios la varianza
es enorme y cualquier número de un solo día significa nada. Mirarlo a diario lleva a
apagar campañas buenas en un mal día, que es la forma más rápida de destruir una cuenta.

---

**Volver al índice:** [README.md](README.md)
