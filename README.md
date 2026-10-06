# OPIA Software

Web comercial publicada en https://www.opiasoftware.com/.

## Versión publicada

Importada de `OPIA-web-oficial.zip`, entregado por el usuario el 6 de octubre de 2026. Incluye inicio, servicios, software, marketing, nosotros, contacto y cuatro páginas de especialidades. El contacto de esta versión es WhatsApp **+57 333 278 2483**.

El archivo recibido contiene la web ya compilada: HTML prerenderizado, JavaScript de React, CSS e imágenes. No incluye el proyecto fuente ni un comando de compilación. Para cambios estructurales posteriores conviene conservar u obtener el proyecto fuente que generó este paquete. Los archivos anteriores en `assets/brand`, `assets/images`, `css/styles.css` y `js/` se mantienen para conservar referencias antiguas; las nuevas páginas utilizan los recursos del paquete.

## Publicación

Vercel publica la rama `main` del repositorio `juanoviedo/opiasoftware`. Se conserva `CNAME` para la configuración existente de GitHub Pages. `vercel.json` mantiene las cabeceras de seguridad y configura la caché de los recursos compilados. Las rutas tienen su propio `index.html` y existe una página `404.html`.

Se conserva Meta Pixel `1096286453264873` en producción; las vistas previas locales no generan eventos. `css/site-preferences.css` oculta las flechas nativas de todos los campos numéricos, incluidos los añadidos dinámicamente, sin cambiar su validación.

## Revisión local

Servir la raíz con un servidor HTTP estático y revisar inicio, navegación entre páginas, enlaces de WhatsApp y menú móvil. No es necesario instalar dependencias ni compilar el ZIP.
