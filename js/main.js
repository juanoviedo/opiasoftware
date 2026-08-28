/**
 * OPIA SOFTWARE - MAIN JAVASCRIPT MODULE
 * Mobile-First Drawer Navigation, Touch Support, Interactive Calculator, FAQ Accordion
 */

document.addEventListener('DOMContentLoaded', () => {

    const WHATSAPP_PHONE = '573002374114';

    /* ==========================================================================
       1. Mobile Drawer Navigation & Backdrop Overlay
       ========================================================================== */
    const navbar = document.getElementById('navbar');
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    const mobileCloseBtn = document.getElementById('mobileCloseBtn');
    const navMenu = document.getElementById('navMenu');
    const navOverlay = document.getElementById('navOverlay');

    function openMobileMenu() {
        if (navMenu) navMenu.classList.add('active');
        if (navOverlay) navOverlay.classList.add('active');
        document.body.classList.add('menu-open');
    }

    function closeMobileMenu() {
        if (navMenu) navMenu.classList.remove('active');
        if (navOverlay) navOverlay.classList.remove('active');
        document.body.classList.remove('menu-open');
    }

    if (hamburgerBtn) {
        hamburgerBtn.addEventListener('click', openMobileMenu);
    }

    if (mobileCloseBtn) {
        mobileCloseBtn.addEventListener('click', closeMobileMenu);
    }

    if (navOverlay) {
        navOverlay.addEventListener('click', closeMobileMenu);
    }

    // Close menu when clicking nav links
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', closeMobileMenu);
    });

    // Navbar background blur on scroll
    window.addEventListener('scroll', () => {
        if (window.scrollY > 30) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }
    });

    /* ==========================================================================
       2. FAQ Accordion Interaction
       ========================================================================== */
    const faqItems = document.querySelectorAll('.faq-item');

    faqItems.forEach(item => {
        const questionBtn = item.querySelector('.faq-question');
        if (questionBtn) {
            questionBtn.addEventListener('click', () => {
                const isActive = item.classList.contains('active');
                
                // Close other accordion items
                faqItems.forEach(otherItem => {
                    otherItem.classList.remove('active');
                });

                // Toggle current item
                if (!isActive) {
                    item.classList.add('active');
                }
            });
        }
    });

    /* ==========================================================================
       3. Interactive Pricing & Plan Calculator
       ========================================================================== */
    const projectTypeSelect = document.getElementById('projectType');
    const complexityRange = document.getElementById('complexityRange');
    const supportAddonSelect = document.getElementById('supportAddon');

    const monthlyResultEl = document.getElementById('monthlyResult');
    const upfrontResultEl = document.getElementById('upfrontResult');
    const btnSendCalcWhatsApp = document.getElementById('btnSendCalcWhatsApp');

    const lblSimple = document.getElementById('lblSimple');
    const lblMedium = document.getElementById('lblMedium');
    const lblComplex = document.getElementById('lblComplex');

    function formatCOP(amount) {
        return new Intl.NumberFormat('es-CO', {
            style: 'decimal',
            maximumFractionDigits: 0
        }).format(amount);
    }

    function calculateEstimate() {
        if (!projectTypeSelect || !complexityRange || !supportAddonSelect) return;

        const selectedOption = projectTypeSelect.options[projectTypeSelect.selectedIndex];
        const basePrice = parseFloat(selectedOption.getAttribute('data-base')) || 8000000;
        
        const complexityVal = parseInt(complexityRange.value);
        let complexityMultiplier = 1.0;
        let complexityText = "Medio (5-8 Módulos)";

        // Update range labels
        if (lblSimple) lblSimple.classList.remove('active');
        if (lblMedium) lblMedium.classList.remove('active');
        if (lblComplex) lblComplex.classList.remove('active');

        if (complexityVal === 1) {
            complexityMultiplier = 0.75;
            complexityText = "Básico (3-4 Módulos)";
            if (lblSimple) lblSimple.classList.add('active');
        } else if (complexityVal === 2) {
            complexityMultiplier = 1.0;
            complexityText = "Medio (5-8 Módulos)";
            if (lblMedium) lblMedium.classList.add('active');
        } else {
            complexityMultiplier = 1.35;
            complexityText = "Avanzado (+9 Módulos)";
            if (lblComplex) lblComplex.classList.add('active');
        }

        const supportAddonVal = parseFloat(supportAddonSelect.value) || 0;

        // Upfront total
        const upfrontTotal = Math.round(basePrice * complexityMultiplier);
        
        // Monthly calculation
        let rawMonthly = (upfrontTotal * 0.05) + supportAddonVal;
        let monthlyTotal = Math.max(500000, Math.round(rawMonthly / 50000) * 50000);

        // Update UI Text
        if (monthlyResultEl) monthlyResultEl.textContent = formatCOP(monthlyTotal);
        if (upfrontResultEl) upfrontResultEl.textContent = formatCOP(upfrontTotal);

        // WhatsApp Quote Link
        if (btnSendCalcWhatsApp) {
            const projectTypeName = selectedOption.text;
            const message = `Hola OPIA Software, realicé una simulación en su calculadora móvil:\n\n` +
                            `📌 *Proyecto:* ${projectTypeName}\n` +
                            `⚙️ *Módulos:* ${complexityText}\n` +
                            `💰 *Suscripción Estimada:* $${formatCOP(monthlyTotal)} COP/mes\n` +
                            `🏢 *Pago Único Estimado:* $${formatCOP(upfrontTotal)} COP\n\n` +
                            `Me gustaría recibir una cotización detallada para mi empresa.`;
            
            btnSendCalcWhatsApp.onclick = () => {
                const encodedMsg = encodeURIComponent(message);
                window.open(`https://wa.me/${WHATSAPP_PHONE}?text=${encodedMsg}`, '_blank');
            };
        }
    }

    if (projectTypeSelect) projectTypeSelect.addEventListener('change', calculateEstimate);
    if (complexityRange) complexityRange.addEventListener('input', calculateEstimate);
    if (supportAddonSelect) supportAddonSelect.addEventListener('change', calculateEstimate);

    calculateEstimate();
});
