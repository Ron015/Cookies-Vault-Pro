// ============ SIDEBAR & PANEL LOGIC ============
(function() {
    'use strict';
    
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    const sidebarCloseMobile = document.getElementById('sidebarCloseMobile');
    
    const isMobile = () => window.innerWidth <= 767;
    
    function openMobileSidebar() {
        if (isMobile()) {
            sidebar.classList.add('mobile-open');
            sidebarOverlay.classList.add('active');
            document.body.style.overflow = 'hidden';
        }
    }
    
    function closeMobileSidebar() {
        sidebar.classList.remove('mobile-open');
        sidebarOverlay.classList.remove('active');
        document.body.style.overflow = '';
    }
    
    if (hamburgerBtn) {
        hamburgerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isMobile()) {
                openMobileSidebar();
            } else {
                sidebar.classList.toggle('collapsed');
            }
        });
    }
    
    if (sidebarCloseMobile) {
        sidebarCloseMobile.addEventListener('click', closeMobileSidebar);
    }
    
    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', closeMobileSidebar);
    }
    
    window.addEventListener('resize', () => {
        if (!isMobile()) {
            closeMobileSidebar();
        }
    });
    
    // Panel switching
    const navItems = document.querySelectorAll('.nav-item[data-panel]');
    const panels = document.querySelectorAll('.panel');
    
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const panelId = item.dataset.panel;
            
            navItems.forEach(ni => ni.classList.remove('active'));
            item.classList.add('active');
            
            panels.forEach(p => p.classList.remove('active'));
            const targetPanel = document.getElementById(panelId + 'Panel');
            if (targetPanel) {
                targetPanel.classList.add('active');
            }
            
            if (isMobile()) {
                closeMobileSidebar();
            }
        });
    });
    
    sidebar.addEventListener('click', (e) => {
        e.stopPropagation();
    });
    
})();