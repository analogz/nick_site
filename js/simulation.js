// Dipole Radiation Simulation
// Electromagnetic radiation from an oscillating electric dipole

const canvas = document.getElementById('physics-canvas');
const ctx = canvas.getContext('2d');

let width, height;
let animationId;
let time = 0;

// Dipole parameters
const dipoles = [];

class Dipole {
    constructor(x, y, frequency = 0.05, amplitude = 1.0) {
        this.x = x;
        this.y = y;
        this.frequency = frequency;
        this.amplitude = amplitude;
    }

    // Calculate electric field at point (x, y) at time t
    getFieldAt(x, y, t) {
        const dx = x - this.x;
        const dy = y - this.y;
        const r = Math.sqrt(dx * dx + dy * dy);

        if (r < 1) return 0;

        // Dipole radiation: oscillating source with 1/r falloff
        const wavelength = 80;
        const k = (2 * Math.PI) / wavelength;
        const omega = this.frequency;

        // Radiation field (1/r falloff)
        const amplitude = this.amplitude / r;

        // Dipole oriented vertically - radiation pattern has nulls along dipole axis
        const theta = Math.atan2(dy, dx);
        const pattern = Math.abs(Math.sin(theta)); // Dipole pattern: zero along axis

        // Oscillating field
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

    // 16:9 aspect ratio
    width = rect.width;
    height = width * 9 / 16;

    canvas.width = width;
    canvas.height = height;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
}

function createInitialDipoles() {
    dipoles.length = 0;
    dipoles.push(new Dipole(width / 2, height / 2, 0.05, 1.0));
}

function drawField() {
    const imageData = ctx.createImageData(width, height);
    const data = imageData.data;

    // Sample at lower resolution for performance
    const step = 2;

    for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
            // Sum fields from all dipoles
            let totalField = 0;
            for (let dipole of dipoles) {
                totalField += dipole.getFieldAt(x, y, time);
            }

            // Map field to grayscale: white background, dark wavefronts
            const normalized = Math.max(-1, Math.min(1, totalField * 5.0));
            const brightness = Math.floor(255 - Math.abs(normalized) * 200);

            // Fill block of pixels
            for (let dy = 0; dy < step; dy++) {
                for (let dx = 0; dx < step; dx++) {
                    const px = x + dx;
                    const py = y + dy;
                    if (px < width && py < height) {
                        const idx = (py * width + px) * 4;
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

function drawDipoles() {
    ctx.strokeStyle = 'rgba(10, 10, 10, 0.4)';
    ctx.fillStyle = 'rgba(10, 10, 10, 0.4)';
    ctx.lineWidth = 1.5;

    for (let dipole of dipoles) {
        // Draw dipole as vertical line segment
        const dipoleLength = 12;
        ctx.beginPath();
        ctx.moveTo(dipole.x, dipole.y - dipoleLength / 2);
        ctx.lineTo(dipole.x, dipole.y + dipoleLength / 2);
        ctx.stroke();

        // Draw end charges
        ctx.beginPath();
        ctx.arc(dipole.x, dipole.y - dipoleLength / 2, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(dipole.x, dipole.y + dipoleLength / 2, 3, 0, Math.PI * 2);
        ctx.fill();
    }
}

function animate() {
    // Draw field
    drawField();

    // Don't draw dipole markers - just show the field

    time += 0.5;
    animationId = requestAnimationFrame(animate);
}

// Click to add dipole
canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const frequency = 0.04 + Math.random() * 0.02;
    dipoles.push(new Dipole(x, y, frequency, 1.0));

    // Limit to 6 dipoles
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

// Initialize
initSimulation();
