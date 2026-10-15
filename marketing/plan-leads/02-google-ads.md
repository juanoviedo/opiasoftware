# 02 · Google Ads: el canal principal

Búsqueda de Google es donde la pyme escribe "software para gestionar pedidos" porque
**ya tiene el problema y ya decidió buscarle solución**. En Meta e Instagram hay que
interrumpir a alguien que estaba viendo otra cosa. Para software B2B en LatAm eso
decide casi todo lo demás: el CPL de búsqueda es más alto, pero el lead llega con
intención, no con curiosidad.

Por eso el orden es: **Google primero, Meta segundo, TikTok orgánico al final.**

---

## Los archivos y en qué orden se importan

Todos están en esta carpeta, en UTF-8 con BOM (abren bien en Excel).

| Archivo | Filas | Qué crea |
|---|---|---|
| `google-ads-campanas.csv` | 3 | Las campañas, con presupuesto y puja |
| `google-ads-geolocalizacion.csv` | 24 | Países/ciudades objetivo por campaña |
| `google-ads-keywords.csv` | 66 | Palabras clave en 7 grupos de anuncios |
| `google-ads-anuncios.csv` | 7 | Anuncios de búsqueda adaptables (15 titulares + 4 descripciones) |
| `google-ads-negativas.csv` | 174 | Negativas a nivel de campaña |
| `google-ads-horario.csv` | 15 | La franja 10:00-20:00 L-V, un renglón por día y campaña |

Se regeneran con `python marketing/plan-leads/tools/build_ads.py`, que valida los
límites de caracteres antes de escribir. Si cambias un texto a mano en el CSV, la
próxima ejecución lo sobrescribe: **edita el `.py`, no el CSV.**

### Procedimiento en Google Ads Editor

Editor es la vía recomendada. La carga masiva desde la interfaz web exige que los
encabezados coincidan exactamente con su plantilla y falla sin explicar por qué.

1. Descarga [Google Ads Editor](https://ads.google.com/home/tools/ads-editor/)
   (app de escritorio, gratis), inicia sesión y descarga la cuenta.
2. **Cuenta → Importar → Desde archivo** y carga `google-ads-campanas.csv`. Revisa la
   vista previa, luego **Publicar**. Las campañas tienen que existir antes de que el
   resto de archivos pueda referenciarlas por nombre.
3. Repite la importación con `google-ads-geolocalizacion.csv`,
   `google-ads-keywords.csv`, `google-ads-anuncios.csv` y `google-ads-negativas.csv`.
   Estos cuatro sí se pueden importar juntos. Revisa la vista previa y **Publicar**.
4. **El horario no se importa.** La plantilla de carga masiva no tiene columna de
   programación. Aplícalo a mano: selecciona cada campaña → **Programación de
   anuncios** → añade Lun-Vie de 10:00 a 20:00. Los valores están en
   `google-ads-horario.csv` como referencia, no como archivo importable.
5. Verifica la geolocalización: Editor avisa cuando una cadena no resuelve a una
   ubicación real. Si aparece el aviso, corrige esa fila con el selector de
   ubicaciones en vez de dejarla caer.
6. Marca la conversión `lead` como **Principal** y `contact` como **Secundaria**
   (ver más abajo) antes de encender nada.

### El estado inicial es deliberado

Las campañas salen así a propósito:

| Campaña | Presupuesto | Estado | Por qué |
|---|---|---|---|
| Software y Automatización | $15 USD/día | Enabled | Es la de mayor volumen de búsqueda B2B |
| Power Platform | $10 USD/día | Enabled | CPC más bajo y es el diferencial real de OPIA |
| Marketing y Publicidad | $15 USD/día | **Paused** | Las keywords de agencia son las más caras y las más competidas |

Total en el aire: **$25 USD/día, unos $750 al mes.** Encender las tres de una vez
serían $1.800/mes gastándose antes de saber si la landing convierte. La de marketing
se activa cuando la primera pase la puerta de las 30 conversiones.

---

## Geografía: capitales hispanohablantes por nivel

Se excluye **Caracas** a propósito: los métodos de pago de Google Ads fallan ahí y la
campaña se cae a cero impresiones sin dar error claro. Se excluye Madrid porque el
brief pidió Latinoamérica, no porque no convenga (es un mercado bueno, caro y
separable en una cuarta campaña).

**Nivel 1** — mayor presupuesto publicitario B2B y más búsquedas de software:
Ciudad de México, Bogotá, Santiago, Buenos Aires, Lima.

**Nivel 2** — mercados más chicos pero con CPC mucho más bajo, lo que en la práctica
los hace rentables antes que los grandes: Quito, Ciudad de Panamá, San José,
Montevideo, Ciudad de Guatemala, San Salvador, Santo Domingo.

Cómo se reparten:

- *Software y Automatización*: nivel 1 + nivel 2 (12 ciudades).
- *Power Platform*: nivel 1 + Quito + Panamá. Power Apps y Power BI solo rinden donde
  hay Microsoft 365 instalado; en el resto del nivel 2 el volumen de búsqueda no da
  para justificar el grupo.
- *Marketing y Publicidad*: solo nivel 1.

Una decisión que conviene tomar conscientemente: **el objetivo es ciudad, no país.**
Seleccionar "México" entero mete a la campaña búsquedas de Guadalajara, Monterrey y
de ciudades donde no hay cliente. Cuesta lo mismo y convierte peor.

---

## El horario 10:00-20:00 y el problema que casi nadie ve

Google aplica la programación de anuncios en la **zona horaria de la cuenta**, y esa
zona horaria **no se puede cambiar después de crear la cuenta**. Es el mismo
candado que tiene Meta. Si la cuenta está en `America/Bogotá` (UTC-5, sin horario de
verano), esto es lo que realmente entrega la franja 10:00-20:00:

| Ciudad | UTC | Hora local cuando en Bogotá son 10:00-20:00 |
|---|---|---|
| Ciudad de México | -6 | 09:00 - 19:00 |
| San José, Guatemala, San Salvador | -6 | 09:00 - 19:00 |
| Bogotá, Quito, Lima, Panamá | -5 | **10:00 - 20:00** |
| Santo Domingo | -4 | 11:00 - 21:00 |
| Santiago (verano austral, sep-abr) | -3 | 12:00 - 22:00 |
| Santiago (invierno austral, abr-sep) | -4 | 11:00 - 21:00 |
| Buenos Aires, Montevideo | -3 | 12:00 - 22:00 |

Google **no permite programación por ubicación**: no hay forma de decir "10 a 20 hora
local de cada país" dentro de una sola cuenta. Las tres salidas posibles:

1. **Aceptar el desfase** — es lo que recomiendo. La franja resultante va de 09:00 a
   22:00 hora local, y todo ese rango es horario de oficina o de tarde. Para pymes
   esto último importa más de lo que parece: el dueño que atiende el negocio todo el
   día busca proveedor a las 9 de la noche, no a las 10 de la mañana. El tramo
   20:00-22:00 en Argentina, Uruguay y Chile no es desperdicio, es otro comprador.
2. Crear una cuenta por zona horaria — inviable con $750/mes: fragmenta el historial
   de conversiones y ninguna cuenta llega a las 30 que necesita la puja automática.
3. Dejar la campaña 24/7 — descarta la restricción que pediste y además quema
   presupuesto de madrugada, cuando el tráfico B2B es casi todo bot.

Si al mes 2 Argentina, Uruguay o Chile salen como los mejores conversores, la
corrección no es alargar los días de semana: es **añadir sábado de 10:00 a 14:00 hora
de Bogotá** (= 12:00-16:00 allá), que es cuando el dueño de pyme sí está sentado
frente al computador sin la operación encima.

---

## Presupuesto y qué CPL es realista en LatAm

Rangos observables en búsqueda B2B de software para Latinoamérica, en USD:

| Tema | CPC típico | Conversión de landing | CPL resultante |
|---|---|---|---|
| Desarrollo de software a la medida | $2.00 - $6.00 | 3 % - 6 % | $40 - $150 |
| Automatización de procesos | $1.50 - $4.00 | 4 % - 8 % | $20 - $80 |
| Power Platform / Power BI | $0.80 - $3.00 | 5 % - 10 % | $10 - $45 |
| Agencia de marketing digital | $1.50 - $5.00 | 2 % - 5 % | $40 - $180 |

**Un CPL sano para este negocio está entre $25 y $70 USD.** Debajo de $25 conviene
preguntarse qué se está captando realmente. Por encima de $90 el problema no es la
puja: es la oferta o la landing.

Etapas, con la puerta de salida de cada una:

**Etapa 1 · Validación (días 1-30) — $25/día.** Las dos campañas Enabled. Puerta de
salida: **30 conversiones `lead` acumuladas** y CPL ≤ $70. Si a los 30 días hay menos
de 15 leads, no se escala: se arregla la landing primero. Escalar una landing que no
convierte solo multiplica el gasto.

**Etapa 2 · Estabilizado (mes 2) — $45/día.** Software sube a $25, Power Platform a
$20, y se activa Marketing y Publicidad en $15 solo si hay caja. Aquí ya hay historial
para cambiar la puja a Maximizar conversiones.

**Etapa 3 · Escala (mes 3+) — $60/día y más.** Solo con CPL ≤ $60 sostenido tres
semanas. Se escala de a 20 % semanal; subir el presupuesto de golpe saca a la campaña
de su fase de aprendizaje y vuelve a empezar.

---

## Secuencia de pujas

El error más común es arrancar en "Maximizar conversiones" o en CPA objetivo sin
datos. Google necesita historial para optimizar, y sin él la puja automática
simplemente gasta.

1. **Días 1-14: Maximizar clics con tope de CPC.** $1.50 para Software y
   Automatización, $1.00 para Power Platform. El tope importa: sin él, Maximizar
   clics se va entero a los términos genéricos caros y agota el presupuesto en tres
   horas. La columna `Max CPC` de `google-ads-keywords.csv` va vacía a propósito,
   porque el tope se fija a nivel de campaña, no por palabra.
2. **Puerta: 30 conversiones en la cuenta.** Recién ahí → **Maximizar conversiones**,
   sin tope.
3. **Puerta: 50 conversiones y CPL estable dos semanas.** Recién ahí → **CPA
   objetivo**, fijado al **110 % del CPL observado**. Poner el objetivo por debajo
   del CPL real hace que Google deje de entregar; no baja el costo, apaga la campaña.
4. En cuanto haya conversiones, activar **conversiones mejoradas para clientes
   potenciales**: manda el hash del correo del lead y recupera conversiones que el
   navegador bloqueó.

---

## Conversiones: qué contar y qué no

Aquí es donde se murió la campaña de Meta. Sin señal de conversión, el sistema de
entrega no tiene qué optimizar y nunca sale de la fase de aprendizaje.

Dos acciones, ni más:

| Acción | Qué la dispara | Categoría |
|---|---|---|
| `lead` | Envío exitoso del formulario de `/lp/diagnostico-gratis` | **Principal** |
| `contact` | Clic en un enlace de WhatsApp en cualquier página | Secundaria (solo recuento) |

**`contact` no puede ser principal.** Si las dos cuentan como conversión principal,
Google optimiza hacia clics de WhatsApp, que son más fáciles de conseguir y no dejan
datos ni registro atribuible. Se pierde exactamente lo que se está intentando
conseguir.

El servidor ya tiene los huecos para esto en `server/ads-config.json`:

```json
{
  "ga4Id": "G-XXXXXXXXXX",
  "googleAdsId": "AW-XXXXXXXXX",
  "googleAdsLeadLabel": "XXXXXXXXXXXXXXXX",
  "googleAdsContactLabel": "XXXXXXXXXXXXXXXX"
}
```

Sin esos IDs no se dispara nada. El servidor inyecta la etiqueta en las 11 páginas
del sitio sin editarlas, así que basta con llenar el archivo y reiniciar. Las
etiquetas salen de Google Ads → Herramientas → Administrador de conversiones.

---

## Las negativas: qué filtran y el error que se corrigió

Son 58 términos × 3 campañas = 174 filas, todas a **nivel de campaña** (columna
`Ad Group` vacía). Ponerlas a nivel de grupo duplicaba el mantenimiento sin añadir
control.

Filtran **intención**, no industria. Están agrupadas por lo que descartan:

- Quien aprende o busca empleo: `curso`, `tutorial`, `universidad`, `estudiante`,
  `empleo`, `vacante`, `sueldo`, `cv`, `hoja de vida`.
- Quien quiere algo gratis o descargable: `gratis`, `barato`, `descargar`, `pdf`,
  `ebook`, `crack`, `pirata`, `plantilla`, `wix`, `wordpress gratis`, `shopify gratis`.
- Quien investiga el concepto: `qué es`, `definición`, `ejemplo`, `wikipedia`,
  `open source`, `código fuente`, `github`.
- Soporte de hardware: `reparar pc`, `arreglar computador`.

Dos decisiones que vale la pena entender antes de tocar la lista:

**`gratis` como negativa no contradice que la oferta sea un diagnóstico gratuito.**
Las negativas filtran las *búsquedas entrantes*, no el texto de nuestros anuncios.
Bloquea a quien escribe "software gratis para empresas"; no toca el titular
"Diagnóstico Gratuito".

**No hay negativas de industria, y es deliberado.** Una versión anterior de esta
lista tenía `seguro`, `crédito`, `inmobiliaria`, `carros`, `celular` e `hipoteca`.
Como negativas de frase bloquean cualquier búsqueda que contenga la palabra, o sea
que habrían frenado **"software para inmobiliarias"**, **"sistema para concesionario"**
y **"software para aseguradoras"**: exactamente los clientes verticales que más
presupuesto tienen. Se quitaron. Lo que se quiere fuera es la intención equivocada,
no el sector del que viene la consulta.

También se cambió la negativa suelta `trabajo` por los patrones `buscar trabajo`,
`ofertas de trabajo`, `bolsa de trabajo` y `trabajar en`. `trabajo` a secas bloqueaba
"software para control de horas de trabajo", que es una búsqueda buena.

**Esto es una red de arranque, no una lista terminada.** Las primeras tres semanas
hay que revisar el informe de términos de búsqueda y añadir lo que aparezca. Es la
tarea de mayor retorno por hora de todo el plan.

---

## Rutina semanal

**Día 3 (una sola vez).** Leer el informe de términos de búsqueda. Con tres días de
datos ya se ven los términos basura que ninguna negativa anticipó. Añadirlos.
Verificar que las 24 ubicaciones resolvieron y que ninguna campaña quedó en
"Limitada por presupuesto" a las 11 de la mañana.

**Semana 1 a 3, 30 minutos cada lunes.**
1. Términos de búsqueda → añadir negativas nuevas.
2. Revisar `Ad strength` de los 7 anuncios. Lo que esté en "Poor" necesita más
   titulares, no mejores: Google rota y descarta solo.
3. Mirar CTR por grupo. Debajo de 3 % en búsqueda, el anuncio no coincide con la
   intención; arriba de 8 %, probablemente la keyword es demasiado estrecha.
4. Cruzar contra `/opadmin`: los leads que Google reporta contra los que registró el
   servidor. Si no cuadran, el problema es de medición y hay que arreglarlo antes de
   tomar decisiones con los números.

**Semana 4 en adelante, 15 minutos cada lunes.** Solo términos de búsqueda y CPL por
campaña. Lo demás ya no se mueve semanalmente: cada cambio grande reinicia el
aprendizaje.

---

## Cuándo matar y cuándo escalar

**Matar un grupo de anuncios** si después de $100 USD gastados tiene cero leads, o si
su CPL triplica el de la campaña. No se "deja un poco más" esperando que mejore: el
grupo que no convirtió con 100 dólares no va a convertir con 200.

**Matar una campaña entera** si a los 30 días no llegó a 15 leads. Antes de apagarla,
revisar en este orden: (1) si la conversión está disparándose, porque lo más común es
que no sea un problema de campaña sino de medición; (2) el informe de términos de
búsqueda; (3) la landing.

**Escalar** solo con CPL ≤ $60 sostenido tres semanas, de a 20 % por semana, y nunca
tocando presupuesto y pujas el mismo día.

**La señal más importante no está en Google Ads.** Es cuántos leads contestan y
cuántos se vuelven proyecto. Un CPL de $30 con leads que no responden es peor que uno
de $70 con dos reuniones agendadas. El registro de eso no lo da ninguna plataforma:
hay que llevarlo en una hoja aparte, lead por lead.

---

**Siguiente:** [03-meta-ads.md](03-meta-ads.md) para el paquete de Meta, o
[05-medicion-presupuesto.md](05-medicion-presupuesto.md) para el sistema de medición
completo.
