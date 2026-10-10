const TAG_RE = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLRC(raw) {
    if (!raw || typeof raw !== 'string') return [];
    const lines = raw.split(/\r?\n/);
    const out = [];

    for (const line of lines) {
        const tags = [...line.matchAll(TAG_RE)];
        if (!tags.length) continue;
        const text = line.replace(TAG_RE, '').trim();
        for (const t of tags) {
            const min = parseInt(t[1], 10) || 0;
            const sec = parseInt(t[2], 10) || 0;
            let frac = t[3] || '0';
            frac = frac.length === 1 ? frac + '0' : frac;
            const ms = frac.length >= 3 ? parseInt(frac.slice(0, 3), 10) : parseInt(frac, 10) * 10;
            const time = min * 60 + sec + ms / 1000;
            out.push({ time, text });
        }
    }

    out.sort((a, b) => a.time - b.time);
    return out;
}

export function formatLRCTime(seconds) {
    if (isNaN(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.floor((seconds - Math.floor(seconds)) * 100);
    return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}]`;
}

export function getActiveLineIndex(lines, currentTime) {
    if (!lines || !lines.length) return -1;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].time <= currentTime) idx = i;
        else break;
    }
    return idx;
}

export function mountSyncedLyrics(container, audio, lrcText) {
    const lines = parseLRC(lrcText);
    container.innerHTML = '';

    if (!lines.length) {
        container.innerHTML = `<div class="lyrics-empty">No synced lyrics yet.<br>Tap "Edit Lyrics" to add some.</div>`;
        return { destroy() {}, lines };
    }

    lines.forEach((line, i) => {
        const p = document.createElement('p');
        p.className = 'lyric-line';
        p.dataset.index = i;
        p.textContent = line.text || '♪';
        container.appendChild(p);
    });

    let lastIdx = -1;
    function tick() {
        const idx = getActiveLineIndex(lines, audio.currentTime || 0);
        if (idx !== lastIdx) {
            const prevEl = container.querySelector('.lyric-line.active');
            if (prevEl) prevEl.classList.remove('active');
            const el = container.querySelector(`.lyric-line[data-index="${idx}"]`);
            if (el) {
                el.classList.add('active');
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            lastIdx = idx;
        }
        raf = requestAnimationFrame(tick);
    }
    let raf = requestAnimationFrame(tick);

    return {
        lines,
        destroy() { cancelAnimationFrame(raf); }
    };
}

const TAG_TEST_RE = /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/;

export function hasSyncedLyrics(track) {
    if (!track || !track.lrc || typeof track.lrc !== 'string') return false;
    if (!track.lrc.trim()) return false;
    return TAG_TEST_RE.test(track.lrc);
}

export function tagTimestampAtCursor(textarea, currentTime) {
    const tag = formatLRCTime(currentTime);
    const value = textarea.value;
    const caret = textarea.selectionStart ?? value.length;

    const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
    const alreadyTagged = /^\s*\[\d{1,2}:\d{2}/.test(value.slice(lineStart));

    let newValue, newCaret;
    if (alreadyTagged) {
        newValue = value.slice(0, lineStart) + tag + value.slice(lineStart);
        newCaret = caret + tag.length;
    } else {
        newValue = value.slice(0, lineStart) + tag + value.slice(lineStart);
        newCaret = caret + tag.length;
    }

    textarea.value = newValue;
    textarea.selectionStart = textarea.selectionEnd = newCaret;
    textarea.focus();
    return newValue;
}
