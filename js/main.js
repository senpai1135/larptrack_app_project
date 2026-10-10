import * as DB from './db.js';
import * as Lyrics from './lyrics.js';
import * as Prefs from './preference.js';
import * as Viz from './visualizer.js';
import * as Waveform from './waveform.js';
import { initExtendedFeatures } from './features.js';

const getEl = (id) => document.getElementById(id);
const safeUpdate = (id, prop, val) => { const el = getEl(id); if (el) el[prop] = val; };
const on = (el, ev, fn, opts) => { if (el) el.addEventListener(ev, fn, opts); };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function lsGet(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; }
}
function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { }
}

const DEFAULT_COVER = "https://cdn-icons-png.flaticon.com/512/3844/3844724.png";
const BACKUP_COLORS = [
    '#FF5F15', '#00D4FF', '#E0115F', '#7C9D8E', '#00A6CB',
    '#EDA6C4', '#520E7D', '#FF007A', '#39FF14', '#FFCF00',
    '#4F738E', '#A020F0', '#1A5F7A', '#FF4500', '#00FFEF',
    '#863A6F', '#BFFF00', '#702963', '#40E0D0', '#FFD700',
    '#C0C0C0', '#E6E6FA', '#FF00FF', '#088F8F', '#FF3131'
];

const VIEW_PANEL_FOR = {
    library: 'tracklist', favorites: 'tracklist',
    'playlist-detail': 'tracklist', 'artist-detail': 'tracklist', 'album-detail': 'tracklist',
    playlists: 'playlists', artists: 'artists', albums: 'albums', settings: 'settings',
};
const NAV_HIGHLIGHT_FOR = {
    library: 'library', favorites: 'favorites',
    'playlist-detail': 'playlists', playlists: 'playlists',
    'artist-detail': 'artists', artists: 'artists',
    'album-detail': 'albums', albums: 'albums',
    settings: 'settings',
};

const state = {
    tracks: [],
    playlists: [],
    queueIds: [],
    currentId: null,
    view: 'library',
    trackMode: 'library',
    trackModeKey: null,
    search: '',
    sort: 'newest',
    shuffleOn: false,
    repeatOn: false,
    shuffleQueue: [],
    lyricsCtrl: null,
    lyricsOpen: false,
    eqOpen: false,
    playCountedForCurrent: false,
    isMuted: false,
    lastVolume: 1,
};

const audio = getEl('audio-track');
const progressBar = getEl('progress-bar');
const playerScreen = getEl('player-screen');

let currentPeaks = [];
let lastPlaytimeTickAt = null;
function renderWaveform() {
    const canvas = getEl('waveform-canvas');
    if (!canvas || !audio) return;
    const ratio = (audio.duration > 0) ? (audio.currentTime / audio.duration) : 0;
    Waveform.drawWaveform(canvas, currentPeaks, isNaN(ratio) ? 0 : ratio);
}
let waveformResizeRaf = null;
window.addEventListener('resize', () => {
    if (waveformResizeRaf) return;
    waveformResizeRaf = requestAnimationFrame(() => { waveformResizeRaf = null; renderWaveform(); });
});

let layoutStyleDrawer = null;
let graphicsQualityDrawer = null;
let sortDrawer = null;

let toastTimer;
function showToast(msg) {
    const t = getEl('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function formatTime(s) {
    if (isNaN(s) || s === Infinity || s < 0) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

function compareStrings(str1, str2) {
    const s1 = (str1 || '').toLowerCase().replace(/\s/g, '');
    const s2 = (str2 || '').toLowerCase().replace(/\s/g, '');
    if (!s1 || !s2) return 0;
    if (s1.includes(s2) || s2.includes(s1)) return 0.9;
    return 0;
}

function getAverageRGB(imgUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        let done = false;
        let timer = null;
        const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
        timer = setTimeout(() => finish("#333"), 8000);
        img.src = imgUrl;
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = 10; canvas.height = 10;
                ctx.drawImage(img, 0, 0, 10, 10);
                const data = ctx.getImageData(0, 0, 10, 10).data;
                let r = 0, g = 0, b = 0;
                for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
                const n = data.length / 4;
                r = Math.floor(r / n); g = Math.floor(g / n); b = Math.floor(b / n);
                finish("#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1));
            } catch (e) { finish("#333"); }
        };
        img.onerror = () => finish("#333");
    });
}

function findTrack(id) { return state.tracks.find(t => t.id === id); }

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(str) {
    return (str == null ? '' : String(str)).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

const INLINE_COVER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1c1c22"/>' +
    '<path fill="#6b6b78" d="M26 16v24.2a8 8 0 1 0 4 6.8V24h14v-8H26z"/></svg>');
document.addEventListener('error', (e) => {
    const t = e.target;
    if (!t || t.tagName !== 'IMG') return;
    if (t.dataset.fb === '2') return;
    if (t.dataset.fb === '1' || t.src === DEFAULT_COVER) { t.dataset.fb = '2'; t.src = INLINE_COVER; return; }
    t.dataset.fb = '1';
    t.src = DEFAULT_COVER;
}, true);
document.addEventListener('load', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.dataset.fb) delete t.dataset.fb;
}, true);

async function fetchJson(url, ms = 7000) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
    try {
        const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally { if (timer) clearTimeout(timer); }
}

const pendingSaves = new Map();
let pendingSaveTimer = null;
function scheduleTrackSave(track, delay = 2500) {
    if (!track || track.id == null) return;
    pendingSaves.set(track.id, track);
    if (pendingSaveTimer !== null) return;
    pendingSaveTimer = setTimeout(() => {
        pendingSaveTimer = null;
        const run = () => flushTrackSaves();
        if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 4000 }); else run();
    }, delay);
}
async function flushTrackSaves() {
    if (pendingSaveTimer !== null) { clearTimeout(pendingSaveTimer); pendingSaveTimer = null; }
    const batch = Array.from(pendingSaves.values());
    pendingSaves.clear();
    for (const t of batch) {
        if (!findTrack(t.id)) continue;
        try { await DB.putTrack(t); } catch (e) { console.warn('Deferred save failed:', e && e.message); }
        await new Promise((r) => setTimeout(r, 0));
    }
}
window.addEventListener('pagehide', () => { flushTrackSaves(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushTrackSaves(); });

const objectUrlCache = new Map();
async function resolvePlayableSrc(track) {
    const f = track.file || '';
    if (typeof f !== 'string' || !f.startsWith('data:')) return f;
    const hit = objectUrlCache.get(track.id);
    if (hit && hit.file === f) { objectUrlCache.delete(track.id); objectUrlCache.set(track.id, hit); return hit.url; }
    try {
        const blob = await (await fetch(f)).blob();
        const url = URL.createObjectURL(blob);
        objectUrlCache.set(track.id, { url, file: f });
        while (objectUrlCache.size > 3) {
            const oldestKey = objectUrlCache.keys().next().value;
            try { URL.revokeObjectURL(objectUrlCache.get(oldestKey).url); } catch (e) {}
            objectUrlCache.delete(oldestKey);
        }
        return url;
    } catch (e) {
        return f;
    }
}
function forgetPlayableSrc(trackId) {
    const hit = objectUrlCache.get(trackId);
    if (hit) { try { URL.revokeObjectURL(hit.url); } catch (e) {} objectUrlCache.delete(trackId); }
}


async function loadAllData() {
    await DB.openDB();

    const seededFlag = lsGet('lt-seeded-static');
    if (!seededFlag && typeof window.songs !== 'undefined' && window.songs.length) {
        for (let i = 0; i < window.songs.length; i++) {
            const s = window.songs[i];
            await DB.putTrack({
                id: `static_${i}`,
                name: s.name || 'Untitled',
                author: s.author || 'Unknown Artist',
                album: s.album || '',
                file: s.file || '',
                cover: s.cover || '',
                color: s.color || BACKUP_COLORS[i % BACKUP_COLORS.length],
                healed: !!s.cover,
                favorite: false,
                lrc: s.lrc || '',
                addedAt: Date.now() - (window.songs.length - i) * 1000,
                durationSec: null,
                playCount: 0,
                openCount: 0,
            });
        }
        lsSet('lt-seeded-static', '1');
    }

    state.tracks = await DB.getAllTracks();
    state.playlists = await DB.getAllPlaylists();

    let needsBackfill = false;
    state.tracks.forEach(t => {
        if (typeof t.playCount !== 'number') { t.playCount = 0; needsBackfill = true; }
        if (typeof t.openCount !== 'number') { t.openCount = 0; needsBackfill = true; }
        if (typeof t.addedAt !== 'number') { t.addedAt = 0; needsBackfill = true; }
        if (typeof t.durationSec === 'undefined') { t.durationSec = null; needsBackfill = true; }
        if (typeof t.album !== 'string') { t.album = ''; needsBackfill = true; }
    });
    if (needsBackfill) {
        for (const t of state.tracks) { try { await DB.putTrack(t); } catch (e) { } }
    }
}

function filterAndSort(tracks) {
    let list = tracks.slice();

    const q = state.search.trim().toLowerCase();
    if (q) {
        list = list.filter(t =>
            (t.name || '').toLowerCase().includes(q) ||
            (t.author || '').toLowerCase().includes(q) ||
            (t.album || '').toLowerCase().includes(q)
        );
    }

    switch (state.sort) {
        case 'plays':
            list.sort((a, b) => (b.playCount || 0) - (a.playCount || 0));
            break;
        case 'alpha':
            list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            break;
        case 'duration':
            list.sort((a, b) => (b.durationSec || 0) - (a.durationSec || 0));
            break;
        case 'newest':
        default:
            list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
            break;
    }
    return list;
}

function getArtistGroups() {
    const map = new Map();
    state.tracks.forEach(t => {
        const key = t.author || 'Unknown Artist';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(t);
    });
    return [...map.entries()].map(([name, tracks]) => ({ key: name, tracks })).sort((a, b) => a.key.localeCompare(b.key));
}

function getAlbumGroups() {
    const map = new Map();
    state.tracks.forEach(t => {
        const key = (t.album && t.album.trim()) ? t.album.trim() : null;
        if (!key) return;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(t);
    });
    return [...map.entries()].map(([name, tracks]) => ({ key: name, tracks })).sort((a, b) => a.key.localeCompare(b.key));
}

function buildTrackRow(track, displayIndex, queueIds, opts = {}) {
    const div = document.createElement('div');
    div.className = 'song-item';
    div.dataset.id = track.id;
    if (track.id === state.currentId) div.classList.add('active-song');

    const cover = (track.cover && track.cover.trim()) ? track.cover : DEFAULT_COVER;
    const showLyricsChip = Lyrics.hasSyncedLyrics(track);
    const durationLabel = track.durationSec ? formatTime(track.durationSec) : '—';

    div.innerHTML = `
        <span class="song-index">${String(displayIndex + 1).padStart(2, '0')}</span>
        <img src="${escapeHtml(cover)}" alt="cover" loading="lazy" decoding="async">
        <div class="song-info">
            <div class="song-info-title-row">
                <h4>${escapeHtml(track.name || 'Untitled')}</h4>
                ${showLyricsChip ? `<span class="lyrics-chip">Lyrics</span>` : ''}
            </div>
            <p>${escapeHtml(track.author || 'Unknown Artist')}</p>
        </div>
        <span class="song-album">${escapeHtml(track.album || '—')}</span>
        <span class="song-plays">${(track.playCount || 0)} plays</span>
        <span class="song-duration">${durationLabel}</span>
        <button class="row-icon-btn fav-toggle ${track.favorite ? 'is-fav' : ''}" title="Favorite" type="button">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="${track.favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.6l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z"/></svg>
        </button>
        <div class="more-menu-anchor">
            <button class="row-icon-btn more-toggle" title="More" type="button"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>
            <div class="row-menu">
                <button data-act="info" type="button"><svg class="row-menu-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M12 11v5.25"/><circle cx="12" cy="8" r="0.75" fill="currentColor" stroke="none"/></svg><span class="row-menu-label">Track details</span></button>
                <button data-act="add-playlist" type="button"><svg class="row-menu-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" d="M12 4.5v15m7.5-7.5h-15"/></svg><span class="row-menu-label">Add to playlist</span></button>
                <button data-act="edit-info" type="button"><svg class="row-menu-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.86 4.49l1.69-1.69a1.875 1.875 0 112.65 2.65L10.58 16.07a4.5 4.5 0 01-1.9 1.13L6 18l.8-2.69a4.5 4.5 0 011.13-1.9l8.93-8.92z"/><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 13.5V18a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 18V7.5A2.25 2.25 0 016.75 5.25h4.5"/></svg><span class="row-menu-label">Edit info</span></button>
                ${opts.playlistId ? `<button data-act="remove-from-playlist" type="button"><svg class="row-menu-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" d="M4.5 12h15"/></svg><span class="row-menu-label">Remove from this playlist</span></button>` : ''}
                ${opts.deletable ? `<button data-act="delete" class="danger" type="button"><svg class="row-menu-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg><span class="row-menu-label">Delete track</span></button>` : ''}
            </div>
        </div>
    `;

    div.addEventListener('click', (e) => {
        if (e.target.closest('.row-icon-btn') || e.target.closest('.row-menu')) return;
        state.queueIds = queueIds;
        selectSong(track.id, true);
        togglePlayer(true);
    });

    div.querySelector('.fav-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(track.id);
    });

    const moreBtn = div.querySelector('.more-toggle');
    const menu = div.querySelector('.row-menu');
    moreBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const willOpen = !menu.classList.contains('open');
        closeAllRowMenus();
        if (willOpen) {
            openRowMenu(menu, moreBtn);
            div.classList.add('menu-active');
        }
    });

    menu.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeRowMenu(menu);
            div.classList.remove('menu-active');
            const act = btn.dataset.act;
            if (act === 'info') openTrackInfoSheet(track.id);
            if (act === 'add-playlist') openPlaylistPicker(track.id);
            if (act === 'edit-info') openTrackEditModal(track.id);
            if (act === 'remove-from-playlist') removeTrackFromPlaylist(opts.playlistId, track.id);
            if (act === 'delete') deleteTrack(track.id);
        });
    });

    return div;
}

window.__ltCloseRowMenu = closeRowMenu;
window.__ltRepositionRowMenu = openRowMenu;

const openMenus = new Set();
function closeAllRowMenus() {
    if (!openMenus.size) return;
    Array.from(openMenus).forEach(closeRowMenu);
    document.querySelectorAll('.song-item.menu-active').forEach(el => el.classList.remove('menu-active'));
}
document.addEventListener('click', closeAllRowMenus);
window.addEventListener('resize', closeAllRowMenus);
window.addEventListener('scroll', (e) => {
    if (!openMenus.size) return;
    if (e.target && e.target.nodeType === 1 && e.target.closest && e.target.closest('.row-menu.open')) return;
    closeAllRowMenus();
}, true);

const rowMenuHomes = new WeakMap();

function openRowMenu(menu, triggerBtn) {
    if (!rowMenuHomes.has(menu)) {
        rowMenuHomes.set(menu, { parent: menu.parentElement, next: menu.nextSibling });
    }

    menu.classList.remove('flip-up', 'no-caret');
    menu.style.visibility = 'hidden';
    menu.style.position = 'fixed';
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
    menu.style.zIndex = 'var(--z-menu-portal)';
    document.body.appendChild(menu);
    menu.classList.add('open');
    openMenus.add(menu);

    const btnRect = triggerBtn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const gutter = 8;
    const margin = 10;
    const miniPlayer = getEl('mini-player');
    const bottomLimit = (miniPlayer && miniPlayer.style.display !== 'none' && getComputedStyle(miniPlayer).display !== 'none')
        ? miniPlayer.getBoundingClientRect().top
        : window.innerHeight;

    const naturalLeft = btnRect.right - menuRect.width;
    let left = Math.max(gutter, Math.min(naturalLeft, window.innerWidth - menuRect.width - gutter));

    let top = btnRect.bottom + margin;
    let flipped = false;
    if (top + menuRect.height > bottomLimit - gutter) {
        const above = btnRect.top - margin - menuRect.height;
        if (above >= gutter) {
            top = above;
            flipped = true;
        } else {
            top = Math.max(gutter, bottomLimit - menuRect.height - gutter);
        }
    }

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.classList.toggle('flip-up', flipped);
    if (Math.round(left) !== Math.round(naturalLeft)) menu.classList.add('no-caret');
    menu.style.visibility = '';
}

function closeRowMenu(menu) {
    openMenus.delete(menu);
    menu.classList.remove('open', 'flip-up', 'no-caret');
    menu.style.position = '';
    menu.style.left = '';
    menu.style.top = '';
    menu.style.right = '';
    menu.style.bottom = '';
    menu.style.zIndex = '';
    menu.style.visibility = '';
    const home = rowMenuHomes.get(menu);
    if (!home || !home.parent) return;
    if (home.next && home.next.parentElement === home.parent) {
        home.parent.insertBefore(menu, home.next);
    } else {
        home.parent.appendChild(menu);
    }
}

const openDrawers = new Map();

function initDrawerSelect(rootId, onSelect, { portal = false } = {}) {
    const root = getEl(rootId);
    if (!root) return null;
    const trigger = root.querySelector('.drawer-trigger');
    const panel = root.querySelector('.drawer-panel');
    const labelEl = trigger?.querySelector('span');
    if (!trigger || !panel) return null;

    function close() {
        root.classList.remove('open');
        panel.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
        openDrawers.delete(root);
        if (portal) {
            root.appendChild(panel);
            panel.style.position = '';
            panel.style.top = '';
            panel.style.bottom = '';
            panel.style.left = '';
            panel.style.right = '';
            panel.style.width = '';
            panel.style.zIndex = '';
        }
    }
    function open() {
        openDrawers.forEach((closeFn) => closeFn());
        openDrawers.clear();

        if (portal) {
            const rect = root.getBoundingClientRect();
            panel.style.position = 'fixed';
            panel.style.zIndex = 'var(--z-menu-portal)';
            panel.style.left = `${Math.round(rect.left)}px`;
            panel.style.right = 'auto';
            panel.style.width = `${Math.round(rect.width)}px`;
            document.body.appendChild(panel);

            const needed = Math.min(panel.scrollHeight, 320) + 12;
            const spaceBelow = window.innerHeight - rect.bottom - 8;
            if (spaceBelow < needed && rect.top > spaceBelow) {
                panel.style.top = 'auto';
                panel.style.bottom = `${Math.round(window.innerHeight - rect.top + 6)}px`;
            } else {
                panel.style.bottom = 'auto';
                panel.style.top = `${Math.round(rect.bottom + 6)}px`;
            }
        }

        root.classList.add('open');
        panel.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
        openDrawers.set(root, close);
    }

    on(trigger, 'click', (e) => {
        e.stopPropagation();
        root.classList.contains('open') ? close() : open();
    });

    function selectOption(opt, { silent = false } = {}) {
        panel.querySelectorAll('.drawer-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        if (labelEl) labelEl.textContent = opt.textContent;
        if (!silent) onSelect(opt.dataset.value);
    }

    panel.querySelectorAll('.drawer-option').forEach(opt => {
        on(opt, 'click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectOption(opt);
            close();
        });
    });

    return {
        setValue(value) {
            const opt = panel.querySelector(`.drawer-option[data-value="${value}"]`);
            if (opt) selectOption(opt, { silent: true });
        },
    };
}

document.addEventListener('click', () => {
    openDrawers.forEach((closeFn) => closeFn());
    openDrawers.clear();
});

function getTracklistSource() {
    switch (state.trackMode) {
        case 'favorites':
            return { tracks: state.tracks.filter(t => t.favorite), title: 'Favorites', showBack: false, showDelete: false };
        case 'playlist': {
            const pl = state.playlists.find(p => p.id === state.trackModeKey);
            const tracks = pl ? pl.trackIds.map(findTrack).filter(Boolean) : [];
            return { tracks, title: pl ? pl.name : 'Playlist', showBack: true, backTo: 'playlists', showDelete: true, playlistId: pl?.id };
        }
        case 'artist': {
            const group = getArtistGroups().find(g => g.key === state.trackModeKey);
            return { tracks: group ? group.tracks : [], title: state.trackModeKey || 'Artist', showBack: true, backTo: 'artists', showDelete: false };
        }
        case 'album': {
            const group = getAlbumGroups().find(g => g.key === state.trackModeKey);
            return { tracks: group ? group.tracks : [], title: state.trackModeKey || 'Album', showBack: true, backTo: 'albums', showDelete: false };
        }
        case 'library':
        default:
            return { tracks: state.tracks, title: 'Library', showBack: false, showDelete: false };
    }
}

function renderTracklist() {
    const src = getTracklistSource();
    const container = getEl('song-list-container');
    const empty = getEl('empty-state-tracklist');
    const count = getEl('track-count');
    const heading = getEl('tracklist-heading');
    const backLink = getEl('tracklist-back');
    const deleteBtn = getEl('tracklist-delete-btn');
    if (!container) return;

    const filtered = filterAndSort(src.tracks);
    const ids = filtered.map(t => t.id);

    container.innerHTML = '';
    const railNode = buildRecentlyPlayedRailNode();
    if (railNode) container.appendChild(railNode);
    container.appendChild(count);
    count.textContent = `${filtered.length} track${filtered.length !== 1 ? 's' : ''}`;

    backLink.style.display = src.showBack ? 'inline-flex' : 'none';
    if (src.showBack) {
        heading.style.display = 'flex';
        getEl('tracklist-heading-title').textContent = src.title;
        deleteBtn.style.display = src.showDelete ? 'inline-flex' : 'none';
    } else {
        heading.style.display = 'none';
    }

    const isSearching = !!state.search.trim();
    if (!filtered.length) {
        container.style.display = 'none';
        empty.style.display = 'flex';
        if (isSearching) {
            getEl('empty-label-tracklist').textContent = 'No matches';
            getEl('empty-sub-tracklist').innerHTML = `Nothing found for "${escapeHtml(state.search)}"`;
        } else if (state.trackMode === 'favorites') {
            getEl('empty-label-tracklist').textContent = 'No favorites yet';
            getEl('empty-sub-tracklist').innerHTML = 'Tap the heart on a track to save it here';
        } else if (state.trackMode === 'playlist') {
            getEl('empty-label-tracklist').textContent = 'This playlist is empty';
            getEl('empty-sub-tracklist').innerHTML = 'Use "Add to playlist" on any track';
        } else if (state.trackMode === 'artist' || state.trackMode === 'album') {
            getEl('empty-label-tracklist').textContent = 'No tracks found';
            getEl('empty-sub-tracklist').innerHTML = 'Nothing here yet';
        } else {
            getEl('empty-label-tracklist').textContent = 'No tracks yet';
            getEl('empty-sub-tracklist').innerHTML = 'Tap "Sync Music" to add songs<br>from your device';
        }
    } else {
        empty.style.display = 'none';
        container.style.display = '';
        const deletable = state.trackMode !== 'playlist';
        const frag = document.createDocumentFragment();
        filtered.forEach((t, i) => frag.appendChild(buildTrackRow(t, i, ids, {
            deletable,
            playlistId: src.playlistId,
        })));
        container.appendChild(frag);
    }
    updateScrollableGuard();
    setTimeout(updateScrollableGuard, 350);
}

function renderPlaylistsGrid() {
    const grid = getEl('playlists-grid');
    const empty = getEl('empty-state-playlists');
    if (!grid) return;

    grid.innerHTML = '';
    empty.style.display = state.playlists.length ? 'none' : 'flex';

    state.playlists.forEach(pl => {
        const card = document.createElement('div');
        card.className = 'playlist-card';
        const covers = pl.trackIds.slice(0, 4).map(id => {
            const t = findTrack(id);
            return (t && t.cover && t.cover.trim()) ? t.cover : DEFAULT_COVER;
        });
        card.innerHTML = `
            <div class="card-cover-grid">
                ${covers.length ? covers.map(c => `<img src="${escapeHtml(c)}" alt="" loading="lazy" decoding="async">`).join('') : `<div class="card-cover-empty"><svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M9 3v10.55A4 4 0 108 17V7h8V3H9z"/></svg></div>`}
            </div>
            <h4>${escapeHtml(pl.name)}</h4>
            <p>${pl.trackIds.length} track${pl.trackIds.length !== 1 ? 's' : ''}</p>
        `;
        card.addEventListener('click', () => { state.trackModeKey = pl.id; switchView('playlist-detail'); });
        grid.appendChild(card);
    });
}

function renderTaxonomyGrid(kind) {
    const grid = getEl(`${kind}-grid`);
    const empty = getEl(`empty-state-${kind}`);
    if (!grid) return;

    const groups = kind === 'artists' ? getArtistGroups() : getAlbumGroups();
    grid.innerHTML = '';
    empty.style.display = groups.length ? 'none' : 'flex';

    groups.forEach(g => {
        const card = document.createElement('div');
        card.className = 'taxonomy-card';
        const covers = g.tracks.slice(0, 4).map(t => (t.cover && t.cover.trim()) ? t.cover : DEFAULT_COVER);
        card.innerHTML = `
            <div class="card-cover-grid">
                ${covers.length ? covers.map(c => `<img src="${escapeHtml(c)}" alt="" loading="lazy" decoding="async">`).join('') : `<div class="card-cover-empty"><svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M9 3v10.55A4 4 0 108 17V7h8V3H9z"/></svg></div>`}
            </div>
            <h4>${escapeHtml(g.key)}</h4>
            <p>${g.tracks.length} track${g.tracks.length !== 1 ? 's' : ''}</p>
        `;
        card.addEventListener('click', () => {
            state.trackModeKey = g.key;
            switchView(kind === 'artists' ? 'artist-detail' : 'album-detail');
        });
        grid.appendChild(card);
    });
}

const VIEW_TITLES = { library: 'Library', favorites: 'Favorites', playlists: 'Playlists', artists: 'Artists', albums: 'Albums', settings: 'Settings' };

function switchView(view) {
    state.view = view;

    if (view === 'library' || view === 'favorites') state.trackMode = view;
    if (view === 'playlist-detail') state.trackMode = 'playlist';
    if (view === 'artist-detail') state.trackMode = 'artist';
    if (view === 'album-detail') state.trackMode = 'album';

    const panel = VIEW_PANEL_FOR[view] || 'tracklist';
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    getEl(`view-${panel}`)?.classList.add('active');
    document.body.classList.toggle('settings-view-active', panel === 'settings');
    const navToggle = getEl('nav-toggle');
    if (navToggle) {
        navToggle.classList.toggle('back-mode', panel === 'settings');
        navToggle.setAttribute('aria-label', panel === 'settings' ? 'Back' : 'Open menu');
    }

    const titleText = ['playlist-detail', 'artist-detail', 'album-detail'].includes(view)
        ? getTracklistSource().title
        : VIEW_TITLES[view];
    document.title = `${titleText} — LarpTrack`;

    const highlight = NAV_HIGHLIGHT_FOR[view] || view;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === highlight));

    getEl('new-playlist-btn').style.display = view === 'playlists' ? 'inline-flex' : 'none';
    getEl('list-toolbar').style.display = panel === 'tracklist' ? 'flex' : 'none';
    getEl('search-toggle-btn').style.display = panel === 'tracklist' ? 'flex' : 'none';
    getEl('search-drawer')?.classList.remove('open');
    getEl('quick-nav-scroll').style.display = panel === 'settings' ? 'none' : 'flex';

    syncHeaderStackHeight();

    const miniPlayer = getEl('mini-player');
    if (miniPlayer) {
        miniPlayer.style.display = (panel === 'settings' || !state.currentId) ? 'none' : 'flex';
    }

    if (panel === 'tracklist') renderTracklist();
    else if (panel === 'playlists') renderPlaylistsGrid();
    else if (panel === 'artists') renderTaxonomyGrid('artists');
    else if (panel === 'albums') renderTaxonomyGrid('albums');
    else if (panel === 'settings') syncSettingsControls();

    closeSidebar();
}

let hasEnoughScrollableContent = false;
const MIN_SCROLLABLE = 200;

function updateScrollableGuard() {
    const scrollEl = getEl('song-list-container');
    hasEnoughScrollableContent = !!scrollEl && (scrollEl.scrollHeight - scrollEl.clientHeight) >= MIN_SCROLLABLE;
    if (!hasEnoughScrollableContent) getEl('header-stack')?.classList.remove('header-hidden');
}
window.addEventListener('resize', () => updateScrollableGuard());

function initHeaderAutoHide() {
    const scrollEl = getEl('song-list-container');
    const stack = getEl('header-stack');
    if (!scrollEl || !stack) return;
    const THRESHOLD = 140;
    let anchorY = 0;
    scrollEl.addEventListener('scroll', () => {
        if (!hasEnoughScrollableContent) { anchorY = 0; return; }
        const y = scrollEl.scrollTop;
        if (y <= 8) { stack.classList.remove('header-hidden'); anchorY = y; return; }
        if (y - anchorY > THRESHOLD) { stack.classList.add('header-hidden'); anchorY = y; }
        else if (anchorY - y > THRESHOLD) { stack.classList.remove('header-hidden'); anchorY = y; }
    }, { passive: true });
}

function syncHeaderStackHeight() {
    const stack = getEl('header-stack');
    if (!stack) return;
    const wasHidden = stack.classList.contains('header-hidden');
    if (wasHidden) stack.classList.remove('header-hidden');
    stack.style.setProperty('--header-stack-h', stack.scrollHeight + 'px');
    if (wasHidden) stack.classList.add('header-hidden');
    updateScrollableGuard();
    setTimeout(updateScrollableGuard, 350);
}

const RECENTLY_PLAYED_KEY = 'lt-recently-played';
const RECENTLY_PLAYED_MAX = 20;

function loadRecentlyPlayedLog() {
    try {
        const raw = localStorage.getItem(RECENTLY_PLAYED_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
}

function recordRecentlyPlayed(track) {
    if (!track) return;
    const entry = { id: track.id, name: track.name || 'Untitled', author: track.author || 'Unknown Artist', cover: track.cover || '', at: Date.now() };
    const list = loadRecentlyPlayedLog().filter((e) => e.id !== track.id);
    list.unshift(entry);
    try { localStorage.setItem(RECENTLY_PLAYED_KEY, JSON.stringify(list.slice(0, RECENTLY_PLAYED_MAX))); } catch (e) {}
}

function buildRecentlyPlayedRailNode() {
    if (state.view !== 'library' || state.search.trim()) return null;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const entries = loadRecentlyPlayedLog().filter((e) => e && e.at >= cutoff && findTrack(e.id));
    if (!entries.length) return null;

    const rail = document.createElement('div');
    rail.className = 'rail-section';
    rail.innerHTML = `
        <h3 class="rail-title">Recently Played</h3>
        <div class="rail-scroll">${entries.map((entry) => {
            const cover = (entry.cover && entry.cover.trim()) ? entry.cover : DEFAULT_COVER;
            return `
                <div class="rail-card" data-id="${escapeHtml(entry.id)}">
                    <img src="${escapeHtml(cover)}" alt="" loading="lazy" decoding="async">
                    <div class="rail-card-title">${escapeHtml(entry.name)}</div>
                    <div class="rail-card-artist">${escapeHtml(entry.author)}</div>
                </div>`;
        }).join('')}</div>
    `;
    rail.querySelectorAll('.rail-card').forEach((card) => {
        card.addEventListener('click', () => {
            if (findTrack(card.dataset.id)) selectSong(card.dataset.id, true);
        });
    });
    return rail;
}

function refreshRecentlyPlayedRailInList() {
    const container = getEl('song-list-container');
    if (!container) return;
    const existing = container.querySelector('.rail-section');
    if (existing) existing.remove();
    const railNode = buildRecentlyPlayedRailNode();
    if (railNode) container.insertBefore(railNode, container.firstChild);
    syncHeaderStackHeight();
}

function refreshCurrentView() {
    const panel = VIEW_PANEL_FOR[state.view] || 'tracklist';
    if (panel === 'tracklist') renderTracklist();
    else if (panel === 'playlists') renderPlaylistsGrid();
    else if (panel === 'artists') renderTaxonomyGrid('artists');
    else if (panel === 'albums') renderTaxonomyGrid('albums');
}

function isSidebarOpen() { return getEl('sidebar').classList.contains('open'); }

function openSidebar() {
    getEl('sidebar').classList.add('open');
    getEl('sidebar-overlay').classList.add('show');
    getEl('nav-toggle')?.classList.add('active');
}
function closeSidebar(force = false) {
    if (force || window.matchMedia('(max-width: 1023px)').matches) {
        getEl('sidebar').classList.remove('open');
        getEl('sidebar-overlay').classList.remove('show');
        getEl('nav-toggle')?.classList.remove('active');
    }
}
function toggleSidebar() { isSidebarOpen() ? closeSidebar(true) : openSidebar(); }

let selectToken = 0;
let peaksTimer = null;

async function selectSong(id, shouldPlay = false) {
    const track = findTrack(id);
    if (!track || !audio) return;
    const token = ++selectToken;

    state.currentId = id;
    state.playCountedForCurrent = false;
    lastPlaytimeTickAt = null;
    lsSet('lt-last-played', String(id));

    try { audio.pause(); } catch (e) {}

    const mini = getEl('mini-player');
    if (mini) mini.style.display = 'flex';

    safeUpdate('full-title', 'textContent', track.name || "Untitled Track");
    safeUpdate('mini-title', 'textContent', track.name || "Untitled Track");
    safeUpdate('full-artist', 'textContent', track.author || "Unknown Artist");
    safeUpdate('mini-artist', 'textContent', track.author || "Unknown Artist");
    safeUpdate('duration', 'textContent', track.durationSec ? formatTime(track.durationSec) : "0:00");

    if (progressBar) { progressBar.value = 0; progressBar.style.background = ''; }

    currentPeaks = new Array(72).fill(0.15);
    renderWaveform();
    clearTimeout(peaksTimer);
    peaksTimer = setTimeout(() => {
        if (token !== selectToken) return;
        Promise.resolve(Waveform.getPeaks(track)).then((peaks) => {
            if (token === selectToken && Array.isArray(peaks) && peaks.length) { currentPeaks = peaks; renderWaveform(); }
        }).catch((e) => console.warn('Waveform failed:', e && e.message));
    }, 500);

    const cover = (track.cover && track.cover.trim()) ? track.cover : DEFAULT_COVER;
    safeUpdate('full-art', 'src', cover);
    safeUpdate('mini-art', 'src', cover);

    const idx = state.tracks.findIndex(t => t.id === id);
    document.documentElement.style.setProperty('--primary-color', track.color || BACKUP_COLORS[Math.max(0, idx) % BACKUP_COLORS.length]);

    updateFavButtons(track.favorite);
    mountLyricsForCurrentTrack();

    document.querySelectorAll('.song-item').forEach(el => el.classList.toggle('active-song', el.dataset.id === String(id)));

    track.openCount = (track.openCount || 0) + 1;
    scheduleTrackSave(track);

    const src = await resolvePlayableSrc(track);
    if (token !== selectToken) return;

    audio.src = src || "";
    try { audio.load(); } catch (e) { }
    if (shouldPlay) {
        ensureAudioGraph();
        audio.play().then(() => updatePlayButtons(true)).catch(() => updatePlayButtons(false));
        recordRecentlyPlayed(track);
        refreshRecentlyPlayedRailInList();
    } else {
        updatePlayButtons(false);
    }
}

const PLAY_ICON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86A1 1 0 008 5.14z"/></svg>';
const PAUSE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

function updateFavButtons(isFav) {
    getEl('fav-btn')?.classList.toggle('on', !!isFav);
    const favPath = getEl('fav-btn')?.querySelector('svg path');
    if (favPath) favPath.setAttribute('fill', isFav ? 'currentColor' : 'none');
    getEl('mini-fav')?.classList.toggle('on', !!isFav);
}

let lastPlayUiState = null;
function updatePlayButtons(isPlaying) {
    isPlaying = !!isPlaying;
    if (lastPlayUiState === isPlaying) return;
    lastPlayUiState = isPlaying;
    const icon = isPlaying ? PAUSE_ICON_SVG : PLAY_ICON_SVG;
    safeUpdate('master-play', 'innerHTML', icon);
    safeUpdate('mini-play', 'innerHTML', icon);
    getEl('mini-equalizer')?.classList.toggle('active', isPlaying);
    getEl('full-art')?.classList.toggle('playing', isPlaying);
}

function ensureAudioGraph() {
    if (!audio) return;
    Viz.ensureAudioGraph(audio);
    if (!window.__ltVizInit) { window.__ltVizInit = true; syncEqControls(); }
}
['pointerdown', 'touchend', 'keydown'].forEach((evt) => {
    const unlock = () => {
        ensureAudioGraph();
        if (Viz.isAudioGraphReady()) document.removeEventListener(evt, unlock, true);
    };
    document.addEventListener(evt, unlock, { capture: true, passive: true });
});

function handlePlay() {
    if (!audio) return;
    ensureAudioGraph();
    if (!audio.src || audio.src === window.location.href) return;

    if (audio.paused) {
        audio.play().then(() => updatePlayButtons(true)).catch(() => {});
    } else {
        audio.pause();
        updatePlayButtons(false);
    }
}

function currentQueue() {
    const live = state.queueIds.filter(id => findTrack(id));
    return live.length ? live : state.tracks.map(t => t.id);
}

function nextSong() {
    const queue = currentQueue();
    if (!queue.length) return;

    if (state.shuffleOn) {
        state.shuffleQueue = state.shuffleQueue.filter(id => findTrack(id));
        if (!state.shuffleQueue.length) buildShuffleQueue(queue);
        const id = state.shuffleQueue.shift() ?? state.currentId ?? queue[0];
        if (!state.shuffleQueue.length) buildShuffleQueue(queue);
        selectSong(id, true);
        return;
    }

    const i = queue.indexOf(state.currentId);
    const nextId = queue[(i + 1 + queue.length) % queue.length];
    selectSong(nextId, true);
}

function prevSong() {
    if (audio && audio.currentTime > 3) { audio.currentTime = 0; return; }
    const queue = currentQueue();
    if (!queue.length) return;
    const i = queue.indexOf(state.currentId);
    const prevId = queue[(i - 1 + queue.length) % queue.length];
    selectSong(prevId, true);
}

function buildShuffleQueue(queue) {
    state.shuffleQueue = queue.filter(id => id !== state.currentId);
    for (let i = state.shuffleQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.shuffleQueue[i], state.shuffleQueue[j]] = [state.shuffleQueue[j], state.shuffleQueue[i]];
    }
}

function toggleShuffle() {
    state.shuffleOn = !state.shuffleOn;
    getEl('shuffle-btn').classList.toggle('on', state.shuffleOn);
    if (state.shuffleOn) buildShuffleQueue(currentQueue());
    showToast(state.shuffleOn ? 'Shuffle On' : 'Shuffle Off');
}

function toggleRepeat() {
    state.repeatOn = !state.repeatOn;
    getEl('repeat-btn').classList.toggle('on', state.repeatOn);
    showToast(state.repeatOn ? 'Repeat On' : 'Repeat Off');
}

function toggleMute() {
    if (!audio) return;
    if (!state.isMuted) {
        state.lastVolume = audio.volume;
        audio.muted = true;
        state.isMuted = true;
        showToast('Muted');
    } else {
        audio.muted = false;
        state.isMuted = false;
        showToast('Unmuted');
    }
}

function seekBy(deltaSeconds) {
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + deltaSeconds));
}

function togglePlayer(show) {
    playerScreen.classList.toggle('active', show);
    if (show) {
        requestAnimationFrame(renderWaveform);
    } else {
        state.lyricsOpen = false;
        state.eqOpen = false;
        playerScreen.classList.remove('lyrics-open', 'eq-open');
        const row = document.querySelector(`.song-item[data-id="${state.currentId}"]`);
        if (row) setTimeout(() => row.scrollIntoView({ behavior: 'smooth', block: 'center' }), 260);
    }
}

function updateRowPlayCount(track) {
    document.querySelectorAll('.song-item').forEach((el) => {
        if (el.dataset.id !== String(track.id)) return;
        const span = el.querySelector('.song-plays');
        if (span) span.textContent = `${track.playCount || 0} plays`;
    });
}

if (audio) {
    audio.addEventListener('loadedmetadata', () => {
        const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
        safeUpdate('duration', 'textContent', formatTime(dur));
        if (progressBar) progressBar.max = dur > 0 ? dur : 0;

        const track = findTrack(state.currentId);
        if (track && dur > 0 && track.durationSec !== Math.round(dur)) {
            track.durationSec = Math.round(dur);
            scheduleTrackSave(track);
        }
    });

    audio.addEventListener('timeupdate', () => {
        safeUpdate('current-time', 'textContent', formatTime(audio.currentTime));
        if (progressBar && Number.isFinite(audio.duration) && audio.duration > 0) {
            progressBar.value = audio.currentTime;
        }

        const nowWall = Date.now();
        if (lastPlaytimeTickAt != null && !audio.paused) {
            const deltaSec = (nowWall - lastPlaytimeTickAt) / 1000;
            if (deltaSec > 0 && deltaSec < 2) window.LarpTrackCloud?.addPlaytime(deltaSec);
        }
        lastPlaytimeTickAt = nowWall;
        if (playerScreen && playerScreen.classList.contains('active')) renderWaveform();

        if (!state.playCountedForCurrent && audio.duration) {
            const threshold = Math.min(30, audio.duration * 0.5);
            if (audio.currentTime >= threshold) {
                state.playCountedForCurrent = true;
                const track = findTrack(state.currentId);
                if (track) {
                    track.playCount = (track.playCount || 0) + 1;
                    scheduleTrackSave(track);
                    updateRowPlayCount(track);
                }
            }
        }
    });

    audio.addEventListener('play', () => { updatePlayButtons(true); Viz.resumeAudioContext(); });
    audio.addEventListener('pause', () => { updatePlayButtons(false); lastPlaytimeTickAt = null; });
    audio.addEventListener('error', () => {
        const attr = audio.getAttribute('src');
        if (!attr || attr === window.location.href) return;
        showToast("Can't play this track");
        updatePlayButtons(false);
    });

    on(progressBar, 'input', () => {
        const v = Number(progressBar.value);
        if (Number.isFinite(v)) audio.currentTime = v;
        if (playerScreen && playerScreen.classList.contains('active')) renderWaveform();
    });

    audio.onended = () => {
        if (state.repeatOn) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
        nextSong();
    };
}

async function toggleFavorite(id) {
    const track = findTrack(id);
    if (!track) return;
    track.favorite = !track.favorite;
    try {
        await DB.putTrack(track);
    } catch (e) {
        showToast('Could not save favorite — storage error');
        track.favorite = !track.favorite;
        return;
    }
    window.LarpTrackCloud?.syncTrack(track);
    if (id === state.currentId) updateFavButtons(track.favorite);
    if (state.trackMode === 'favorites' && state.view === 'favorites') {
        refreshCurrentView();
    } else {
        document.querySelectorAll('.song-item').forEach((el) => {
            if (el.dataset.id !== String(id)) return;
            const btn = el.querySelector('.fav-toggle');
            if (!btn) return;
            btn.classList.toggle('is-fav', !!track.favorite);
            btn.querySelector('svg')?.setAttribute('fill', track.favorite ? 'currentColor' : 'none');
        });
    }
    showToast(track.favorite ? 'Added to Favorites' : 'Removed from Favorites');
}

async function createPlaylist(name) {
    if (!name || !name.trim()) return null;
    const pl = { id: DB.makeId('pl'), name: name.trim(), trackIds: [] };
    try {
        await DB.putPlaylist(pl);
    } catch (e) {
        showToast('Could not create playlist — storage error');
        return null;
    }
    state.playlists.push(pl);
    window.LarpTrackCloud?.syncPlaylist(pl);
    return pl;
}

async function addTrackToPlaylist(playlistId, trackId) {
    const pl = state.playlists.find(p => p.id === playlistId);
    if (!pl) return;
    if (pl.trackIds.includes(trackId)) { showToast('Already in playlist'); return; }
    pl.trackIds.push(trackId);
    try {
        await DB.putPlaylist(pl);
    } catch (e) {
        pl.trackIds.pop();
        showToast('Could not update playlist — storage error');
        return;
    }
    window.LarpTrackCloud?.syncPlaylist(pl);
    refreshCurrentView();
    showToast(`Added to "${pl.name}"`);
}

async function removeTrackFromPlaylist(playlistId, trackId) {
    const pl = state.playlists.find(p => p.id === playlistId);
    if (!pl) return;
    const prev = pl.trackIds.slice();
    pl.trackIds = pl.trackIds.filter(id => id !== trackId);
    try {
        await DB.putPlaylist(pl);
    } catch (e) {
        pl.trackIds = prev;
        showToast('Could not update playlist — storage error');
        return;
    }
    window.LarpTrackCloud?.syncPlaylist(pl);
    refreshCurrentView();
    showToast('Removed from playlist');
}

async function deletePlaylistById(playlistId) {
    if (!await confirmDialog('Tracks stay in your library.', { title: 'Delete this playlist?', confirmLabel: 'Delete Playlist' })) return;
    try {
        await DB.deletePlaylist(playlistId);
    } catch (e) {
        showToast('Could not delete playlist — storage error');
        return;
    }
    state.playlists = state.playlists.filter(p => p.id !== playlistId);
    window.LarpTrackCloud?.deletePlaylist(playlistId);
    switchView('playlists');
    showToast('Playlist deleted');
}

function openPlaylistPicker(trackId) {
    const modal = getEl('playlist-picker-modal');
    modal.dataset.trackId = trackId;
    renderPlaylistPickerList(trackId);
    openModal('playlist-picker-modal');
}

function renderPlaylistPickerList(trackId) {
    const list = getEl('playlist-picker-list');
    list.innerHTML = '';
    if (!state.playlists.length) {
        list.innerHTML = `<p class="modal-hint">No playlists yet — create one above.</p>`;
        return;
    }
    state.playlists.forEach(pl => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'playlist-pick-row';
        const already = pl.trackIds.includes(trackId);
        row.innerHTML = `<span>${escapeHtml(pl.name)}</span><span class="pick-count">${already ? 'Added ✓' : pl.trackIds.length + ' tracks'}</span>`;
        row.disabled = already;
        row.addEventListener('click', async () => {
            await addTrackToPlaylist(pl.id, trackId);
            renderPlaylistPickerList(trackId);
        });
        list.appendChild(row);
    });
}

function openTrackEditModal(trackId) {
    const track = findTrack(trackId);
    if (!track) return;
    const modal = getEl('track-edit-modal');
    modal.dataset.trackId = trackId;
    getEl('edit-title').value = track.name || '';
    getEl('edit-artist').value = track.author || '';
    getEl('edit-album').value = track.album || '';
    getEl('edit-cover-url').value = '';
    getEl('edit-cover-preview').src = (track.cover && track.cover.trim()) ? track.cover : DEFAULT_COVER;
    openModal('track-edit-modal');
}

async function saveTrackEdit() {
    const modal = getEl('track-edit-modal');
    const trackId = modal.dataset.trackId;
    const track = findTrack(trackId);
    if (!track) return;

    track.name = getEl('edit-title').value.trim() || track.name;
    track.author = getEl('edit-artist').value.trim() || track.author;
    track.album = getEl('edit-album').value.trim();

    const url = getEl('edit-cover-url').value.trim();
    const previewSrc = getEl('edit-cover-preview').src;
    if (url) {
        track.cover = url;
        track.color = await getAverageRGB(url);
    } else if (previewSrc && previewSrc.startsWith('data:')) {
        track.cover = previewSrc;
        track.color = await getAverageRGB(previewSrc);
    }

    try {
        await DB.putTrack(track);
    } catch (e) {
        showToast(`Could not save changes: ${e.message}`);
        return;
    }
    window.LarpTrackCloud?.syncTrack(track);

    closeModal('track-edit-modal');
    refreshCurrentView();

    if (trackId === state.currentId) {
        safeUpdate('full-title', 'textContent', track.name);
        safeUpdate('mini-title', 'textContent', track.name);
        safeUpdate('full-artist', 'textContent', track.author);
        safeUpdate('mini-artist', 'textContent', track.author);
        const cover = (track.cover && track.cover.trim()) ? track.cover : DEFAULT_COVER;
        safeUpdate('full-art', 'src', cover);
        safeUpdate('mini-art', 'src', cover);
        document.documentElement.style.setProperty('--primary-color', track.color);
    }
    showToast('Track info updated');
}

async function deleteTrack(trackId) {
    const track = findTrack(trackId);
    if (!track) return;
    if (!await confirmDialog(`"${track.name}" will be removed from your library.`, { title: 'Delete this track?', confirmLabel: 'Delete Track' })) return;

    try {
        await DB.deleteTrack(trackId);
    } catch (e) {
        showToast(`Could not delete track: ${e.message}`);
        return;
    }
    window.LarpTrackCloud?.deleteTrack(trackId);
    state.tracks = state.tracks.filter(t => t.id !== trackId);
    state.playlists.forEach(pl => { pl.trackIds = pl.trackIds.filter(id => id !== trackId); });
    state.queueIds = state.queueIds.filter(id => id !== trackId);
    state.shuffleQueue = state.shuffleQueue.filter(id => id !== trackId);
    pendingSaves.delete(trackId);
    forgetPlayableSrc(trackId);

    if (trackId === state.currentId) {
        selectToken++;
        try { audio.pause(); } catch (e) {}
        audio.removeAttribute('src');
        try { audio.load(); } catch (e) {}
        state.currentId = null;
        state.lyricsCtrl?.destroy();
        state.lyricsCtrl = null;
        currentPeaks = [];
        updatePlayButtons(false);
        togglePlayer(false);
        const mini = getEl('mini-player');
        if (mini) mini.style.display = 'none';
        try { localStorage.removeItem('lt-last-played'); } catch (e) {}
    }
    refreshCurrentView();
    showToast('Track deleted');
}

function openTrackInfoSheet(trackId) {
    const track = findTrack(trackId);
    if (!track) return;
    const modal = getEl('track-info-modal');
    modal.dataset.trackId = trackId;

    getEl('info-cover').src = (track.cover && track.cover.trim()) ? track.cover : DEFAULT_COVER;
    getEl('info-title').textContent = track.name || 'Untitled';
    getEl('info-artist').textContent = track.author || 'Unknown Artist';
    getEl('info-album').textContent = track.album || '—';
    getEl('info-duration').textContent = track.durationSec ? formatTime(track.durationSec) : '—';
    getEl('info-playcount').textContent = track.playCount || 0;
    getEl('info-opencount').textContent = track.openCount || 0;
    getEl('info-lyrics').textContent = Lyrics.hasSyncedLyrics(track) ? 'Synced ✓' : 'Not added';

    openModal('track-info-modal');
}

function mountLyricsForCurrentTrack() {
    state.lyricsCtrl?.destroy();
    const track = findTrack(state.currentId);
    const container = getEl('lyrics-scroll');
    if (!track || !container) return;
    state.lyricsCtrl = Lyrics.mountSyncedLyrics(container, audio, track.lrc || '');
}

function toggleLyricsPanel(show) {
    state.lyricsOpen = show ?? !state.lyricsOpen;
    if (state.lyricsOpen) { state.eqOpen = false; playerScreen.classList.remove('eq-open'); }
    playerScreen.classList.toggle('lyrics-open', state.lyricsOpen);
}

function openLrcEditor() {
    const track = findTrack(state.currentId);
    if (!track) { showToast('Select a song first'); return; }
    getEl('lrc-editor-modal').dataset.trackId = track.id;
    getEl('lrc-textarea').value = track.lrc || '';
    openModal('lrc-editor-modal');
}

async function saveLrc() {
    const modal = getEl('lrc-editor-modal');
    const track = findTrack(modal.dataset.trackId);
    if (!track) return;
    track.lrc = getEl('lrc-textarea').value;
    try {
        await DB.putTrack(track);
    } catch (e) {
        showToast(`Could not save lyrics: ${e.message}`);
        return;
    }
    window.LarpTrackCloud?.syncTrack(track);
    closeModal('lrc-editor-modal');
    if (track.id === state.currentId) mountLyricsForCurrentTrack();
    refreshCurrentView();
    showToast('Lyrics saved');
}

function toggleEqPanel(show) {
    state.eqOpen = show ?? !state.eqOpen;
    if (state.eqOpen) { ensureAudioGraph(); state.lyricsOpen = false; playerScreen.classList.remove('lyrics-open'); }
    playerScreen.classList.toggle('eq-open', state.eqOpen);
}

const EQ_CURVE = { left: 20, right: 320, top: 30, bottom: 140 };
function eqDbToY(db) {
    const mid = (EQ_CURVE.top + EQ_CURVE.bottom) / 2;
    const half = mid - EQ_CURVE.top;
    return mid - (clamp(db, -12, 12) / 12) * half;
}
function eqYToDb(y) {
    const mid = (EQ_CURVE.top + EQ_CURVE.bottom) / 2;
    const half = mid - EQ_CURVE.top;
    return clamp(((mid - y) / half) * 12, -12, 12);
}
function eqBandX(i, count) {
    return EQ_CURVE.left + i * (EQ_CURVE.right - EQ_CURVE.left) / (count - 1);
}
function eqSmoothPath(points) {
    if (points.length < 2) return '';
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i], p1 = points[i + 1];
        d += ` Q ${p0.x} ${p0.y} ${(p0.x + p1.x) / 2} ${(p0.y + p1.y) / 2}`;
    }
    const last = points[points.length - 1];
    d += ` L ${last.x} ${last.y}`;
    return d;
}

let eqCurvePoints = [];
let eqPresetDrawer = null;
let eqDials = {};

function buildEqCurve() {
    const svg = getEl('eq-curve-svg');
    const group = getEl('eq-curve-points');
    if (!svg || !group || eqCurvePoints.length) return;
    const bands = Viz.EQ_BANDS;
    const SVG_NS = 'http://www.w3.org/2000/svg';

    eqCurvePoints = bands.map((freq, i) => {
        const x = eqBandX(i, bands.length);
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('class', 'eq-curve-point');
        circle.setAttribute('r', '6');
        circle.setAttribute('cx', String(x));
        circle.setAttribute('tabindex', '0');
        circle.setAttribute('role', 'slider');
        circle.setAttribute('aria-label', `${freq >= 1000 ? freq / 1000 + 'kHz' : freq + 'Hz'} band gain`);

        const label = document.createElementNS(SVG_NS, 'text');
        label.setAttribute('class', 'eq-curve-point-label');
        label.setAttribute('x', String(x));

        group.appendChild(circle);
        group.appendChild(label);

        let dragging = false;
        function dbFromClientY(clientY) {
            const ctm = svg.getScreenCTM();
            if (!ctm) return eqYToDb(0);
            const pt = svg.createSVGPoint();
            pt.x = 0; pt.y = clientY;
            return eqYToDb(pt.matrixTransform(ctm.inverse()).y);
        }
        function onMove(e) {
            if (!dragging) return;
            e.preventDefault();
            Viz.setBandGain(i, dbFromClientY(e.clientY));
            syncEqCurve();
            syncEqPresetLabel();
        }
        function onUp() {
            dragging = false;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        }
        circle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dragging = true;
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        });
        circle.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            const cur = Viz.getBandGains()[i];
            Viz.setBandGain(i, cur + (e.key === 'ArrowUp' ? 1 : -1));
            syncEqCurve();
            syncEqPresetLabel();
        });

        return { circle, label };
    });

    const freqRow = getEl('eq-freq-labels');
    if (freqRow) freqRow.innerHTML = bands.map((f) => `<span>${f >= 1000 ? f / 1000 + 'k' : f}</span>`).join('');
}

function syncEqCurve() {
    const bands = Viz.EQ_BANDS;
    const gains = Viz.getBandGains();
    const pts = bands.map((freq, i) => ({ x: eqBandX(i, bands.length), y: eqDbToY(gains[i]) }));

    eqCurvePoints.forEach((p, i) => {
        p.circle.setAttribute('cy', String(pts[i].y));
        p.circle.setAttribute('aria-valuenow', gains[i].toFixed(1));
        p.label.setAttribute('y', String(pts[i].y - 10));
        p.label.textContent = gains[i] > 0 ? `+${gains[i].toFixed(1)}` : gains[i].toFixed(1);
    });

    const linePath = eqSmoothPath(pts);
    const baseline = (EQ_CURVE.top + EQ_CURVE.bottom) / 2;
    getEl('eq-curve-line')?.setAttribute('d', linePath);
    getEl('eq-curve-fill')?.setAttribute('d', `${linePath} L ${pts[pts.length - 1].x} ${baseline} L ${pts[0].x} ${baseline} Z`);
}

function syncEqPresetLabel() {
    const active = Viz.getActivePreset();
    if (active === 'custom' || !eqPresetDrawer) {
        safeUpdate('eq-preset-label', 'textContent', 'Custom');
        document.querySelectorAll('#eq-preset-drawer .drawer-option').forEach((o) => o.classList.remove('selected'));
    } else {
        eqPresetDrawer.setValue(active);
    }
}

function eqAngleFromCenter(cx, cy, px, py) {
    let deg = Math.atan2(py - cy, px - cx) * 180 / Math.PI;
    if (deg < 0) deg += 360;
    return deg;
}
function eqAngleToPercent(deg, prev = 0) {
    let rel = deg - 135;
    if (rel < 0) rel += 360;
    if (rel <= 270) return clamp((rel / 270) * 100, 0, 100);
    return prev >= 50 ? 100 : 0;
}

function wireEqDial(name, { getState, setAmount, setEnabled }) {
    const dial = document.querySelector(`.eq-dial[data-dial="${name}"]`);
    const gauge = dial?.querySelector('.eq-dial-gauge');
    const svgEl = dial?.querySelector('.eq-dial-svg');
    const fillPath = getEl(`eq-dial-fill-${name}`);
    const valueEl = getEl(`eq-dial-value-${name}`);
    const toggle = getEl(`eq-toggle-${name}`);
    if (!dial || !gauge || !svgEl || !fillPath || !valueEl || !toggle) return null;

    let measuredArc = 0;
    function getArcLength() {
        if (!measuredArc) {
            try { measuredArc = fillPath.getTotalLength() || 0; } catch (e) { measuredArc = 0; }
        }
        return measuredArc || (2 * Math.PI * 40 * 0.75);
    }
    fillPath.style.strokeDasharray = String(getArcLength());

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const thumb = document.createElementNS(SVG_NS, 'circle');
    thumb.setAttribute('class', 'eq-dial-thumb');
    thumb.setAttribute('r', '8');
    svgEl.appendChild(thumb);
    function placeThumb(pct) {
        const rad = (135 + (clamp(pct, 0, 100) / 100) * 270) * Math.PI / 180;
        thumb.setAttribute('cx', (50 + 40 * Math.cos(rad)).toFixed(2));
        thumb.setAttribute('cy', (50 + 40 * Math.sin(rad)).toFixed(2));
    }

    function render() {
        const s = getState();
        valueEl.textContent = `${Math.round(s.amount)}%`;
        const arcLength = getArcLength();
        fillPath.style.strokeDasharray = String(arcLength);
        fillPath.style.strokeDashoffset = String(arcLength * (1 - clamp(s.amount, 0, 100) / 100));
        placeThumb(s.amount);
        dial.classList.toggle('off', !s.enabled);
        toggle.checked = s.enabled;
    }

    let dragging = false;
    function updateFromEvent(e) {
        const rect = svgEl.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const prev = getState().amount;
        const pct = eqAngleToPercent(eqAngleFromCenter(cx, cy, e.clientX, e.clientY), prev);
        if (!getState().enabled) setEnabled(true);
        setAmount(pct);
        render();
    }
    function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        try { gauge.releasePointerCapture(e.pointerId); } catch (err) { }
    }
    gauge.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = svgEl.getBoundingClientRect();
        const dist = Math.hypot(e.clientX - (rect.left + rect.width / 2), e.clientY - (rect.top + rect.height / 2));
        if (dist < rect.width * 0.14) return;
        dragging = true;
        try { gauge.setPointerCapture(e.pointerId); } catch (err) { }
        updateFromEvent(e);
    });
    gauge.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        e.preventDefault();
        updateFromEvent(e);
    });
    gauge.addEventListener('pointerup', endDrag);
    gauge.addEventListener('pointercancel', endDrag);
    gauge.addEventListener('lostpointercapture', endDrag);
    on(toggle, 'change', () => { setEnabled(toggle.checked); render(); });

    return { render };
}

function syncEqBalance() {
    const b = Viz.getBalance();
    const toggle = getEl('eq-balance-toggle');
    const slider = getEl('eq-balance-slider');
    if (toggle) toggle.checked = b.enabled;
    if (slider) slider.value = String(Math.round(b.value * 100));
    safeUpdate('eq-balance-l-val', 'textContent', `${Math.round((1 - Math.max(0, b.value)) * 100)}%`);
    safeUpdate('eq-balance-r-val', 'textContent', `${Math.round((1 - Math.max(0, -b.value)) * 100)}%`);
}

function syncEqVolume() {
    const pct = Math.round((Number.isFinite(audio.volume) ? audio.volume : 1) * 100);
    const slider = getEl('eq-volume-slider');
    if (slider) slider.value = String(pct);
    safeUpdate('eq-volume-val', 'textContent', `${pct}%`);
}

function syncEqControls() {
    const masterToggle = getEl('eq-master-toggle');
    if (masterToggle) masterToggle.checked = Viz.isEqEnabled();
    syncEqCurve();
    syncEqPresetLabel();
    Object.values(eqDials).forEach((d) => d?.render());
    syncEqBalance();
    syncEqVolume();
}

function initEqualizerV2() {
    buildEqCurve();

    eqPresetDrawer = initDrawerSelect('eq-preset-drawer', (value) => {
        Viz.applyPreset(value);
        syncEqControls();
    }, { portal: true });

    eqDials.bassBoost = wireEqDial('bassBoost', { getState: Viz.getBassBoost, setAmount: Viz.setBassBoostAmount, setEnabled: Viz.setBassBoostEnabled });
    eqDials.loudness = wireEqDial('loudness', { getState: Viz.getLoudness, setAmount: Viz.setLoudnessAmount, setEnabled: Viz.setLoudnessEnabled });
    eqDials.virtualizer = wireEqDial('virtualizer', { getState: Viz.getVirtualizer, setAmount: Viz.setVirtualizerAmount, setEnabled: Viz.setVirtualizerEnabled });

    on(getEl('eq-master-toggle'), 'change', (e) => { Viz.setEqEnabled(e.target.checked); });
    on(getEl('eq-balance-toggle'), 'change', (e) => { Viz.setBalanceEnabled(e.target.checked); syncEqBalance(); });
    on(getEl('eq-balance-slider'), 'input', (e) => { Viz.setBalance(Number(e.target.value) / 100); syncEqBalance(); });
    on(getEl('eq-volume-slider'), 'input', (e) => {
        audio.volume = clamp(Number(e.target.value) / 100, 0, 1);
        safeUpdate('eq-volume-val', 'textContent', `${e.target.value}%`);
    });

    syncEqControls();
}

async function handleSyncFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f && (!f.type || /^(audio|video)\//.test(f.type) || /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|mp4)$/i.test(f.name || '')));
    if (!files.length) { showToast('No audio files selected'); return; }

    const container = getEl('song-list-container');
    if (state.view !== 'library') switchView('library');
    getEl('empty-state-tracklist').style.display = 'none';
    showToast(`Hunting ${files.length} track${files.length !== 1 ? 's' : ''}...`);

    const skeletons = [];
    if (container) {
        for (let i = 0; i < files.length; i++) {
            const skeleton = document.createElement('div');
            skeleton.className = 'skeleton-item';
            skeleton.innerHTML = `
                <div class="skeleton-art"><div class="shimmer"></div></div>
                <div class="skeleton-info">
                    <div class="skeleton-text"><div class="shimmer"></div></div>
                    <div class="skeleton-text short"><div class="shimmer"></div></div>
                </div>`;
            container.appendChild(skeleton);
            skeletons.push(skeleton);
        }
    }

    let successCount = 0;
    let failCount = 0;

    for (const file of files) {
        try {
            let b64;
            try {
                b64 = await DB.fileToBase64(file);
            } catch (readErr) {
                throw new Error(`File could not be read: ${DB.describeError(readErr)}`);
            }

            if (!b64 || typeof b64 !== 'string' || !b64.startsWith('data:')) {
                throw new Error('File did not resolve to a valid data URL');
            }

            const rawName = file.name.replace(/\.[^/.]+$/, "");
            const searchName = rawName.replace(/\[.*?\]|\(.*?\)|_|MP3|320K/gi, " ").trim();

            let finalCover = "", finalArtist = "Local File", isHealed = false;
            let finalColor = BACKUP_COLORS[Math.floor(Math.random() * BACKUP_COLORS.length)];

            try {
                const data = await fetchJson(`https://itunes.apple.com/search?term=${encodeURIComponent(searchName)}&entity=song&limit=1`);
                if (data.results?.length > 0) {
                    const match = data.results[0];
                    if (compareStrings(searchName, match.trackName) > 0.3) {
                        finalCover = match.artworkUrl100.replace('100x100bb', '800x800bb');
                        finalArtist = match.artistName;
                        finalColor = await getAverageRGB(finalCover);
                        isHealed = true;
                    }
                }
            } catch (e) { }

            if (!isHealed) {
                try {
                    const data = await fetchJson(`https://api.deezer.com/search?q=${encodeURIComponent(searchName)}`);
                    if (data.data?.length > 0) {
                        const match = data.data[0];
                        if (match.album?.cover_xl) { finalCover = match.album.cover_xl; finalColor = await getAverageRGB(finalCover); }
                        if (match.artist?.name) finalArtist = match.artist.name;
                        isHealed = true;
                    }
                } catch (e) { }
            }

            const track = {
                id: DB.makeId('trk'),
                name: rawName, author: finalArtist, album: '',
                file: b64, cover: finalCover, color: finalColor,
                healed: !!finalCover && finalArtist !== "Local File",
                favorite: false, lrc: '',
                addedAt: Date.now(),
                durationSec: null,
                playCount: 0, openCount: 0,
            };

            try {
                await DB.putTrack(track);
            } catch (dbErr) {
                throw new Error(`IndexedDB write failed: ${dbErr.message || DB.describeError(dbErr)}`);
            }

            state.tracks.push(track);
            successCount++;
            window.LarpTrackCloud?.syncTrack(track);
        } catch (err) {
            failCount++;
            console.error(`LarpTrack sync error for "${file.name}":`, err.name || 'Error', '—', err.message || err);
        } finally {
            const sk = skeletons.shift();
            if (sk) sk.remove();
        }
    }

    refreshCurrentView();

    if (successCount && !failCount) {
        showToast('Sync Complete!');
    } else if (successCount && failCount) {
        showToast(`Synced ${successCount}, ${failCount} failed — see console`);
    } else {
        showToast(`Sync failed for all ${failCount} file${failCount !== 1 ? 's' : ''} — see console`);
    }

    autoHealTracks();
}

let healRunning = false;
async function autoHealTracks() {
    if (healRunning || !navigator.onLine) return;
    healRunning = true;
    try { await autoHealTracksInner(); }
    finally { healRunning = false; }
}

async function autoHealTracksInner() {
    const candidates = state.tracks.filter(t => !(t.healed && t.cover && t.author !== 'Local File'));
    if (!candidates.length) return;

    let updatedAny = false;
    for (const track of candidates) {
        if (!track.cover || track.cover.includes('flaticon') || track.author === 'Local File') {
            try {
                await new Promise(r => setTimeout(r, 1200 + Math.random() * 1800));
                if (!findTrack(track.id)) continue;
                const cleanName = (track.name || '').replace(/\[.*?\]|\(.*?\)|_|MP3|320K/gi, " ").trim();
                if (!cleanName) continue;
                let found = false;

                try {
                    const data = await fetchJson(`https://itunes.apple.com/search?term=${encodeURIComponent(cleanName)}&entity=song&limit=1`);
                    if (data.results?.length > 0) {
                        const match = data.results[0];
                        track.cover = match.artworkUrl100.replace('100x100bb', '800x800bb');
                        track.author = match.artistName;
                        track.color = await getAverageRGB(track.cover);
                        found = true;
                    }
                } catch (e) {}

                if (!found) {
                    try {
                        const data = await fetchJson(`https://api.deezer.com/search?q=${encodeURIComponent(cleanName)}`);
                        if (data.data?.length > 0) {
                            const match = data.data[0];
                            if (match.album?.cover_xl) { track.cover = match.album.cover_xl; track.color = await getAverageRGB(track.cover); }
                            if (match.artist?.name) track.author = match.artist.name;
                            found = true;
                        }
                    } catch (e) {}
                }

                if (found && findTrack(track.id)) {
                    track.healed = true;
                    try {
                        await DB.putTrack(track);
                        updatedAny = true;
                        window.LarpTrackCloud?.syncTrack(track);
                    }
                    catch (e) { console.error('Auto-healer DB write failed:', DB.describeError(e)); }
                }
            } catch (err) { console.warn('Healer failed for track:', track.name, err.message || err); }
        }
    }

    if (updatedAny) { refreshCurrentView(); showToast('Library Auto-Updated!'); }
}

function openModal(id) { getEl(id)?.classList.add('active'); }
function closeModal(id) { getEl(id)?.classList.remove('active'); }

function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Delete', danger = true } = {}) {
    return new Promise((resolve) => {
        const modal = getEl('confirm-modal');
        const okBtn = getEl('confirm-modal-ok');
        const cancelBtn = getEl('confirm-modal-cancel');
        if (!modal || !okBtn || !cancelBtn) { resolve(window.confirm(message)); return; }

        getEl('confirm-modal-title').textContent = title;
        getEl('confirm-modal-message').textContent = message;
        okBtn.textContent = confirmLabel;
        okBtn.classList.toggle('danger', danger);
        okBtn.classList.toggle('primary', !danger);

        let settled = false;
        function finish(result) {
            if (settled) return;
            settled = true;
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            modal.removeEventListener('click', onBackdrop);
            closeModal('confirm-modal');
            resolve(result);
        }
        function onOk() { finish(true); }
        function onCancel() { finish(false); }
        function onBackdrop(e) { if (e.target === modal) finish(false); }

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        modal.addEventListener('click', onBackdrop);
        openModal('confirm-modal');
    });
}

document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
});
document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.classList.remove('active'); });
});

function syncSettingsControls() {
    layoutStyleDrawer?.setValue(lsGet('lt-user-layout') || 'list-view');
    graphicsQualityDrawer?.setValue(lsGet('lt-graphics-quality') || 'medium');
    const pt = getEl('particle-toggle');
    if (pt) pt.checked = lsGet('lt-particles-enabled') !== 'off';
    syncEqControls();
}

function applyTheme(theme, { persist = true } = {}) {
    const bg = getEl('app-bg');
    if (!bg) return;
    bg.style.transition = "background 0.8s ease";

    switch (theme) {
        case 'midnight':
            document.documentElement.style.setProperty('--primary-color', '#000814');
            bg.style.background = "linear-gradient(180deg, #000814 0%, #001d3d 100%)";
            break;
        case 'sunset':
            document.documentElement.style.setProperty('--primary-color', '#2d0a1a');
            bg.style.background = "linear-gradient(180deg, #2d0a1a 0%, #70163c 100%)";
            break;
        case 'matrix':
            document.documentElement.style.setProperty('--primary-color', '#000b00');
            bg.style.background = "linear-gradient(180deg, #000b00 0%, #003b00 100%)";
            break;
        default:
            bg.style.background = "";
            const track = findTrack(state.currentId);
            if (track) document.documentElement.style.setProperty('--primary-color', track.color || '#1a1a1a');
    }
    if (persist) Prefs.saveThemePreference(theme);
    showToast(`Theme: ${theme}`);
}

window.applyAddonStyle = function (property, value) {
    if (typeof property === 'string' && property.startsWith('--')) {
        document.documentElement.style.setProperty(property, value, 'important');
        console.log(`%c Addon: Set ${property} to ${value} `, "background:#1a1a1a;color:#f5c97a");
    }
};

window.LTAddons = {
    setAccent(cssColor) {
        if (typeof cssColor !== 'string' || !cssColor.trim()) return;
        document.documentElement.style.setProperty('--accent-warm', cssColor, 'important');
        document.documentElement.style.setProperty('--glass-border-active', cssColor, 'important');
        showToast(`Addon: accent set to ${cssColor}`);
    },

    setFontSize(px) {
        const n = Number(px);
        if (!Number.isFinite(n) || n < 8 || n > 40) return;
        document.documentElement.style.fontSize = `${n}px`;
        showToast(`Addon: font size set to ${n}px`);
    },

    toggleVisibility(selector, visible) {
        if (typeof selector !== 'string') return;
        document.querySelectorAll(selector).forEach(el => {
            el.style.display = visible ? '' : 'none';
        });
    },

    onButtonClick(selector, callback) {
        if (typeof selector !== 'string' || typeof callback !== 'function') return;
        document.querySelectorAll(selector).forEach(el => {
            el.addEventListener('click', (e) => {
                try { callback(e); } catch (err) { console.error('LTAddons: button callback threw —', err); }
            });
        });
    },

    toast(message) { showToast(String(message ?? '')); },
};

Object.keys(window.LTAddons).forEach((name) => {
    window[`LTAddons_${name}`] = (...args) => window.LTAddons[name](...args);
});

window.runLuaFromText = function () {
    const rawUserCode = getEl('lua-input').value;
    if (!rawUserCode) return;
    const prefix = `local js = require "js"\nlocal window = js.global\n`;
    const fullLuaCode = prefix + rawUserCode;
    const lineOffset = prefix.split('\n').length - 1;

    try {
        window.fengari.load(fullLuaCode)();
        showToast("Addon Applied!");
    } catch (err) {
        let errorMessage = (err.message || String(err)).replace(/\[string "\?"\]:/gi, '');
        const userLines = rawUserCode.split('\n');
        const numbersFound = errorMessage.match(/\d+/g);
        let targetLine = null;

        if (numbersFound) {
            numbersFound.forEach(numStr => {
                const absoluteLine = parseInt(numStr, 10);
                const correctedLine = absoluteLine - lineOffset;
                if (targetLine === null || correctedLine < targetLine) targetLine = correctedLine;
                errorMessage = errorMessage.replace(numStr, correctedLine);
            });
        }
        if (targetLine === null || targetLine < 1) targetLine = 1;
        const errorLineText = userLines[targetLine - 1] || "[End of file]";

        alert(`❌ Lua Syntax Error\n-----------------------------------\nIssue: ${errorMessage.trim()}\nLine: ${targetLine}\n\nCode Snippet:\n> Line ${targetLine}:  ${errorLineText.trim()}\n-----------------------------------\nPlease check your syntax and try again.`);
    }
};

window.threeHelper = {
    scene: null, camera: null, renderer: null, objects: {},
    mouse: { x: 0, y: 0, px: 0, py: 0 }, keys: {}, time: 0, onUpdate: null,

    init: function () {
        const container = document.getElementById('lua-3d-container');
        if (!container || this.renderer) return;

        import('three').then((THREE) => {
            window.THREE = THREE;
            this.scene = new THREE.Scene();
            const aspect = window.innerWidth / window.innerHeight;
            this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 1000);
            this.camera.position.z = 7;

            this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
            container.appendChild(this.renderer.domElement);

            const ambient = new THREE.AmbientLight(0xffffff, 1.5);
            this.scene.add(ambient);
            const sun = new THREE.DirectionalLight(0xffffff, 2.0);
            sun.position.set(5, 10, 7);
            this.scene.add(sun);

            window.addEventListener('resize', () => {
                this.camera.aspect = window.innerWidth / window.innerHeight;
                this.camera.updateProjectionMatrix();
                this.renderer.setSize(window.innerWidth, window.innerHeight);
                this._dirty = true;
            });
            window.addEventListener('mousemove', (e) => {
                this.mouse.px = e.clientX; this.mouse.py = e.clientY;
                this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
                this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
            });
            window.addEventListener('keydown', (e) => { this.keys[e.key.toLowerCase()] = true; });
            window.addEventListener('keyup', (e) => { this.keys[e.key.toLowerCase()] = false; });

            this.clock = new THREE.Clock();
            this.animate();
            console.log("🎮 Game Engine Sandbox Pipeline Fully Functional.");
        }).catch(err => console.error("Three.js initiation failed:", err));
    },

    isKeyDown: function (keyString) { return !!this.keys[keyString.toLowerCase()]; },

    setUIVisibility: function (visible) {
        const displayVal = visible ? "" : "none";
        ['#app-shell', '.mini-player', '#app-bg', '#particle-canvas'].forEach(sel => {
            const el = document.querySelector(sel);
            if (el) el.style.display = displayVal;
        });
    },

    setInteractive: function (canInteract) {
        const container = document.getElementById('lua-3d-container');
        if (!container) return;
        container.style.pointerEvents = canInteract ? "auto" : "none";
        container.style.zIndex = canInteract ? "10" : "1";
    },

    setBackgroundColor: function (hexColor, alpha) {
        if (!this.renderer) return;
        const colorAlpha = alpha !== undefined ? alpha : 1.0;
        this.renderer.setClearColor(hexColor, colorAlpha);
        this._dirty = true;
        const bg = document.getElementById('app-bg');
        if (bg && colorAlpha > 0) bg.style.background = "none";
    },

    clearScene: function () {
        if (!this.scene) return;
        this.onUpdate = null; this.keys = {};
        Object.keys(this.objects).forEach(id => this.destroy(id));
        this.objects = {};
        this.setUIVisibility(true); this.setInteractive(false);
        if (this.renderer) this.renderer.setClearColor(0x000000, 0);
        this._dirty = true;
    },

    spawn: function (id, type, size, color, wireframe) {
        if (!this.scene) return;
        this.destroy(id);
        let geo;
        if (type === "sphere") geo = new THREE.SphereGeometry(size, 16, 16);
        else if (type === "torus") geo = new THREE.TorusGeometry(size, size * 0.2, 8, 24);
        else if (type === "plane") geo = new THREE.PlaneGeometry(size, size);
        else geo = new THREE.BoxGeometry(size, size, size);

        const mat = new THREE.MeshStandardMaterial({ color: color !== undefined ? color : 0xffffff, roughness: 0.6, wireframe: !!wireframe });
        const mesh = new THREE.Mesh(geo, mat);
        this.scene.add(mesh);
        this.objects[id] = mesh;
        return id;
    },

    transform: function (id, x, y, z, rX, rY, rZ, sX, sY, sZ) {
        const obj = this.objects[id];
        if (!obj) return;
        if (x != null) obj.position.x = x; if (y != null) obj.position.y = y; if (z != null) obj.position.z = z;
        if (rX != null) obj.rotation.x = rX; if (rY != null) obj.rotation.y = rY; if (rZ != null) obj.rotation.z = rZ;
        if (sX != null) obj.scale.x = sX; if (sY != null) obj.scale.y = sY; if (sZ != null) obj.scale.z = sZ;
    },

    destroy: function (id) {
        const obj = this.objects[id];
        if (obj) {
            this.scene.remove(obj);
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) obj.material.dispose();
            delete this.objects[id];
            this._dirty = true;
        }
    },

    _dirty: true,
    animate: function () {
        requestAnimationFrame(() => this.animate());
        if (document.hidden) return;
        if (this.clock) this.time = this.clock.getElapsedTime();
        const hasUpdate = typeof this.onUpdate === 'function';
        if (hasUpdate) {
            try { this.onUpdate(); }
            catch (err) {
                console.error('threeHelper.onUpdate threw — callback removed:', err);
                this.onUpdate = null;
            }
        }
        const hasObjects = !!this.objects && Object.keys(this.objects).length > 0;
        if (this.renderer && this.scene && this.camera && (hasUpdate || hasObjects || this._dirty)) {
            this.renderer.render(this.scene, this.camera);
            this._dirty = false;
        }
    }
};
window.threeHelper.init();

const ORIGINAL_PAGE_TITLE = document.title;
window.resetAddons = function () {
    document.title = ORIGINAL_PAGE_TITLE;
    if (getEl('lua-input')) getEl('lua-input').value = "";
    if (window.threeHelper) {
        try {
            if (window.threeHelper.renderer?.dispose) window.threeHelper.renderer.dispose();
            window.threeHelper.objects = {};
            window.threeHelper.renderer = null;
        } catch (e) { console.warn("Non-fatal cleanup error:", e); }
    }
    const container = document.getElementById('lua-3d-container');
    if (container) container.innerHTML = '';
    window.location.reload();
};

window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'R') { e.preventDefault(); window.resetAddons(); }
});

(function () {
    let netTimer;
    function showNetworkToast(msg) {
        const t = getEl('toast');
        if (!t) return;
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(netTimer);
        netTimer = setTimeout(() => t.classList.remove('show'), 3000);
    }
    function updateNetworkStatus() {
        if (navigator.onLine) {
            showNetworkToast("🌐 You're online! Music details and artwork will load.");
            autoHealTracks();
        } else {
            showNetworkToast("🔌 You're offline. Automatic artwork searching is paused.");
        }
    }
    window.addEventListener('online', updateNetworkStatus);
    window.addEventListener('offline', updateNetworkStatus);
})();

(function () {
    let currentFocusIndex = -1;

    document.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
            if (e.code === 'Escape') { e.target.blur(); }
            return;
        }

        if (e.ctrlKey || e.metaKey || e.altKey) return;

        const isPlayerOpen = !!playerScreen && playerScreen.classList.contains('active');
        const isNavKey = e.code === 'ArrowRight' || e.code === 'ArrowLeft' || e.code === 'ArrowDown' || e.code === 'ArrowUp' || e.code === 'KeyJ' || e.code === 'KeyK';
        if (e.repeat && !isNavKey) { if (e.code === 'Space') e.preventDefault(); return; }

        switch (e.code) {
            case 'Space':
                e.preventDefault();
                handlePlay();
                return;
            case 'ArrowRight':
                e.preventDefault();
                seekBy(5);
                return;
            case 'ArrowLeft':
                e.preventDefault();
                seekBy(-5);
                return;
            case 'KeyN':
                nextSong();
                return;
            case 'KeyP':
                prevSong();
                return;
            case 'KeyM':
                toggleMute();
                return;
            case 'KeyS':
                toggleShuffle();
                return;
            case 'KeyR':
                toggleRepeat();
                return;
            case 'Escape':
                e.preventDefault();
                if (isPlayerOpen) togglePlayer(false);
                document.querySelectorAll('.modal-backdrop.active').forEach(m => m.classList.remove('active'));
                return;
        }

        if (!isPlayerOpen) {
            const tracks = document.querySelectorAll('.song-item');
            if (tracks.length) {
                if (e.code === 'ArrowDown' || e.code === 'KeyJ') {
                    e.preventDefault();
                    currentFocusIndex = (currentFocusIndex + 1) % tracks.length;
                    highlightTrack(tracks, currentFocusIndex);
                } else if (e.code === 'ArrowUp' || e.code === 'KeyK') {
                    e.preventDefault();
                    currentFocusIndex = (currentFocusIndex - 1 + tracks.length) % tracks.length;
                    highlightTrack(tracks, currentFocusIndex);
                } else if (e.code === 'Enter' && currentFocusIndex >= 0 && tracks[currentFocusIndex]) {
                    e.preventDefault();
                    tracks[currentFocusIndex].click();
                }
            }
        }
    });

    function highlightTrack(tracks, index) {
        document.querySelectorAll('.song-item.keyboard-focused').forEach(t => t.classList.remove('keyboard-focused'));
        const el = tracks[index];
        if (!el) return;
        el.classList.add('keyboard-focused');
        el.focus();
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
})();

(function () {
    let playerStartY = 0, playerStartX = 0, playerStartedInTopHalf = false;

    function isInsideBlockedSubpanel(target) {
        if (playerScreen.classList.contains('lyrics-open') || playerScreen.classList.contains('eq-open')) return true;
        return !!(target && target.closest && (target.closest('#lyrics-panel') || target.closest('#eq-panel')));
    }

    on(playerScreen, 'touchstart', (e) => {
        if (isInsideBlockedSubpanel(e.target)) { playerStartedInTopHalf = false; return; }
        if (!e.touches || !e.touches[0]) return;
        const rect = playerScreen.getBoundingClientRect();
        const touchY = e.touches[0].clientY;
        playerStartedInTopHalf = (touchY - rect.top) < rect.height / 2;
        playerStartY = touchY;
        playerStartX = e.touches[0].clientX;
    }, { passive: true });

    on(playerScreen, 'touchend', (e) => {
        if (!playerStartedInTopHalf) return;
        if (isInsideBlockedSubpanel(e.target)) return;
        if (!e.changedTouches || !e.changedTouches[0]) return;
        const endY = e.changedTouches[0].clientY;
        const endX = e.changedTouches[0].clientX;
        const diffY = endY - playerStartY;
        const diffX = Math.abs(endX - playerStartX);
        if (diffY > 70 && diffX < 60) togglePlayer(false);
    }, { passive: true });

    const miniPlayer = getEl('mini-player');
    let miniStartX = 0, miniStartY = 0;

    on(miniPlayer, 'touchstart', (e) => {
        if (!e.touches || !e.touches[0]) return;
        miniStartX = e.touches[0].clientX;
        miniStartY = e.touches[0].clientY;
    }, { passive: true });

    on(miniPlayer, 'touchend', (e) => {
        if (!e.changedTouches || !e.changedTouches[0]) return;
        const endX = e.changedTouches[0].clientX;
        const endY = e.changedTouches[0].clientY;
        const diffX = miniStartX - endX;
        const diffY = miniStartY - endY;
        const threshold = 45;

        if (Math.abs(diffY) > threshold && Math.abs(diffY) > Math.abs(diffX)) {
            if (diffY > 0) togglePlayer(true);
            return;
        }
        if (Math.abs(diffX) > threshold && Math.abs(diffX) > Math.abs(diffY)) {
            diffX > 0 ? nextSong() : prevSong();
        }
    }, { passive: true });

    let lastTap = 0;
    on(miniPlayer, 'touchstart', () => {
        const now = Date.now();
        if (now - lastTap < 300) handlePlay();
        lastTap = now;
    }, { passive: true });
})();

function wireEvents() {
    document.querySelectorAll('.nav-item[data-view]').forEach(btn => on(btn, 'click', () => switchView(btn.dataset.view)));
    on(getEl('nav-toggle'), 'click', () => {
        if (getEl('nav-toggle').classList.contains('back-mode')) switchView('library');
        else toggleSidebar();
    });
    on(getEl('sidebar-close-btn'), 'click', () => closeSidebar(true));
    on(getEl('sidebar-overlay'), 'click', () => closeSidebar(true));
    on(getEl('sidebar-sync-btn'), 'click', () => getEl('lazy-sync').click());
    on(getEl('lazy-sync'), 'change', function () { handleSyncFiles(this.files); this.value = ''; });

    let searchRenderTimer = null;
    on(getEl('track-search'), 'input', (e) => {
        state.search = e.target.value;
        clearTimeout(searchRenderTimer);
        searchRenderTimer = setTimeout(renderTracklist, 140);
    });
    sortDrawer = initDrawerSelect('sort-drawer', (value) => { state.sort = value; renderTracklist(); }, { portal: true });

    const searchDrawer = getEl('search-drawer');
    const mainTopbar = getEl('main-topbar');
    function openSearchDrawer() {
        if (mainTopbar) {
            const topbarRect = mainTopbar.getBoundingClientRect();
            const drawerRect = searchDrawer.getBoundingClientRect();
            const targetWidth = Math.round(drawerRect.right - topbarRect.left);
            searchDrawer.style.width = `${targetWidth}px`;
        }
        searchDrawer.classList.add('open');
        getEl('track-search').focus();
    }
    function closeSearchDrawer() {
        searchDrawer.classList.remove('open');
        searchDrawer.style.width = '';
    }
    on(getEl('search-toggle-btn'), 'click', (e) => {
        e.stopPropagation();
        openSearchDrawer();
    });
    on(getEl('search-drawer-close'), 'click', () => {
        const input = getEl('track-search');
        if (input) input.value = '';
        if (state.search) {
            state.search = '';
            renderTracklist();
        }
        closeSearchDrawer();
    });
    document.addEventListener('click', (e) => {
        if (searchDrawer.classList.contains('open') && !e.target.closest('.search-drawer') && !e.target.closest('#search-toggle-btn')) {
            closeSearchDrawer();
        }
    });

    initHeaderAutoHide();

    on(getEl('mini-left'), 'click', () => togglePlayer(true));
    on(getEl('mini-play'), 'click', handlePlay);
    on(getEl('mini-prev'), 'click', prevSong);
    on(getEl('mini-next'), 'click', nextSong);
    on(getEl('mini-fav'), 'click', () => state.currentId && toggleFavorite(state.currentId));

    on(getEl('player-back-btn'), 'click', () => togglePlayer(false));
    on(getEl('master-play'), 'click', handlePlay);
    on(getEl('skip-prev'), 'click', prevSong);
    on(getEl('skip-next'), 'click', nextSong);
    on(getEl('shuffle-btn'), 'click', toggleShuffle);
    on(getEl('repeat-btn'), 'click', toggleRepeat);
    on(getEl('fav-btn'), 'click', () => state.currentId && toggleFavorite(state.currentId));
    on(getEl('edit-track-btn'), 'click', () => state.currentId && openTrackEditModal(state.currentId));
    on(getEl('add-to-playlist-btn'), 'click', () => state.currentId && openPlaylistPicker(state.currentId));

    const playerMoreBtn = getEl('player-more-btn');
    const playerMoreMenu = getEl('player-more-menu');
    on(playerMoreBtn, 'click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const willOpen = !playerMoreMenu.classList.contains('open');
        closeAllRowMenus();
        if (willOpen) openRowMenu(playerMoreMenu, playerMoreBtn);
    });
    on(playerMoreMenu, 'click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.hasAttribute('data-keep-open')) { e.stopPropagation(); return; }
        closeRowMenu(playerMoreMenu);
    });

    on(getEl('lyrics-btn'), 'click', () => toggleLyricsPanel());
    on(getEl('lyrics-close-btn'), 'click', () => toggleLyricsPanel(false));
    on(getEl('edit-lyrics-btn'), 'click', openLrcEditor);
    on(getEl('tag-timestamp-btn'), 'click', () => Lyrics.tagTimestampAtCursor(getEl('lrc-textarea'), audio.currentTime || 0));
    on(getEl('save-lrc-btn'), 'click', saveLrc);

    on(getEl('eq-btn'), 'click', () => toggleEqPanel());
    on(getEl('eq-close-btn'), 'click', () => toggleEqPanel(false));
    on(getEl('eq-reset-btn'), 'click', () => {
        Viz.resetBands();
        Viz.setBassBoostEnabled(false);
        Viz.setLoudnessEnabled(false);
        Viz.setVirtualizerEnabled(false);
        Viz.setBalanceEnabled(false);
        Viz.setBalance(0);
        Viz.setEqEnabled(true);
        syncEqControls();
    });
    initEqualizerV2();

    on(getEl('save-track-btn'), 'click', saveTrackEdit);
    on(getEl('edit-cover-file'), 'change', async function () {
        const file = this.files[0];
        if (!file) return;
        try {
            const b64 = await DB.fileToBase64(file);
            getEl('edit-cover-preview').src = b64;
            getEl('edit-cover-url').value = '';
        } catch (e) {
            showToast(`Could not read image: ${DB.describeError(e)}`);
        }
    });
    on(getEl('edit-cover-url'), 'input', function () {
        if (this.value.trim()) getEl('edit-cover-preview').src = this.value.trim();
    });

    on(getEl('info-edit-btn'), 'click', () => {
        const id = getEl('track-info-modal').dataset.trackId;
        closeModal('track-info-modal');
        openTrackEditModal(id);
    });
    on(getEl('info-playlist-btn'), 'click', () => {
        const id = getEl('track-info-modal').dataset.trackId;
        closeModal('track-info-modal');
        openPlaylistPicker(id);
    });

    on(getEl('new-playlist-btn'), 'click', () => openModal('new-playlist-modal'));
    on(getEl('create-playlist-btn'), 'click', async () => {
        const name = getEl('new-playlist-name').value;
        const pl = await createPlaylist(name);
        getEl('new-playlist-name').value = '';
        closeModal('new-playlist-modal');
        if (pl) { renderPlaylistsGrid(); showToast(`Created "${pl.name}"`); }
    });
    on(getEl('quick-playlist-create-btn'), 'click', async () => {
        const name = getEl('quick-playlist-name').value;
        const pl = await createPlaylist(name);
        getEl('quick-playlist-name').value = '';
        if (pl) {
            const trackId = getEl('playlist-picker-modal').dataset.trackId;
            await addTrackToPlaylist(pl.id, trackId);
            renderPlaylistPickerList(trackId);
        }
    });
    on(getEl('tracklist-back'), 'click', () => {
        const src = getTracklistSource();
        switchView(src.backTo || 'library');
    });
    on(getEl('tracklist-delete-btn'), 'click', () => deletePlaylistById(state.trackModeKey));

    document.querySelectorAll('[data-theme]').forEach(btn => on(btn, 'click', () => applyTheme(btn.dataset.theme)));
    layoutStyleDrawer = initDrawerSelect('layout-style-drawer', (value) => Prefs.setLayout(value));
    graphicsQualityDrawer = initDrawerSelect('graphics-quality-drawer', (value) => Prefs.setGraphicsQuality(value, { toast: showToast }));
    on(getEl('particle-toggle'), 'change', (e) => {
        Prefs.toggleParticles(e.target.checked);
    });
    on(getEl('run-lua-btn'), 'click', () => window.runLuaFromText());
    on(getEl('reset-lua-btn'), 'click', () => window.resetAddons());
}

function setupMemoryBadge() {
    const summary = window.LarpTrackCloud?.getMemorySummary?.();
    if (!summary) return;
    const badge = getEl('memory-badge');
    const label = getEl('memory-badge-label');
    if (!badge || !label) return;
    label.textContent = summary.label;
    badge.style.display = 'inline-flex';
    on(badge, 'click', () => openMemoryModal(summary));
}

function openMemoryModal(summary) {
    const hours = Math.floor(summary.seconds / 3600);
    const minutes = Math.round((summary.seconds % 3600) / 60);
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    safeUpdate('memory-modal-month', 'textContent', summary.monthName);
    safeUpdate('memory-modal-hours', 'textContent', parts.join(' '));
    safeUpdate('memory-modal-sub', 'textContent', `listened in ${summary.monthName}`);
    openModal('memory-modal');
}

async function init() {
    wireEvents();
    setupMemoryBadge();
    const savedParticles = Prefs.loadParticlesPreference();
    const savedGfx = Prefs.loadGraphicsPreference();
    const savedLayout = Prefs.loadLayoutPreference();
    graphicsQualityDrawer?.setValue(savedGfx);
    layoutStyleDrawer?.setValue(savedLayout);
    sortDrawer?.setValue(state.sort);
    const particleToggle = getEl('particle-toggle');
    if (particleToggle) particleToggle.checked = savedParticles;
    applyTheme(Prefs.loadThemePreference(), { persist: false });

    try {
        await loadAllData();
    } catch (e) {
        console.error('LarpTrack: failed to open database —', DB.describeError(e));
        showToast('Could not open local storage — some features may be unavailable');
    }

    switchView('library');

    if (state.tracks.length) {
        const last = lsGet('lt-last-played');
        const target = (last && findTrack(last)) ? last : state.tracks[0].id;
        state.queueIds = filterAndSort(state.tracks).map(t => t.id);
        selectSong(target, false);
    } else {
        const mini = getEl('mini-player');
        if (mini) mini.style.display = 'none';
    }

    initExtendedFeatures(state, audio, {
        onSelectTrack: (id) => selectSong(id, true),
        getPitchSemitones: Viz.getPitchSemitones,
        setPitchSemitones: Viz.setPitchSemitones,
        pitchMin: Viz.PITCH_MIN,
        pitchMax: Viz.PITCH_MAX,
        ensureAudioGraph,
    });

    setTimeout(autoHealTracks, 3000);
}

window.addEventListener('DOMContentLoaded', init);