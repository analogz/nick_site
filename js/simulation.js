// Dipole Radiation Simulation
// Electromagnetic radiation from oscillating electric dipoles

const canvas = document.getElementById('physics-canvas');
const ctx = canvas.getContext('2d');
const label = document.getElementById('sim-label');
const buttons = Array.from(document.querySelectorAll('[data-sim]'));

let width, height, dpr;
let animationId = null;
let time = 0;
let playing = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let onScreen = true;

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let isDark = darkQuery.matches;
darkQuery.addEventListener('change', (e) => { isDark = e.matches; if (!playing) drawField(); });

const dipoles = [];

class Dipole {
    constructor(x, y, frequency = 0.05, amplitude = 1.0) {
        this.x = x;
        this.y = y;
        this.frequency = frequency;
        this.amplitude = amplitude;
    }

    getFieldAt(x, y, t) {
        const dx = x - this.x;
        const dy = y - this.y;
        const r = Math.sqrt(dx * dx + dy * dy);

        if (r < 1) return 0;

        const wavelength = 40;
        const k = (2 * Math.PI) / wavelength;
        const omega = this.frequency;

        // Slower decay so outer rings stay visible
        const amplitude = this.amplitude / Math.pow(r, 0.55);

        // Softened dipole pattern — minimum 20% radiation even along axis
        const theta = Math.atan2(dy, dx);
        const pattern = 0.2 + 0.8 * Math.abs(Math.sin(theta));

        return amplitude * pattern * Math.sin(k * r - omega * t);
    }
}

function initSimulation() {
    resizeCanvas();
    setPreset('dipole');
    syncPlayButton();
    if (playing) start(); else drawField();
}

function resizeCanvas() {
    dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
}

function setPreset(name) {
    dipoles.length = 0;
    time = 0;
    if (name === 'pair') {
        const sep = Math.min(width, height) * 0.22;
        dipoles.push(new Dipole(width / 2 - sep, height / 2, 0.05, 1.0));
        dipoles.push(new Dipole(width / 2 + sep, height / 2, 0.05, 1.0));
        if (label) label.textContent = 'Two-source interference';
    } else {
        dipoles.push(new Dipole(width / 2, height / 2, 0.05, 1.0));
        if (label) label.textContent = 'Dipole radiation';
    }
    markPreset(name);
    if (!playing) drawField();
}

function markPreset(name) {
    buttons.forEach((b) => {
        if (b.dataset.sim === 'dipole' || b.dataset.sim === 'pair') {
            b.setAttribute('aria-pressed', String(b.dataset.sim === name));
        }
    });
}

function syncPlayButton() {
    const toggle = buttons.find((b) => b.dataset.sim === 'toggle');
    if (!toggle) return;
    toggle.textContent = playing ? 'Pause' : 'Play';
    toggle.setAttribute('aria-pressed', String(!playing));
}

function drawField() {
    const w = canvas.width;
    const h = canvas.height;
    const imageData = ctx.createImageData(w, h);
    const data = imageData.data;

    const step = 2;

    for (let py = 0; py < h; py += step) {
        for (let px = 0; px < w; px += step) {
            const x = px / dpr;
            const y = py / dpr;

            let totalField = 0;
            for (let dipole of dipoles) {
                totalField += dipole.getFieldAt(x, y, time);
            }

            // tanh for sharp wavefront edges, abs to show both polarities
            const sharp = Math.tanh(totalField * 3.5);
            const brightness = isDark
                ? Math.floor(Math.abs(sharp) * 245 + 10)
                : Math.floor(255 - Math.abs(sharp) * 255);

            for (let dy = 0; dy < step; dy++) {
                for (let dx = 0; dx < step; dx++) {
                    const fx = px + dx;
                    const fy = py + dy;
                    if (fx < w && fy < h) {
                        const idx = (fy * w + fx) * 4;
                        data[idx] = brightness;
                        data[idx + 1] = brightness;
                        data[idx + 2] = brightness;
                        data[idx + 3] = 255;
                    }
                }
            }
        }
    }

    ctx.putImageData(imageData, 0, 0);
}

function animate() {
    animationId = requestAnimationFrame(animate);
    if (!onScreen || document.hidden) return;
    drawField();
    time += 0.5;
}

function start() {
    if (animationId === null) animate();
}

function stop() {
    if (animationId !== null) cancelAnimationFrame(animationId);
    animationId = null;
}

function setPlaying(next) {
    playing = next;
    syncPlayButton();
    if (playing) start(); else stop();
}

buttons.forEach((b) => {
    b.addEventListener('click', () => {
        const action = b.dataset.sim;
        if (action === 'toggle') setPlaying(!playing);
        else setPreset(action);
    });
});

// Click to add dipole
canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left);
    const y = (e.clientY - rect.top);

    const frequency = 0.04 + Math.random() * 0.02;
    dipoles.push(new Dipole(x, y, frequency, 1.0));

    if (dipoles.length > 6) {
        dipoles.shift();
    }
    markPreset(null);
    if (label) label.textContent = dipoles.length === 1 ? 'Dipole radiation' : `${dipoles.length} sources`;
    if (!playing) drawField();
});

// Double-click to reset
canvas.addEventListener('dblclick', (e) => {
    e.preventDefault();
    setPreset('dipole');
});

// Handle resize
window.addEventListener('resize', () => {
    const wasPair = buttons.some((b) => b.dataset.sim === 'pair' && b.getAttribute('aria-pressed') === 'true');
    resizeCanvas();
    setPreset(wasPair ? 'pair' : 'dipole');
});

if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
        onScreen = entries[entries.length - 1].isIntersecting;
    }).observe(canvas);
}

initSimulation();
