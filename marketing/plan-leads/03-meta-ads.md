# 03 · Meta Ads: el paquete y por qué está armado así

Los archivos están listos y validados. Antes de usarlos conviene entender dos cosas:
qué hizo imposible la campaña anterior y qué límites estructurales tiene Meta, porque
ambos cambian cómo se configura esto.

El diagnóstico completo de la campaña fallida está en
[01-diagnostico.md](01-diagnostico.md). El resumen: no había formularios, el Pixel
solo disparaba `PageView`, y el tráfico pagado caía a la home corporativa de doce
secciones en vez de a una landing. Meta nunca recibió una sola conversión que
optimizar.

---

## Los archivos

| Archivo | Filas | Qué contiene |
|---|---|---|
| `meta-ads-conjuntos.csv` | 2 | Conjuntos de anuncios: presupuesto, público, geografía, programación |
| `meta-ads-copys.csv` | 6 | Los textos de los 6 anuncios, con la URL final ya parametrizada |
| `meta-ads-audiencias.csv` | 5 | Los públicos personalizados que hay que crear en el Administrador de audiencias |

A diferencia de Google, **Meta no tiene una importación masiva fiable desde CSV.** Su
herramienta de creación masiva exige su propia plantilla y cambia de formato sin
aviso. Estos archivos son hojas de configuración para volcar a mano o a la plantilla
de Meta, no un importador directo. Están armados para que se puedan copiar campo por
campo sin traducir nada.

Los textos ya están validados contra los límites reales (125 / 40 / 30 caracteres).
Lo que se pasa no se rechaza: **se trunca con puntos suspensivos** en el anuncio, que
es peor porque nadie se entera.

---

## Por qué dos conjuntos y no cinco

La versión anterior de este plan tenía cinco conjuntos: dos de automatización por
nivel de país, uno de Power Platform, uno de marketing y uno de retargeting. Estaba
mal, y la razón es aritmética.

**Meta necesita alrededor de 50 eventos de optimización cada 7 días por conjunto para
salir de la fase de aprendizaje.** Repartir $385 semanales entre cinco conjuntos da
$77 a cada uno. Con un CPL de lead B2B en LatAm de entre $10 y $25, eso produce de 3
a 8 conversiones semanales por conjunto. Ninguno sale de aprendizaje jamás, los cinco
entregan de forma inestable y ninguno acumula señal suficiente para que el algoritmo
aprenda nada.

Consolidar todo el presupuesto de prospección en **un solo conjunto** cambia el
resultado aunque el gasto total sea el mismo:

| Configuración | Presupuesto/conjunto | Conversiones/semana | Sale de aprendizaje |
|---|---|---|---|
| 5 conjuntos × $77 | $77 | 3 - 8 | Nunca |
| 1 conjunto × $150 | $150 | 6 - 15 | No, pero entrega estable |

**Con $150 semanales tampoco se sale de aprendizaje.** Harían falta unas 50
conversiones semanales, o sea $500-$750 por semana en un solo conjunto para llegar.
Eso no es un error del plan: es el costo real de que Meta optimice bien leads B2B.

Lo importante es no leer el aviso "Aprendizaje" como un fracaso. Significa que Meta
no está optimizando automáticamente, no que no esté entregando. Con $150 semanales y
un formulario que convierte, salen leads igual. El criterio de decisión a los 30 días
es el **CPL real y cuántos leads responden**, no la insignia de estado del conjunto.

---

## Público amplio, sin intereses

El conjunto de prospección va con **segmentación amplia: 28-60 años, las 12 capitales,
sin intereses.** Esto va en contra del instinto, y es deliberado.

Los intereses de Meta se autodeterminan: quien marca "Pequeña y mediana empresa" suele
ser alguien que leyó sobre pymes, no necesariamente alguien que dirige una. Y cada
capa de segmentación reduce el conjunto, que es exactamente lo que no se puede hacer
cuando ya se está por debajo del umbral de aprendizaje.

Lo que hace el filtrado en un conjunto amplio no es la segmentación, es **el anuncio y
las preguntas del formulario.** Cuatro ángulos distintos compitiendo dentro del mismo
conjunto le dicen a Meta quién responde, y eso lo aprende mejor de lo que lo
aprende una lista de intereses elegida a mano.

`meta-ads-audiencias.csv` sigue incluyendo los públicos por intereses y por cargo. Sirven
para dos cosas concretas, no para prospección en frío:

- Como **exclusión**: sacar a estudiantes y a quien busca empleo.
- Como **público de retargeting**, donde el tamaño chico no importa porque ya son
  personas que pasaron por el sitio.

Los dos públicos de retargeting (`Visitantes web 90 días` y `FormStart sin envío`)
requieren que el Pixel esté recibiendo tráfico. El segundo es el de mayor intención de
todo el plan: gente que abrió el formulario y no lo mandó. Empieza a existir en cuanto
el pixel registre `FormStart`, que ya está cableado en `server/public/conversions.js`.

---

## Formulario instantáneo, no landing

Para Meta se recomienda **formulario instantáneo con dos preguntas de calificación**,
y para Google la landing. No es inconsistencia: cada plataforma tiene una fortaleza
distinta.

| | Google (landing) | Meta (formulario instantáneo) |
|---|---|---|
| CPL típico LatAm | $25 - $70 | $6 - $20 |
| Calidad del lead | Alta: buscó activamente | Media: rellenó sin salir del feed |
| Volumen de conversión | Bajo | Alto |

En Meta el usuario está en el feed, no buscando proveedor. Sacarlo a una web externa
añade fricción y sube el CPL. El formulario instantáneo viene precargado con el correo
y el teléfono del perfil, se rellena en dos toques y no abandona la app.

El riesgo es obvio: **leads basura.** Se controla con las preguntas, que son las que
hacen el trabajo que en Google hace la intención de búsqueda:

1. *¿Cuántas personas trabajan en tu empresa?* → opciones: Solo yo / 2-10 / 11-50 /
   51-200 / Más de 200. Filtra al que no tiene empresa.
2. *¿Qué proceso te gustaría resolver?* → texto libre. Filtra al que rellenó por
   accidente y da el contexto para el primer contacto.

Dos preguntas es el máximo. Cada pregunta adicional cuesta entre 10 % y 20 % de
completitud.

El formulario se construye dentro del Administrador de anuncios; **no es importable.**
Al terminarlo hay que conectarlo con el CRM o, como mínimo, activar la descarga
automática del CSV, porque los leads de Meta caducan del panel y la velocidad de
respuesta es lo que más pesa en la conversión final.

---

## Los dos candados estructurales de Meta

**1. La programación por horas exige presupuesto total, no diario.**
Con presupuesto diario la opción de franja horaria directamente no aparece en la
interfaz. Es el motivo por el que `meta-ads-conjuntos.csv` dice "Total por semana" en
los dos conjuntos.

**2. La zona horaria de la cuenta publicitaria es inmutable.**
Se fija al crear la cuenta y no se puede cambiar después, igual que en Google. La
franja 10:00-20:00 se aplica en esa zona horaria, no en la del país del anuncio. La
tabla de desfases por ciudad está en
[02-google-ads.md](02-google-ads.md#el-horario-1000-2000-y-el-problema-que-casi-nadie-ve)
y aplica idéntica acá si la cuenta está en hora de Bogotá.

Hay una diferencia que sí importa: Meta **reparte el presupuesto total dentro de las
ventanas activas**, así que con presupuesto semanal la entrega se concentra en las
franjas habilitadas. En la práctica funciona mejor que la programación de Google, que
simplemente apaga la campaña fuera del horario.

**El conjunto de retargeting va sin restricción horaria** a propósito. Con $50
semanales, acotarlo a 50 horas semanales lo deja sin capacidad de entrega. Además, al
que ya visitó el sitio se le aparece el anuncio cuando está disponible, no cuando a
nosotros nos conviene.

---

## Creativos que faltan

Los textos están listos; las imágenes no. Lo mínimo para arrancar:

| Formato | Medidas | Para qué |
|---|---|---|
| Cuadrado | 1080 × 1080 | Feed de Facebook e Instagram |
| Vertical | 1080 × 1920 | Stories y Reels (donde está el inventario barato) |
| Horizontal | 1200 × 628 | Ubicaciones de Audience Network y resultados de búsqueda |

Cuatro ángulos de prospección × tres formatos = **12 imágenes.** En Reels y Stories
el video rinde bastante más que la estática, pero no hace falta producción: una
grabación de pantalla de 15 segundos mostrando un proceso en Excel y después la app
que lo reemplaza es exactamente el tipo de pieza que funciona para este servicio.

Reglas que importan más que el diseño:

- Menos del 20 % del área con texto. Meta ya no penaliza formalmente el texto en la
  imagen, pero sigue entregando peor.
- La primera línea del copy tiene que nombrar el dolor concreto, no la empresa. Nadie
  en el feed está buscando a OPIA.
- Mostrar la interfaz real del producto. En software, una captura vale más que
  cualquier ilustración genérica de personas estrechando la mano.

Puedo generar las 12 piezas si las quieres; se hace con el generador de imágenes y
quedan en `marketing/plan-leads/creativos/`.

---

## Lo que el Pixel no alcanza a ver

El Pixel es JavaScript en el navegador. Entre el bloqueo de iOS, los ad-blockers y las
restricciones de cookies de terceros, **subregistra entre un 20 % y un 40 % de las
conversiones reales.** En la campaña anterior eso se sumó al problema de que solo
disparaba `PageView`: Meta no es que viera pocas conversiones, es que no veía ninguna.

La Conversations API (CAPI) manda el evento desde el servidor en vez del navegador y
recupera buena parte de esa pérdida. Encaja bien acá porque el servidor ya recibe el
POST del formulario en `/api/leads`: ese es exactamente el punto donde habría que
disparar el evento.

Para activarla hacen falta dos datos que solo están en tu cuenta: el **ID del Pixel** y
un **token de acceso** (Configuración del negocio → Orígenes de datos → Píxeles →
Token de API de conversiones). Con esos dos valores se implementa el envío y la
deduplicación contra el Pixel del navegador, que necesita un `event_id` compartido
para no contar el mismo lead dos veces.

---

## Veredicto honesto sobre Meta para este negocio

Meta no es el canal natural para vender software B2B. Es interrupción en un espacio
de ocio, y el comprador de un desarrollo a la medida no está ahí cuando decide
comprar: está en Google, escribiendo el problema.

Dónde sí tiene sentido Meta:

- **Retargeting.** Es su mejor uso y el más barato. Alguien que ya vio el sitio y no
  convirtió necesita menos de tres impactos para volver.
- **Alcance en pymes chicas**, donde el dueño no busca "desarrollo de software" porque
  ni sabe que eso es lo que necesita. Ahí la interrupción sí funciona.
- **Construir la audiencia de retargeting** que después usa Google.

Con $200 semanales ($150 prospección + $50 retargeting, unos $860/mes), lo esperable
es **entre 15 y 40 leads mensuales** con el formulario instantáneo, de calidad media.
Si Google está entregando a $40 el lead con calidad alta, Meta a $15 con calidad media
puede salir igual o peor una vez que se descuenta el tiempo de filtrar lo que no
sirve. La decisión se toma con los números del mes 1, no antes.

**Recomendación de secuencia:** encender primero Google, dejarlo correr tres semanas,
y recién ahí prender Meta con el retargeting ya alimentado por el tráfico que Google
generó. Prender los dos el día 1 con presupuesto limitado deja a ambos por debajo de
sus umbrales y no se aprende nada de ninguno.

---

**Siguiente:** [04-tiktok.md](04-tiktok.md) o
[05-medicion-presupuesto.md](05-medicion-presupuesto.md).
