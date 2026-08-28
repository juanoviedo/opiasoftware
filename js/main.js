/**
 * OPIA SOFTWARE - MAIN JAVASCRIPT MODULE
 * Mobile Drawer, Calculator, FAQ Accordions, Dynamic WhatsApp Integration
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
       3. Interactive Cost & Plan Calculator
       ========================================================================== */
    const projectTypeSelect = document.getElementById('projectTypeSelect');
    const complexityInput = document.getElementById('complexityInput');
    const supportSelect = document.getElementById('supportSelect');

    const monthlyPriceVal = document.getElementById('monthlyPriceVal');
    const upfrontPriceVal = document.getElementById('upfrontPriceVal');
    const calcWhatsAppBtn = document.getElementById('calcWhatsAppBtn');

    const lblBase = document.getElementById('lblBase');
    const lblMid = document.getElementById('lblMid');
    const lblAdv = document.getElementById('lblAdv');

    function formatCOP(amount) {
        return new Intl.NumberFormat('es-CO', {
            style: 'decimal',
            maximumFractionDigits: 0
        }).format(amount);
    }

    function calculateEstimate() {
        if (!projectTypeSelect || !complexityInput || !supportSelect) return;

        const selectedOption = projectTypeSelect.options[projectTypeSelect.selectedIndex];
        const basePrice = parseFloat(selectedOption.getAttribute('data-base')) || 8000000;
        
        const complexityVal = parseInt(complexityInput.value);
        let complexityMultiplier = 1.0;
        let complexityText = "Medio (5-8 Módulos)";

        if (lblBase) lblBase.classList.remove('active-lbl');
        if (lblMid) lblMid.classList.remove('active-lbl');
        if (lblAdv) lblAdv.classList.remove('active-lbl');

        if (complexityVal === 1) {
            complexityMultiplier = 0.75;
            complexityText = "Básico (3-4 Módulos)";
            if (lblBase) lblBase.classList.add('active-lbl');
        } else if (complexityVal === 2) {
            complexityMultiplier = 1.0;
            complexityText = "Medio (5-8 Módulos)";
            if (lblMid) lblMid.classList.add('active-lbl');
        } else {
            complexityMultiplier = 1.35;
            complexityText = "Avanzado (+9 Módulos)";
            if (lblAdv) lblAdv.classList.add('active-lbl');
        }

        const supportAddonVal = parseFloat(supportSelect.value) || 0;

        // Calculate upfront total
        const upfrontTotal = Math.round(basePrice * complexityMultiplier);
        
        // Calculate monthly plan
        let rawMonthly = (upfrontTotal * 0.05) + supportAddonVal;
        let monthlyTotal = Math.max(500000, Math.round(rawMonthly / 50000) * 50000);

        // Update UI
        if (monthlyPriceVal) monthlyPriceVal.textContent = formatCOP(monthlyTotal);
        if (upfrontPriceVal) upfrontPriceVal.textContent = formatCOP(upfrontTotal);

        // Update WhatsApp Send Button URL
        if (calcWhatsAppBtn) {
            const projectTypeName = selectedOption.text;
            const message = `Hola OPIA Software, realicé una cotización en su simulador:\n\n` +
                            `📌 *Proyecto:* ${projectTypeName}\n` +
                            `⚙️ *Módulos:* ${complexityText}\n` +
                            `💰 *Suscripción Estimada:* $${formatCOP(monthlyTotal)} COP/mes\n` +
                            `🏢 *Pago Único Estimado:* $${formatCOP(upfrontTotal)} COP\n\n` +
                            `Me gustaría recibir una asesoría técnica para mi empresa.`;
            
            calcWhatsAppBtn.onclick = () => {
                const encodedMsg = encodeURIComponent(message);
                window.open(`https://wa.me/${WHATSAPP_PHONE}?text=${encodedMsg}`, '_blank');
            };
        }
    }

    if (projectTypeSelect) projectTypeSelect.addEventListener('change', calculateEstimate);
    if (complexityInput) complexityInput.addEventListener('input', calculateEstimate);
    if (supportSelect) supportSelect.addEventListener('change', calculateEstimate);

    calculateEstimate();
});
