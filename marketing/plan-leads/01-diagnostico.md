# 01 · Por qué la campaña de Meta no trajo ni un lead

Diagnóstico hecho sobre el código publicado en producción, no sobre suposiciones.
Cada causa tiene la evidencia que la respalda.

---

## Las diez causas, en orden de gravedad

### 1. No había nada que convertir

**Evidencia:** `grep -c "<form"` sobre las 11 páginas del sitio devuelve **cero**.

El sitio no tenía ni un solo formulario. La única forma de dejar datos era pulsar un
botón que abría WhatsApp. Eso no es un mecanismo de captación, es una puerta giratoria:
la persona tiene que salir de la web, tener WhatsApp instalado, y animarse a escribirle
a un desconocido. Cada uno de esos pasos pierde gente.

### 2. El Pixel solo disparaba `PageView`

**Evidencia:** en las 11 páginas el bloque de Meta Pixel contiene exactamente dos llamadas:

```js
fbq('init', '1096286453264873');
fbq('track', 'PageView');
```

No existía `Lead`, ni `Contact`, ni ningún evento de conversión. **Este es el punto más
importante de todos.** Si la campaña se configuró con objetivo de clientes potenciales
apuntando al sitio web, Meta no tuvo ni una sola conversión que optimizar.

### 3. Sin conversiones, la campaña nunca salió del aprendizaje

El sistema de entrega de Meta necesita aproximadamente **50 conversiones por semana por
conjunto de anuncios** para salir de la fase de aprendizaje. Con cero eventos configurados,
el algoritmo no tuvo señal de ningún tipo y repartió el presupuesto buscando el resultado
más barato que sí podía ver: impresiones y clics. Clics de gente curiosa, no de compradores.

### 4. El destino era una web corporativa, no una landing

Los anuncios mandaban a `opiasoftware.com`, una home con menú completo, doce secciones,
portafolio, FAQ y seis llamadas a la acción distintos. Para tráfico frío eso es letal:
cada opción adicional es una oportunidad de irse sin convertir. Una campaña necesita una
página con **un solo** siguiente paso.

### 5. No había oferta

El mensaje central del sitio es "Software que ordena, marketing que mueve el negocio".
Es correcto como posicionamiento corporativo, pero no es una **oferta**: no le da a nadie
una razón para entregar su correo y su teléfono. No había nada que intercambiar —ni
diagnóstico, ni demo, ni calculadora, ni guía, ni caso de estudio.

### 6. Cero prueba social utilizable

**Evidencia:** `REDESIGN-REVIEW.md` documenta la decisión de publicar "Portafolio sin
proyectos ni descripciones". La web muestra seis logos de clientes, pero ningún caso,
ninguna cifra y ningún testimonio.

Vender software B2B en frío sin prueba es lo más difícil que existe. Un gerente no contrata
un desarrollo a medida porque el anuncio sea bonito; lo contrata porque alguien más ya lo
hizo y le fue bien. La página de marketing incluso usa un tablero marcado como
"Visualización ilustrativa · Datos de ejemplo" (128 consultas, $18.400 COP por lead):
es honesto, pero confirma que no había resultados reales que mostrar.

### 7. Los enlaces de WhatsApp no distinguían campañas

**Evidencia:** el mismo enlace exacto aparece en las 11 páginas:

```
https://wa.me/573332782483?text=Hola%2C%20quiero%20hablar%20sobre%20un%20proyecto%20con%20OPIA%20Software.
```

Sin UTM, sin parámetro de campaña, idéntico en todas partes. **Consecuencia grave:** si
alguien llegó por un anuncio y escribió por WhatsApp, era imposible saber de qué anuncio
venía. Es muy probable que parte de "cero leads" sea en realidad "cero leads atribuibles".

### 8. Solo Pixel de navegador, sin Conversions API

Con iOS 14.5+, el bloqueo de cookies de terceros y los adblockers, un pixel de navegador
pierde entre el 30 % y el 50 % de los eventos. Sin CAPI no había forma de recuperarlos.

### 9. B2B en inventario de consumo

Facebook e Instagram son mayoritariamente inventario de consumo y entretenimiento. Un
dueño de pyme scrolleando a las 7 de la tarde no está en modo "contratar un desarrollo en
Power Platform". Para servicios B2B, la **búsqueda** captura demanda existente; las redes
tienen que **crearla**, que es muchísimo más caro y lento.

### 10. La franja horaria (por confirmar)

Si la campaña corrió de 5 a 9 pm, se sumó un problema más: es la peor ventana para B2B.
A esa hora la gente va en transporte, cena o está con su familia. La atención es baja y
la intención de compra empresarial es prácticamente nula. **Necesito que me confirmes si
la campaña anterior usó esa programación**, porque cambia el peso de esta causa.

---

## El veredicto

La campaña no falló por el anuncio, ni por el presupuesto, ni por la segmentación.
**Falló porque no había nada del otro lado.** Se pagó por llevar personas a una página que
no podía recibirlas: sin formulario, sin oferta, sin prueba y sin un evento que le dijera a
Meta qué era un éxito.

Cambiar de Meta a Google sin arreglar eso habría producido exactamente el mismo resultado,
solo que con clics más caros. Por eso el orden de este plan es: primero la máquina de
conversión, después el tráfico.

---

## Lo que ya quedó arreglado en el código

| Problema | Solución implementada |
|---|---|
| Sin formularios | Landing `/lp/diagnostico-gratis` con oferta concreta y formulario real que guarda en el servidor |
| Sin evento `Lead` | Se dispara solo cuando el registro quedó guardado de verdad, no al intentar enviar |
| Sin evento `Contact` | `server/public/conversions.js` escucha cada clic de WhatsApp en las 11 páginas |
| Sin señal para Google | `gtag.js` con GA4 + conversión de Google Ads, inyectado por el servidor en todas las páginas |
| UTM perdido al navegar | El beacon guarda el primer toque en `sessionStorage` y lo reenvía en cada evento |
| Leads sin atribución | Cada lead se almacena con campaña, medio, contenido y `gclid`/`fbclid` |
| Sin visibilidad | `/opadmin`: quién entra, de dónde, por qué campaña, y bandeja de leads |
| Bots inflando métricas | Filtro por user-agent + separación de visitas internas y de bots |
| IDs dispersos | Un solo archivo `server/ads-config.json` alimenta GA4, Google Ads y Meta |

**Nota técnica:** la inyección de etiquetas se hace desde el servidor Node y no editando
los 11 HTML, porque el bundle de React **hidrata** el prerenderizado (`fa.hasChildNodes() ?
hydrateRoot(...) : createRoot(...)`) y cualquier cambio dentro de `#root` se pierde.

---

## Lo que todavía depende de ti

Estas tres cosas son las que más van a mover la aguja y no las puedo hacer yo:

1. **Poner los IDs reales** en `server/ads-config.json` (GA4 `G-…`, Google Ads `AW-…` y las
   etiquetas de conversión). Sin esto, las campañas se crean pero no miden nada.
2. **Prueba social real.** Un caso de estudio con cifras verificables por cada servicio
   vale más que cualquier optimización de puja. Tienes seis clientes; con que dos te
   autoricen a contar qué problema tenían y qué cambió, el costo por lead baja solo.
3. **Velocidad de respuesta.** En B2B, responder en menos de 5 minutos multiplica la tasa
   de contacto. Si los leads llegan a `/opadmin` y nadie los revisa hasta el día siguiente,
   el presupuesto se pierde igual. Define quién responde y en cuánto tiempo **antes** de
   encender las campañas.
