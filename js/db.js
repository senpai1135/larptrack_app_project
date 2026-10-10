const DB_NAME = 'LarpTrack_db';
const DB_VERSION = 3;
const TRACK_STORE = 'larp_tracks';
const PLAYLIST_STORE = 'larp_playlists';

let dbInstance = null;
let openPromise = null;

export function openDB() {
    if (openPromise) return openPromise;

    openPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = (e) => {
            const d = e.target.result;
            const oldVersion = e.oldVersion || 0;
            console.info(`LarpTrack DB: upgrading schema v${oldVersion} → v${DB_VERSION}`);

            try {
                if (!d.objectStoreNames.contains(TRACK_STORE)) {
                    d.createObjectStore(TRACK_STORE, { keyPath: 'id' });
                    console.info(`LarpTrack DB: created missing store "${TRACK_STORE}"`);
                }
            } catch (err) {
                console.error(`LarpTrack DB: failed to create "${TRACK_STORE}" —`, describeError(err));
            }

            try {
                if (!d.objectStoreNames.contains(PLAYLIST_STORE)) {
                    d.createObjectStore(PLAYLIST_STORE, { keyPath: 'id' });
                    console.info(`LarpTrack DB: created missing store "${PLAYLIST_STORE}"`);
                }
            } catch (err) {
                console.error(`LarpTrack DB: failed to create "${PLAYLIST_STORE}" —`, describeError(err));
            }
        };

        req.onblocked = () => {
            console.warn('LarpTrack DB: upgrade blocked — another tab has an older connection open. Close other LarpTrack tabs and reload.');
        };

        req.onsuccess = (e) => {
            dbInstance = e.target.result;
            const missing = [TRACK_STORE, PLAYLIST_STORE].filter(s => !dbInstance.objectStoreNames.contains(s));
            if (missing.length) {
                console.error(`LarpTrack DB: opened v${dbInstance.version} but still missing store(s): ${missing.join(', ')}`);
            }
            resolve(dbInstance);
        };
        req.onerror = (e) => reject(e.target.error);
    });

    return openPromise;
}

function withStore(storeName, mode) {
    return openDB().then((d) => d.transaction(storeName, mode).objectStore(storeName));
}

function reqToPromise(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function getAllTracks() {
    try {
        const store = await withStore(TRACK_STORE, 'readonly');
        return (await reqToPromise(store.getAll())) || [];
    } catch (e) {
        console.warn('LarpTrack DB: getAllTracks failed', e);
        return [];
    }
}

export async function putTrack(track) {
    try {
        const store = await withStore(TRACK_STORE, 'readwrite');
        return await reqToPromise(store.put(track));
    } catch (err) {
        console.error('LarpTrack DB: putTrack failed —', describeError(err), track?.id);
        throw new Error(`Could not save track: ${describeError(err)}`);
    }
}

export async function deleteTrack(id) {
    try {
        const store = await withStore(TRACK_STORE, 'readwrite');
        return await reqToPromise(store.delete(id));
    } catch (err) {
        console.error('LarpTrack DB: deleteTrack failed —', describeError(err), id);
        throw new Error(`Could not delete track: ${describeError(err)}`);
    }
}

export async function getAllPlaylists() {
    try {
        const store = await withStore(PLAYLIST_STORE, 'readonly');
        return (await reqToPromise(store.getAll())) || [];
    } catch (e) {
        console.warn('LarpTrack DB: getAllPlaylists failed', e);
        return [];
    }
}

export async function putPlaylist(playlist) {
    try {
        const store = await withStore(PLAYLIST_STORE, 'readwrite');
        return await reqToPromise(store.put(playlist));
    } catch (err) {
        console.error('LarpTrack DB: putPlaylist failed —', describeError(err));
        throw new Error(`Could not save playlist: ${describeError(err)}`);
    }
}

export async function deletePlaylist(id) {
    try {
        const store = await withStore(PLAYLIST_STORE, 'readwrite');
        return await reqToPromise(store.delete(id));
    } catch (err) {
        console.error('LarpTrack DB: deletePlaylist failed —', describeError(err));
        throw new Error(`Could not delete playlist: ${describeError(err)}`);
    }
}

export function makeId(prefix = 'trk') {
    if (window.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        if (!file) { reject(new Error('No file provided')); return; }
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error || new Error('FileReader failed'));
        r.onabort = () => reject(new Error('FileReader aborted'));
        try {
            r.readAsDataURL(file);
        } catch (err) {
            reject(err);
        }
    });
}

export function describeError(err) {
    if (!err) return 'Unknown error';
    const name = err.name || 'Error';
    const message = err.message || String(err);
    const code = (typeof err.code !== 'undefined') ? err.code : 'n/a';
    return `${name} (code ${code}): ${message}`;
}

export const DB_NAMES = { DB_NAME, TRACK_STORE, PLAYLIST_STORE };
