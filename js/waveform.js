const CACHE_PREFIX = 'lt-wave-';
const BAR_COUNT = 72;

let decodeCtx = null;
function getDecodeContext() {
    if (!decodeCtx) decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    return decodeCtx;
}

function readCache(id) {
    try {
        const raw = localStorage.getItem(CACHE_PREFIX + id);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) && parsed.length === BAR_COUNT ? parsed : null;
    } catch (e) { return null; }
}

function writeCache(id, peaks) {
    try { localStorage.setItem(CACHE_PREFIX + id, JSON.stringify(peaks)); }
    catch (e) { }
}

function computePeaks(channelData) {
    const peaks = new Array(BAR_COUNT).fill(0);
    const blockSize = Math.floor(channelData.length / BAR_COUNT) || 1;
    let max = 0;
    for (let i = 0; i < BAR_COUNT; i++) {
        const start = i * blockSize;
        let peak = 0;
        for (let j = 0; j < blockSize; j++) {
            const v = Math.abs(channelData[start + j] || 0);
            if (v > peak) peak = v;
        }
        peaks[i] = peak;
        if (peak > max) max = peak;
    }
    if (max > 0) for (let i = 0; i < BAR_COUNT; i++) peaks[i] = peaks[i] / max;
    return peaks;
}

const FALLBACK_PEAKS = new Array(BAR_COUNT).fill(0.15);

export async function getPeaks(track) {
    if (!track) return FALLBACK_PEAKS;
    const cached = readCache(track.id);
    if (cached) return cached;
    if (!track.file) return FALLBACK_PEAKS;

    try {
        const res = await fetch(track.file);
        const buf = await res.arrayBuffer();
        const ctx = getDecodeContext();
        const audioBuffer = await ctx.decodeAudioData(buf);
        const channel = audioBuffer.getChannelData(0);
        const peaks = computePeaks(channel);
        writeCache(track.id, peaks);
        return peaks;
    } catch (e) {
        console.warn('LarpTrack waveform: decode failed —', e.message);
        return FALLBACK_PEAKS;
    }
}

export function drawWaveform(canvas, peaks, ratio = 0) {
    if (!canvas || !peaks || !peaks.length) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 300;
    const cssH = canvas.clientHeight || 40;
    if (cssW === 0 || cssH === 0) return;

    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const gap = 2;
    const barW = Math.max(1.5, (cssW - gap * (peaks.length - 1)) / peaks.length);
    const midY = cssH / 2;
    const playedBars = Math.round(Math.max(0, Math.min(1, ratio)) * peaks.length);

    const rootStyle = getComputedStyle(document.documentElement);
    const playedColor = rootStyle.getPropertyValue('--accent-warm').trim() || '#f5c97a';
    const unplayedColor = 'rgba(255,255,255,0.22)';

    peaks.forEach((p, i) => {
        const h = Math.max(3, p * (cssH - 6));
        const x = i * (barW + gap);
        ctx.fillStyle = i < playedBars ? playedColor : unplayedColor;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, midY - h / 2, barW, h, barW / 2);
        else ctx.rect(x, midY - h / 2, barW, h);
        ctx.fill();
    });
}
