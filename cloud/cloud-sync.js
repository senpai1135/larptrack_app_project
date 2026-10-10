import { supabase } from './supabase-client.js';

const DEEZER_ENDPOINT = 'https://api.deezer.com/search';
const DEEZER_TIMEOUT_MS = 5000;

const UNAVAILABLE = 'Cloud services are unavailable right now (Supabase failed to load).';

function requireClient() {
    if (!supabase) throw new Error(UNAVAILABLE);
    return supabase;
}

export async function fetchDeezerMatch(title, artist) {
    const q = encodeURIComponent(`${artist || ''} ${title || ''}`.trim());
    if (!q) return { matched: false };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEEZER_TIMEOUT_MS);

    try {
        const res = await fetch(`${DEEZER_ENDPOINT}?q=${q}`, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) return { matched: false };

        const json = await res.json();
        if (json.data && json.data.length > 0) {
            const m = json.data[0];
            return {
                matched: true,
                cover_url: m.album?.cover_xl || m.album?.cover_big || null,
                author: m.artist?.name || null,
                album: m.album?.title || null,
                deezer_match_id: m.id != null ? String(m.id) : null,
            };
        }
        return { matched: false };
    } catch (e) {
        clearTimeout(timer);
        return { matched: false, error: e.message };
    }
}

export async function upsertTrackMetadata(track, userId) {
    const client = requireClient();
    let cover_url = track.cover || null;
    let author = track.author;
    let album = track.album;
    let deezer_match_id = null;
    let match_status = 'unmatched';

    if (track.healed && track.cover) {
        match_status = 'matched';
    } else {
        const match = await fetchDeezerMatch(track.name, track.author);
        if (match.matched) {
            cover_url = match.cover_url || cover_url;
            author = match.author || author;
            album = match.album || album;
            deezer_match_id = match.deezer_match_id;
            match_status = cover_url ? 'matched' : 'partial';
        }
    }

    const { error } = await client.from('tracks').upsert({
        id: track.id,
        user_id: userId,
        name: track.name,
        author,
        album,
        cover_url,
        lrc_text: track.lrc || '',
        duration_sec: track.durationSec,
        favorite: !!track.favorite,
        play_count: track.playCount || 0,
        open_count: track.openCount || 0,
        deezer_match_id,
        match_status,
        updated_at: new Date().toISOString(),
    });
    if (error) throw error;
}

export async function deleteTrackCloud(trackId) {
    const client = requireClient();
    const { error } = await client.from('tracks').delete().eq('id', trackId);
    if (error) throw error;
}

export async function fetchCloudTracks(userId) {
    const client = requireClient();
    const { data, error } = await client.from('tracks').select('*').eq('user_id', userId);
    if (error) throw error;
    return data;
}

export async function upsertPlaylist(playlist, userId) {
    const client = requireClient();
    const { error } = await client
        .from('playlists')
        .upsert({ id: playlist.id, user_id: userId, name: playlist.name });
    if (error) throw error;
}

export async function syncPlaylistTracks(playlist) {
    const client = requireClient();
    await client.from('playlist_tracks').delete().eq('playlist_id', playlist.id);
    const rows = playlist.trackIds.map((trackId, i) => ({
        playlist_id: playlist.id, track_id: trackId, position: i,
    }));
    if (rows.length) {
        const { error } = await client.from('playlist_tracks').insert(rows);
        if (error) throw error;
    }
}

export async function deletePlaylistCloud(playlistId) {
    const client = requireClient();
    const { error } = await client.from('playlists').delete().eq('id', playlistId);
    if (error) throw error;
}

export async function addMonthlyPlaytime(userId, yearMonth, seconds) {
    const client = requireClient();
    const { error } = await client.rpc('increment_playtime', {
        p_user_id: userId,
        p_year_month: yearMonth,
        p_seconds: seconds,
    });
    if (error) throw error;
}

export async function fetchMonthlyPlaytime(userId, yearMonth) {
    const client = requireClient();
    const { data, error } = await client
        .from('listening_monthly')
        .select('seconds')
        .eq('user_id', userId)
        .eq('year_month', yearMonth)
        .maybeSingle();
    if (error) throw error;
    return data?.seconds || 0;
}

export async function fetchAllMonthlyPlaytime(userId) {
    const client = requireClient();
    const { data, error } = await client
        .from('listening_monthly')
        .select('year_month, seconds')
        .eq('user_id', userId)
        .order('year_month', { ascending: false });
    if (error) throw error;
    return data || [];
}

export async function updateDisplayName(userId, displayName) {
    const client = requireClient();
    const { error } = await client
        .from('profiles')
        .update({ display_name: displayName })
        .eq('id', userId);
    if (error) throw error;
}
