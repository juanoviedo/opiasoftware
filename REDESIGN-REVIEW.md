# OPIA Software — propuesta de rediseño corporativo

## Estado
Rediseño aprobado para publicación por el usuario. Portafolio sin proyectos ni descripciones; el píxel se conserva.

## Stack y contenido
HTML, CSS y JavaScript estáticos, sin dependencias de ejecución ni cambio de plataforma. Inicio y dos especialidades en una sola página con contenido completo y enlaces #software / #marketing. No se crearon páginas repetitivas de servicios. Se conservaron #servicios, #decisiones-datos, #forma-de-trabajo, #evaluador y #faq.

## Identidad
Colores del encargo: #071E3D, #0B2B50, #087EF5, #15B8F4 y #FFFFFF. Montserrat e Inter con font-display swap. Los SVG de assets/brand contienen los trazados originales extraídos de OPIA_Brandbook_Corregido.pdf; no se reconstruyó el lettering. No se utilizaron los mockups ni sus nombres, datos de contacto o cifras.

## Contacto y medición
WhatsApp confirmado: +57 300 237 4114. El evaluador cambia sus preguntas para seis servicios y abre WhatsApp con un mensaje editable. No guarda respuestas, no calcula precios y no envía mensajes automáticamente. Sin JavaScript queda disponible el contacto directo.
Meta Pixel: 1096286453264873, PageView una vez por carga; no dispara en localhost. Se mantiene el fallback noscript para producción.

## Cargar proyectos aprobados
Editar js/projects.js. La lista empieza vacía; no hay ejemplos públicos. Cada registro debe incluir:
- title y client: nombre del proyecto y cliente autorizado.
- category: Software, Marketing digital o Sitios web.
- need y work: necesidad y trabajo realizado, confirmados.
- attribution: OPIA Software o Experiencia de nuestro equipo (solo cuando corresponda y esté autorizado).
- approved: true, únicamente después de confirmar la autorización para publicar.
- image e imageAlt: opcionales; ruta local assets/images/ y descripción útil. Usar imágenes autorizadas y optimizadas.
- result: opcional; únicamente un resultado verificable, sin inventar cifras.
Los filtros y proyectos se muestran solo si existen registros aprobados y completos. Los valores se insertan con textContent, no como HTML.

## Material pendiente
Nombres de clientes o marcas con permiso, imágenes/logos autorizados, necesidad, trabajo realizado, atribución y resultados documentados para el portafolio. Cualquier dato empresarial adicional (equipo, trayectoria, ubicación o contacto adicional) requiere confirmación. No se añadieron certificaciones, alianzas ni sedes.

## SEO
Canonical https://opiasoftware.com/, Open Graph y Twitter con imagen PNG de 1200×630, sitemap.xml y robots.txt para la única ruta pública, datos estructurados Organization y Service. La imagen social usa únicamente logo y mensajes de OPIA.

## Verificación
Vista de 1440, 820, 390 y 320 px; sin desbordamiento horizontal. Menú móvil/Escape, anclas internas, seis ramas del evaluador y URLs WhatsApp probadas sin enviar mensajes. Un H1, imágenes con alt, foco visible, zoom permitido y reducción de movimiento. Revisados los logos, el hero y el pie de página. El servidor de vista previa envía X-Robots-Tag: noindex, nofollow.

## Publicación
Publicación autorizada por el usuario. Mantener el portafolio vacío hasta recibir una nueva indicación expresa para agregar proyectos y sus descripciones.
