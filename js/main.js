/**
 * OPIA SOFTWARE - MAIN JAVASCRIPT MODULE
 * Mobile Drawer Navigation, Project Evaluator, FAQ Accordion, WhatsApp Messaging
 */

document.addEventListener('DOMContentLoaded', () => {

    const WHATSAPP_PHONE = '573002374114';

    /* ==========================================================================
       1. Mobile Navigation Drawer & Backdrop Overlay
       ========================================================================== */
    const menuToggleBtn = document.getElementById('menuToggleBtn');
    const drawerCloseBtn = document.getElementById('drawerCloseBtn');
    const mobileDrawer = document.getElementById('mobileDrawer');
    const drawerOverlay = document.getElementById('drawerOverlay');

    function openDrawer() {
        if (mobileDrawer) mobileDrawer.classList.add('active');
        if (drawerOverlay) drawerOverlay.classList.add('active');
        document.body.classList.add('menu-open');
    }

    function closeDrawer() {
        if (mobileDrawer) mobileDrawer.classList.remove('active');
        if (drawerOverlay) drawerOverlay.classList.remove('active');
        document.body.classList.remove('menu-open');
    }

    if (menuToggleBtn) menuToggleBtn.addEventListener('click', openDrawer);
    if (drawerCloseBtn) drawerCloseBtn.addEventListener('click', closeDrawer);
    if (drawerOverlay) drawerOverlay.addEventListener('click', closeDrawer);

    // Close drawer when clicking any nav link inside drawer
    document.querySelectorAll('.drawer-link').forEach(link => {
        link.addEventListener('click', closeDrawer);
    });

    /* ==========================================================================
       2. FAQ Accordion Cards
       ========================================================================== */
    const faqCards = document.querySelectorAll('.faq-card');

    faqCards.forEach(card => {
        const toggleBtn = card.querySelector('.faq-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                const isActive = card.classList.contains('active');
                
                // Close other cards
                faqCards.forEach(other => other.classList.remove('active'));

                // Toggle selected card
                if (!isActive) {
                    card.classList.add('active');
                }
            });
        }
    });

    /* ==========================================================================
       3. Interactive Project Requirements Evaluator
       ========================================================================== */
    const projectTypeSelect = document.getElementById('projectTypeSelect');
    const complexityInput = document.getElementById('complexityInput');
    const paymentModeSelect = document.getElementById('paymentModeSelect');
    const calcWhatsAppBtn = document.getElementById('calcWhatsAppBtn');

    const lblBase = document.getElementById('lblBase');
    const lblMid = document.getElementById('lblMid');
    const lblAdv = document.getElementById('lblAdv');

    function updateEvaluatorState() {
        if (!projectTypeSelect || !complexityInput || !paymentModeSelect) return;

        const projectTypeName = projectTypeSelect.value;
        const paymentModeName = paymentModeSelect.value;
        const complexityVal = parseInt(complexityInput.value);
        let complexityText = "Medio (5-8 Módulos)";

        if (lblBase) lblBase.classList.remove('active-lbl');
        if (lblMid) lblMid.classList.remove('active-lbl');
        if (lblAdv) lblAdv.classList.remove('active-lbl');

        if (complexityVal === 1) {
            complexityText = "Básico (3-4 Módulos)";
            if (lblBase) lblBase.classList.add('active-lbl');
        } else if (complexityVal === 2) {
            complexityText = "Medio (5-8 Módulos)";
            if (lblMid) lblMid.classList.add('active-lbl');
        } else {
            complexityText = "Avanzado (+9 Módulos)";
            if (lblAdv) lblAdv.classList.add('active-lbl');
        }

        // Configure custom WhatsApp request message
        if (calcWhatsAppBtn) {
            const message = `Hola OPIA Software, me gustaría solicitar la evaluación de un proyecto:\n\n` +
                            `📌 *Tipo de Solución:* ${projectTypeName}\n` +
                            `⚙️ *Complejidad:* ${complexityText}\n` +
                            `💳 *Esquema Preferido:* ${paymentModeName}\n\n` +
                            `Quisiera agendar una breve asesoría para recibir una cotización previa con tarifa favorable.`;
            
            calcWhatsAppBtn.onclick = () => {
                const encodedMsg = encodeURIComponent(message);
                window.open(`https://wa.me/${WHATSAPP_PHONE}?text=${encodedMsg}`, '_blank');
            };
        }
    }

    if (projectTypeSelect) projectTypeSelect.addEventListener('change', updateEvaluatorState);
    if (complexityInput) complexityInput.addEventListener('input', updateEvaluatorState);
    if (paymentModeSelect) paymentModeSelect.addEventListener('change', updateEvaluatorState);

    updateEvaluatorState();
});
