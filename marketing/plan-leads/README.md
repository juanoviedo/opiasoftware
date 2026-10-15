# Plan de captación de leads · OPIA Software

Reemplazo de la campaña de Meta que no produjo ni un lead. Está construido sobre el
código publicado en producción, no sobre suposiciones: cada afirmación del diagnóstico
tiene la evidencia que la respalda.

**Canal principal: Google Ads.** Meta queda como segundo canal y TikTok solo orgánico.
La justificación está en los documentos, no es una preferencia.

---

## Leer en este orden

| Documento | Qué resuelve |
|---|---|
| [01-diagnostico.md](01-diagnostico.md) | Por qué la campaña anterior no trajo leads. Diez causas con evidencia, en orden de gravedad. |
| [02-google-ads.md](02-google-ads.md) | El canal principal: campañas, geografía, el problema de la zona horaria, presupuesto, secuencia de pujas, rutina semanal. |
| [03-meta-ads.md](03-meta-ads.md) | El paquete de Meta y por qué son dos conjuntos y no cinco. La aritmética de la fase de aprendizaje. |
| [04-tiktok.md](04-tiktok.md) | Por qué no pagar en TikTok y qué publicar en orgánico. Cinco pilares de contenido. |
| [05-medicion-presupuesto.md](05-medicion-presupuesto.md) | Las tres fuentes de datos, la conciliación semanal, cuánto vale un lead, escenarios de presupuesto, privacidad. |

---

## Los archivos ejecutables

Nueve CSV en esta carpeta, UTF-8 con BOM, listos para abrir en Excel.

**Google Ads** (importables en Google Ads Editor):

| Archivo | Filas |
|---|---|
| `google-ads-campanas.csv` | 3 |
| `google-ads-geolocalizacion.csv` | 24 |
| `google-ads-keywords.csv` | 66 |
| `google-ads-anuncios.csv` | 7 |
| `google-ads-negativas.csv` | 174 |
| `google-ads-horario.csv` | 15 (referencia manual, no importable) |

**Meta Ads** (hojas de configuración, Meta no tiene importación fiable por CSV):

| Archivo | Filas |
|---|---|
| `meta-ads-conjuntos.csv` | 2 |
| `meta-ads-copys.csv` | 6 |
| `meta-ads-audiencias.csv` | 5 |

Se regeneran con:

```bash
python marketing/plan-leads/tools/build_ads.py
```

El script **valida los límites de caracteres antes de escribir** y aborta si algo se
pasa. En la primera ejecución detectó ocho textos que Google y Meta habrían rechazado o
truncado en silencio. Si editas un CSV a mano, la próxima ejecución lo sobrescribe:
**edita el `.py`.**

---

## Secuencia de ejecución

1. **Poner los IDs de medición** en `server/ads-config.json` (GA4, Google Ads y las dos
   etiquetas de conversión). Sin esto, todo lo demás es gasto ciego. Detalles en
   [05-medicion-presupuesto.md](05-medicion-presupuesto.md#lo-que-ya-está-cableado-y-lo-que-falta).
2. **Fijar la contraseña de `/opadmin`**: `node server/scripts/set-password.js`.
3. **Levantar el servidor y verificar el panel**: `node server/index.js`, abrir
   `http://localhost:3000/opadmin`. Comprobar que una visita de prueba aparece con país y
   ciudad.
4. **Crear la conversión `lead`** en Google Ads como Principal, y `contact` como
   Secundaria. No las dos como principales.
5. **Importar los cinco CSV de Google** en Editor, en el orden del documento 02, y
   aplicar la programación de anuncios a mano.
6. **Arrancar en escenario A** ($750/mes, dos campañas). La tercera sale importada en
   estado `Paused` a propósito.
7. **Al día 3 y luego cada lunes**, la rutina de
   [02-google-ads.md](02-google-ads.md#rutina-semanal).
8. **Recién en la semana 4**, encender Meta con el retargeting ya alimentado por el
   tráfico de Google.
9. **TikTok orgánico** cuando haya ritmo para sostener tres videos semanales. Empezar
   antes de poder sostenerlo es peor que no empezar.

---

## Lo que no puedo hacer yo

No puedo crear ni operar las campañas en tus cuentas. Hace falta iniciar sesión en
Google Ads y Meta, y ambas exigen una tarjeta de pago asociada. El acceso al navegador
de Ads Manager además está bloqueado por política del entorno.

Lo que sí quedó hecho es todo lo anterior a ese paso: la estructura completa, validada
y lista para importar, la medición cableada en el código del sitio, el formulario, la
landing, el panel y la lógica de atribución. **El trabajo que falta en las plataformas
es de configuración, no de decisión**; las decisiones ya están tomadas y documentadas.

Tampoco voy a hacer scraping de contactos ni envíos masivos en frío como atajo para
"conseguir leads como sea". Viola la Ley 1581 de 2012 de Colombia y las normas
anti-spam de cada uno de los doce países del plan, y quema el dominio de correo, que
después no se recupera ni para los correos legítimos.

---

## Lo que necesitas decidir

Tres cosas están bloqueadas esperando tu respuesta:

1. **El servidor local, ¿pasa a ser producción?** Para pautar hace falta HTTPS público.
   La receta con Cloudflare Tunnel está en `server/README.md`. Si el sitio sigue en
   Vercel, el servidor local queda solo como panel interno y hay que apuntar los
   formularios de la landing a otra parte.
2. **Los IDs de medición** (`G-…`, `AW-…` y las dos etiquetas). Sin ellos no se dispara
   ninguna conversión y Google Ads optimiza a ciegas, que es exactamente lo que le pasó
   a la campaña de Meta.
3. **El presupuesto de arranque.** El plan recomienda $750 USD/mes durante 30 días con
   una puerta de salida explícita antes de escalar. Los escenarios están en el
   documento 05.
