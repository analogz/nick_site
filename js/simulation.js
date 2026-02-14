// Dipole Radiation Simulation
// Electromagnetic radiation from oscillating electric dipoles

const canvas = document.getElementById('physics-canvas');
const ctx = canvas.getContext('2d');

let width, height, dpr;
let animationId;
let time = 0;

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
    createInitialDipoles();
    animate();
}

function resizeCanvas() {
    const container = canvas.parentElement;
    const rect = container.getBoundingClientRect();

    dpr = window.devicePixelRatio || 1;
    width = rect.width;
    height = width * 9 / 16;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
}

function createInitialDipoles() {
    dipoles.length = 0;
    dipoles.push(new Dipole(width / 2, height / 2, 0.05, 1.0));
}

function drawField() {
    const w = Math.ceil(width * dpr);
    const h = Math.ceil(height * dpr);
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
            const brightness = Math.floor(255 - Math.abs(sharp) * 255);

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
    drawField();
    time += 0.5;
    animationId = requestAnimationFrame(animate);
}

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
});

// Double-click to reset
canvas.addEventListener('dblclick', (e) => {
    e.preventDefault();
    createInitialDipoles();
    time = 0;
});

// Handle resize
window.addEventListener('resize', () => {
    resizeCanvas();
    createInitialDipoles();
});

initSimulation();
