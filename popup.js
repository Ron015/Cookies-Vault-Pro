(function() {
    'use strict';

    // ============ INDEXEDDB ============
    const DB_NAME = 'RonCookieVaultDB';
    const DB_VERSION = 1;
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

    // ============ STATE ============
    let currentProfileId = null;
    let currentViewMode = 'domain';
    let currentTabDomain = '';
    let currentTabUrl = '';
    let currentTabId = null;
    let searchQuery = '';
    let settings = { autoReload: true, compressionEnabled: true, autoCleanupDays: 30 };

    // ============ DOM ============
    const $ = (sel) => document.querySelector(sel);
    const dom = {
        switchDropdown: $('#switchDropdown'),
        applySwitchBtn: $('#applySwitchBtn'),
        captureCurrentBtn: $('#captureCurrentBtn'),
        showDomainBtn: $('#showDomainBtn'),
        showGlobalBtn: $('#showGlobalBtn'),
        addProfileBtn: $('#addProfileBtn'),
        clearDomainBtn: $('#clearDomainBtn'),
        cleanupBtn: $('#cleanupBtn'),
        exportBtn: $('#exportBtn'),
        importBtn: $('#importBtn'),
        hiddenFileInput: $('#hiddenFileInput'),
        profilesListContainer: $('#profilesListContainer'),
        viewTitle: $('#viewTitle'),
        activeProfileName: $('#activeProfileName'),
        currentDomainBadge: $('#currentDomainBadge'),
        totalProfilesBadge: $('#totalProfilesBadge'),
        searchInput: $('#searchInput'),
        clearSearchBtn: $('#clearSearchBtn'),
        statusToast: $('#statusToast'),
        confirmModal: $('#confirmModal'),
        confirmTitle: $('#confirmTitle'),
        confirmIcon: $('#confirmIcon'),
        confirmMessage: $('#confirmMessage'),
        confirmActionBtn: $('#confirmActionBtn'),
        profileFormModal: $('#profileFormModal'),
        formModalTitle: $('#formModalTitle'),
        profileNameInput: $('#profileNameInput'),
        profileDomainInput: $('#profileDomainInput'),
        profileTagsInput: $('#profileTagsInput'),
        cookieDataInput: $('#cookieDataInput'),
        formModalFooter: $('#formModalFooter')
    };

    let confirmCallback = null;
    let profileFormMode = 'add';
    let editProfileId = null;

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

    // ============ MODALS ============
    function showConfirmModal(title, message, icon, callback, confirmText = 'Confirm', isDanger = false) {
        dom.confirmTitle.textContent = title;
        dom.confirmIcon.textContent = icon;
        dom.confirmMessage.innerHTML = message;
        confirmCallback = callback;
        dom.confirmActionBtn.textContent = confirmText;
        dom.confirmActionBtn.className = isDanger ? 'btn btn-delete' : 'btn btn-confirm';
        dom.confirmModal.classList.add('active');
    }

    function hideConfirmModal() { dom.confirmModal.classList.remove('active'); confirmCallback = null; }

    function showProfileFormModal(mode = 'add', profileData = null) {
        profileFormMode = mode;
        editProfileId = null;
        if (mode === 'add') {
            dom.formModalTitle.textContent = 'Create Profile';
            dom.profileNameInput.value = '';
            dom.profileDomainInput.value = currentTabDomain || '';
            dom.profileTagsInput.value = '';
            dom.cookieDataInput.value = '';
            dom.formModalFooter.innerHTML = `
                <button class="btn btn-cancel" data-close="profileFormModal">Cancel</button>
                <button class="btn btn-confirm" id="saveProfileBtn">Save</button>`;
        } else if (mode === 'edit' && profileData) {
            editProfileId = profileData.id;
            dom.formModalTitle.textContent = 'Edit Profile';
            dom.profileNameInput.value = profileData.name || '';
            dom.profileDomainInput.value = profileData.domain || '';
            dom.profileTagsInput.value = (profileData.tags || []).join(', ');
            dom.cookieDataInput.value = JSON.stringify(Compressor.decompress(profileData.cookieData) || '', null, 2);
            dom.formModalFooter.innerHTML = `
                <button class="btn btn-delete" id="deleteProfileBtn">Delete</button>
                <button class="btn btn-cancel" data-close="profileFormModal">Cancel</button>
                <button class="btn btn-confirm" id="saveProfileBtn">Update</button>`;
        }
        dom.profileFormModal.classList.add('active');
    }

    function hideProfileFormModal() {
        dom.profileFormModal.classList.remove('active');
        editProfileId = null;
    }

    function showToast(message, type = 'success') {
        dom.statusToast.textContent = message;
        dom.statusToast.className = 'toast ' + type;
        dom.statusToast.classList.add('show');
        setTimeout(() => dom.statusToast.classList.remove('show'), 3000);
    }

    // ============ CORE ============
    async function getCurrentTabInfo() {
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0]?.url) {
                currentTabUrl = tabs[0].url;
                currentTabId = tabs[0].id;
                currentTabDomain = new URL(currentTabUrl).hostname;
                dom.currentDomainBadge.textContent = currentTabDomain;
                return { url: currentTabUrl, domain: currentTabDomain, tabId: currentTabId };
            }
        } catch(e) {}
        dom.currentDomainBadge.textContent = 'unknown';
        return null;
    }

    async function getFilteredProfiles() {
        try {
            let profiles = await dbGetAll(PROFILES_STORE);
            if (currentViewMode === 'domain') profiles = profiles.filter(p => matchesDomain(p.domain, currentTabDomain));
            if (searchQuery) {
                const q = searchQuery.toLowerCase();
                profiles = profiles.filter(p =>
                    (p.name || '').toLowerCase().includes(q) ||
                    (p.domain || '').toLowerCase().includes(q) ||
                    (p.tags || []).some(t => t.toLowerCase().includes(q))
                );
            }
            return profiles;
        } catch(e) { return []; }
    }

    async function captureCurrentCookies() {
        const tabInfo = await getCurrentTabInfo();
        if (!tabInfo) { showToast('Cannot access tab', 'error'); return null; }
        try {
            const cookies = await chrome.cookies.getAll({ domain: tabInfo.domain });
            const allCookies = await chrome.cookies.getAll({ url: tabInfo.url });
            const unique = Array.from(new Map([...cookies, ...allCookies].map(c => [c.name + c.domain + c.path, c])).values());
            const now = Date.now() / 1000;
            return {
                domain: tabInfo.domain,
                cookies: unique.filter(c => !c.expirationDate || c.expirationDate > now).map(c => ({
                    name: c.name, value: c.value, domain: c.domain, path: c.path,
                    secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: c.expirationDate
                })),
                capturedAt: Date.now()
            };
        } catch(e) { showToast('Capture failed', 'error'); return null; }
    }

    async function applyCookieProfile(profileId) {
        try {
            const profile = await dbGet(PROFILES_STORE, profileId);
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

    async function clearDomainCookies() {
        showConfirmModal('Clear Cookies', `Delete ALL cookies for <span class="highlight">${currentTabDomain}</span>?`, '🗑️', async () => {
            try {
                const cookies = await chrome.cookies.getAll({ domain: currentTabDomain });
                let deleted = 0;
                for (const c of cookies) {
                    try {
                        const protocol = c.secure ? 'https://' : 'http://';
                        await chrome.cookies.remove({ url: `${protocol}${c.domain.replace(/^\./, '')}${c.path}`, name: c.name });
                        deleted++;
                    } catch(e) {}
                }
                showToast(`Cleared ${deleted} cookies`);
            } catch(e) { showToast('Clear failed', 'error'); }
            hideConfirmModal();
        }, 'Delete All', true);
    }

    async function cleanupExpired() {
        showConfirmModal('Cleanup', 'Remove expired cookies from all profiles?', '🧹', async () => {
            try {
                const profiles = await dbGetAll(PROFILES_STORE);
                const now = Date.now() / 1000;
                let cleaned = 0;
                for (const profile of profiles) {
                    const data = Compressor.decompress(profile.cookieData);
                    if (!Array.isArray(data)) continue;
                    const valid = data.filter(c => !c.expirationDate || c.expirationDate > now);
                    if (valid.length === 0) { await dbDelete(PROFILES_STORE, profile.id); cleaned++; }
                    else if (valid.length < data.length) {
                        profile.cookieData = Compressor.compress(valid);
                        profile.updated = Date.now();
                        await dbPut(PROFILES_STORE, profile);
                        cleaned++;
                    }
                }
                updateUI();
                showToast(`Cleaned ${cleaned} profiles`);
            } catch(e) { showToast('Cleanup failed', 'error'); }
            hideConfirmModal();
        });
    }

    async function exportProfiles() {
        try {
            const profiles = await dbGetAll(PROFILES_STORE);
            const data = {
                version: '1.0',
                exportedAt: Date.now(),
                profiles: profiles.map(p => ({ ...p, cookieData: Compressor.decompress(p.cookieData) })),
                activeProfileId: currentProfileId
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `cookies-${new Date().toISOString().slice(0,10)}.json`;
            a.click();
            URL.revokeObjectURL(a.href);
            showToast('Exported');
        } catch(e) { showToast('Export failed', 'error'); }
    }

    async function importProfiles(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.profiles?.length) { showToast('Invalid file', 'error'); return; }
            showConfirmModal('Import', `Import <span class="highlight">${data.profiles.length}</span> profiles?`, '📥', async () => {
                let count = 0;
                for (const p of data.profiles) {
                    const id = p.id || 'prof_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
                    await dbPut(PROFILES_STORE, { ...p, id, cookieData: Compressor.compress(p.cookieData), imported: Date.now() });
                    count++;
                }
                if (data.activeProfileId) {
                    const exists = await dbGet(PROFILES_STORE, data.activeProfileId);
                    if (exists) { currentProfileId = data.activeProfileId; await dbPut(SETTINGS_STORE, { key: 'activeProfile', value: data.activeProfileId }); }
                }
                updateUI();
                showToast(`Imported ${count}`);
                hideConfirmModal();
            });
        } catch(e) { showToast('Parse failed', 'error'); }
    }

    async function deleteProfile(profileId) {
        const profile = await dbGet(PROFILES_STORE, profileId);
        if (!profile) return;
        showConfirmModal('Delete', `Delete "<span class="highlight">${escapeHtml(profile.name)}</span>"?`, '⚠️', async () => {
            await dbDelete(PROFILES_STORE, profileId);
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

    async function saveProfileFromForm() {
        const name = dom.profileNameInput.value.trim();
        const domain = dom.profileDomainInput.value.trim();
        const tags = dom.profileTagsInput.value.split(',').map(t => t.trim()).filter(Boolean);
        let cookieData = dom.cookieDataInput.value.trim();

        if (!name) { showToast('Name required', 'warning'); return; }
        if (cookieData.startsWith('[') || cookieData.startsWith('{')) {
            try { cookieData = JSON.parse(cookieData); } catch(e) { showToast('Invalid JSON', 'error'); return; }
        }

        const compressed = Compressor.compress(cookieData);

        try {
            if (profileFormMode === 'add') {
                const id = 'prof_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
                await dbPut(PROFILES_STORE, { id, name, domain: domain || currentTabDomain, tags, cookieData: compressed, created: Date.now(), updated: Date.now() });
                currentProfileId = id;
                await dbPut(SETTINGS_STORE, { key: 'activeProfile', value: id });
                showToast('Created');
            } else if (profileFormMode === 'edit' && editProfileId) {
                const existing = await dbGet(PROFILES_STORE, editProfileId);
                if (!existing) { showToast('Not found', 'error'); return; }
                await dbPut(PROFILES_STORE, { ...existing, name, domain: domain || existing.domain, tags, cookieData: compressed, updated: Date.now() });
                showToast('Updated');
            }
            hideProfileFormModal();
            updateUI();
        } catch(e) { showToast('Save failed', 'error'); }
    }

    // ============ UI ============
    function updateSwitchDropdown(profiles) {
        dom.switchDropdown.innerHTML = '<option value="" disabled>— select —</option>';
        if (!profiles.length) { dom.switchDropdown.innerHTML += '<option disabled>📭 None</option>'; return; }
        profiles.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name} (${p.domain || '?'}) [${Compressor.getCookieCount(p.cookieData)}]`;
            if (currentProfileId === p.id) opt.selected = true;
            dom.switchDropdown.appendChild(opt);
        });
    }

    async function renderProfilesList() {
        try {
            const filtered = await getFilteredProfiles();
            const allProfiles = await dbGetAll(PROFILES_STORE);

            dom.viewTitle.textContent = currentViewMode === 'domain' ? `📋 ${currentTabDomain || 'Domain'}` : '📋 All Profiles';
            dom.totalProfilesBadge.textContent = `📦 ${allProfiles.length}`;

            if (!filtered.length) {
                dom.profilesListContainer.innerHTML = `<div class="empty-message">${searchQuery ? `No matches for "<span class="highlight">${escapeHtml(searchQuery)}</span>"` : '✨ No profiles yet'}</div>`;
                updateSwitchDropdown([]);
                dom.activeProfileName.textContent = 'none';
                return;
            }

            updateSwitchDropdown(filtered);

            dom.profilesListContainer.innerHTML = filtered.map(p => {
                const isActive = currentProfileId === p.id;
                return `
                <div class="profile-card ${isActive ? 'active-profile' : ''}" data-id="${p.id}">
                    <div class="profile-info" data-click-id="${p.id}">
                        <span class="profile-icon">${isActive ? '⭐' : '🍪'}</span>
                        <div class="profile-details">
                            <div class="profile-name">${escapeHtml(p.name)}</div>
                            <div class="profile-meta">
                                ${p.domain ? `<span class="badge badge-domain">🌐 ${escapeHtml(p.domain)}</span>` : ''}
                                <span class="badge badge-cookies">${Compressor.getCookieCount(p.cookieData)} cookies</span>
                                ${(p.tags || []).map(t => `<span class="badge badge-tag">#${escapeHtml(t)}</span>`).join('')}
                            </div>
                        </div>
                    </div>
                    <button class="manage-btn" data-manage="${p.id}">⚙️</button>
                </div>`;
            }).join('');

            dom.activeProfileName.textContent = filtered.find(p => p.id === currentProfileId)?.name || 'none';

            // Event binding
            dom.profilesListContainer.querySelectorAll('.profile-info').forEach(el => {
                el.addEventListener('click', () => applyCookieProfile(el.dataset.clickId));
            });
            dom.profilesListContainer.querySelectorAll('.manage-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const profile = await dbGet(PROFILES_STORE, btn.dataset.manage);
                    if (profile) showProfileFormModal('edit', profile);
                });
            });
        } catch(e) { dom.profilesListContainer.innerHTML = '<div class="empty-message">Error loading</div>'; }
    }

    async function updateUI() { await renderProfilesList(); }

    function switchView(mode) {
        currentViewMode = mode;
        dom.showDomainBtn.classList.toggle('active', mode === 'domain');
        dom.showGlobalBtn.classList.toggle('active', mode === 'global');
        updateUI();
    }

    function escapeHtml(s) { return String(s || '').replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m])); }

    // ============ EVENTS ============
    function bindEvents() {
        dom.showDomainBtn.addEventListener('click', () => switchView('domain'));
        dom.showGlobalBtn.addEventListener('click', () => switchView('global'));

        let searchTimer;
        dom.searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                searchQuery = dom.searchInput.value.trim();
                dom.clearSearchBtn.classList.toggle('visible', !!searchQuery);
                updateUI();
            }, 300);
        });
        dom.clearSearchBtn.addEventListener('click', () => { dom.searchInput.value = ''; searchQuery = ''; dom.clearSearchBtn.classList.remove('visible'); updateUI(); });

        dom.applySwitchBtn.addEventListener('click', () => {
            const id = dom.switchDropdown.value;
            id ? applyCookieProfile(id) : showToast('Select a profile', 'warning');
        });

        dom.captureCurrentBtn.addEventListener('click', async () => {
            const captured = await captureCurrentCookies();
            if (captured?.cookies.length) {
                const id = 'prof_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
                await dbPut(PROFILES_STORE, {
                    id, name: `${currentTabDomain}_${new Date().toLocaleString('en', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}`,
                    domain: captured.domain, tags: ['auto'], cookieData: Compressor.compress(captured.cookies),
                    created: Date.now(), updated: Date.now()
                });
                currentProfileId = id;
                await dbPut(SETTINGS_STORE, { key: 'activeProfile', value: id });
                updateUI();
                showToast(`Captured ${captured.cookies.length} cookies`);
            } else showToast('No cookies', 'warning');
        });

        dom.addProfileBtn.addEventListener('click', () => showProfileFormModal('add'));
        dom.clearDomainBtn.addEventListener('click', clearDomainCookies);
        dom.cleanupBtn.addEventListener('click', cleanupExpired);
        dom.exportBtn.addEventListener('click', exportProfiles);
        dom.importBtn.addEventListener('click', () => dom.hiddenFileInput.click());
        dom.hiddenFileInput.addEventListener('change', (e) => {
            if (e.target.files[0]) importProfiles(e.target.files[0]);
            dom.hiddenFileInput.value = '';
        });

        dom.formModalFooter.addEventListener('click', (e) => {
            if (e.target.id === 'saveProfileBtn') saveProfileFromForm();
            if (e.target.id === 'deleteProfileBtn' && editProfileId) deleteProfile(editProfileId);
        });

        document.addEventListener('click', (e) => {
            const target = e.target.closest('[data-close]');
            if (!target) return;
        
            const id = target.dataset.close;
            if (id === 'confirmModal') hideConfirmModal();
            if (id === 'profileFormModal') hideProfileFormModal();
        });

        dom.confirmActionBtn.addEventListener('click', () => confirmCallback?.());
        dom.confirmModal.addEventListener('click', (e) => { if (e.target === dom.confirmModal) hideConfirmModal(); });
        dom.profileFormModal.addEventListener('click', (e) => { if (e.target === dom.profileFormModal) hideProfileFormModal(); });

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
            const activeResult = await dbGet(SETTINGS_STORE, 'activeProfile');
            if (activeResult) currentProfileId = activeResult.value;
            const settingsResult = await dbGet(SETTINGS_STORE, 'main');
            if (settingsResult) settings = { ...settings, ...settingsResult.value };

            await getCurrentTabInfo();
            dom.showDomainBtn.classList.add('active');
            await updateUI();
            bindEvents();
        } catch(e) { console.error('Init failed:', e); showToast('Init failed', 'error'); }
    }

    init();
})();