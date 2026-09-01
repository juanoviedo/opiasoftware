/**
 * OPIA SOFTWARE - MAIN JAVASCRIPT MODULE
 * Solar Kits Manager & Catalog, Dynamic Image Fallback, Accumulated Cost Calculator, WhatsApp Integration
 */

document.addEventListener('DOMContentLoaded', () => {

    const WHATSAPP_PHONE = '573002374114';

    /* ==========================================================================
       1. Base Store Products Database (Inversores, Paneles, Baterías, Accesorios)
       ========================================================================== */
    const STORE_PRODUCTS = [
        {
            id: 'inv-deye-5k',
            nombre: 'Inversor Híbrido Deye 5kW 48V',
            categoria: 'Inversor',
            precio: 4200000,
            imagen: 'assets/images/hero_preview.png',
            especificacion: '5kW / 48V / 2 MPPT / Pantalla Touch'
        },
        {
            id: 'inv-growatt-3k',
            nombre: 'Inversor Off-Grid Growatt 3kW 24V',
            categoria: 'Inversor',
            precio: 2100000,
            imagen: 'assets/images/hero_preview.png',
            especificacion: '3kW / 24V / Controlador MPPT 80A'
        },
        {
            id: 'panel-mono-550',
            nombre: 'Panel Solar Monocristalino 550W Tier 1',
            categoria: 'Panel Solar',
            precio: 650000,
            imagen: 'assets/images/hero_preview.png',
            especificacion: '550W PERC / Eficiencia 21.3%'
        },
        {
            id: 'panel-bifacial-600',
            nombre: 'Panel Solar Bifacial 600W High Efficiency',
            categoria: 'Panel Solar',
            precio: 780000,
            imagen: 'assets/images/hero_preview.png',
            especificacion: '600W Dual Glass / Ganancia trasera +25%'
        },
        {
            id: 'bat-litio-5k',
            nombre: 'Batería de Litio LiFePO4 48V 100Ah (5.12kWh)',
            categoria: 'Batería',
            precio: 5800000,
            imagen: 'assets/images/hero_preview.png',
            especificacion: '5.12kWh / 6000 Ciclos / BMS Inteligente'
        },
        {
            id: 'bat-gel-200a',
            nombre: 'Batería Gel Ciclo Profundo 12V 200Ah',
            categoria: 'Batería',
            precio: 1450000,
            imagen: 'assets/images/hero_preview.png',
            especificacion: '12V 200Ah / 1200 Ciclos @ 50% DOD'
        },
        {
            id: 'kit-cable-prot',
            nombre: 'Kit de Cableado Solar & Protecciones DC/AC',
            categoria: 'Accesorios',
            precio: 850000,
            imagen: 'assets/images/hero_preview.png',
            especificacion: 'Cable 6mm² + Breakers DC + Tablero AC'
        },
        {
            id: 'est-mont-4p',
            nombre: 'Estructura de Montaje Aluminio (4 Paneles)',
            categoria: 'Accesorios',
            precio: 450000,
            imagen: 'assets/images/hero_preview.png',
            especificacion: 'Aluminio Anodizado Al6005-T5 / Inclinación 15°'
        }
    ];

    /* ==========================================================================
       2. Solar Kits Storage (LocalStorage + Initial Sample Kits)
       ========================================================================== */
    const INITIAL_KITS = [
        {
            id: 'kit-res-5k',
            nombre: 'Kit Solar Residencial Híbrido 5kW',
            descripcion: 'Sistema completo con inversor híbrido 5kW, 6 paneles de 550W y batería de litio de 5.12kWh. Ideal para hogares y pequeñas oficinas.',
            imagenPropia: '', // Dejar vacío a propósito para probar el FALLBACK automático a imágenes de componentes
            items: [
                { productId: 'inv-deye-5k', cantidad: 1 },
                { productId: 'panel-mono-550', cantidad: 6 },
                { productId: 'bat-litio-5k', cantidad: 1 },
                { productId: 'kit-cable-prot', cantidad: 1 },
                { productId: 'est-mont-4p', cantidad: 2 }
            ]
        },
        {
            id: 'kit-finca-3k',
            nombre: 'Kit Solar Finca Off-Grid 3kW',
            descripcion: 'Sistema autónomo con inversor 3kW, 4 paneles solares y 2 baterías gel de ciclo profundo para zonas sin red eléctrica.',
            imagenPropia: 'assets/images/hero_preview.png', // Con imagen propia
            items: [
                { productId: 'inv-growatt-3k', cantidad: 1 },
                { productId: 'panel-mono-550', cantidad: 4 },
                { productId: 'bat-gel-200a', cantidad: 2 },
                { productId: 'kit-cable-prot', cantidad: 1 }
            ]
        }
    ];

    let solarKits = [];
    
    // Load stored kits or use initial kits
    try {
        const storedKits = localStorage.getItem('OPIA_SOLAR_KITS');
        if (storedKits) {
            solarKits = JSON.parse(storedKits);
        } else {
            solarKits = INITIAL_KITS;
            localStorage.setItem('OPIA_SOLAR_KITS', JSON.stringify(solarKits));
        }
    } catch (e) {
        solarKits = INITIAL_KITS;
    }

    /* ==========================================================================
       3. Helper Functions: Number Formatter & Image Fallback Logic
       ========================================================================== */
    function formatCOP(amount) {
        return new Intl.NumberFormat('es-CO', {
            style: 'decimal',
            maximumFractionDigits: 0
        }).format(amount);
    }

    /**
     * IMAGE FALLBACK LOGIC:
     * Si el kit tiene imagenPropia no vacía, devuelve [kit.imagenPropia].
     * Si no tiene imagenPropia (o es nula/vacía), extrae las imágenes de los productos que integran el kit.
     */
    function getKitGalleryImages(kit) {
        if (kit.imagenPropia && kit.imagenPropia.trim() !== '') {
            return [kit.imagenPropia.trim()];
        }
        
        // Fallback: recopilar imágenes de los productos componentes
        const componentImages = [];
        kit.items.forEach(item => {
            const product = STORE_PRODUCTS.find(p => p.id === item.productId);
            if (product && product.imagen) {
                // Evitar duplicados exactos
                if (!componentImages.includes(product.imagen)) {
                    componentImages.push(product.imagen);
                }
            }
        });

        return componentImages.length > 0 ? componentImages : ['assets/images/hero_preview.png'];
    }

    function calculateKitTotalCost(kit) {
        let total = 0;
        kit.items.forEach(item => {
            const product = STORE_PRODUCTS.find(p => p.id === item.productId);
            if (product) {
                total += (product.precio * item.cantidad);
            }
        });
        return total;
    }

    /* ==========================================================================
       4. Render Public Solar Kits Catalog Grid
       ========================================================================== */
    const publicKitsGrid = document.getElementById('publicKitsGrid');

    function renderPublicKitsCatalog() {
        if (!publicKitsGrid) return;
        publicKitsGrid.innerHTML = '';

        solarKits.forEach(kit => {
            const totalCost = calculateKitTotalCost(kit);
            const galleryImages = getKitGalleryImages(kit);
            const isUsingFallback = !kit.imagenPropia || kit.imagenPropia.trim() === '';

            const kitCard = document.createElement('div');
            kitCard.className = 'card-glass kit-card';

            // Items breakdown text list
            let itemsHtml = '';
            let whatsappTextItems = [];
            kit.items.forEach(item => {
                const product = STORE_PRODUCTS.find(p => p.id === item.productId);
                if (product) {
                    itemsHtml += `<li><i class="ri-checkbox-circle-fill text-success"></i> <strong>${item.cantidad}x</strong> ${product.nombre}</li>`;
                    whatsappTextItems.push(`- ${item.cantidad}x ${product.nombre}`);
                }
            });

            // Images gallery markup
            let galleryHtml = '';
            galleryImages.forEach((imgUrl, idx) => {
                galleryHtml += `<img src="${imgUrl}" alt="Componente ${idx + 1}" class="kit-gallery-thumb">`;
            });

            const whatsappMsg = `Hola OPIA Software, me interesa el Kit Solar:\n\n` +
                                `☀️ *${kit.nombre}*\n` +
                                `💰 *Costo Consolidado:* $${formatCOP(totalCost)} COP\n\n` +
                                `📋 *Productos Incluidos:*\n${whatsappTextItems.join('\n')}\n\n` +
                                `Quisiera consultar facilidades de crédito o mensualidades para este Kit.`;

            kitCard.innerHTML = `
                <div class="kit-card-header">
                    <span class="kit-category-badge"><i class="ri-sun-line"></i> Kit Solar Consolidado</span>
                    <h3 class="kit-title">${kit.nombre}</h3>
                    <p class="kit-desc">${kit.descripcion}</p>
                </div>

                <div class="kit-gallery-box">
                    <div class="kit-gallery-header">
                        <span><i class="ri-image-line"></i> ${isUsingFallback ? 'Imágenes de Productos Componentes (Fallback)' : 'Imagen del Kit'}</span>
                    </div>
                    <div class="kit-gallery-strip">
                        ${galleryHtml}
                    </div>
                </div>

                <div class="kit-breakdown-box">
                    <h4>Componentes del Grupo:</h4>
                    <ul class="kit-items-list">
                        ${itemsHtml}
                    </ul>
                </div>

                <div class="kit-card-footer">
                    <div class="kit-price-box">
                        <span class="price-label">Costo Total Consolidado:</span>
                        <div class="price-val-row">
                            <span class="currency-symbol">$</span>
                            <span class="price-number">${formatCOP(totalCost)}</span>
                            <span class="currency-code">COP</span>
                        </div>
                    </div>

                    <a href="https://wa.me/${WHATSAPP_PHONE}?text=${encodeURIComponent(whatsappMsg)}" 
                       target="_blank" 
                       rel="noopener noreferrer" 
                       class="btn btn-whatsapp btn-full">
                        <i class="ri-whatsapp-line"></i>
                        <span>Cotizar este Kit por WhatsApp</span>
                    </a>
                </div>
            `;

            publicKitsGrid.appendChild(kitCard);
        });
    }

    /* ==========================================================================
       5. Dynamic Kit Creator & Manager State (Draft Kit Construction)
       ========================================================================== */
    const productPicker = document.getElementById('productPicker');
    const productQtyInput = document.getElementById('productQtyInput');
    const btnMinusQty = document.getElementById('btnMinusQty');
    const btnPlusQty = document.getElementById('btnPlusQty');
    const btnAddProductToDraft = document.getElementById('btnAddProductToDraft');

    const kitNameInput = document.getElementById('kitNameInput');
    const kitDescriptionInput = document.getElementById('kitDescriptionInput');
    const kitImageInput = document.getElementById('kitImageInput');

    const draftKitTitleDisplay = document.getElementById('draftKitTitleDisplay');
    const draftKitDescDisplay = document.getElementById('draftKitDescDisplay');
    const draftItemsList = document.getElementById('draftItemsList');
    const draftGalleryContainer = document.getElementById('draftGalleryContainer');
    const draftTotalAmount = document.getElementById('draftTotalAmount');
    const btnFinalizeKit = document.getElementById('btnFinalizeKit');

    // Draft state
    let draftItems = [];

    function populateProductPicker() {
        if (!productPicker) return;
        productPicker.innerHTML = '';

        STORE_PRODUCTS.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `[${p.categoria}] ${p.nombre} - $${formatCOP(p.precio)} COP`;
            productPicker.appendChild(opt);
        });
    }

    // Quantity buttons
    if (btnMinusQty && productQtyInput) {
        btnMinusQty.addEventListener('click', () => {
            let val = parseInt(productQtyInput.value) || 1;
            if (val > 1) productQtyInput.value = val - 1;
        });
    }

    if (btnPlusQty && productQtyInput) {
        btnPlusQty.addEventListener('click', () => {
            let val = parseInt(productQtyInput.value) || 1;
            productQtyInput.value = val + 1;
        });
    }

    function calculateDraftTotal() {
        let total = 0;
        draftItems.forEach(item => {
            const product = STORE_PRODUCTS.find(p => p.id === item.productId);
            if (product) {
                total += (product.precio * item.cantidad);
            }
        });
        return total;
    }

    function updateDraftUI() {
        // Update Title and Description
        if (draftKitTitleDisplay && kitNameInput) {
            draftKitTitleDisplay.textContent = kitNameInput.value.trim() || 'Kit Solar Personalizado';
        }
        if (draftKitDescDisplay && kitDescriptionInput) {
            draftKitDescDisplay.textContent = kitDescriptionInput.value.trim() || 'Selecciona productos de la izquierda para sumar al kit.';
        }

        // Render Items List
        if (draftItemsList) {
            if (draftItems.length === 0) {
                draftItemsList.innerHTML = '<p class="empty-draft-msg">No has agregado productos al kit todavía.</p>';
            } else {
                draftItemsList.innerHTML = '';
                draftItems.forEach((item, index) => {
                    const product = STORE_PRODUCTS.find(p => p.id === item.productId);
                    if (product) {
                        const itemRow = document.createElement('div');
                        itemRow.className = 'draft-item-row';
                        const itemSubtotal = product.precio * item.cantidad;

                        itemRow.innerHTML = `
                            <div class="draft-item-info">
                                <strong>${item.cantidad}x ${product.nombre}</strong>
                                <span>$${formatCOP(product.precio)} c/u &rarr; Subtotal: $${formatCOP(itemSubtotal)} COP</span>
                            </div>
                            <button type="button" class="btn-remove-item" data-index="${index}" aria-label="Eliminar producto">
                                <i class="ri-delete-bin-line"></i>
                            </button>
                        `;

                        draftItemsList.appendChild(itemRow);
                    }
                });

                // Attach remove listeners
                draftItemsList.querySelectorAll('.btn-remove-item').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const idx = parseInt(btn.getAttribute('data-index'));
                        draftItems.splice(idx, 1);
                        updateDraftUI();
                    });
                });
            }
        }

        // Update Dynamic Component Images Gallery Preview
        if (draftGalleryContainer) {
            draftGalleryContainer.innerHTML = '';
            
            const customImg = kitImageInput ? kitImageInput.value.trim() : '';
            let imagesToDisplay = [];

            if (customImg !== '') {
                imagesToDisplay = [customImg];
            } else {
                // Fallback to components
                draftItems.forEach(item => {
                    const product = STORE_PRODUCTS.find(p => p.id === item.productId);
                    if (product && product.imagen && !imagesToDisplay.includes(product.imagen)) {
                        imagesToDisplay.push(product.imagen);
                    }
                });
            }

            if (imagesToDisplay.length === 0) {
                draftGalleryContainer.innerHTML = '<span class="no-images-text">Las imágenes de los productos agregados se mostrarán aquí.</span>';
            } else {
                imagesToDisplay.forEach(img => {
                    const imgEl = document.createElement('img');
                    imgEl.src = img;
                    imgEl.alt = 'Imagen de componente';
                    imgEl.className = 'draft-preview-thumb';
                    draftGalleryContainer.appendChild(imgEl);
                });
            }
        }

        // Update Total Cost Amount Display
        if (draftTotalAmount) {
            draftTotalAmount.textContent = formatCOP(calculateDraftTotal());
        }
    }

    // Add Product to Draft Event
    if (btnAddProductToDraft && productPicker && productQtyInput) {
        btnAddProductToDraft.addEventListener('click', () => {
            const selectedProductId = productPicker.value;
            const qty = parseInt(productQtyInput.value) || 1;

            if (!selectedProductId) return;

            // Check if already in draft
            const existingItem = draftItems.find(item => item.productId === selectedProductId);
            if (existingItem) {
                existingItem.cantidad += qty;
            } else {
                draftItems.push({ productId: selectedProductId, cantidad: qty });
            }

            updateDraftUI();
        });
    }

    // Input listeners for text changes
    if (kitNameInput) kitNameInput.addEventListener('input', updateDraftUI);
    if (kitDescriptionInput) kitDescriptionInput.addEventListener('input', updateDraftUI);
    if (kitImageInput) kitImageInput.addEventListener('input', updateDraftUI);

    // Finalize Kit Event (Consolidate & Publish)
    if (btnFinalizeKit) {
        btnFinalizeKit.addEventListener('click', () => {
            if (draftItems.length === 0) {
                alert('Por favor agrega al menos un producto al kit antes de finalizar.');
                return;
            }

            const kitName = kitNameInput ? kitNameInput.value.trim() : '';
            if (!kitName) {
                alert('Por favor ingresa un nombre para el Kit Solar.');
                return;
            }

            const newKit = {
                id: 'kit-' + Date.now(),
                nombre: kitName,
                descripcion: kitDescriptionInput ? kitDescriptionInput.value.trim() : 'Kit Solar personalizado con productos de la tienda.',
                imagenPropia: kitImageInput ? kitImageInput.value.trim() : '',
                items: [...draftItems]
            };

            // Save to array and LocalStorage
            solarKits.unshift(newKit);
            try {
                localStorage.setItem('OPIA_SOLAR_KITS', JSON.stringify(solarKits));
            } catch (e) {}

            // Re-render Public Catalog
            renderPublicKitsCatalog();

            // Reset Draft Form
            draftItems = [];
            if (kitNameInput) kitNameInput.value = 'Kit Solar Personalizado';
            if (kitDescriptionInput) kitDescriptionInput.value = '';
            if (kitImageInput) kitImageInput.value = '';
            if (productQtyInput) productQtyInput.value = '1';

            updateDraftUI();

            alert('¡El Kit Solar ha sido consolidado y publicado con éxito en la tienda!');

            // Scroll smoothly to public catalog
            const catElem = document.getElementById('kits-solares');
            if (catElem) catElem.scrollIntoView({ behavior: 'smooth' });
        });
    }

    /* ==========================================================================
       6. Mobile Drawer Navigation & Backdrop
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

    document.querySelectorAll('.drawer-link').forEach(link => {
        link.addEventListener('click', closeDrawer);
    });

    /* ==========================================================================
       7. FAQ Accordion Cards
       ========================================================================== */
    const faqCards = document.querySelectorAll('.faq-card');

    faqCards.forEach(card => {
        const toggleBtn = card.querySelector('.faq-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                const isActive = card.classList.contains('active');
                faqCards.forEach(other => other.classList.remove('active'));
                if (!isActive) {
                    card.classList.add('active');
                }
            });
        }
    });

    /* ==========================================================================
       8. Initial Execution
       ========================================================================== */
    populateProductPicker();
    updateDraftUI();
    renderPublicKitsCatalog();
});
