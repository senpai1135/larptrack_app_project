const HISTORY_KEY = 'lt-smart-history';
const SPEED_KEY = 'lt-playback-speed';
const HISTORY_MAX = 10;

const SPEED_MIN = 0.5;
const SPEED_MAX = 2.0;
const SPEED_STEP = 0.05;
const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const SLEEP_PRESETS_MIN = [15, 30, 45, 60, 90];
const SLEEP_MIN_MINUTES = 1;
const SLEEP_MAX_MINUTES = 240;
const FADE_WINDOW_MS = 20_000;

const getEl = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;

const ICONS = {
    speed: `<svg class="row-menu-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9 9 0 100-18 9 9 0 000 18z"/><path stroke-linecap="round" stroke-linejoin="round" d="M12 12l4-3"/><path stroke-linecap="round" d="M12 7.5v1M6.5 12h1M16.5 12h1"/></svg>`,
    sleep: `<svg class="row-menu-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M20.5 13.65A8.5 8.5 0 1110.35 3.5a6.7 6.7 0 0010.15 10.15z"/></svg>`,
    history: `<svg class="row-menu-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" stroke-linejoin="round" d="M12 7.5V12l3.2 1.9"/></svg>`,
    back: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path stroke-linecap="round" stroke-linejoin="round" d="M15 18l-6-6 6-6"/></svg>`,
};

function dismissMenu(menu) {
    if (typeof window.__ltCloseRowMenu === 'function') window.__ltCloseRowMenu(menu);
    else menu.classList.remove('open');
}
function repositionMenu(menu, triggerBtn) {
    if (typeof window.__ltRepositionRowMenu === 'function' && triggerBtn) {
        window.__ltRepositionRowMenu(menu, triggerBtn);
    }
}

function loadHistory() {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e === 'object' && e.id != null) : [];
    } catch (e) {
        console.warn('LarpTrack features: could not read history —', e.message);
        return [];
    }
}

function saveHistory(list) {
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
    } catch (e) {
        console.warn('LarpTrack features: could not save history —', e.message);
    }
}

function recordFullyListened(track) {
    if (!track || track.id == null) return;
    const entry = {
        id: track.id,
        name: track.name || 'Untitled',
        author: track.author || 'Unknown Artist',
        cover: track.cover || '',
        at: Date.now(),
    };
    const list = loadHistory().filter((e) => e.id !== track.id);
    list.unshift(entry);
    saveHistory(list);
}

function popoverOption(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
}

function makeTriggerBtn(iconSvg, labelText) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = iconSvg;
    const label = document.createElement('span');
    label.className = 'row-menu-label';
    label.textContent = labelText;
    btn.appendChild(label);
    return { btn, label };
}

function makeDrillHeader(title, onBack) {
    const header = document.createElement('div');
    header.className = 'menu-drill-header';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'menu-drill-back';
    back.setAttribute('data-keep-open', 'true');
    back.setAttribute('aria-label', 'Back');
    back.innerHTML = ICONS.back;
    back.addEventListener('click', (e) => { e.stopPropagation(); onBack(); });
    header.appendChild(back);
    const titleEl = document.createElement('span');
    titleEl.textContent = title;
    header.appendChild(titleEl);
    return header;
}

let closeActiveDrill = null;

function openDrillPanel(menu, triggerBtn, buildContent) {
    if (closeActiveDrill) closeActiveDrill();

    const normalRows = Array.from(menu.children);
    normalRows.forEach((el) => { el.style.display = 'none'; });

    const wrap = document.createElement('div');
    wrap.className = 'menu-drill';
    menu.insertBefore(wrap, menu.firstChild);

    function close() {
        wrap.remove();
        normalRows.forEach((el) => { el.style.display = ''; });
        closeActiveDrill = null;
        repositionMenu(menu, triggerBtn);
    }
    closeActiveDrill = close;

    buildContent(wrap, close);
    repositionMenu(menu, triggerBtn);
    return close;
}

export function initExtendedFeatures(state, audio, callbacks = {}) {
    if (!audio) { console.warn('LarpTrack features: no <audio> element — extended features disabled'); return; }
    const { onSelectTrack, getPitchSemitones, setPitchSemitones, pitchMin, pitchMax, ensureAudioGraph } = callbacks;

    const menu = getEl('player-more-menu');
    const insertBeforeEl = getEl('edit-track-btn');
    const triggerBtn = getEl('player-more-btn');
    if (!menu) return;

    if (menu.dataset.ltFeaturesInit === '1') {
        console.warn('LarpTrack features: initExtendedFeatures() already ran for this menu — skipping duplicate init');
        return;
    }
    menu.dataset.ltFeaturesInit = '1';

    initSpeedControl(menu, insertBeforeEl, triggerBtn, audio, { getPitchSemitones, setPitchSemitones, pitchMin, pitchMax, ensureAudioGraph });
    initSleepTimer(menu, insertBeforeEl, triggerBtn, audio);
    initHistoryLog(menu, insertBeforeEl, triggerBtn, state, audio, onSelectTrack);
}

function formatSpeed(v) { return `${round2(v)}x`; }

function initSpeedControl(menu, insertBeforeEl, triggerBtn, audio, pitchApi = {}) {
    const { getPitchSemitones, setPitchSemitones, pitchMin = -12, pitchMax = 12, ensureAudioGraph } = pitchApi;
    const pitchAvailable = typeof getPitchSemitones === 'function' && typeof setPitchSemitones === 'function';

    let savedRaw = NaN;
    try {
        const stored = localStorage.getItem(SPEED_KEY);
        if (stored !== null && stored !== '') savedRaw = Number(stored);
    } catch (e) { }
    let speed = clamp(Number.isFinite(savedRaw) ? savedRaw : 1, SPEED_MIN, SPEED_MAX);

    const { btn, label } = makeTriggerBtn(ICONS.speed, `${formatSpeed(speed)} Speed`);
    btn.setAttribute('data-keep-open', 'true');
    menu.insertBefore(btn, insertBeforeEl);

    let valueEl = null;
    let sliderEl = null;
    let chipEls = [];

    function apply(rate, { persist = true } = {}) {
        if (!Number.isFinite(rate)) return;
        rate = clamp(round2(rate), SPEED_MIN, SPEED_MAX);
        speed = rate;

        try {
            audio.playbackRate = rate;
            if ('preservesPitch' in audio) audio.preservesPitch = true;
            if ('mozPreservesPitch' in audio) audio.mozPreservesPitch = true;
            if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = true;
        } catch (e) {
            console.warn('LarpTrack features: could not set playback rate —', e.message);
        }

        if (persist) {
            try { localStorage.setItem(SPEED_KEY, String(rate)); }
            catch (e) { }
        }

        label.textContent = `${formatSpeed(rate)} Speed`;
        if (valueEl) valueEl.textContent = formatSpeed(rate);
        if (sliderEl && Math.abs(Number(sliderEl.value) - rate) > 0.001) sliderEl.value = String(rate);
        chipEls.forEach((chip) => {
            chip.classList.toggle('selected', Math.abs(Number(chip.dataset.speed) - rate) < 0.001);
        });
    }

    apply(speed, { persist: false });

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof ensureAudioGraph === 'function') ensureAudioGraph();
        openDrillPanel(menu, triggerBtn, (wrap) => {
            wrap.appendChild(makeDrillHeader('Playback Speed', () => closeActiveDrill && closeActiveDrill()));

            valueEl = document.createElement('div');
            valueEl.className = 'menu-drill-value';
            valueEl.textContent = formatSpeed(speed);
            wrap.appendChild(valueEl);

            const sliderRow = document.createElement('div');
            sliderRow.className = 'menu-drill-slider-row';
            sliderEl = document.createElement('input');
            sliderEl.type = 'range';
            sliderEl.min = String(SPEED_MIN);
            sliderEl.max = String(SPEED_MAX);
            sliderEl.step = String(SPEED_STEP);
            sliderEl.value = String(speed);
            sliderEl.setAttribute('aria-label', 'Playback speed');
            sliderEl.addEventListener('input', () => apply(Number(sliderEl.value)));
            sliderRow.appendChild(sliderEl);
            wrap.appendChild(sliderRow);

            const chipsRow = document.createElement('div');
            chipsRow.className = 'menu-drill-chips';
            chipEls = SPEED_PRESETS.map((preset) => {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'menu-drill-chip';
                chip.dataset.speed = String(preset);
                chip.setAttribute('data-keep-open', 'true');
                chip.textContent = formatSpeed(preset);
                chip.addEventListener('click', (e) => { e.stopPropagation(); apply(preset); });
                chipsRow.appendChild(chip);
                return chip;
            });
            wrap.appendChild(chipsRow);

            if (pitchAvailable) {
                const pitchHeader = document.createElement('div');
                pitchHeader.className = 'menu-drill-subheader';
                pitchHeader.textContent = 'Pitch — independent of speed';
                wrap.appendChild(pitchHeader);

                const pitchValueEl = document.createElement('div');
                pitchValueEl.className = 'menu-drill-value';
                wrap.appendChild(pitchValueEl);

                function formatPitch(v) {
                    const r = Math.round(v * 10) / 10;
                    return r === 0 ? '0 st' : `${r > 0 ? '+' : ''}${r} st`;
                }

                const pitchSliderRow = document.createElement('div');
                pitchSliderRow.className = 'menu-drill-slider-row';
                const pitchSlider = document.createElement('input');
                pitchSlider.type = 'range';
                pitchSlider.min = String(pitchMin);
                pitchSlider.max = String(pitchMax);
                pitchSlider.step = '0.5';
                pitchSlider.value = String(getPitchSemitones());
                pitchSlider.setAttribute('aria-label', 'Pitch shift in semitones');
                pitchSlider.addEventListener('input', () => {
                    const v = Number(pitchSlider.value);
                    if (typeof ensureAudioGraph === 'function') ensureAudioGraph();
                    setPitchSemitones(v);
                    pitchValueEl.textContent = formatPitch(v);
                });
                pitchSliderRow.appendChild(pitchSlider);
                wrap.appendChild(pitchSliderRow);

                const pitchActionsRow = document.createElement('div');
                pitchActionsRow.className = 'menu-drill-chips';
                const resetChip = document.createElement('button');
                resetChip.type = 'button';
                resetChip.className = 'menu-drill-chip';
                resetChip.style.flex = '1 1 100%';
                resetChip.setAttribute('data-keep-open', 'true');
                resetChip.textContent = 'Reset Pitch';
                resetChip.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    setPitchSemitones(0);
                    pitchSlider.value = '0';
                    pitchValueEl.textContent = formatPitch(0);
                });
                pitchActionsRow.appendChild(resetChip);
                wrap.appendChild(pitchActionsRow);

                pitchValueEl.textContent = formatPitch(getPitchSemitones());
            }

            apply(speed, { persist: false });
        });
    });

    audio.addEventListener('loadedmetadata', () => apply(speed, { persist: false }));
}

function initSleepTimer(menu, insertBeforeEl, triggerBtn, audio) {
    const { btn, label } = makeTriggerBtn(ICONS.sleep, 'Sleep Timer');
    btn.setAttribute('data-keep-open', 'true');
    menu.insertBefore(btn, insertBeforeEl);

    let targetAt = null;
    let originalVolume = 1;
    let tickTimer = null;
    let fading = false;

    let renderDrillBody = null;

    function isRunning() { return targetAt != null; }

    function clearTimer() {
        const wasFading = fading;
        targetAt = null;
        fading = false;
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
        if (wasFading) {
            try { audio.volume = originalVolume; } catch (e) { }
        }
        label.textContent = 'Sleep Timer';
        if (renderDrillBody) renderDrillBody();
    }

    function start(minutes) {
        minutes = clamp(Math.round(Number(minutes) || 0), SLEEP_MIN_MINUTES, SLEEP_MAX_MINUTES);
        if (!minutes) return;
        clearTimer();
        originalVolume = Number.isFinite(audio.volume) ? audio.volume : 1;
        targetAt = Date.now() + minutes * 60_000;
        tickTimer = setInterval(tick, 500);
        tick();
        if (renderDrillBody) renderDrillBody();
    }

    function tick() {
        if (!targetAt) return;
        const remaining = targetAt - Date.now();

        if (remaining <= 0) {
            try { audio.pause(); } catch (e) { }
            clearTimer();
            return;
        }

        if (remaining <= FADE_WINDOW_MS && !fading) {
            fading = true;
            originalVolume = Number.isFinite(audio.volume) ? audio.volume : 1;
        }
        if (fading) {
            const t = Math.max(0, remaining / FADE_WINDOW_MS);
            audio.volume = clamp(originalVolume * t, 0, originalVolume);
        }

        const mm = Math.floor(remaining / 60_000);
        const ss = Math.floor((remaining % 60_000) / 1000).toString().padStart(2, '0');
        label.textContent = `${mm}:${ss} left`;
        const liveEl = document.querySelector('.menu-drill-sleep-live');
        if (liveEl) liveEl.textContent = `${mm}:${ss}`;
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && isRunning()) tick();
    });

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openDrillPanel(menu, triggerBtn, (wrap) => {
            renderDrillBody = () => {
                Array.from(wrap.children).slice(1).forEach((n) => n.remove());

                if (isRunning()) {
                    const remaining = Math.max(0, targetAt - Date.now());
                    const mm = Math.floor(remaining / 60_000);
                    const ss = Math.floor((remaining % 60_000) / 1000).toString().padStart(2, '0');

                    const live = document.createElement('div');
                    live.className = 'menu-drill-value menu-drill-sleep-live';
                    live.textContent = `${mm}:${ss}`;
                    wrap.appendChild(live);

                    const cancelRow = document.createElement('div');
                    cancelRow.className = 'menu-drill-custom-row';
                    const cancelBtn = document.createElement('button');
                    cancelBtn.type = 'button';
                    cancelBtn.className = 'extra-btn';
                    cancelBtn.style.flex = '1';
                    cancelBtn.textContent = 'Cancel Timer';
                    cancelBtn.setAttribute('data-keep-open', 'true');
                    cancelBtn.addEventListener('click', (ev) => { ev.stopPropagation(); clearTimer(); });
                    cancelRow.appendChild(cancelBtn);
                    wrap.appendChild(cancelRow);
                    return;
                }

                const hint = document.createElement('div');
                hint.className = 'menu-drill-empty';
                hint.style.textAlign = 'center';
                hint.textContent = 'Fade out and pause after…';
                wrap.appendChild(hint);

                const chipsRow = document.createElement('div');
                chipsRow.className = 'menu-drill-chips';
                SLEEP_PRESETS_MIN.forEach((mins) => {
                    const chip = document.createElement('button');
                    chip.type = 'button';
                    chip.className = 'menu-drill-chip';
                    chip.setAttribute('data-keep-open', 'true');
                    chip.textContent = `${mins}m`;
                    chip.addEventListener('click', (ev) => { ev.stopPropagation(); start(mins); });
                    chipsRow.appendChild(chip);
                });
                wrap.appendChild(chipsRow);

                const customRow = document.createElement('div');
                customRow.className = 'menu-drill-custom-row';
                const customInput = document.createElement('input');
                customInput.type = 'number';
                customInput.inputMode = 'numeric';
                customInput.min = String(SLEEP_MIN_MINUTES);
                customInput.max = String(SLEEP_MAX_MINUTES);
                customInput.placeholder = `Custom (${SLEEP_MIN_MINUTES}-${SLEEP_MAX_MINUTES} min)`;
                customInput.addEventListener('click', (ev) => ev.stopPropagation());
                customInput.addEventListener('keydown', (ev) => {
                    ev.stopPropagation();
                    if (ev.key === 'Enter') { ev.preventDefault(); start(customInput.value); }
                });
                const startBtn = document.createElement('button');
                startBtn.type = 'button';
                startBtn.className = 'extra-btn primary';
                startBtn.textContent = 'Start';
                startBtn.setAttribute('data-keep-open', 'true');
                startBtn.addEventListener('click', (ev) => { ev.stopPropagation(); start(customInput.value); });
                customRow.append(customInput, startBtn);
                wrap.appendChild(customRow);
            };

            wrap.appendChild(makeDrillHeader('Sleep Timer', () => closeActiveDrill && closeActiveDrill()));
            renderDrillBody();
        });
    });
}

function initHistoryLog(menu, insertBeforeEl, triggerBtn, state, audio, onSelectTrack) {
    const { btn: historyBtn } = makeTriggerBtn(ICONS.history, 'History');
    historyBtn.setAttribute('data-keep-open', 'true');
    menu.insertBefore(historyBtn, insertBeforeEl);

    historyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openDrillPanel(menu, triggerBtn, (wrap, close) => {
            wrap.appendChild(makeDrillHeader('History', close));

            const entries = loadHistory();
            if (!entries.length) {
                const empty = document.createElement('div');
                empty.className = 'menu-drill-empty';
                empty.textContent = 'Nothing fully played yet';
                wrap.appendChild(empty);
                return;
            }
            entries.forEach((entry) => {
                const item = popoverOption(`${entry.name} — ${entry.author}`, () => {
                    close();
                    dismissMenu(menu);
                    if (typeof onSelectTrack === 'function') onSelectTrack(entry.id);
                });
                wrap.appendChild(item);
            });
        });
    });

    let lastPlayingId = null;
    audio.addEventListener('timeupdate', () => {
        if (audio.currentTime > 0 && state) lastPlayingId = state.currentId;
    });
    audio.addEventListener('ended', () => {
        if (!state || !Array.isArray(state.tracks)) return;
        const id = lastPlayingId != null ? lastPlayingId : state.currentId;
        const track = state.tracks.find((t) => t.id === id);
        recordFullyListened(track);
    });
}
