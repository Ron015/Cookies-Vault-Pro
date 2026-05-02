(function() {
    'use strict';

    // ============ INDEXEDDB ============
    const DB_NAME = 'RonCookieVaultDB';
    const DB_VERSION = 2;
    const PROFILES_STORE = 'profiles';
    const SETTINGS_STORE = 'settings';

    let db = null;

    function openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (event) => {
                const database = event.target.result;
                
                if (!database.objectStoreNames.contains(PROFILES_STORE)) {
                    const profilesStore = database.createObjectStore(PROFILES_STORE, { keyPath: 'id' });
                    profilesStore.createIndex('domain', 'domain', { unique: false });
                    profilesStore.createIndex('name', 'name', { unique: false });
                    profilesStore.createIndex('tags', 'tags', { unique: false, multiEntry: true });
                    profilesStore.createIndex('updated', 'updated', { unique: false });
                }
                
                if (event.oldVersion < 2) {
                    const tx = event.target.transaction;
                    const store = tx.objectStore(PROFILES_STORE);
                    if (!store.indexNames.contains('storageType')) {
                        store.createIndex('storageType', 'storageType', { unique: false });
                    }
                }
                
                if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
                    database.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
                }
            };
            request.onsuccess = (event) => { db = event.target.result; resolve(db); };
            request.onerror = (event) => reject(event.target.error);
        });
    }

    function getDB() { return db ? Promise.resolve(db) : openDB(); }

    function dbGet(store, key) {
        return getDB().then(database => new Promise((resolve, reject) => {
            const tx = database.transaction(store, 'readonly');
            const req = tx.objectStore(store).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }));
    }

    function dbGetAll(store) {
        return getDB().then(database => new Promise((resolve, reject) => {
            const tx = database.transaction(store, 'readonly');
            const req = tx.objectStore(store).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        }));
    }

    function dbPut(store, data) {
        return getDB().then(database => new Promise((resolve, reject) => {
            const tx = database.transaction(store, 'readwrite');
            const req = tx.objectStore(store).put(data);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }));
    }

    function dbDelete(store, key) {
        return getDB().then(database => new Promise((resolve, reject) => {
            const tx = database.transaction(store, 'readwrite');
            const req = tx.objectStore(store).delete(key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        }));
    }

    // ============ FIREBASE CLOUD STORAGE ============
    let firebaseApp = null;
    let firebaseDB = null;
    let firebaseAuth = null;
    let cloudConnected = false;
    let currentStorageMode = 'local';

    const CloudStorage = {
        async initialize(config) {
            try {
                if (typeof firebase === 'undefined') {
                    throw new Error('Firebase SDK not loaded');
                }

                if (!firebase.apps.length) {
                    firebaseApp = firebase.initializeApp({
                        apiKey: config.apiKey,
                        authDomain: config.authDomain,
                        projectId: config.projectId,
                        databaseURL: config.databaseURL,
                        appId: config.appId
                    });
                } else {
                    firebaseApp = firebase.app();
                }
                
                firebaseAuth = firebase.auth();
                firebaseDB = firebase.database();
                
                if (config.email && config.password) {
                    await firebaseAuth.signInWithEmailAndPassword(config.email, config.password);
                }

                cloudConnected = true;
                return true;
            } catch (error) {
                console.error('Firebase init failed:', error);
                cloudConnected = false;
                throw error;
            }
        },

        async saveProfile(profile) {
            if (!cloudConnected || !firebaseDB) return false;
            try {
                const cleanProfile = {
                    ...profile,
                    cookieData: typeof profile.cookieData === 'string' ? 
                        profile.cookieData : 
                        JSON.stringify(profile.cookieData)
                };
                await firebaseDB.ref(`profiles/${profile.id}`).set(cleanProfile);
                return true;
            } catch (error) {
                console.error('Cloud save failed:', error);
                return false;
            }
        },

        async getProfile(id) {
            if (!cloudConnected || !firebaseDB) return null;
            try {
                const snapshot = await firebaseDB.ref(`profiles/${id}`).once('value');
                return snapshot.val();
            } catch (error) {
                console.error('Cloud get failed:', error);
                return null;
            }
        },

        async getAllProfiles() {
            if (!cloudConnected || !firebaseDB) return [];
            try {
                const snapshot = await firebaseDB.ref('profiles').once('value');
                const data = snapshot.val();
                return data ? Object.values(data) : [];
            } catch (error) {
                console.error('Cloud getAll failed:', error);
                return [];
            }
        },

        async deleteProfile(id) {
            if (!cloudConnected || !firebaseDB) return false;
            try {
                await firebaseDB.ref(`profiles/${id}`).remove();
                return true;
            } catch (error) {
                console.error('Cloud delete failed:', error);
                return false;
            }
        },

        async disconnect() {
            if (firebaseAuth) {
                await firebaseAuth.signOut();
            }
            if (firebaseApp) {
                await firebaseApp.delete();
            }
            firebaseApp = null;
            firebaseDB = null;
            firebaseAuth = null;
            cloudConnected = false;
        }
    };

    // ============ STATE ============
    let currentProfileId = null;
    let currentViewMode = 'domain';
    let currentTabDomain = '';
    let currentTabUrl = '';
    let currentTabId = null;
    let searchQuery = '';
    let settings = { 
        autoReload: true, 
        compressionEnabled: true, 
        autoCleanupDays: 30,
        storageMode: 'local'
    };
    let firebaseConfig = null;
    let confirmCallback = null;
    let profileFormMode = 'add';
    let editProfileId = null;

    // ============ DOM ELEMENTS (UPDATED FOR NEW UI) ============
    const $ = (sel) => document.querySelector(sel);
    const dom = {
        // Sidebar
        sidebarProfileCount: $('#sidebarProfileCount'),
        sidebarActiveProfile: $('#sidebarActiveProfile'),
        sidebarCloudStatus: $('#sidebarCloudStatus'),
        sidebarDomain: $('#sidebarDomain'),
        
        // Top bar
        cloudStatusDot: $('#cloudStatusDot'),
        cloudStatusText: $('#cloudStatusText'),
        currentDomainBadge: $('#currentDomainBadge'),
        
        // Panels
        dashboardPanel: $('#dashboardPanel'),
        cloudPanel: $('#cloudPanel'),
        toolsPanel: $('#toolsPanel'),
        settingsPanel: $('#settingsPanel'),
        
        // Profiles
        profilesGrid: $('#profilesGrid'),
        searchInput: $('#searchInput'),
        clearSearchBtn: $('#clearSearchBtn'),
        showDomainBtn: $('#showDomainBtn'),
        showGlobalBtn: $('#showGlobalBtn'),
        addProfileBtn: $('#addProfileBtn'),
        addCloudProfileBtn: $('#addCloudProfileBtn'),
        
        // Cloud
        syncNowBtn: $('#syncNowBtn'),
        localModeBtn: $('#localModeBtn'),
        cloudModeBtn: $('#cloudModeBtn'),
        hybridModeBtn: $('#hybridModeBtn'),
        firebaseApiKey: $('#firebaseApiKey'),
        firebaseProjectId: $('#firebaseProjectId'),
        firebaseAuthDomain: $('#firebaseAuthDomain'),
        firebaseDatabaseURL: $('#firebaseDatabaseURL'),
        firebaseAppId: $('#firebaseAppId'),
        firebaseEmail: $('#firebaseEmail'),
        firebasePassword: $('#firebasePassword'),
        saveFirebaseConfigBtn: $('#saveFirebaseConfigBtn'),
        clearFirebaseConfigBtn: $('#clearFirebaseConfigBtn'),
        
        // Tools
        exportBtn: $('#exportBtn'),
        importBtn: $('#importBtn'),
        hiddenFileInput: $('#hiddenFileInput'),
        
        // Settings
        autoReloadCheckbox: $('#autoReloadCheckbox'),
        compressionCheckbox: $('#compressionCheckbox'),
        cleanupSettingsBtn: $('#cleanupSettingsBtn'),
        
        // Quick actions (sidebar)
        captureCurrentBtn: $('#captureCurrentBtn'),
        clearDomainBtn: $('#clearDomainBtn'),
        cleanupBtn: $('#cleanupBtn'),
        
        // Modals
        profileFormModal: $('#profileFormModal'),
        formModalTitle: $('#formModalTitle'),
        profileNameInput: $('#profileNameInput'),
        profileDomainInput: $('#profileDomainInput'),
        profileTagsInput: $('#profileTagsInput'),
        profileStorageSelect: $('#profileStorageSelect'),
        cookieDataInput: $('#cookieDataInput'),
        formModalFooter: $('#formModalFooter'),
        saveProfileBtn: $('#saveProfileBtn'),
        
        confirmModal: $('#confirmModal'),
        confirmTitle: $('#confirmTitle'),
        confirmMessage: $('#confirmMessage'),
        confirmActionBtn: $('#confirmActionBtn'),
        captureDashboardBtn: $('#captureDashboardBtn'),
        // Toast
        statusToast: $('#statusToast')
    };

    // ============ COMPRESSION ============
    const Compressor = {
        compress(data) {
            try {
                if (settings.compressionEnabled && typeof LZString !== 'undefined') {
                    const json = typeof data === 'string' ? data : JSON.stringify(data);
                    return { compressed: true, data: LZString.compressToUTF16(json) };
                }
            } catch(e) {}
            return { compressed: false, data };
        },
        decompress(stored) {
            if (!stored) return null;
            if (stored.compressed && typeof LZString !== 'undefined') {
                try {
                    return JSON.parse(LZString.decompressFromUTF16(stored.data));
                } catch(e) { return stored.data; }
            }
            return stored.data;
        },
        getCookieCount(storedData) {
            const data = this.decompress(storedData);
            return Array.isArray(data) ? data.length : 0;
        }
    };

    // ============ DOMAIN MATCHING ============
    function matchesDomain(profileDomain, targetDomain) {
        if (!profileDomain || !targetDomain) return false;
        if (profileDomain === targetDomain) return true;
        if (profileDomain.startsWith('.') && (targetDomain === profileDomain.slice(1) || targetDomain.endsWith(profileDomain))) return true;
        if (profileDomain.startsWith('*.')) {
            const dp = profileDomain.slice(2);
            return targetDomain === dp || targetDomain.endsWith('.' + dp);
        }
        return false;
    }

    // ============ UI HELPERS ============
    function showToast(message, type = 'success') {
        dom.statusToast.textContent = message;
        dom.statusToast.className = 'toast ' + type;
        dom.statusToast.classList.add('show');
        setTimeout(() => dom.statusToast.classList.remove('show'), 3000);
    }

    function escapeHtml(s) { 
        return String(s || '').replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m])); 
    }

    function updateSidebarStats(profiles) {
        dom.sidebarProfileCount.textContent = profiles.length;
        const active = profiles.find(p => p.id === currentProfileId);
        dom.sidebarActiveProfile.textContent = active ? active.name : 'none';
        dom.sidebarCloudStatus.textContent = cloudConnected ? '🟢 Connected' : '⬤ Off';
        dom.sidebarDomain.textContent = currentTabDomain || '...';
    }

    function updateCloudStatusUI() {
        if (cloudConnected) {
            dom.cloudStatusDot.className = 'status-dot connected';
            dom.cloudStatusText.textContent = '☁️ Connected to Firebase';
            dom.sidebarCloudStatus.textContent = '🟢 Connected';
        } else {
            dom.cloudStatusDot.className = 'status-dot disconnected';
            dom.cloudStatusText.textContent = '☁️ Not connected';
            dom.sidebarCloudStatus.textContent = '⬤ Off';
        }

        // Update storage mode buttons
        dom.localModeBtn.classList.toggle('active', currentStorageMode === 'local');
        dom.cloudModeBtn.classList.toggle('active', currentStorageMode === 'cloud');
        dom.hybridModeBtn.classList.toggle('active', currentStorageMode === 'hybrid');

        // Show/hide add buttons based on mode
        dom.addProfileBtn.style.display = currentStorageMode === 'cloud' ? 'none' : '';
        dom.addCloudProfileBtn.style.display = currentStorageMode === 'local' ? 'none' : '';
    }

    // ============ MODALS ============
    function showConfirmModal(title, message, callback, confirmText = 'Confirm', isDanger = false) {
        dom.confirmTitle.textContent = title;
        dom.confirmMessage.innerHTML = message;
        confirmCallback = callback;
        dom.confirmActionBtn.textContent = confirmText;
        dom.confirmActionBtn.className = isDanger ? 'btn btn-danger' : 'btn btn-primary';
        dom.confirmModal.classList.add('active');
    }

    function hideConfirmModal() { 
        dom.confirmModal.classList.remove('active'); 
        confirmCallback = null; 
    }

    function showProfileFormModal(mode = 'add', profileData = null, defaultStorage = 'local') {
        profileFormMode = mode;
        editProfileId = null;
        dom.profileStorageSelect.value = defaultStorage;
        
        if (mode === 'add') {
            dom.formModalTitle.textContent = `Create Profile (${defaultStorage === 'cloud' ? 'Cloud' : 'Local'})`;
            dom.profileNameInput.value = '';
            dom.profileDomainInput.value = currentTabDomain || '';
            dom.profileTagsInput.value = '';
            dom.cookieDataInput.value = '';
            dom.formModalFooter.innerHTML = `
                <button class="btn btn-secondary" data-close="profileFormModal">Cancel</button>
                <button class="btn btn-primary" id="saveProfileBtn">Save</button>`;
        } else if (mode === 'edit' && profileData) {
            editProfileId = profileData.id;
            dom.formModalTitle.textContent = 'Edit Profile';
            dom.profileNameInput.value = profileData.name || '';
            dom.profileDomainInput.value = profileData.domain || '';
            dom.profileTagsInput.value = (profileData.tags || []).join(', ');
            dom.profileStorageSelect.value = profileData.storageType || 'local';
            dom.cookieDataInput.value = JSON.stringify(Compressor.decompress(profileData.cookieData) || '', null, 2);
            dom.formModalFooter.innerHTML = `
                <button class="btn btn-danger" id="deleteProfileBtn">Delete</button>
                <button class="btn btn-secondary" data-close="profileFormModal">Cancel</button>
                <button class="btn btn-primary" id="saveProfileBtn">Update</button>`;
        }
        dom.profileFormModal.classList.add('active');
    }

    function hideProfileFormModal() {
        dom.profileFormModal.classList.remove('active');
        editProfileId = null;
    }

    // ============ CORE FUNCTIONS ============
    async function getCurrentTabInfo() {
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0]?.url) {
                currentTabUrl = tabs[0].url;
                currentTabId = tabs[0].id;
                currentTabDomain = new URL(currentTabUrl).hostname;
                dom.currentDomainBadge.textContent = '🌐 ' + currentTabDomain;
                dom.sidebarDomain.textContent = currentTabDomain;
                return { url: currentTabUrl, domain: currentTabDomain, tabId: currentTabId };
            }
        } catch(e) {}
        dom.currentDomainBadge.textContent = '🌐 unknown';
        dom.sidebarDomain.textContent = '...';
        return null;
    }

    async function getFilteredProfiles() {
        try {
            let profiles = [];
            const localProfiles = await dbGetAll(PROFILES_STORE);
            let cloudProfiles = [];
            
            if (cloudConnected && currentStorageMode !== 'local') {
                cloudProfiles = await CloudStorage.getAllProfiles();
            }
            
            if (currentStorageMode === 'local') {
                profiles = localProfiles;
            } else if (currentStorageMode === 'cloud') {
                profiles = cloudProfiles;
            } else {
                const mergedMap = new Map();
                localProfiles.forEach(p => mergedMap.set(p.id, p));
                cloudProfiles.forEach(p => mergedMap.set(p.id, p));
                profiles = Array.from(mergedMap.values());
            }
            
            if (currentViewMode === 'domain') {
                profiles = profiles.filter(p => matchesDomain(p.domain, currentTabDomain));
            }
            
            if (searchQuery) {
                const q = searchQuery.toLowerCase();
                profiles = profiles.filter(p =>
                    (p.name || '').toLowerCase().includes(q) ||
                    (p.domain || '').toLowerCase().includes(q) ||
                    (p.tags || []).some(t => t.toLowerCase().includes(q))
                );
            }
            
            return profiles;
        } catch(e) { 
            console.error('getFilteredProfiles error:', e);
            return []; 
        }
    }

    async function renderProfilesList() {
        try {
            const filtered = await getFilteredProfiles();
            const allProfiles = await dbGetAll(PROFILES_STORE);
            
            updateSidebarStats(allProfiles);

            if (!filtered.length) {
                dom.profilesGrid.innerHTML = `<div class="empty-state">${
                    searchQuery ? `No matches for "<span class="highlight">${escapeHtml(searchQuery)}</span>"` : 
                    '✨ No profiles yet. Create one to get started!'
                }</div>`;
                return;
            }


            dom.profilesGrid.innerHTML = filtered.map(p => {
                const isActive = currentProfileId === p.id;
                const storageIcon = p.storageType === 'cloud' ? '☁️' : p.storageType === 'hybrid' ? '🔄' : '💾';
                const storageClass = p.storageType === 'cloud' ? 'cloud' : p.storageType === 'hybrid' ? 'success' : 'primary';
                
                return `
                <div class="profile-card ${isActive ? 'active' : ''}" data-id="${p.id}">
                    <div class="profile-card-header">
                        <div class="profile-name">
                            ${isActive ? '⭐ ' : ''}${escapeHtml(p.name)}
                        </div>
                        <div class="profile-actions">
                            <button class="btn btn-sm btn-secondary manage-btn" data-manage="${p.id}" title="Edit">&nbsp;&nbsp;⚙️&nbsp;&nbsp;</button>
                        </div>
                    </div>
                    <div class="profile-meta">
                        ${p.domain ? `<span class="badge badge-domain">🌐 ${escapeHtml(p.domain)}</span>` : ''}
                        <span class="badge badge-success">${Compressor.getCookieCount(p.cookieData)} cookies</span>
                        <span class="badge badge-${storageClass}">${storageIcon} ${p.storageType}</span>
                        ${(p.tags || []).slice(0, 3).map(t => `<span class="badge badge-primary">#${escapeHtml(t)}</span>`).join('')}
                    </div>
                </div>`;
            }).join('');

            // Event binding for profile cards
            dom.profilesGrid.querySelectorAll('.profile-card').forEach(card => {
                card.addEventListener('click', (e) => {
                    if (!e.target.closest('.manage-btn')) {
                        applyCookieProfile(card.dataset.id);
                    }
                });
            });
            
            dom.profilesGrid.querySelectorAll('.manage-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    let profile = await dbGet(PROFILES_STORE, btn.dataset.manage);
                    if (!profile && cloudConnected) {
                        profile = await CloudStorage.getProfile(btn.dataset.manage);
                    }
                    if (profile) showProfileFormModal('edit', profile);
                });
            });
        } catch(e) { 
            console.error('renderProfilesList error:', e);
            dom.profilesGrid.innerHTML = '<div class="empty-state">Error loading profiles</div>'; 
        }
    }


    async function updateUI() { 
        await renderProfilesList();
        updateCloudStatusUI();
    }

    // ============ PROFILE ACTIONS ============
    async function applyCookieProfile(profileId) {
        try {
            let profile = await dbGet(PROFILES_STORE, profileId);
            if (!profile && cloudConnected) {
                profile = await CloudStorage.getProfile(profileId);
            }
            
            if (!profile) { showToast('Profile not found', 'error'); return false; }
            
            const cookieData = Compressor.decompress(profile.cookieData);
            if (!Array.isArray(cookieData)) { showToast('Invalid format', 'error'); return false; }
            
            const tabInfo = await getCurrentTabInfo();
            if (!tabInfo) { showToast('No tab access', 'error'); return false; }

            let count = 0;
            for (const cookie of cookieData) {
                try {
                    await chrome.cookies.set({
                        url: tabInfo.url, name: cookie.name, value: cookie.value || '',
                        domain: cookie.domain || profile.domain || tabInfo.domain,
                        path: cookie.path || '/', secure: cookie.secure || false,
                        httpOnly: cookie.httpOnly || false, sameSite: cookie.sameSite || 'lax',
                        expirationDate: cookie.expirationDate
                    });
                    count++;
                } catch(e) {}
            }

            currentProfileId = profileId;
            await dbPut(SETTINGS_STORE, { key: 'activeProfile', value: profileId });

            if (settings.autoReload && tabInfo.tabId) await chrome.tabs.reload(tabInfo.tabId);
            updateUI();
            showToast(`Applied ${count} cookies${settings.autoReload ? ' & reloaded' : ''}`);
            return true;
        } catch(e) { showToast('Apply failed', 'error'); return false; }
    }

    async function captureCurrentCookies() {
        const tabInfo = await getCurrentTabInfo();
        if (!tabInfo) { showToast('Cannot access tab', 'error'); return null; }
        try {
            const cookies = await chrome.cookies.getAll({ domain: tabInfo.domain });
            const allCookies = await chrome.cookies.getAll({ url: tabInfo.url });
            const unique = Array.from(new Map([...cookies, ...allCookies].map(c => [c.name + c.domain + c.path, c])).values());
            const now = Date.now() / 1000;
            
            const validCookies = unique.filter(c => !c.expirationDate || c.expirationDate > now).map(c => ({
                name: c.name, value: c.value, domain: c.domain, path: c.path,
                secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: c.expirationDate
            }));
            
            if (validCookies.length === 0) {
                showToast('No cookies found', 'warning');
                return null;
            }
            
            const id = 'prof_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
            const profile = {
                id,
                name: `${currentTabDomain}_${new Date().toLocaleString('en', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}`,
                domain: tabInfo.domain,
                tags: ['auto'],
                cookieData: Compressor.compress(validCookies),
                storageType: currentStorageMode,
                created: Date.now(),
                updated: Date.now()
            };
            
            await dbPut(PROFILES_STORE, profile);
            
            if (cloudConnected && currentStorageMode !== 'local') {
                await CloudStorage.saveProfile(profile);
            }
            
            currentProfileId = id;
            await dbPut(SETTINGS_STORE, { key: 'activeProfile', value: id });
            updateUI();
            showToast(`Captured ${validCookies.length} cookies`);
            return profile;
        } catch(e) { 
            showToast('Capture failed', 'error'); 
            return null; 
        }
    }

    async function clearDomainCookies() {
        showConfirmModal('Clear Cookies', `Delete ALL cookies for <span class="highlight">${currentTabDomain}</span>?`, async () => {
            try {
                const cookies = await chrome.cookies.getAll({ domain: currentTabDomain });
                let deleted = 0;
                for (const c of cookies) {
                    try {
                        const protocol = c.secure ? 'https://' : 'http://';
                        await chrome.cookies.remove({ 
                            url: `${protocol}${c.domain.replace(/^\./, '')}${c.path}`, 
                            name: c.name 
                        });
                        deleted++;
                    } catch(e) {}
                }
                showToast(`Cleared ${deleted} cookies`);
            } catch(e) { showToast('Clear failed', 'error'); }
            hideConfirmModal();
        }, 'Delete All', true);
    }

    async function cleanupExpired() {
        showConfirmModal('Cleanup', 'Remove expired cookies from all profiles?', async () => {
            try {
                const profiles = await dbGetAll(PROFILES_STORE);
                const now = Date.now() / 1000;
                let cleaned = 0;
                
                for (const profile of profiles) {
                    const data = Compressor.decompress(profile.cookieData);
                    if (!Array.isArray(data)) continue;
                    const valid = data.filter(c => !c.expirationDate || c.expirationDate > now);
                    
                    if (valid.length === 0) { 
                        await dbDelete(PROFILES_STORE, profile.id);
                        if (cloudConnected && profile.storageType !== 'local') {
                            await CloudStorage.deleteProfile(profile.id);
                        }
                        cleaned++; 
                    } else if (valid.length < data.length) {
                        profile.cookieData = Compressor.compress(valid);
                        profile.updated = Date.now();
                        await dbPut(PROFILES_STORE, profile);
                        if (cloudConnected && profile.storageType !== 'local') {
                            await CloudStorage.saveProfile(profile);
                        }
                        cleaned++;
                    }
                }
                
                updateUI();
                showToast(`Cleaned ${cleaned} profiles`);
            } catch(e) { showToast('Cleanup failed', 'error'); }
            hideConfirmModal();
        });
    }

    async function saveProfileFromForm() {
        const name = dom.profileNameInput.value.trim();
        const domain = dom.profileDomainInput.value.trim();
        const tags = dom.profileTagsInput.value.split(',').map(t => t.trim()).filter(Boolean);
        const storageType = dom.profileStorageSelect.value;
        let cookieData = dom.cookieDataInput.value.trim();

        if (!name) { showToast('Name required', 'warning'); return; }
        
        if (cookieData) {
            if (cookieData.startsWith('[') || cookieData.startsWith('{')) {
                try { cookieData = JSON.parse(cookieData); } catch(e) { 
                    showToast('Invalid JSON', 'error'); 
                    return; 
                }
            }
        } else {
            cookieData = [];
        }

        const compressed = Compressor.compress(cookieData);

        try {
            if (profileFormMode === 'add') {
                const id = 'prof_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
                const profile = { 
                    id, name, 
                    domain: domain || currentTabDomain, 
                    tags, 
                    cookieData: compressed, 
                    storageType,
                    created: Date.now(), 
                    updated: Date.now() 
                };
                
                await dbPut(PROFILES_STORE, profile);
                
                if (cloudConnected && storageType !== 'local') {
                    await CloudStorage.saveProfile(profile);
                }
                
                currentProfileId = id;
                await dbPut(SETTINGS_STORE, { key: 'activeProfile', value: id });
                showToast(`Created (${storageType})`);
            } else if (profileFormMode === 'edit' && editProfileId) {
                const existing = await dbGet(PROFILES_STORE, editProfileId);
                if (!existing) { showToast('Not found', 'error'); return; }
                
                const updated = { 
                    ...existing, name, 
                    domain: domain || existing.domain, 
                    tags, 
                    cookieData: compressed, 
                    storageType,
                    updated: Date.now() 
                };
                
                await dbPut(PROFILES_STORE, updated);
                
                if (cloudConnected && storageType !== 'local') {
                    await CloudStorage.saveProfile(updated);
                }
                
                if (cloudConnected && storageType === 'local' && existing.storageType !== 'local') {
                    await CloudStorage.deleteProfile(editProfileId);
                }
                
                showToast('Updated');
            }
            hideProfileFormModal();
            updateUI();
        } catch(e) { showToast('Save failed', 'error'); }
    }

    async function deleteProfile(profileId) {
        const profile = await dbGet(PROFILES_STORE, profileId);
        if (!profile) return;
        
        showConfirmModal('Delete', `Delete "<span class="highlight">${escapeHtml(profile.name)}</span>"?`, async () => {
            await dbDelete(PROFILES_STORE, profileId);
            
            if (cloudConnected && profile.storageType !== 'local') {
                await CloudStorage.deleteProfile(profileId);
            }
            
            if (currentProfileId === profileId) {
                const remaining = await dbGetAll(PROFILES_STORE);
                const newActive = remaining[0]?.id || null;
                currentProfileId = newActive;
                await dbPut(SETTINGS_STORE, { key: 'activeProfile', value: newActive });
            }
            
            hideProfileFormModal();
            updateUI();
            showToast('Deleted');
            hideConfirmModal();
        }, 'Delete', true);
    }

    async function exportProfiles() {
        try {
            const profiles = await getFilteredProfiles();
            const data = {
                version: '2.0',
                exportedAt: Date.now(),
                profiles: profiles.map(p => ({ ...p, cookieData: Compressor.decompress(p.cookieData) })),
                activeProfileId: currentProfileId
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `cookie-vault-${new Date().toISOString().slice(0,10)}.json`;
            a.click();
            URL.revokeObjectURL(a.href);
            showToast('Exported successfully');
        } catch(e) { showToast('Export failed', 'error'); }
    }

    async function importProfiles(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.profiles?.length) { showToast('Invalid file', 'error'); return; }
            
            showConfirmModal('Import', `Import <span class="highlight">${data.profiles.length}</span> profiles?`, async () => {
                let count = 0;
                for (const p of data.profiles) {
                    const id = p.id || 'prof_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
                    const profile = { 
                        ...p, 
                        id, 
                        cookieData: Compressor.compress(p.cookieData), 
                        imported: Date.now(),
                        storageType: p.storageType || currentStorageMode
                    };
                    
                    await dbPut(PROFILES_STORE, profile);
                    
                    if (cloudConnected && profile.storageType !== 'local') {
                        await CloudStorage.saveProfile(profile);
                    }
                    
                    count++;
                }
                
                if (data.activeProfileId) {
                    const exists = await dbGet(PROFILES_STORE, data.activeProfileId);
                    if (exists) { 
                        currentProfileId = data.activeProfileId; 
                        await dbPut(SETTINGS_STORE, { key: 'activeProfile', value: data.activeProfileId }); 
                    }
                }
                
                updateUI();
                showToast(`Imported ${count} profiles`);
                hideConfirmModal();
            });
        } catch(e) { showToast('Parse failed', 'error'); }
    }

    // ============ CLOUD FUNCTIONS ============
    async function connectToFirebase(config) {
        try {
            await CloudStorage.initialize(config);
            firebaseConfig = config;
            await dbPut(SETTINGS_STORE, { key: 'firebaseConfig', value: config });
            updateCloudStatusUI();
            await updateUI();
            showToast('☁️ Connected to Firebase!', 'success');
            return true;
        } catch (error) {
            showToast('Failed to connect: ' + error.message, 'error');
            return false;
        }
    }

    async function disconnectFirebase() {
        await CloudStorage.disconnect();
        firebaseConfig = null;
        await dbDelete(SETTINGS_STORE, 'firebaseConfig');
        cloudConnected = false;
        updateCloudStatusUI();
        showToast('Disconnected from cloud', 'warning');
    }

    async function setStorageMode(mode) {
        if (mode === 'cloud' && !cloudConnected) {
            showToast('Please configure Firebase first', 'warning');
            return;
        }
        
        currentStorageMode = mode;
        settings.storageMode = mode;
        await dbPut(SETTINGS_STORE, { key: 'main', value: settings });
        
        if ((mode === 'cloud' || mode === 'hybrid') && cloudConnected) {
            await syncToCloud();
        }
        
        updateCloudStatusUI();
        await updateUI();
    }

    async function syncToCloud() {
        if (!cloudConnected) {
            showToast('Not connected to cloud', 'error');
            return;
        }

        dom.syncNowBtn.textContent = '⏳ Syncing...';
        dom.syncNowBtn.disabled = true;
        
        try {
            const localProfiles = await dbGetAll(PROFILES_STORE);
            const cloudProfiles = await CloudStorage.getAllProfiles();
            
            let syncedCount = 0;
            
            for (const localProfile of localProfiles) {
                if (localProfile.storageType !== 'local') {
                    await CloudStorage.saveProfile(localProfile);
                    syncedCount++;
                }
            }
            
            for (const cloudProfile of cloudProfiles) {
                const localExists = localProfiles.find(p => p.id === cloudProfile.id);
                if (!localExists) {
                    cloudProfile.storageType = cloudProfile.storageType || 'cloud';
                    await dbPut(PROFILES_STORE, cloudProfile);
                    syncedCount++;
                }
            }
            
            await updateUI();
            showToast(`Synced ${syncedCount} profiles`, 'success');
        } catch (error) {
            showToast('Sync failed: ' + error.message, 'error');
        } finally {
            dom.syncNowBtn.textContent = '🔄 Sync Now';
            dom.syncNowBtn.disabled = false;
        }
    }

    // ============ EVENT BINDING ============
    function bindEvents() {
        // Panel switching is handled by the inline script in HTML
        
        // View toggle
        dom.showDomainBtn.addEventListener('click', () => {
            currentViewMode = 'domain';
            dom.showDomainBtn.classList.add('active');
            dom.showGlobalBtn.classList.remove('active');
            updateUI();
        });
        
        dom.showGlobalBtn.addEventListener('click', () => {
            currentViewMode = 'global';
            dom.showGlobalBtn.classList.add('active');
            dom.showDomainBtn.classList.remove('active');
            updateUI();
        });

        // Search
        let searchTimer;
        dom.searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                searchQuery = dom.searchInput.value.trim();
                dom.clearSearchBtn.classList.toggle('visible', !!searchQuery);
                updateUI();
            }, 300);
        });
        
        dom.clearSearchBtn.addEventListener('click', () => { 
            dom.searchInput.value = ''; 
            searchQuery = ''; 
            dom.clearSearchBtn.classList.remove('visible'); 
            updateUI(); 
        });


        // Capture
        dom.captureCurrentBtn.addEventListener('click', captureCurrentCookies);
        dom.captureDashboardBtn.addEventListener('click', captureCurrentCookies);
        // Profile management
        dom.addProfileBtn.addEventListener('click', () => showProfileFormModal('add', null, 'local'));
        dom.addCloudProfileBtn.addEventListener('click', () => showProfileFormModal('add', null, 'cloud'));
        dom.clearDomainBtn.addEventListener('click', clearDomainCookies);
        dom.cleanupBtn.addEventListener('click', cleanupExpired);
        dom.cleanupSettingsBtn.addEventListener('click', cleanupExpired);

        // Import/Export
        dom.exportBtn.addEventListener('click', exportProfiles);
        dom.importBtn.addEventListener('click', () => dom.hiddenFileInput.click());
        dom.hiddenFileInput.addEventListener('change', (e) => {
            if (e.target.files[0]) importProfiles(e.target.files[0]);
            dom.hiddenFileInput.value = '';
        });

        // Cloud storage mode
        dom.localModeBtn.addEventListener('click', () => setStorageMode('local'));
        dom.cloudModeBtn.addEventListener('click', () => setStorageMode('cloud'));
        dom.hybridModeBtn.addEventListener('click', () => setStorageMode('hybrid'));
        dom.syncNowBtn.addEventListener('click', syncToCloud);
        
        // Firebase config
        dom.saveFirebaseConfigBtn.addEventListener('click', async () => {
            const config = {
                apiKey: dom.firebaseApiKey.value.trim(),
                projectId: dom.firebaseProjectId.value.trim(),
                authDomain: dom.firebaseAuthDomain.value.trim(),
                databaseURL: dom.firebaseDatabaseURL.value.trim(),
                appId: dom.firebaseAppId.value.trim(),
                email: dom.firebaseEmail.value.trim(),
                password: dom.firebasePassword.value
            };
            
            if (!config.apiKey || !config.projectId) {
                showToast('API Key and Project ID required', 'warning');
                return;
            }
            
            await connectToFirebase(config);
        });
        
        dom.clearFirebaseConfigBtn.addEventListener('click', async () => {
            await disconnectFirebase();
            dom.firebaseApiKey.value = '';
            dom.firebaseProjectId.value = '';
            dom.firebaseAuthDomain.value = '';
            dom.firebaseDatabaseURL.value = '';
            dom.firebaseAppId.value = '';
            dom.firebaseEmail.value = '';
            dom.firebasePassword.value = '';
        });

        // Settings
        dom.autoReloadCheckbox.addEventListener('change', async (e) => {
            settings.autoReload = e.target.checked;
            await dbPut(SETTINGS_STORE, { key: 'main', value: settings });
            showToast('Setting saved');
        });
        
        dom.compressionCheckbox.addEventListener('change', async (e) => {
            settings.compressionEnabled = e.target.checked;
            await dbPut(SETTINGS_STORE, { key: 'main', value: settings });
            showToast('Setting saved');
        });

        // Form modal buttons (delegated)
        dom.formModalFooter.addEventListener('click', (e) => {
            if (e.target.id === 'saveProfileBtn') saveProfileFromForm();
            if (e.target.id === 'deleteProfileBtn' && editProfileId) deleteProfile(editProfileId);
        });

        // Close modals
        document.addEventListener('click', (e) => {
            const target = e.target.closest('[data-close]');
            if (!target) return;
        
            const id = target.dataset.close;
            if (id === 'confirmModal') hideConfirmModal();
            if (id === 'profileFormModal') hideProfileFormModal();
        });

        // Confirm modal
        dom.confirmActionBtn.addEventListener('click', () => {
            if (confirmCallback) confirmCallback();
        });
        
        // Close modals on overlay click
        dom.confirmModal.addEventListener('click', (e) => { 
            if (e.target === dom.confirmModal) hideConfirmModal(); 
        });
        dom.profileFormModal.addEventListener('click', (e) => { 
            if (e.target === dom.profileFormModal) hideProfileFormModal(); 
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (dom.confirmModal.classList.contains('active')) hideConfirmModal();
                if (dom.profileFormModal.classList.contains('active')) hideProfileFormModal();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 's' && dom.profileFormModal.classList.contains('active')) {
                e.preventDefault();
                saveProfileFromForm();
            }
        });
    }

    // ============ INIT ============
    async function init() {
        try {
            await openDB();
            
            // Load settings
            const activeResult = await dbGet(SETTINGS_STORE, 'activeProfile');
            if (activeResult) currentProfileId = activeResult.value;
            
            const settingsResult = await dbGet(SETTINGS_STORE, 'main');
            if (settingsResult) {
                settings = { ...settings, ...settingsResult.value };
                dom.autoReloadCheckbox.checked = settings.autoReload;
                dom.compressionCheckbox.checked = settings.compressionEnabled;
            }
            
            currentStorageMode = settings.storageMode || 'local';
            
            // Load Firebase config
            const firebaseConfigResult = await dbGet(SETTINGS_STORE, 'firebaseConfig');
            if (firebaseConfigResult) {
                firebaseConfig = firebaseConfigResult.value;
                dom.firebaseApiKey.value = firebaseConfig.apiKey || '';
                dom.firebaseProjectId.value = firebaseConfig.projectId || '';
                dom.firebaseAuthDomain.value = firebaseConfig.authDomain || '';
                dom.firebaseDatabaseURL.value = firebaseConfig.databaseURL || '';
                dom.firebaseAppId.value = firebaseConfig.appId || '';
                dom.firebaseEmail.value = firebaseConfig.email || '';
                dom.firebasePassword.value = firebaseConfig.password || '';
                
                try {
                    await connectToFirebase(firebaseConfig);
                } catch (e) {
                    console.warn('Auto-connect to Firebase failed:', e);
                }
            }

            await getCurrentTabInfo();
            updateCloudStatusUI();
            await updateUI();
            bindEvents();
            
            console.log('🍪 Cookie Vault Pro initialized');
        } catch(e) { 
            console.error('Init failed:', e); 
            showToast('Init failed', 'error'); 
        }
    }

    init();
})();