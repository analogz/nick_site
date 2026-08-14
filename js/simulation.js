// SOI waveguide-maze field animation
// Complex Ez from Meep 2D FDTD at 1310 nm, animated as Re{E exp(-iωt)}

const canvas = document.getElementById('physics-canvas');
const overlay = document.getElementById('physics-overlay');
const stage = document.querySelector('.physics-stage');

const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    preserveDrawingBuffer: false,
    powerPreference: 'low-power',
});
const octx = overlay ? overlay.getContext('2d') : null;

if (!gl) {
    canvas.insertAdjacentHTML(
        'afterend',
        '<p class="simulation-caption">WebGL is required for the photonic field animation.</p>'
    );
    throw new Error('WebGL unavailable');
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let animationId = 0;
let startMs = 0;
let paused = false;
let phase = 0;
let dpr = 1;
let meta = {
    phase_speed: 2.4,
    caption: '1310 nm · SOI waveguide maze (Meep FDTD)',
    outline: null,
    extent_um: null,
};

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_field;
uniform float u_phase;
uniform vec2 u_resolution;
uniform float u_boost;

vec3 rdbu(float t) {
    float x = clamp(t, -1.0, 1.0);
    float a = abs(x);
    vec3 neg = vec3(0.09, 0.36, 0.78);
    vec3 pos = vec3(0.82, 0.10, 0.14);
    vec3 mid = vec3(1.0);
    vec3 col = mix(mid, mix(neg, pos, step(0.0, x)), pow(a, 0.72));
    // Deepen the extremes slightly so peaks read against white
    col *= 1.0 - 0.10 * pow(a, 3.0);
    return col;
}

void main() {
    vec2 uv = v_uv;
    vec4 sample = texture2D(u_field, uv);
    float re0 = sample.r * 2.0 - 1.0;
    float im0 = sample.g * 2.0 - 1.0;
    float mask = sample.b;
    float mag = length(vec2(re0, im0));

    float c = cos(u_phase);
    float s = sin(u_phase);
    float re = re0 * c - im0 * s;

    float guided = smoothstep(0.08, 0.65, mask);
    // 49 tight corners shed a lot of radiation; hold the cladding speckle
    // back hard so the guided mode threading the maze stays the subject.
    float amp = re * mix(0.26, 1.28, guided) * u_boost;
    amp *= mix(0.58, 1.0, clamp(mag * 1.4, 0.0, 1.0));

    vec3 color = rdbu(amp);

    // Soft secondary edge hint from mask (crisp stroke is drawn on overlay)
    float mL = texture2D(u_field, uv + vec2(-1.5, 0.0) / u_resolution).b;
    float mR = texture2D(u_field, uv + vec2( 1.5, 0.0) / u_resolution).b;
    float mU = texture2D(u_field, uv + vec2( 0.0, 1.5) / u_resolution).b;
    float mD = texture2D(u_field, uv + vec2( 0.0,-1.5) / u_resolution).b;
    float edge = abs(mL - mR) + abs(mU - mD);
    edge = smoothstep(0.05, 0.35, edge);
    color -= vec3(0.30, 0.32, 0.36) * edge * 0.35;

    color = clamp(color, 0.0, 1.0);
    gl_FragColor = vec4(color, 1.0);
}
`;

function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed');
    }
    return sh;
}

function createProgram() {
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog) || 'program link failed');
    }
    return prog;
}

const program = createProgram();
gl.useProgram(program);

const aPos = gl.getAttribLocation(program, 'a_pos');
const uField = gl.getUniformLocation(program, 'u_field');
const uPhase = gl.getUniformLocation(program, 'u_phase');
const uResolution = gl.getUniformLocation(program, 'u_resolution');
const uBoost = gl.getUniformLocation(program, 'u_boost');

const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW
);
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
gl.uniform1i(uField, 0);
gl.uniform1f(uBoost, 1.18);

const fieldTex = gl.createTexture();
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, fieldTex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([128, 128, 0, 0])
);

function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    const changed = canvas.width !== w || canvas.height !== h;
    if (changed) {
        canvas.width = w;
        canvas.height = h;
        if (overlay) {
            overlay.width = w;
            overlay.height = h;
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(uResolution, canvas.width, canvas.height);
        drawOutline();
    }
}

function umToCanvas(xUm, yUm) {
    const e = meta.extent_um;
    const u = (xUm - e.xmin_um) / (e.xmax_um - e.xmin_um);
    const v = (yUm - e.ymin_um) / (e.ymax_um - e.ymin_um);
    return [u * canvas.width, (1 - v) * canvas.height];
}

function drawOutline() {
    if (!octx || !meta.outline || !meta.extent_um) return;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    octx.save();
    octx.lineJoin = 'round';
    octx.lineCap = 'round';

    // Soft halo so the stroke separates from saturated field lobes
    octx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    octx.lineWidth = 3.2 * dpr;
    octx.beginPath();
    meta.outline.forEach((p, i) => {
        const [x, y] = umToCanvas(p.x, p.y);
        if (i === 0) octx.moveTo(x, y);
        else octx.lineTo(x, y);
    });
    octx.closePath();
    octx.stroke();

    // Crisp core stroke
    octx.strokeStyle = 'rgba(10, 10, 10, 0.85)';
    octx.lineWidth = 1.15 * dpr;
    octx.stroke();
    octx.restore();
}

function frame(now) {
    if (!startMs) startMs = now;
    const t = (now - startMs) * 0.001;

    if (!paused && !reduceMotion.matches) {
        phase = t * meta.phase_speed;
    }

    resize();
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uPhase, phase);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    animationId = requestAnimationFrame(frame);
}

function setCaption(text) {
    const el = document.querySelector('.simulation-caption');
    if (el) el.textContent = text;
}

function setPaused(next) {
    paused = next;
    canvas.classList.toggle('is-paused', paused);
    if (stage) stage.classList.toggle('is-paused', paused);
}

async function loadAssets() {
    const base = 'data/';
    const [metaRes, img] = await Promise.all([
        fetch(`${base}soi-euler-bend-web.json`).then((r) => r.json()),
        new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = reject;
            image.src = `${base}soi-euler-bend-field.png`;
        }),
    ]);

    meta = { ...meta, ...metaRes };
    setCaption(meta.caption || meta.title);

    // Match the stage to the simulated region so µm stay square on screen.
    if (stage && meta.extent_um) {
        const e = meta.extent_um;
        stage.style.aspectRatio = `${e.xmax_um - e.xmin_um} / ${e.ymax_um - e.ymin_um}`;
    }

    gl.bindTexture(gl.TEXTURE_2D, fieldTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

    // Force a size/outline sync now that extent + polygon are available
    canvas.width = 0;
    resize();
}

function onInteractToggle() {
    setPaused(!paused);
}

canvas.addEventListener('click', onInteractToggle);
if (overlay) overlay.addEventListener('click', onInteractToggle);

function onRestart(e) {
    e.preventDefault();
    phase = 0;
    startMs = performance.now();
    setPaused(false);
}
canvas.addEventListener('dblclick', onRestart);
if (overlay) overlay.addEventListener('dblclick', onRestart);

window.addEventListener('resize', resize);

resize();
setCaption('Loading 1310 nm SOI waveguide-maze FDTD…');
loadAssets()
    .then(() => {
        animationId = requestAnimationFrame(frame);
    })
    .catch((err) => {
        console.error(err);
        setCaption('Could not load FDTD field data.');
    });

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        cancelAnimationFrame(animationId);
        animationId = 0;
    } else if (!animationId) {
        startMs = 0;
        animationId = requestAnimationFrame(frame);
    }
});
