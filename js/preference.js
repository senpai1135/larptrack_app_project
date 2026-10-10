const GRAPHICS_KEY = 'lt-graphics-quality';
const LAYOUT_KEY = 'lt-user-layout';
const THEME_KEY = 'lt-theme';
const PARTICLES_KEY = 'lt-particles-enabled';

function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function lsSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { } }

const TARGET_FPS = 24;
const FRAME_MS = 1000 / TARGET_FPS;
const RESIZE_SETTLE_MS = 220;
const MAX_DT_FRAMES = 4;

let particleState = {
    pts: [], W: 0, H: 0, raf: null, enabled: true, ctx: null, canvas: null,
    quality: 'medium', lastTick: 0, resizeTimer: null, settleUntil: 0, paused: false,
    sprite: null, listenersBound: false,
};

export function setGraphicsQuality(level, { silent = false, toast } = {}) {
    if (level !== 'low' && level !== 'medium' && level !== 'high') level = 'medium';
    lsSet(GRAPHICS_KEY, level);
    particleState.quality = level;
    document.body.classList.remove('gfx-low', 'gfx-medium', 'gfx-high');
    document.body.classList.add(`gfx-${level}`);
    document.documentElement.style.setProperty('--blur-strength', level === 'low' ? '0px' : level === 'high' ? '24px' : '20px');

    refreshParticles();

    if (level === 'low') stopLoop();
    else if (particleState.enabled) startLoop();

    if (!silent && toast) toast(`Graphics: ${level[0].toUpperCase()}${level.slice(1)}`);
}

export function loadGraphicsPreference() {
    const saved = lsGet(GRAPHICS_KEY) || 'medium';
    setGraphicsQuality(saved, { silent: true });
    return saved;
}

export function setLayout(value) {
    const container = document.getElementById('song-list-container');
    if (container) container.classList.toggle('grid-view', value === 'grid-view');
    lsSet(LAYOUT_KEY, value);
}

export function loadLayoutPreference() {
    const saved = lsGet(LAYOUT_KEY) || 'list-view';
    setLayout(saved);
    return saved;
}

export function loadThemePreference() {
    return lsGet(THEME_KEY) || 'dynamic';
}

export function saveThemePreference(theme) {
    lsSet(THEME_KEY, theme);
}

export function toggleParticles(enabled) {
    particleState.enabled = !!enabled;
    lsSet(PARTICLES_KEY, enabled ? 'on' : 'off');
    const canvas = document.getElementById('particle-canvas');
    if (canvas) canvas.style.display = enabled ? 'block' : 'none';
    if (enabled) startParticleLoop();
    else stopLoop();
}

export function loadParticlesPreference() {
    const saved = lsGet(PARTICLES_KEY);
    const enabled = saved === null ? true : saved === 'on';
    toggleParticles(enabled);
    return enabled;
}

export function setParticlesPaused(paused) {
    particleState.paused = !!paused;
    if (paused) stopLoop();
    else if (particleState.enabled && particleState.quality !== 'low') startLoop();
}

function getSprite() {
    if (particleState.sprite) return particleState.sprite;
    const size = 16;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = 'rgb(245, 201, 122)';
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 0.5, 0, Math.PI * 2);
    g.fill();
    particleState.sprite = c;
    return c;
}

function measure() {
    const w = Math.max(1, Math.round(window.innerWidth || document.documentElement.clientWidth || 1));
    const h = Math.max(1, Math.round(window.innerHeight || document.documentElement.clientHeight || 1));
    return { w, h };
}

function applySize() {
    const c = particleState.canvas;
    if (!c) return;
    const { w, h } = measure();
    if (w === particleState.W && h === particleState.H && c.width === w && c.height === h) return;

    const oldW = particleState.W || w, oldH = particleState.H || h;
    c.width = w;
    c.height = h;
    particleState.W = w;
    particleState.H = h;

    const sx = w / oldW, sy = h / oldH;
    if (sx !== 1 || sy !== 1) {
        for (const p of particleState.pts) { p.x *= sx; p.y *= sy; }
    }
}

function onResize() {
    particleState.settleUntil = performance.now() + RESIZE_SETTLE_MS;
    if (particleState.resizeTimer !== null) clearTimeout(particleState.resizeTimer);
    particleState.resizeTimer = setTimeout(() => {
        particleState.resizeTimer = null;
        applySize();
        if (particleState.enabled && particleState.quality !== 'low' && !particleState.paused) startLoop();
    }, RESIZE_SETTLE_MS);
}

function onVisibility() {
    if (document.hidden) { stopLoop(); return; }
    if (particleState.enabled && particleState.quality !== 'low' && !particleState.paused) startLoop();
}

function bindListeners() {
    if (particleState.listenersBound) return;
    particleState.listenersBound = true;
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('orientationchange', onResize, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
}

function makePoint(highQuality) {
    const { W, H } = particleState;
    const r = Math.random() * 1.6 + 1.6;
    return {
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.12,
        vy: (Math.random() - 0.5) * 0.12,
        tvx: highQuality ? (Math.random() - 0.5) * 0.22 : null,
        tvy: highQuality ? (Math.random() - 0.5) * 0.22 : null,
        shiftEvery: highQuality ? 90 + Math.random() * 140 : Infinity,
        life: 0,
        r, baseR: r,
        pulse: Math.random() * Math.PI * 2,
    };
}

export function refreshParticles() {
    const canvas = document.getElementById('particle-canvas');
    if (!canvas) return;
    particleState.canvas = canvas;
    if (!particleState.ctx) particleState.ctx = canvas.getContext('2d');
    if (!particleState.ctx) return;
    bindListeners();

    particleState.W = 0; particleState.H = 0;
    applySize();

    const quality = particleState.quality || lsGet(GRAPHICS_KEY) || 'medium';
    const count = quality === 'low' ? 0 : quality === 'high' ? 90 : 28;
    particleState.pts = Array.from({ length: count }, () => makePoint(quality === 'high'));

    if (count === 0) {
        particleState.ctx.clearRect(0, 0, particleState.W, particleState.H);
    }
}

function draw(now) {
    particleState.raf = requestAnimationFrame(draw);
    const { ctx, W, H, pts, enabled } = particleState;
    if (!ctx || !enabled || !pts.length) return;

    if (now < particleState.settleUntil) return;

    const elapsed = now - particleState.lastTick;
    if (elapsed < FRAME_MS - 1) return;
    const dt = Math.min(MAX_DT_FRAMES * 4, (particleState.lastTick ? elapsed : FRAME_MS) / (1000 / 60));
    particleState.lastTick = now;

    const sprite = getSprite();
    ctx.clearRect(0, 0, W, H);
    const easeK = 1 - Math.pow(1 - 0.01, dt);
    for (const p of pts) {
        p.pulse += 0.006 * dt;

        if (p.tvx !== null) {
            p.life += dt;
            if (p.life >= p.shiftEvery) {
                p.tvx = (Math.random() - 0.5) * 0.22;
                p.tvy = (Math.random() - 0.5) * 0.22;
                p.life = 0;
            }
            p.vx += (p.tvx - p.vx) * easeK;
            p.vy += (p.tvy - p.vy) * easeK;
        }

        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.x < -10) p.x = W + 10; else if (p.x > W + 10) p.x = -10;
        if (p.y < -10) p.y = H + 10; else if (p.y > H + 10) p.y = -10;

        ctx.globalAlpha = Math.sin(p.pulse) * 0.12 + 0.28;
        const d = p.baseR * 2;
        ctx.drawImage(sprite, p.x - p.baseR, p.y - p.baseR, d, d);
    }
    ctx.globalAlpha = 1;
}

function startLoop() {
    if (particleState.raf !== null) return;
    if (!particleState.enabled || particleState.paused || particleState.quality === 'low' || document.hidden) return;
    if (!particleState.ctx) return;
    particleState.lastTick = 0;
    particleState.raf = requestAnimationFrame(draw);
}

function stopLoop() {
    if (particleState.raf !== null) {
        cancelAnimationFrame(particleState.raf);
        particleState.raf = null;
    }
}

export function startParticleLoop() {
    const canvas = document.getElementById('particle-canvas');
    if (!canvas) return;
    refreshParticles();
    startLoop();
}
