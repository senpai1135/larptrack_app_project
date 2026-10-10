let audioCtx, analyser, source, dataArray;
let pos = [0, 0, 0, 0];
let vel = [0, 0, 0, 0];
let rafId = null;
let boundAudioEl = null;
let graphFailed = false;

function setParam(param, value, immediate = false) {
    if (!param || !Number.isFinite(value)) return;
    try {
        if (immediate || !audioCtx) {
            param.cancelScheduledValues(0);
            param.value = value;
        } else {
            const t = audioCtx.currentTime;
            param.cancelScheduledValues(t);
            param.setTargetAtTime(value, t, 0.02);
        }
    } catch (e) {
        try { param.value = value; } catch (err) { }
    }
}

function createBypassStage(hooks = {}) {
    const input = audioCtx.createGain();
    const output = audioCtx.createGain();
    const dry = audioCtx.createGain();
    const wet = audioCtx.createGain();
    input.connect(dry);
    dry.connect(output);
    wet.connect(output);
    dry.gain.value = 1;
    wet.gain.value = 0;

    const rampTime = hooks.rampTime || 0.015;
    let isActive = false;
    let generation = 0;
    let timer = null;

    function ramp(active) {
        const now = audioCtx.currentTime;
        [dry.gain, wet.gain].forEach((p) => { p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); });
        dry.gain.linearRampToValueAtTime(active ? 0 : 1, now + rampTime);
        wet.gain.linearRampToValueAtTime(active ? 1 : 0, now + rampTime);
    }

    function setActive(active) {
        active = !!active;
        if (active === isActive) return;
        isActive = active;
        const myGen = ++generation;
        clearTimeout(timer);

        if (active) {
            if (!hooks.attach) { ramp(true); return; }
            Promise.resolve()
                .then(() => hooks.attach())
                .then(() => {
                    if (myGen !== generation) return;
                    timer = setTimeout(() => { if (myGen === generation) ramp(true); }, hooks.preroll || 0);
                })
                .catch((e) => { console.warn('LarpTrack: stage failed to start —', e && e.message ? e.message : e); });
        } else {
            ramp(false);
            if (hooks.detach) {
                timer = setTimeout(() => { if (myGen === generation) hooks.detach(); }, rampTime * 1000 + 60);
            }
        }
    }
    return { input, output, wet, setActive };
}

export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const BAND_Q = 1.41;

const EQ_STATE_KEY = 'lt-eq-state-v2';
const OLD_EQ_KEY = 'lt-eq-values';
const PITCH_KEY = 'lt-pitch-semitones';

export const EQ_PRESETS = {
    flat:      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bassBoost: [7, 6, 4, 2, 0, 0, 0, 0, 0, 0],
    trebleBoost: [0, 0, 0, 0, 0, 0, 2, 4, 6, 7],
    vocal:     [-2, -2, -1, 1, 3, 3, 2, 1, -1, -2],
    rock:      [5, 3, -2, -3, -1, 1, 3, 4, 4, 4],
    pop:       [-1, 2, 4, 4, 2, 0, -1, -1, 1, 2],
    classical: [4, 3, 2, 0, 0, 0, -2, -2, 0, 3],
};

let eqStage = null;
let eqFilters = [];
const _loadedEq = loadEqState();
let eqEnabled = _loadedEq.enabled;
let eqBandValues = _loadedEq.bands;
let eqActivePreset = _loadedEq.preset;

function savedAmount(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && v !== null && v !== undefined ? Math.max(0, Math.min(100, n)) : fallback;
}

function clampDb(v) { return Math.max(-12, Math.min(12, Number(v) || 0)); }
function clampBalance(v) { return Math.max(-1, Math.min(1, Number(v) || 0)); }

function nameMatchingPreset(values) {
    for (const [name, preset] of Object.entries(EQ_PRESETS)) {
        if (preset.every((v, i) => Math.abs(v - values[i]) < 0.05)) return name;
    }
    return 'custom';
}

export function setEqEnabled(enabled) {
    eqEnabled = !!enabled;
    eqStage?.setActive(eqEnabled);
    saveEqState();
}
export function isEqEnabled() { return eqEnabled; }

export function setBandGain(index, db) {
    if (!Number.isInteger(index) || index < 0 || index >= EQ_BANDS.length) return;
    db = clampDb(db);
    eqBandValues[index] = db;
    if (eqFilters[index]) setParam(eqFilters[index].gain, db);
    eqActivePreset = nameMatchingPreset(eqBandValues);
    saveEqState();
}
export function getBandGains() { return eqBandValues.slice(); }
export function getActivePreset() { return eqActivePreset; }

export function applyPreset(name) {
    const preset = EQ_PRESETS[name];
    if (!preset) return;
    preset.forEach((db, i) => {
        eqBandValues[i] = db;
        if (eqFilters[i]) setParam(eqFilters[i].gain, db);
    });
    eqActivePreset = name;
    saveEqState();
}

export function resetBands() { applyPreset('flat'); }

let bassBoostStage = null, bassBoostFilter = null;
let bassBoostEnabled = _loadedEq.bassBoost.enabled, bassBoostAmount = _loadedEq.bassBoost.amount;

export function setBassBoostEnabled(enabled) {
    bassBoostEnabled = !!enabled;
    bassBoostStage?.setActive(bassBoostEnabled);
    saveEqState();
}
export function setBassBoostAmount(pct) {
    bassBoostAmount = Math.max(0, Math.min(100, Number(pct) || 0));
    if (bassBoostFilter) setParam(bassBoostFilter.gain, (bassBoostAmount / 100) * 9);
    saveEqState();
}
export function getBassBoost() { return { enabled: bassBoostEnabled, amount: bassBoostAmount }; }

let loudnessStage = null, loudnessCompressor = null, loudnessMakeup = null;
let loudnessEnabled = _loadedEq.loudness.enabled, loudnessAmount = _loadedEq.loudness.amount;

export function setLoudnessEnabled(enabled) {
    loudnessEnabled = !!enabled;
    loudnessStage?.setActive(loudnessEnabled);
    saveEqState();
}
function applyLoudnessCurve(immediate) {
    const t = loudnessAmount / 100;
    if (loudnessCompressor) {
        setParam(loudnessCompressor.threshold, -6 - t * 24, immediate);
        setParam(loudnessCompressor.ratio, 2 + t * 8, immediate);
    }
    if (loudnessMakeup) setParam(loudnessMakeup.gain, 1 + t * 1.2, immediate);
}
export function setLoudnessAmount(pct) {
    loudnessAmount = Math.max(0, Math.min(100, Number(pct) || 0));
    applyLoudnessCurve(false);
    saveEqState();
}
export function getLoudness() { return { enabled: loudnessEnabled, amount: loudnessAmount }; }

let virtualizerStage = null, vSplitter = null, vMerger = null, vGainLL, vGainLR, vGainRL, vGainRR;
let virtualizerEnabled = _loadedEq.virtualizer.enabled, virtualizerAmount = _loadedEq.virtualizer.amount;

export function setVirtualizerEnabled(enabled) {
    virtualizerEnabled = !!enabled;
    virtualizerStage?.setActive(virtualizerEnabled);
    saveEqState();
}
function applyVirtualizerWidth(immediate) {
    const width = 1 + (virtualizerAmount / 100) * 1.5;
    if (!vGainLL) return;
    setParam(vGainLL.gain, 0.5 + 0.5 * width, immediate);
    setParam(vGainRR.gain, 0.5 + 0.5 * width, immediate);
    setParam(vGainLR.gain, 0.5 - 0.5 * width, immediate);
    setParam(vGainRL.gain, 0.5 - 0.5 * width, immediate);
}
export function setVirtualizerAmount(pct) {
    virtualizerAmount = Math.max(0, Math.min(100, Number(pct) || 0));
    applyVirtualizerWidth(false);
    saveEqState();
}
export function getVirtualizer() { return { enabled: virtualizerEnabled, amount: virtualizerAmount }; }

let balanceStage = null, balancePanner = null;
let balanceEnabled = _loadedEq.balance.enabled, balanceValue = _loadedEq.balance.value;

export function setBalanceEnabled(enabled) {
    balanceEnabled = !!enabled;
    balanceStage?.setActive(balanceEnabled);
    saveEqState();
}
export function setBalance(value) {
    balanceValue = clampBalance(value);
    if (balancePanner) setParam(balancePanner.pan, balanceValue);
    saveEqState();
}
export function getBalance() { return { enabled: balanceEnabled, value: balanceValue }; }

export const PITCH_MIN = -12;
export const PITCH_MAX = 12;
const PITCH_PROC_NAME = 'lt-pitch-shifter';

let pitchStage = null;
let pitchSemitones = loadPitchState();

function createPitchCore(sampleRate, cfg) {
    const fs = sampleRate;
    const ms = (v) => Math.max(1, Math.round(v * fs / 1000));
    cfg = cfg || {};

    const OVL = ms(cfg.overlapMs || 8);
    const SEQ_SLOW = cfg.seqSlowMs || 90, SEQ_FAST = cfg.seqFastMs || 40;
    const SEEK_SLOW = cfg.seekSlowMs || 22, SEEK_FAST = cfg.seekFastMs || 14;
    const SEQ_MAX = ms(Math.max(SEQ_SLOW, SEQ_FAST)) + 2;

    const CH = 512;
    const IN_CAP = 65536;
    const S_CAP = SEQ_MAX + 10 * CH + 64;

    const inL = new Float32Array(IN_CAP), inR = new Float32Array(IN_CAP), inM = new Float32Array(IN_CAP);
    const sL = new Float32Array(S_CAP), sR = new Float32Array(S_CAP);
    const midL = new Float32Array(OVL), midR = new Float32Array(OVL), midM = new Float32Array(OVL);

    let inLen = 0, inPos = 0, skipFract = 0, haveMid = false, primed = false;
    let sLen = 1, rpos = 1;
    let target = 1, cur = 1;
    let margin = ms(20);
    let marginSet = false;
    const smoothK = 1 - Math.exp(-1 / (0.03 * fs));

    const lp = [
        { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, zl1: 0, zl2: 0, zr1: 0, zr2: 0 },
        { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, zl1: 0, zl2: 0, zr1: 0, zr2: 0 },
    ];
    function setLowpass(fc) {
        const qs = [0.5412, 1.3066];
        fc = Math.min(fc, fs * 0.49);
        const w0 = 2 * Math.PI * fc / fs, cw = Math.cos(w0), sw = Math.sin(w0);
        for (let s = 0; s < 2; s++) {
            const alpha = sw / (2 * qs[s]);
            const a0 = 1 + alpha;
            const f = lp[s];
            f.b0 = ((1 - cw) / 2) / a0;
            f.b1 = (1 - cw) / a0;
            f.b2 = f.b0;
            f.a1 = (-2 * cw) / a0;
            f.a2 = (1 - alpha) / a0;
        }
    }
    setLowpass(fs * 0.45);

    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    function setRatio(r) {
        r = clamp(+r || 1, 0.25, 4);
        target = r;
        setLowpass(0.45 * fs / Math.max(1, r));
    }

    function reset() {
        inLen = 0; inPos = 0; skipFract = 0; haveMid = false; primed = false;
        sLen = 1; rpos = 1; sL[0] = 0; sR[0] = 0;
        midL.fill(0); midR.fill(0); midM.fill(0);
        for (let s = 0; s < 2; s++) { const f = lp[s]; f.zl1 = f.zl2 = f.zr1 = f.zr2 = 0; }
        cur = target;
    }

    function lerp(a, b, t) { return a + (b - a) * t; }
    function grainParams(tempo) {
        const t = clamp((tempo - 0.5) / 1.5, 0, 1);
        return {
            seq: ms(lerp(SEQ_SLOW, SEQ_FAST, t)),
            seek: ms(lerp(SEEK_SLOW, SEEK_FAST, t)),
        };
    }

    function compactIn() {
        if (inPos <= 0) return;
        const keep = inLen - inPos;
        if (keep > 0) {
            inL.copyWithin(0, inPos, inLen); inR.copyWithin(0, inPos, inLen); inM.copyWithin(0, inPos, inLen);
        }
        inLen = Math.max(0, keep); inPos = 0;
    }
    function compactS() {
        const drop = Math.floor(rpos) - 1;
        if (drop <= 0) return;
        const keep = sLen - drop;
        if (keep > 0) { sL.copyWithin(0, drop, sLen); sR.copyWithin(0, drop, sLen); }
        sLen = Math.max(1, keep); rpos -= drop;
    }

    function bestOffset(base, seek) {
        let energy = 0;
        for (let k = 0; k < OVL; k++) { const v = inM[base + k]; energy += v * v; }
        let best = 0, bestScore = -1e30;
        for (let o = 0; o < seek; o++) {
            if (o > 0) {
                const add = inM[base + o + OVL - 1], sub = inM[base + o - 1];
                energy += add * add - sub * sub;
            }
            let corr = 0;
            const p = base + o;
            for (let k = 0; k < OVL; k++) corr += midM[k] * inM[p + k];
            const score = corr / Math.sqrt(energy > 0 ? energy + 1e-9 : 1e-9);
            if (score > bestScore) { bestScore = score; best = o; }
        }
        return best;
    }

    function runGrain() {
        const tempo = 1 / cur;
        const gp = grainParams(tempo);
        const seq = gp.seq, seek = gp.seek;
        const need = seek + seq + 2;
        if (inLen - inPos < need + (primed ? 0 : margin)) return false;
        primed = true;

        const hs = seq - OVL;
        if (sLen + hs > S_CAP) compactS();
        if (sLen + hs > S_CAP) return false;

        const base = inPos;
        const off = haveMid ? bestOffset(base, seek) : 0;
        const p = base + off;

        for (let k = 0; k < OVL; k++) {
            const w = (k + 0.5) / OVL;
            sL[sLen + k] = midL[k] * (1 - w) + inL[p + k] * w;
            sR[sLen + k] = midR[k] * (1 - w) + inR[p + k] * w;
        }
        if (!haveMid) { for (let k = 0; k < OVL; k++) { const w = (k + 0.5) / OVL; sL[sLen + k] = inL[p + k] * w; sR[sLen + k] = inR[p + k] * w; } }
        const mid = seq - 2 * OVL;
        for (let k = 0; k < mid; k++) {
            sL[sLen + OVL + k] = inL[p + OVL + k];
            sR[sLen + OVL + k] = inR[p + OVL + k];
        }
        sLen += hs;
        const tail = p + seq - OVL;
        for (let k = 0; k < OVL; k++) { midL[k] = inL[tail + k]; midR[k] = inR[tail + k]; midM[k] = inM[tail + k]; }
        haveMid = true;

        skipFract += tempo * hs;
        const sk = Math.floor(skipFract);
        skipFract -= sk;
        inPos += sk;
        return true;
    }

    function appendInput(srcL, srcR, start, c) {
        if (inLen + c > IN_CAP) compactIn();
        if (inLen + c > IN_CAP) {
            const over = inLen + c - IN_CAP;
            inPos = Math.min(inLen, Math.max(inPos, over)); compactIn();
        }
        const f0 = lp[0], f1 = lp[1];
        for (let i = 0; i < c; i++) {
            let xl = srcL[start + i], xr = srcR[start + i];
            let yl = f0.b0 * xl + f0.zl1; f0.zl1 = f0.b1 * xl - f0.a1 * yl + f0.zl2; f0.zl2 = f0.b2 * xl - f0.a2 * yl;
            let yr = f0.b0 * xr + f0.zr1; f0.zr1 = f0.b1 * xr - f0.a1 * yr + f0.zr2; f0.zr2 = f0.b2 * xr - f0.a2 * yr;
            xl = yl; xr = yr;
            yl = f1.b0 * xl + f1.zl1; f1.zl1 = f1.b1 * xl - f1.a1 * yl + f1.zl2; f1.zl2 = f1.b2 * xl - f1.a2 * yl;
            yr = f1.b0 * xr + f1.zr1; f1.zr1 = f1.b1 * xr - f1.a1 * yr + f1.zr2; f1.zr2 = f1.b2 * xr - f1.a2 * yr;
            const idx = inLen + i;
            inL[idx] = yl; inR[idx] = yr; inM[idx] = 0.5 * (yl + yr);
        }
        inLen += c;
    }

    function process(srcL, srcR, dstL, dstR, n) {
        if (!marginSet) { margin = Math.max(ms(20), Math.ceil(Math.min(n, CH) * 1.5)); marginSet = true; }
        for (let start = 0; start < n; start += CH) {
            const c = Math.min(CH, n - start);
            appendInput(srcL, srcR, start, c);
            for (let i = 0; i < c; i++) {
                cur += (target - cur) * smoothK;
                if (Math.abs(target - cur) < 1e-5) cur = target;

                while (rpos + 2 >= sLen) { if (!runGrain()) break; }
                if (rpos + 2 >= sLen) { dstL[start + i] = 0; dstR[start + i] = 0; continue; }

                const i0 = Math.floor(rpos), t = rpos - i0;
                const t2 = t * t, t3 = t2 * t;
                const c0 = -0.5 * t3 + t2 - 0.5 * t;
                const c1 = 1.5 * t3 - 2.5 * t2 + 1;
                const c2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
                const c3 = 0.5 * t3 - 0.5 * t2;
                dstL[start + i] = c0 * sL[i0 - 1] + c1 * sL[i0] + c2 * sL[i0 + 1] + c3 * sL[i0 + 2];
                dstR[start + i] = c0 * sR[i0 - 1] + c1 * sR[i0] + c2 * sR[i0 + 1] + c3 * sR[i0 + 2];
                rpos += cur;
            }
            compactS();
        }
    }

    return { process, setRatio, reset };
}

const pitchEngine = { node: null, kind: null, core: null, ready: null, attached: false };

function pitchWorkletSource() {
    return `const makeCore = (${createPitchCore.toString()});
class LTPitchProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.core = makeCore(sampleRate);
        this.port.onmessage = (e) => {
            const d = e.data || {};
            if (typeof d.ratio === 'number') this.core.setRatio(d.ratio);
            if (d.reset) this.core.reset();
        };
    }
    process(inputs, outputs) {
        const out = outputs[0];
        if (!out || !out[0]) return true;
        const oL = out[0], oR = out[1] || out[0];
        const inp = inputs[0];
        if (!inp || !inp[0]) { oL.fill(0); if (out[1]) out[1].fill(0); return true; }
        this.core.process(inp[0], inp[1] || inp[0], oL, oR, oL.length);
        return true;
    }
}
registerProcessor('${PITCH_PROC_NAME}', LTPitchProcessor);`;
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out')), ms);
        promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}

function buildScriptProcessorEngine() {
    const core = createPitchCore(audioCtx.sampleRate);
    const node = audioCtx.createScriptProcessor(4096, 2, 2);
    node.onaudioprocess = (e) => {
        try {
            const ib = e.inputBuffer, ob = e.outputBuffer;
            const iL = ib.getChannelData(0);
            const iR = ib.numberOfChannels > 1 ? ib.getChannelData(1) : iL;
            const oL = ob.getChannelData(0);
            const oR = ob.numberOfChannels > 1 ? ob.getChannelData(1) : oL;
            core.process(iL, iR, oL, oR, iL.length);
        } catch (err) { }
    };
    pitchEngine.node = node;
    pitchEngine.core = core;
    pitchEngine.kind = 'script';
}

function loadPitchEngine() {
    if (pitchEngine.ready) return pitchEngine.ready;
    pitchEngine.ready = (async () => {
        const canWorklet = audioCtx && audioCtx.audioWorklet && typeof AudioWorkletNode === 'function'
            && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
        if (canWorklet) {
            let url = null;
            try {
                url = URL.createObjectURL(new Blob([pitchWorkletSource()], { type: 'application/javascript' }));
                await withTimeout(audioCtx.audioWorklet.addModule(url), 5000);
                const node = new AudioWorkletNode(audioCtx, PITCH_PROC_NAME, {
                    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
                    channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
                });
                node.onprocessorerror = () => {
                    console.warn('LarpTrack: pitch worklet crashed — switching to fallback');
                    const wasAttached = pitchEngine.attached;
                    detachPitchNode();
                    try { node.disconnect(); } catch (e) {}
                    buildScriptProcessorEngine();
                    if (wasAttached && pitchStage) attachPitchNode();
                };
                pitchEngine.node = node;
                pitchEngine.kind = 'worklet';
                return;
            } catch (e) {
                console.warn('LarpTrack: AudioWorklet unavailable — using ScriptProcessor fallback.', e && e.message ? e.message : e);
            } finally {
                if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
            }
        }
        buildScriptProcessorEngine();
    })();
    return pitchEngine.ready;
}

function sendPitchRatio() {
    const ratio = 2 ** (pitchSemitones / 12);
    if (pitchEngine.kind === 'worklet') { try { pitchEngine.node.port.postMessage({ ratio }); } catch (e) {} }
    else if (pitchEngine.kind === 'script' && pitchEngine.core) pitchEngine.core.setRatio(ratio);
}
function resetPitchEngine() {
    if (pitchEngine.kind === 'worklet') { try { pitchEngine.node.port.postMessage({ reset: true }); } catch (e) {} }
    else if (pitchEngine.kind === 'script' && pitchEngine.core) pitchEngine.core.reset();
}

function attachPitchNode() {
    return loadPitchEngine().then(() => {
        if (pitchEngine.attached || !pitchEngine.node || !pitchStage) return;
        sendPitchRatio();
        resetPitchEngine();
        pitchStage.input.connect(pitchEngine.node);
        pitchEngine.node.connect(pitchStage.wet);
        pitchEngine.attached = true;
    });
}
function detachPitchNode() {
    if (!pitchEngine.attached || !pitchEngine.node || !pitchStage) return;
    try { pitchStage.input.disconnect(pitchEngine.node); } catch (e) {}
    try { pitchEngine.node.disconnect(pitchStage.wet); } catch (e) {}
    pitchEngine.attached = false;
}

export function setPitchSemitones(semitones) {
    semitones = Math.max(PITCH_MIN, Math.min(PITCH_MAX, Number(semitones) || 0));
    pitchSemitones = semitones;
    sendPitchRatio();
    pitchStage?.setActive(Math.abs(semitones) > 0.001);
    savePitchState();
}
export function getPitchSemitones() { return pitchSemitones; }
export function resetPitch() { setPitchSemitones(0); }

let eqSaveTimer = null, pitchSaveTimer = null;

function flushEqState() {
    eqSaveTimer = null;
    try {
        localStorage.setItem(EQ_STATE_KEY, JSON.stringify({
            enabled: eqEnabled,
            bands: eqBandValues,
            preset: eqActivePreset,
            bassBoost: { enabled: bassBoostEnabled, amount: bassBoostAmount },
            loudness: { enabled: loudnessEnabled, amount: loudnessAmount },
            virtualizer: { enabled: virtualizerEnabled, amount: virtualizerAmount },
            balance: { enabled: balanceEnabled, value: balanceValue },
        }));
    } catch (e) { }
}
function flushPitchState() {
    pitchSaveTimer = null;
    try { localStorage.setItem(PITCH_KEY, String(pitchSemitones)); } catch (e) {}
}
function saveEqState() { if (eqSaveTimer === null) eqSaveTimer = setTimeout(flushEqState, 300); }
function savePitchState() { if (pitchSaveTimer === null) pitchSaveTimer = setTimeout(flushPitchState, 300); }

function flushAllPending() {
    if (eqSaveTimer !== null) { clearTimeout(eqSaveTimer); flushEqState(); }
    if (pitchSaveTimer !== null) { clearTimeout(pitchSaveTimer); flushPitchState(); }
}
if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushAllPending);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAllPending(); });
}

function loadEqState() {
    try {
        const raw = localStorage.getItem(EQ_STATE_KEY);
        if (raw) {
            const p = JSON.parse(raw) || {};
            return {
                enabled: p.enabled !== false,
                bands: Array.isArray(p.bands) && p.bands.length === 10 ? p.bands.map((v) => clampDb(v)) : EQ_PRESETS.flat.slice(),
                preset: typeof p.preset === 'string' ? p.preset : 'custom',
                bassBoost: { enabled: !!p.bassBoost?.enabled, amount: savedAmount(p.bassBoost?.amount, 70) },
                loudness: { enabled: !!p.loudness?.enabled, amount: savedAmount(p.loudness?.amount, 70) },
                virtualizer: { enabled: !!p.virtualizer?.enabled, amount: savedAmount(p.virtualizer?.amount, 60) },
                balance: { enabled: !!p.balance?.enabled, value: clampBalance(p.balance?.value) },
            };
        }
        const oldRaw = localStorage.getItem(OLD_EQ_KEY);
        if (oldRaw) {
            const old = JSON.parse(oldRaw) || {};
            const bands = EQ_PRESETS.flat.slice();
            const bass = clampDb(old.bass), mid = clampDb(old.mid), treble = clampDb(old.treble);
            [0, 1, 2].forEach((i) => { bands[i] = bass; });
            [4, 5].forEach((i) => { bands[i] = mid; });
            [7, 8, 9].forEach((i) => { bands[i] = treble; });
            return { enabled: true, bands, preset: 'custom', bassBoost: { enabled: false, amount: 70 }, loudness: { enabled: false, amount: 70 }, virtualizer: { enabled: false, amount: 60 }, balance: { enabled: false, value: 0 } };
        }
    } catch (e) { }
    return { enabled: true, bands: EQ_PRESETS.flat.slice(), preset: 'flat', bassBoost: { enabled: false, amount: 70 }, loudness: { enabled: false, amount: 70 }, virtualizer: { enabled: false, amount: 60 }, balance: { enabled: false, value: 0 } };
}

function loadPitchState() {
    try {
        const raw = localStorage.getItem(PITCH_KEY);
        return raw != null ? Math.max(PITCH_MIN, Math.min(PITCH_MAX, Number(raw) || 0)) : 0;
    } catch (e) { return 0; }
}

export function initAudioVisualizer(audioEl) {
    if (!audioEl || audioCtx || graphFailed) return;
    boundAudioEl = audioEl;

    try {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) throw new Error('Web Audio API not supported');
        audioCtx = new Ctor();
        source = audioCtx.createMediaElementSource(audioEl);

        eqStage = createBypassStage();
        eqFilters = EQ_BANDS.map((freq) => {
            const f = audioCtx.createBiquadFilter();
            f.type = 'peaking';
            f.frequency.value = freq;
            f.Q.value = BAND_Q;
            f.gain.value = 0;
            return f;
        });
        let node = eqStage.input;
        eqFilters.forEach((f) => { node.connect(f); node = f; });
        node.connect(eqStage.wet);

        bassBoostStage = createBypassStage();
        bassBoostFilter = audioCtx.createBiquadFilter();
        bassBoostFilter.type = 'lowshelf';
        bassBoostFilter.frequency.value = 120;
        bassBoostFilter.gain.value = 0;
        bassBoostStage.input.connect(bassBoostFilter);
        bassBoostFilter.connect(bassBoostStage.wet);

        loudnessStage = createBypassStage();
        loudnessCompressor = audioCtx.createDynamicsCompressor();
        loudnessCompressor.knee.value = 12;
        loudnessCompressor.attack.value = 0.01;
        loudnessCompressor.release.value = 0.25;
        loudnessMakeup = audioCtx.createGain();
        loudnessStage.input.connect(loudnessCompressor);
        loudnessCompressor.connect(loudnessMakeup);
        loudnessMakeup.connect(loudnessStage.wet);

        virtualizerStage = createBypassStage();
        vSplitter = audioCtx.createChannelSplitter(2);
        vMerger = audioCtx.createChannelMerger(2);
        vGainLL = audioCtx.createGain(); vGainLR = audioCtx.createGain();
        vGainRL = audioCtx.createGain(); vGainRR = audioCtx.createGain();
        virtualizerStage.input.channelCount = 2;
        virtualizerStage.input.channelCountMode = 'explicit';
        virtualizerStage.input.connect(vSplitter);
        vSplitter.connect(vGainLL, 0); vGainLL.connect(vMerger, 0, 0);
        vSplitter.connect(vGainLR, 0); vGainLR.connect(vMerger, 0, 1);
        vSplitter.connect(vGainRL, 1); vGainRL.connect(vMerger, 0, 0);
        vSplitter.connect(vGainRR, 1); vGainRR.connect(vMerger, 0, 1);
        vMerger.connect(virtualizerStage.wet);

        balanceStage = createBypassStage();
        balancePanner = audioCtx.createStereoPanner();
        balanceStage.input.connect(balancePanner);
        balancePanner.connect(balanceStage.wet);

        pitchStage = createBypassStage({
            attach: attachPitchNode,
            detach: detachPitchNode,
            preroll: 220,
            rampTime: 0.06,
        });

        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.45;
        dataArray = new Uint8Array(analyser.frequencyBinCount);

        source.connect(eqStage.input);
        eqStage.output.connect(bassBoostStage.input);
        bassBoostStage.output.connect(loudnessStage.input);
        loudnessStage.output.connect(virtualizerStage.input);
        virtualizerStage.output.connect(balanceStage.input);
        balanceStage.output.connect(pitchStage.input);
        pitchStage.output.connect(analyser);
        analyser.connect(audioCtx.destination);

        applyLoadedStateToNodes();
        bindVisualizerLoop(audioEl);
        startLoop();
    } catch (e) {
        console.error('Visualizer init failed:', e);
        graphFailed = true;
        try { source?.disconnect(); source?.connect(audioCtx.destination); } catch (err) { }
    }
}

export function ensureAudioGraph(audioEl) {
    if (!audioCtx && !graphFailed) initAudioVisualizer(audioEl || boundAudioEl);
    resumeAudioContext();
    return !!audioCtx && !graphFailed;
}
export function isAudioGraphReady() { return !!audioCtx && audioCtx.state === 'running'; }

function applyLoadedStateToNodes() {
    eqFilters.forEach((f, i) => setParam(f.gain, eqBandValues[i], true));
    eqStage.setActive(eqEnabled);

    setParam(bassBoostFilter.gain, (bassBoostAmount / 100) * 9, true);
    bassBoostStage.setActive(bassBoostEnabled);

    applyLoudnessCurve(true);
    loudnessStage.setActive(loudnessEnabled);

    applyVirtualizerWidth(true);
    virtualizerStage.setActive(virtualizerEnabled);

    setParam(balancePanner.pan, balanceValue, true);
    balanceStage.setActive(balanceEnabled);

    pitchStage.setActive(Math.abs(pitchSemitones) > 0.001);
}

export function resumeAudioContext() {
    if (audioCtx && audioCtx.state !== 'running' && audioCtx.state !== 'closed') audioCtx.resume().catch(() => {});
}

let eqSpans = [];
let lastHeights = [];
let loopBound = false;

function refreshSpans() {
    eqSpans = Array.from(document.querySelectorAll('.equalizer span'));
    lastHeights = eqSpans.map(() => -1);
}

function writeHeight(i, px) {
    if (lastHeights[i] === px) return;
    lastHeights[i] = px;
    eqSpans[i].style.height = `${px}px`;
}

function rms() {
    let sumSq = 0;
    for (let i = 0; i < dataArray.length; i++) sumSq += dataArray[i] * dataArray[i];
    return Math.sqrt(sumSq / dataArray.length);
}

function avg(start, end) {
    const last = Math.min(end, dataArray.length - 1);
    if (last < start) return 0;
    let s = 0;
    for (let i = start; i <= last; i++) s += dataArray[i];
    return s / (last - start + 1);
}

function isPlayingNow() {
    return !!(analyser && boundAudioEl && !boundAudioEl.paused && !boundAudioEl.ended);
}

function startLoop() {
    if (rafId === null && !document.hidden) rafId = requestAnimationFrame(renderFrame);
}
function stopLoop() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
}

function bindVisualizerLoop(audioEl) {
    if (loopBound) return;
    loopBound = true;
    ['play', 'playing', 'pause', 'ended', 'seeked'].forEach((evt) => audioEl.addEventListener(evt, startLoop));
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) { stopLoop(); return; }
        if (isPlayingNow()) resumeAudioContext();
        startLoop();
    });
}

function renderFrame() {
    rafId = null;
    if (document.hidden) return;

    if (!eqSpans.length || !eqSpans[0].isConnected) refreshSpans();
    if (!eqSpans.length) {
        if (isPlayingNow()) setTimeout(startLoop, 1000);
        return;
    }

    if (!isPlayingNow()) {
        for (let i = 0; i < 4; i++) { pos[i] = 0; vel[i] = 0; }
        for (let i = 0; i < eqSpans.length; i++) writeHeight(i, 4);
        return;
    }

    analyser.getByteFrequencyData(dataArray);

    const master = rms();
    const rawInputs = [
        (master / 255) * 1.5,
        (master / 255),
        avg(12, 18) / 255,
        avg(25, 35) / 255,
    ];

    for (let k = 0; k < 4; k++) {
        const target = Math.min(rawInputs[k] || 0, 1);
        if (target > pos[k]) {
            vel[k] = (target - pos[k]) * 0.6;
            pos[k] = target;
        } else {
            vel[k] -= 0.008;
            pos[k] += vel[k];
        }
        if (pos[k] < 0) { pos[k] = 0; vel[k] = 0; }
        if (pos[k] > 1) { pos[k] = 1; vel[k] = 0; }
    }
    for (let i = 0; i < eqSpans.length; i++) writeHeight(i, Math.round(pos[i % 4] * 20) + 4);

    rafId = requestAnimationFrame(renderFrame);
}

export function destroyVisualizer() {
    stopLoop();
}
