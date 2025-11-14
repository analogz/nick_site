// Wave Interference Pattern - Photonics Inspired
// Multiple wave sources creating constructive and destructive interference

class WaveSource {
    constructor(x, y, frequency, amplitude, phase = 0) {
        this.x = x;
        this.y = y;
        this.frequency = frequency;
        this.amplitude = amplitude;
        this.phase = phase;
    }

    // Calculate wave amplitude at a given point and time
    getAmplitudeAt(x, y, time) {
        const dx = x - this.x;
        const dy = y - this.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // Wave equation: A * sin(k*r - ω*t + φ)
        // k = wave number, r = distance, ω = angular frequency, φ = phase
        const wavelength = 40; // pixels
        const k = (2 * Math.PI) / wavelength;
        const omega = this.frequency;

        // Amplitude decreases with distance (realistic wave propagation)
        const attenuation = Math.max(0, 1 - distance / 400);

        return this.amplitude * attenuation * Math.sin(k * distance - omega * time + this.phase);
    }
}

class WaveInterferenceSimulation {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) return;

        this.ctx = this.canvas.getContext('2d');
        this.sources = [];
        this.time = 0;
        this.resolution = 3; // Grid resolution (lower = better quality, slower)
        this.showSources = true;

        this.setupCanvas();
        this.createInitialSources();
        this.setupEventListeners();
        this.animate();
    }

    setupCanvas() {
        const updateSize = () => {
            const rect = this.canvas.getBoundingClientRect();
            this.canvas.width = rect.width;
            this.canvas.height = rect.height;
        };
        updateSize();
        window.addEventListener('resize', () => {
            updateSize();
            this.createInitialSources();
        });
    }

    createInitialSources() {
        this.sources = [];
        const w = this.canvas.width;
        const h = this.canvas.height;

        // Create multiple wave sources in interesting positions
        this.sources.push(new WaveSource(w * 0.3, h * 0.5, 0.05, 1.0));
        this.sources.push(new WaveSource(w * 0.7, h * 0.5, 0.05, 1.0));
        this.sources.push(new WaveSource(w * 0.5, h * 0.3, 0.05, 0.8, Math.PI / 2));
    }

    setupEventListeners() {
        this.canvas.addEventListener('click', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            // Add a new wave source
            const frequency = 0.04 + Math.random() * 0.02;
            const amplitude = 0.8 + Math.random() * 0.4;
            const phase = Math.random() * Math.PI * 2;

            this.sources.push(new WaveSource(x, y, frequency, amplitude, phase));

            // Limit number of sources
            if (this.sources.length > 8) {
                this.sources.shift();
            }
        });

        this.canvas.addEventListener('dblclick', (e) => {
            e.preventDefault();
            // Reset to initial sources
            this.createInitialSources();
        });
    }

    calculateInterference(x, y) {
        let totalAmplitude = 0;

        // Sum all wave amplitudes at this point (superposition principle)
        for (let source of this.sources) {
            totalAmplitude += source.getAmplitudeAt(x, y, this.time);
        }

        return totalAmplitude;
    }

    draw() {
        const imageData = this.ctx.createImageData(this.canvas.width, this.canvas.height);
        const data = imageData.data;

        // Calculate interference pattern
        for (let y = 0; y < this.canvas.height; y += this.resolution) {
            for (let x = 0; x < this.canvas.width; x += this.resolution) {
                const amplitude = this.calculateInterference(x, y);

                // Map amplitude to grayscale
                // Normalize amplitude (typically ranges from -N to +N where N is number of sources)
                const normalized = (amplitude / this.sources.length + 1) / 2; // 0 to 1
                const brightness = Math.floor(normalized * 255);

                // Fill a block of pixels for the resolution
                for (let dy = 0; dy < this.resolution; dy++) {
                    for (let dx = 0; dx < this.resolution; dx++) {
                        const px = x + dx;
                        const py = y + dy;
                        if (px < this.canvas.width && py < this.canvas.height) {
                            const index = (py * this.canvas.width + px) * 4;
                            data[index] = brightness;     // R
                            data[index + 1] = brightness; // G
                            data[index + 2] = brightness; // B
                            data[index + 3] = 255;        // A
                        }
                    }
                }
            }
        }

        this.ctx.putImageData(imageData, 0, 0);

        // Draw wave sources
        if (this.showSources) {
            for (let source of this.sources) {
                // Draw a subtle circle at source location
                this.ctx.strokeStyle = '#0a0a0a';
                this.ctx.lineWidth = 1.5;
                this.ctx.beginPath();
                this.ctx.arc(source.x, source.y, 4, 0, Math.PI * 2);
                this.ctx.stroke();

                // Draw smaller filled circle
                this.ctx.fillStyle = '#0a0a0a';
                this.ctx.beginPath();
                this.ctx.arc(source.x, source.y, 2, 0, Math.PI * 2);
                this.ctx.fill();
            }
        }
    }

    animate() {
        this.draw();
        this.time += 0.5; // Time step

        requestAnimationFrame(() => this.animate());
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new WaveInterferenceSimulation('physics-canvas');
});
