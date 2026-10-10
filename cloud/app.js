import * as Auth from './auth.js';
import * as Cloud from './cloud-sync.js';

let currentUser = null;
let currentProfile = null;
let pendingPlaytimeSeconds = 0;
let flushTimer = null;

const qs = (id) => document.getElementById(id);

function showAuthModal(show) {
    qs('auth-modal')?.classList.toggle('active', show);
}

function setAuthError(msg) {
    const el = qs('auth-error');
    if (el) el.textContent = msg || '';
}

function showProfileModal(show) {
    qs('profile-modal')?.classList.toggle('active', show);
}

function displayLabel() {
    if (!currentUser) return 'Guest';
    return currentProfile?.display_name || currentUser.email.split('@')[0];
}

function refreshSidebarAuthRow() {
    const btn = qs('sidebar-auth-item');
    const label = qs('sidebar-auth-label');
    const avatar = qs('sidebar-avatar');
    const loginLabel = qs('sidebar-login-label');
    if (!btn || !label || !avatar) return;

    const name = displayLabel();
    label.textContent = name;
    avatar.textContent = name.charAt(0).toUpperCase();
    btn.classList.toggle('logged-in', !!currentUser);
    btn.title = currentUser ? 'View profile' : 'Log in';

    if (loginLabel) loginLabel.textContent = currentUser ? 'Log Out' : 'Log In';
}

async function handleSession(session) {
    currentUser = session?.user || null;
    if (currentUser) {
        try {
            currentProfile = await Auth.getProfile(currentUser.id);
        } catch (e) {
            currentProfile = null;
            console.warn('Could not load profile/role:', e.message);
        }
        showAuthModal(false);
        startPlaytimeFlushLoop();
    } else {
        currentProfile = null;
    }
    refreshSidebarAuthRow();
}

function wireAuthForm() {
    qs('auth-signup-btn')?.addEventListener('click', async () => {
        setAuthError('');
        const email = qs('auth-email').value.trim();
        const password = qs('auth-password').value;
        if (!email || !password) { setAuthError('Email and password are required.'); return; }
        try {
            await Auth.signUp(email, password);
            setAuthError('Account created. If email confirmation is on, check your inbox, then log in below.');
        } catch (e) {
            setAuthError(e.message);
        }
    });

    qs('auth-login-btn')?.addEventListener('click', async () => {
        setAuthError('');
        const email = qs('auth-email').value.trim();
        const password = qs('auth-password').value;
        if (!email || !password) { setAuthError('Email and password are required.'); return; }
        try {
            await Auth.signIn(email, password);
        } catch (e) {
            setAuthError(e.message);
        }
    });

    qs('sidebar-auth-item')?.addEventListener('click', () => {
        if (currentUser) {
            openProfileModal();
        } else {
            showAuthModal(true);
            qs('auth-email')?.focus();
        }
    });

    qs('sidebar-login-item')?.addEventListener('click', async () => {
        if (currentUser) {
            try { await Auth.signOut(); } catch (e) { console.warn(e.message); }
        } else {
            showAuthModal(true);
            qs('auth-email')?.focus();
        }
    });

    qs('profile-save-btn')?.addEventListener('click', async () => {
        if (!currentUser) return;
        const status = qs('profile-save-status');
        const name = qs('profile-name-input')?.value.trim() || '';
        try {
            await Cloud.updateDisplayName(currentUser.id, name);
            currentProfile = { ...(currentProfile || {}), display_name: name };
            refreshSidebarAuthRow();
            if (status) { status.textContent = 'Saved'; setTimeout(() => { status.textContent = ''; }, 1800); }
        } catch (e) {
            if (status) status.textContent = `Could not save: ${e.message}`;
        }
    });

    qs('profile-logout-btn')?.addEventListener('click', async () => {
        try { await Auth.signOut(); } catch (e) { console.warn(e.message); }
        showProfileModal(false);
    });
}

function formatHoursMinutes(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    if (hours <= 0 && minutes <= 0) return '0m';
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

async function openProfileModal() {
    if (!currentUser) return;

    qs('profile-avatar-big').textContent = displayLabel().charAt(0).toUpperCase();
    qs('profile-name-input').value = currentProfile?.display_name || '';
    qs('profile-email-text').textContent = currentUser.email;
    qs('profile-save-status').textContent = '';
    qs('profile-stat-total').textContent = '…';
    qs('profile-stat-month').textContent = '…';

    showProfileModal(true);

    try {
        const rows = await Cloud.fetchAllMonthlyPlaytime(currentUser.id);
        const totalSeconds = rows.reduce((sum, r) => sum + Number(r.seconds || 0), 0) + pendingPlaytimeSeconds;
        const thisKey = monthKey(new Date());
        const thisMonthRow = rows.find(r => r.year_month === thisKey);
        const thisMonthSeconds = Number(thisMonthRow?.seconds || 0) + pendingPlaytimeSeconds;

        qs('profile-stat-total').textContent = formatHoursMinutes(totalSeconds);
        qs('profile-stat-month').textContent = formatHoursMinutes(thisMonthSeconds);
    } catch (e) {
        qs('profile-stat-total').textContent = '—';
        qs('profile-stat-month').textContent = '—';
        console.warn('Could not load playtime stats:', e.message);
    }
}

async function init() {
    wireAuthForm();
    try {
        Auth.onAuthStateChange((session) => handleSession(session));
        const user = await Auth.getCurrentUser();
        await handleSession(user ? { user } : null);
    } catch (e) {
        console.warn('Cloud init failed:', e.message);
        refreshSidebarAuthRow();
    }
}

window.addEventListener('DOMContentLoaded', init);

function monthKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function playtimeStorageKey(key) { return `lt-playtime-${key}`; }

function addLocalPlaytime(seconds) {
    const key = monthKey(new Date());
    const storeKey = playtimeStorageKey(key);
    const current = Number(localStorage.getItem(storeKey) || 0);
    localStorage.setItem(storeKey, String(current + seconds));
}

function startPlaytimeFlushLoop() {
    if (flushTimer) return;
    flushTimer = setInterval(flushPendingPlaytime, 20000);
    window.addEventListener('beforeunload', flushPendingPlaytime);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushPendingPlaytime();
    });
}

async function flushPendingPlaytime() {
    if (!currentUser || pendingPlaytimeSeconds <= 0) return;
    const seconds = pendingPlaytimeSeconds;
    pendingPlaytimeSeconds = 0;
    try {
        await Cloud.addMonthlyPlaytime(currentUser.id, monthKey(new Date()), seconds);
    } catch (e) {
        pendingPlaytimeSeconds += seconds;
        console.warn('Playtime cloud sync failed:', e.message);
    }
}

function getMemorySummary() {
    const now = new Date();
    if (now.getDate() > 7) return null;
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const key = monthKey(prev);
    const seconds = Number(localStorage.getItem(playtimeStorageKey(key)) || 0);
    if (seconds <= 0) return null;
    return {
        yearMonth: key,
        label: prev.toLocaleString('en-US', { month: 'short' }),
        monthName: prev.toLocaleString('en-US', { month: 'long' }),
        seconds,
    };
}

window.LarpTrackCloud = {
    isLoggedIn: () => !!currentUser,

    syncTrack: async (track) => {
        if (!currentUser) return;
        try { await Cloud.upsertTrackMetadata(track, currentUser.id); }
        catch (e) { console.warn('Cloud sync (track) failed:', e.message); }
    },

    deleteTrack: async (trackId) => {
        if (!currentUser) return;
        try { await Cloud.deleteTrackCloud(trackId); }
        catch (e) { console.warn('Cloud sync (delete track) failed:', e.message); }
    },

    syncPlaylist: async (playlist) => {
        if (!currentUser) return;
        try {
            await Cloud.upsertPlaylist(playlist, currentUser.id);
            await Cloud.syncPlaylistTracks(playlist);
        } catch (e) { console.warn('Cloud sync (playlist) failed:', e.message); }
    },

    deletePlaylist: async (playlistId) => {
        if (!currentUser) return;
        try { await Cloud.deletePlaylistCloud(playlistId); }
        catch (e) { console.warn('Cloud sync (delete playlist) failed:', e.message); }
    },

    addPlaytime: (seconds) => {
        if (!(seconds > 0)) return;
        addLocalPlaytime(seconds);
        if (currentUser) pendingPlaytimeSeconds += seconds;
    },

    getMemorySummary,
};
