// Photonic Waveguide Coupling Simulation
// Demonstrates evanescent coupling between parallel integrated waveguides

const canvas = document.getElementById('physics-canvas');
const ctx = canvas.getContext('2d');

let width, height;
let animationId;

// Simulation parameters
let separation = 3; // Waveguide separation (coupling strength inversely related)
const waveSpeed = 2;
const couplingLength = 150; // Distance for complete power transfer
let time = 0;

function initSimulation() {
    resizeCanvas();
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

function drawWaveguides(ctx) {
    const waveguideWidth = 4;
    const centerY = height / 2;
    const spacing = separation * 8; // Visual spacing

    ctx.strokeStyle = 'rgba(10, 10, 10, 0.3)';
    ctx.lineWidth = waveguideWidth;

    // Top waveguide
    ctx.beginPath();
    ctx.moveTo(0, centerY - spacing);
    ctx.lineTo(width, centerY - spacing);
    ctx.stroke();

    // Bottom waveguide
    ctx.beginPath();
    ctx.moveTo(0, centerY + spacing);
    ctx.lineTo(width, centerY + spacing);
    ctx.stroke();
}

function calculateCoupling(x, t) {
    // Coupled mode theory: power oscillates between waveguides
    const kappa = Math.PI / (2 * couplingLength); // Coupling coefficient
    const beta = 2 * Math.PI / 100; // Propagation constant

    // Phase evolution
    const z = x - waveSpeed * t;
    const phase = beta * z;

    // Coupling between waveguides
    const couplingStrength = kappa / Math.sqrt(1 + (separation / 3) ** 4);

    // Power in each waveguide (coupled mode equations solution)
    const power1 = Math.cos(couplingStrength * x) ** 2;
    const power2 = Math.sin(couplingStrength * x) ** 2;

    // Field amplitude (with propagation)
    const envelope = Math.exp(-((z % 400 - 200) ** 2) / 5000); // Gaussian pulse

    return {
        field1: Math.sqrt(power1) * Math.cos(phase) * envelope,
        field2: Math.sqrt(power2) * Math.cos(phase) * envelope,
        power1: power1 * envelope,
        power2: power2 * envelope
    };
}

function drawField(ctx) {
    const centerY = height / 2;
    const spacing = separation * 8;
    const fieldWidth = 20;

    const imageData = ctx.createImageData(width, height);
    const data = imageData.data;

    for (let x = 0; x < width; x++) {
        const coupling = calculateCoupling(x, time);

        for (let y = 0; y < height; y++) {
            const dy1 = Math.abs(y - (centerY - spacing));
            const dy2 = Math.abs(y - (centerY + spacing));

            // Field amplitude in each waveguide region
            let field = 0;
            if (dy1 < fieldWidth) {
                const decay = Math.exp(-(dy1 ** 2) / 100);
                field += coupling.field1 * decay;
            }
            if (dy2 < fieldWidth) {
                const decay = Math.exp(-(dy2 ** 2) / 100);
                field += coupling.field2 * decay;
            }

            // Convert field to color (blue-white-red for electric field)
            const idx = (y * width + x) * 4;
            const intensity = Math.max(0, Math.min(1, (field + 1) / 2));

            if (field > 0) {
                // Positive field: white to red
                data[idx] = 10 + Math.floor(intensity * 245);
                data[idx + 1] = 10 + Math.floor(intensity * 100);
                data[idx + 2] = 10 + Math.floor(intensity * 100);
            } else {
                // Negative field: white to blue
                data[idx] = 10 + Math.floor((1 - intensity) * 100);
                data[idx + 1] = 10 + Math.floor((1 - intensity) * 150);
                data[idx + 2] = 10 + Math.floor((1 - intensity) * 245);
            }
            data[idx + 3] = 255;
        }
    }

    ctx.putImageData(imageData, 0, 0);
}

function drawPowerIndicators(ctx) {
    const centerY = height / 2;
    const spacing = separation * 8;
    const indicatorX = width - 80;

    // Sample power at indicator position
    const coupling = calculateCoupling(indicatorX, time);

    // Top waveguide power bar
    const barWidth = 60;
    const barHeight = 8;
    const power1Width = barWidth * coupling.power1;
    const power2Width = barWidth * coupling.power2;

    ctx.fillStyle = 'rgba(200, 50, 50, 0.6)';
    ctx.fillRect(indicatorX, centerY - spacing - barHeight / 2, power1Width, barHeight);

    ctx.fillStyle = 'rgba(200, 50, 50, 0.6)';
    ctx.fillRect(indicatorX, centerY + spacing - barHeight / 2, power2Width, barHeight);

    // Outline
    ctx.strokeStyle = 'rgba(10, 10, 10, 0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(indicatorX, centerY - spacing - barHeight / 2, barWidth, barHeight);
    ctx.strokeRect(indicatorX, centerY + spacing - barHeight / 2, barWidth, barHeight);
}

function animate() {
    // Clear
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    // Draw field
    drawField(ctx);

    // Draw waveguides on top
    drawWaveguides(ctx);

    // Draw power indicators
    drawPowerIndicators(ctx);

    time += 0.3;
    animationId = requestAnimationFrame(animate);
}

// Interaction: click to adjust waveguide separation
canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;

    // Map vertical position to separation (1 to 6)
    const normalizedY = y / height;
    separation = 1 + normalizedY * 5;
});

// Double-click to reset
canvas.addEventListener('dblclick', () => {
    separation = 3;
    time = 0;
});

// Handle window resize
window.addEventListener('resize', () => {
    resizeCanvas();
});

// Initialize
initSimulation();
