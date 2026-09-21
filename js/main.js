'use strict';
const toggle = document.querySelector('.menu-toggle');
const nav = document.getElementById('main-nav');
function closeMenu(returnFocus = false) { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); if (returnFocus) toggle.focus(); }
toggle.addEventListener('click', () => { const open = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', String(open)); nav.classList.toggle('open', open); });
nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => closeMenu()));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && nav.classList.contains('open')) closeMenu(true); });
document.addEventListener('click', e => { if (!e.target.closest('.site-header')) closeMenu(); });
document.addEventListener('focusin', e => { if (!e.target.closest('.site-header')) closeMenu(); });
matchMedia('(min-width:851px)').addEventListener('change', () => closeMenu());
const questions = {
 'Software a la medida': ['¿Qué necesitas desarrollar?', ['Una herramienta para mi operación', 'Un sistema ERP o CRM', 'Una aplicación web o móvil', 'Mejorar un sistema existente', 'Quiero definirlo con ustedes'], '¿Qué proceso quieres mejorar?', 'Cuéntanos brevemente qué necesita tu equipo (opcional)'],
 'Automatización y datos': ['¿Dónde necesitas más claridad?', ['Automatizar tareas repetitivas', 'Conectar sistemas e información', 'Tableros de Power BI', 'Organizar y analizar datos', 'Quiero definirlo con ustedes'], '¿Cómo trabajan hoy con esa información?', 'Por ejemplo: hojas de cálculo, herramientas desconectadas o reportes manuales (opcional)'],
 'Marketing digital': ['¿Qué te gustaría trabajar?', ['Estrategia de marketing', 'Campañas en Google Ads o Meta Ads', 'Gestión de redes sociales', 'Creación de contenido', 'SEO y medición', 'Quiero definirlo con ustedes'], '¿Qué quieres comunicar y a quién?', 'Cuéntanos sobre tu marca, tu público o tus canales actuales (opcional)'],
 'Página web o landing page': ['¿Qué tipo de sitio necesitas?', ['Página web empresarial', 'Landing page para una campaña', 'Renovar un sitio existente', 'Quiero definirlo con ustedes'], '¿Qué quieres que hagan tus visitantes?', 'Por ejemplo: conocer tus servicios o solicitar información (opcional)'],
 'Solución integral': ['¿Cuál es tu punto de partida?', ['Presencia digital y captación de contactos', 'Organización comercial y automatización', 'Software y estrategia de marketing', 'Quiero definirlo con ustedes'], '¿Qué áreas necesitas conectar?', 'Cuéntanos qué te gustaría mejorar en tu empresa (opcional)'],
 'Necesito orientación': ['¿Qué te gustaría mejorar?', ['La operación de mi equipo', 'La presencia digital de mi empresa', 'La organización de la información', 'La comunicación con mis clientes', 'Aún quiero explorar posibilidades'], '¿Qué desafío tienes hoy?', 'No necesitas términos técnicos: cuéntanos con tus palabras (opcional)']
};
const service = document.getElementById('service'), focus = document.getElementById('focus'), context = document.getElementById('context');
service.addEventListener('change', () => { const q = questions[service.value]; document.getElementById('focus-label').textContent = q[0]; focus.replaceChildren(...q[1].map(text => new Option(text, text))); document.getElementById('context-label').textContent = q[2]; context.placeholder = q[3]; });
document.getElementById('project-form').addEventListener('submit', e => {
 e.preventDefault(); const error = document.getElementById('form-error'); error.hidden = true;
 const message = `Hola OPIA Software, me gustaría conversar sobre un proyecto para mi empresa.\n\nServicio: ${service.value}\nNecesidad: ${focus.value}\nMomento: ${document.getElementById('priority').value}${context.value.trim() ? '\nContexto: ' + context.value.trim() : ''}\n\nQuisiera definir el siguiente paso con ustedes.`;
 try { window.location.assign('https://wa.me/573002374114?text=' + encodeURIComponent(message)); } catch { error.textContent = 'No se pudo abrir WhatsApp. Utiliza el enlace “Hablar con OPIA” o escríbenos al +57 300 237 4114.'; error.hidden = false; }
});
// Only approved and complete records are rendered; no illustrative case studies.
const projects = (Array.isArray(window.OPIA_PROJECTS) ? window.OPIA_PROJECTS : []).filter(p => p.approved === true && ['Software', 'Marketing digital', 'Sitios web'].includes(p.category) && ['OPIA Software', 'Experiencia de nuestro equipo'].includes(p.attribution) && ['title', 'client', 'need', 'work'].every(k => typeof p[k] === 'string' && p[k].trim()));
if (projects.length) {
 const filters = document.getElementById('project-filters'), grid = document.getElementById('project-grid'); filters.hidden = false; grid.hidden = false;
 function element(tag, text) { const el = document.createElement(tag); el.textContent = text; return el; }
 function render(category) { const list = projects.filter(p => category === 'Todos' || p.category === category); grid.replaceChildren(...list.map(p => { const article = document.createElement('article'); article.className = 'project-card';
 if (typeof p.image === 'string' && /^assets\/images\/[a-zA-Z0-9_./-]+$/.test(p.image) && !p.image.includes('..') && p.imageAlt) { const img = document.createElement('img'); img.src = p.image; img.alt = p.imageAlt; img.loading = 'lazy'; article.append(img); }
 article.append(element('small', p.attribution + ' · ' + p.category), element('h3', p.title), element('p', p.client), element('p', 'Necesidad: ' + p.need), element('p', 'Trabajo realizado: ' + p.work)); if (typeof p.result === 'string' && p.result.trim()) article.append(element('p', 'Resultado: ' + p.result)); return article; })); document.getElementById('project-status').textContent = list.length ? list.length + ' proyectos en esta categoría.' : 'No hay proyectos publicados en esta categoría.'; }
 filters.querySelectorAll('button').forEach(button => button.addEventListener('click', () => { filters.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === button))); render(button.dataset.filter); })); render('Todos');
}

document.getElementById('send-whatsapp').disabled = false;
