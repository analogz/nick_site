import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const W = 20;
const D = 20;
const BASE = -3.4;
const TOP = 6.2;
const PLINTH_M = 0.9;
const PLINTH_H = 0.7;
const SEGS_X = 136;
const SEGS_Z = 94;
const FOG_COLOR = 0xe1e5de;
const MIST_FROM = 6.8;
const MIST_TO = 23;
const SUN_DIR = new THREE.Vector3(14, 20, 10).normalize();
const NOISE_GLSL = `
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
`;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const rand = mulberry32(20261003);
const clock = new THREE.Clock();
const timeUniforms = [];
const updaters = [];

const CABIN = { x: 7.15, z: 1.15, pad: 2.15, padH: 4, yaw: 0 };
const STUMP = { x: -7.0, z: 6.6, r: 0.82, h: 0.72, stump: true };
const outlet = { x: 4.15, y: 3 };

let riverCurve;
let riverPts = [];
let waterY0 = 3.7;
let waterY1 = 2.85;
let TREES = [];
let PATH = [];
let sharedCrownMats = null;
let clumpBase = null;
const CROWN_PALETTE = ['#22452f', '#2a5236', '#34603c', '#416d42'].map((c) => new THREE.Color(c));
const CROWN_TIP = new THREE.Color('#90a95a');

const host = document.querySelector('[data-redwood]');
if (host) {
    const start = () => {
        try {
            main(host);
        } catch (err) {
            showError(host, err);
        }
    };
    if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                io.disconnect();
                start();
            }
        }, { rootMargin: '600px 0px' });
        io.observe(host);
    } else {
        start();
    }
}

function installHeightFog() {
    THREE.ShaderChunk.fog_pars_vertex = `
        #ifdef USE_FOG
            varying float vFogDepth;
            varying float vFogHeight;
        #endif`;
    THREE.ShaderChunk.fog_vertex = `
        #ifdef USE_FOG
            vFogDepth = - mvPosition.z;
            vFogHeight = (inverse(viewMatrix) * mvPosition).y;
        #endif`;
    THREE.ShaderChunk.fog_pars_fragment = `
        #ifdef USE_FOG
            uniform vec3 fogColor;
            varying float vFogDepth;
            varying float vFogHeight;
            #ifdef FOG_EXP2
                uniform float fogDensity;
            #else
                uniform float fogNear;
                uniform float fogFar;
            #endif
        #endif`;
    THREE.ShaderChunk.fog_fragment = `
        #ifdef USE_FOG
            #ifdef FOG_EXP2
                float fogFactor = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth);
            #else
                float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
            #endif
            float mist = smoothstep(${MIST_FROM.toFixed(1)}, ${MIST_TO.toFixed(1)}, vFogHeight);
            fogFactor = 1.0 - (1.0 - fogFactor) * (1.0 - mist * 0.9);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
        #endif`;
}

function main(host) {
    installHeightFog();
    const canvas = host.querySelector('canvas');
    const freeZoom = host.hasAttribute('data-free-zoom');
    const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance'
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.localClippingEnabled = true;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0085);

    initRiver();
    CABIN.padH = hillOnly(CABIN.x, CABIN.z) - 0.08;
    TREES = placeTrees();
    PATH = placePath();

    const camera = new THREE.PerspectiveCamera(30, 1.6, 0.1, 240);
    camera.position.set(44, 13, 41);
    const fitCamera = () => {
        const w = Math.max(1, host.clientWidth);
        const h = Math.max(1, host.clientHeight);
        camera.aspect = w / h;
        // The view is composed at 16:10; narrower frames widen the lens so the whole block stays in shot.
        camera.fov = camera.aspect >= 1.6
            ? 30
            : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(15)) * 1.6 / camera.aspect));
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
    };
    fitCamera();

    const controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 7.6, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.enablePan = false;
    controls.minDistance = 24;
    controls.maxDistance = 90;
    controls.minPolarAngle = 0.42;
    controls.maxPolarAngle = 1.25;
    controls.update();

    if (!freeZoom) {
        // Embedded in a scrolling page: plain wheel scrolls the page, pinch or Ctrl/Cmd + wheel zooms.
        host.addEventListener('wheel', (event) => {
            if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
        }, { capture: true });
        canvas.style.touchAction = 'pan-y';
    }

    addLights(scene);
    scene.add(buildPlinth());
    scene.add(buildTerrain());
    scene.add(buildWalls());

    const treeGroup = new THREE.Group();
    for (const tree of TREES) treeGroup.add(buildTree(tree));
    treeGroup.add(buildTree(STUMP));
    scene.add(treeGroup);

    const rocks = placeRocks();
    scene.add(buildRocks(rocks));
    scene.add(buildBedPebbles());
    scene.add(buildShorePebbles());
    scene.add(buildWater(rocks));
    scene.add(buildWaterfall());
    scene.add(buildFerns(rocks));
    scene.add(buildSorrel(rocks));
    scene.add(buildLog());
    scene.add(buildPath());
    scene.add(buildCabin());
    scene.add(buildShrubs(rocks));
    scene.add(buildShafts());
    scene.add(buildMist());
    scene.add(buildMotes(renderer));

    if ('ResizeObserver' in window) new ResizeObserver(fitCamera).observe(host);
    else window.addEventListener('resize', fitCamera);

    let running = !document.hidden;
    let onScreen = true;
    document.addEventListener('visibilitychange', () => {
        running = !document.hidden;
    });
    if ('IntersectionObserver' in window) {
        new IntersectionObserver((entries) => {
            onScreen = entries[entries.length - 1].isIntersecting;
        }).observe(host);
    }

    host.classList.add('is-ready');
    renderer.setAnimationLoop(() => {
        if (!running || !onScreen) return;
        const t = clock.getElapsedTime() * (reducedMotion ? 0.2 : 1);
        for (const uniform of timeUniforms) uniform.value = t;
        for (const update of updaters) update(t);
        controls.update();
        renderer.render(scene, camera);
    });
}

function addLights(scene) {
    scene.add(new THREE.HemisphereLight(0xe8eee6, 0x3c4630, 1.45));

    const sun = new THREE.DirectionalLight(0xfff0dc, 1.55);
    sun.position.copy(SUN_DIR).multiplyScalar(32).add(new THREE.Vector3(0, 3, 0));
    sun.target.position.set(0, 3, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.05;
    const cam = sun.shadow.camera;
    cam.left = -24;
    cam.right = 24;
    cam.top = 24;
    cam.bottom = -24;
    cam.near = 1;
    cam.far = 110;
    scene.add(sun);
    scene.add(sun.target);

    const fill = new THREE.DirectionalLight(0xc6d9d4, 0.5);
    fill.position.set(-16, 9, 8);
    scene.add(fill);
}

// River and terrain

function initRiver() {
    riverCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-6.0, 0, -8.0),
        new THREE.Vector3(-1.8, 0, -4.0),
        new THREE.Vector3(2.2, 0, -0.3),
        new THREE.Vector3(-0.6, 0, 3.4),
        new THREE.Vector3(2.4, 0, 7.0),
        new THREE.Vector3(3.6, 0, D / 2 - 0.18)
    ], false, 'catmullrom', 0.35);
    riverPts = riverCurve.getSpacedPoints(140);
    const a = frameAt(0.02).p;
    const b = frameAt(0.98).p;
    waterY0 = hillOnly(a.x, a.z) - 0.28;
    waterY1 = hillOnly(b.x, b.z) - 1.05;
    const end = riverCurve.getPointAt(1);
    outlet.x = end.x;
    outlet.y = waterLevel(1);
}

function hillOnly(x, z) {
    return 4.18
        + Math.sin(x * 0.28 + 0.7) * 0.38
        + Math.cos(z * 0.33 - 0.4) * 0.3
        + Math.sin(x * 0.82 + z * 0.55) * 0.1
        + (fbm2(x * 0.32 + 2.0, z * 0.32) - 0.45) * 0.34;
}

function waterLevel(t) {
    return waterY0 + (waterY1 - waterY0) * t;
}

function channelWidth(t) {
    const pinch = t < 0.08 ? 0.55 + t * 5.6 : 1;
    return (1.12 + Math.sin(t * 5.2) * 0.14) * pinch;
}

function surfaceHeight(x, z) {
    let h = hillOnly(x, z);
    const hit = distToRiver(x, z);
    const bedHalf = 1.32;
    const bank = 2.15;
    if (hit.d < bank) {
        let k;
        if (hit.d <= bedHalf) k = 1;
        else k = 1 - smoothstep(0, 1, (hit.d - bedHalf) / (bank - bedHalf));
        const bed = waterLevel(hit.t) - 0.62;
        h = h * (1 - k) + Math.min(h, bed) * k;
    }
    const cd = Math.hypot(x - CABIN.x, z - CABIN.z);
    if (cd < CABIN.pad) {
        const s = smoothstep(1, 0, cd / CABIN.pad);
        h = h * (1 - s) + CABIN.padH * s;
    }
    return Math.max(h, 1.25);
}

function distToRiver(x, z) {
    let best = Infinity;
    let bestT = 0;
    const n = riverPts.length;
    for (let i = 0; i < n - 1; i++) {
        const ax = riverPts[i].x;
        const az = riverPts[i].z;
        const dx = riverPts[i + 1].x - ax;
        const dz = riverPts[i + 1].z - az;
        const len2 = dx * dx + dz * dz || 1;
        let u = ((x - ax) * dx + (z - az) * dz) / len2;
        u = Math.max(0, Math.min(1, u));
        const d = Math.hypot(x - (ax + dx * u), z - (az + dz * u));
        if (d < best) {
            best = d;
            bestT = (i + u) / (n - 1);
        }
    }
    return { d: best, t: bestT };
}

function frameAt(t) {
    const u = THREE.MathUtils.clamp(t, 0.001, 0.999);
    const p = riverCurve.getPointAt(u);
    const tan = riverCurve.getTangentAt(u);
    tan.y = 0;
    tan.normalize();
    const side = new THREE.Vector3(-tan.z, 0, tan.x);
    return { p, tan, side };
}

function sorrelAmount(x, z) {
    const n = fbm2(x * 0.42 + 7.0, z * 0.42 - 3.0);
    let k = smoothstep(0.38, 0.5, n);
    if (k === 0) return 0;
    if (distToRiver(x, z).d < 1.9) return 0;
    if (Math.hypot(x - CABIN.x, z - CABIN.z) < 1.7) return 0;
    if (distToTrail(x, z) < 0.55) return 0;
    for (const tree of TREES) {
        if (Math.hypot(x - tree.x, z - tree.z) < tree.r * 1.9 + 0.5) return 0;
    }
    return k;
}

function buildTerrain() {
    const gx = SEGS_X;
    const gz = SEGS_Z;
    const positions = [];
    const indices = [];
    for (let j = 0; j <= gz; j++) {
        for (let i = 0; i <= gx; i++) {
            const x = (i / gx - 0.5) * W;
            const z = (j / gz - 0.5) * D;
            positions.push(x, surfaceHeight(x, z), z);
        }
    }
    for (let j = 0; j < gz; j++) {
        for (let i = 0; i < gx; i++) {
            const a = j * (gx + 1) + i;
            const b = a + 1;
            const c = a + gx + 1;
            const d = c + 1;
            indices.push(a, c, b, b, c, d);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const pos = geo.attributes.position;
    const norm = geo.attributes.normal;
    const colors = new Float32Array(pos.count * 3);
    const duffA = new THREE.Color('#4a3322');
    const duffB = new THREE.Color('#3a2c1e');
    const litter = new THREE.Color('#74442a');
    const sorrel = new THREE.Color('#4b7034');
    const moss = new THREE.Color('#3e6a36');
    const groundGreen = new THREE.Color('#3f5f2e');
    const trail = new THREE.Color('#94532f');
    const trailEdge = new THREE.Color('#6a4630');
    const gravel = new THREE.Color('#a39b8b');
    const bed = new THREE.Color('#566760');
    const packed = new THREE.Color('#5e4836');
    const slope = new THREE.Color('#6b5948');
    const tmp = new THREE.Color();
    const allTrees = [...TREES, STUMP];
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        const ny = norm.getY(i);
        const hit = distToRiver(x, z);
        const n = fbm2(x * 1.3, z * 1.3);
        tmp.copy(duffA).lerp(duffB, n);
        tmp.lerp(groundGreen, smoothstep(0.32, 0.56, fbm2(x * 0.55 - 4.0, z * 0.55 + 9.0)) * 0.7);

        for (const tree of allTrees) {
            const dd = Math.hypot(x - tree.x, z - tree.z) - tree.r * 1.5;
            const k = 1 - smoothstep(0, 1.2 + tree.r, dd);
            if (k > 0) tmp.lerp(litter, k * 0.35);
        }

        const s = sorrelAmount(x, z);
        if (s > 0) tmp.lerp(sorrel, s * 0.85);

        const td = distToTrail(x, z);
        if (td < 0.62) {
            tmp.lerp(trailEdge, 0.7 * (1 - smoothstep(0.42, 0.62, td)));
            tmp.lerp(trail, 0.9 * (1 - smoothstep(0.22, 0.44, td)));
        }

        if (ny < 0.78) tmp.lerp(slope, 0.32);
        if (hit.d < 1.38) tmp.lerp(bed, 0.92);
        else if (hit.d < 1.8) tmp.lerp(gravel, 0.72);
        else if (hit.d < 2.7) tmp.lerp(moss, 0.5 * (1 - smoothstep(1.8, 2.7, hit.d)));

        const cd = Math.hypot(x - CABIN.x, z - CABIN.z);
        if (cd < 1.7) tmp.lerp(packed, 0.6 * (1 - cd / 1.7));

        tmp.multiplyScalar(0.88 + n * 0.22);
        colors[i * 3] = tmp.r;
        colors[i * 3 + 1] = tmp.g;
        colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.95,
        metalness: 0
    }));
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    return mesh;
}

// Cut faces

function buildWalls() {
    const group = new THREE.Group();
    const specs = [
        { name: 'front', length: W, at: (u) => [(u - 0.5) * W, D / 2], normal: [0, 0, 1], flip: false },
        { name: 'back', length: W, at: (u) => [(u - 0.5) * W, -D / 2], normal: [0, 0, -1], flip: true },
        { name: 'right', length: D, at: (u) => [W / 2, (u - 0.5) * D], normal: [1, 0, 0], flip: true },
        { name: 'left', length: D, at: (u) => [-W / 2, (u - 0.5) * D], normal: [-1, 0, 0], flip: false }
    ];

    specs.forEach((spec, index) => {
        const heightAt = (u) => {
            const [x, z] = spec.at(THREE.MathUtils.clamp(u, 0, 1));
            return surfaceHeight(x, z);
        };

        const roots = [];
        for (const tree of [...TREES, STUMP]) {
            if (tree.sapling) continue;
            let dist;
            let u;
            if (spec.name === 'front') { dist = D / 2 - tree.z; u = tree.x / W + 0.5; }
            else if (spec.name === 'back') { dist = tree.z + D / 2; u = tree.x / W + 0.5; }
            else if (spec.name === 'right') { dist = W / 2 - tree.x; u = tree.z / D + 0.5; }
            else { dist = tree.x + W / 2; u = tree.z / D + 0.5; }
            const reach = tree.r * 2.6 + 0.6;
            if (dist < reach) roots.push({ u, strength: tree.r * (1 - Math.max(dist, 0) / reach) });
        }

        const texture = paintStrata({
            length: spec.length,
            heightAt,
            seed: 11 + index * 17,
            outletU: spec.name === 'front' ? outlet.x / W + 0.5 : null,
            roots
        });

        const cols = Math.round(spec.length * 3.6);
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];
        for (let i = 0; i <= cols; i++) {
            const u = i / cols;
            const [x, z] = spec.at(u);
            const h = surfaceHeight(x, z);
            positions.push(x, h, z, x, BASE, z);
            normals.push(...spec.normal, ...spec.normal);
            uvs.push(u, (h - BASE) / (TOP - BASE), u, 0);
        }
        for (let i = 0; i < cols; i++) {
            const a = i * 2;
            const b = a + 1;
            const c = a + 2;
            const d = a + 3;
            if (spec.flip) indices.push(a, d, b, a, c, d);
            else indices.push(a, b, d, a, d, c);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geo.setIndex(indices);
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
            map: texture,
            roughness: 0.94,
            metalness: 0,
            side: THREE.DoubleSide
        }));
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
    });
    return group;
}

function paintStrata({ length, heightAt, seed, outletU, roots }) {
    const ppu = 56;
    const w = Math.ceil(length * ppu);
    const h = Math.ceil((TOP - BASE) * ppu);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    const r = mulberry32(seed);
    const Y = (y) => (TOP - y) * ppu;
    const s = seed * 0.37;
    const b1 = (x) => 2.3 + Math.sin(x * 0.55 + s) * 0.14 + Math.sin(x * 1.7 + s * 2) * 0.05;
    const b2 = (x) => 0.85 + Math.sin(x * 0.38 + 1.3 + s) * 0.2 + Math.sin(x * 1.1 + s) * 0.05;
    const b3 = (x) => -0.6 + Math.sin(x * 0.7 + 2.1 + s) * 0.12;

    const surf = new Float32Array(w + 1);
    for (let px = 0; px <= w; px++) surf[px] = heightAt(px / w);

    for (let px = 0; px < w; px++) {
        const x = px / ppu;
        const hs = surf[px];
        const soilTop = hs - 0.5;
        const paint = (color, lowerY) => {
            g.fillStyle = color;
            g.fillRect(px, 0, 1, Math.ceil(Y(lowerY)) + 1);
        };
        g.fillStyle = '#58675f';
        g.fillRect(px, 0, 1, h);
        paint('#a4987f', Math.min(b3(x), soilTop));
        paint('#c99659', Math.min(b2(x), soilTop));
        paint('#8c5332', Math.min(b1(x), soilTop));
        paint('#4a2a19', soilTop);
        paint('#2a180f', hs - 0.09);
    }

    const speckles = Math.round((w * h) / 80);
    for (let i = 0; i < speckles; i++) {
        g.fillStyle = r() > 0.5 ? 'rgba(255, 240, 220, 0.09)' : 'rgba(20, 12, 8, 0.12)';
        const size = 1 + r() * 2;
        g.fillRect(r() * w, r() * h, size, size);
    }

    function strokeBand(lower, upper, f, color, width) {
        g.strokeStyle = color;
        g.lineWidth = width;
        g.beginPath();
        let pen = false;
        for (let px = 0; px <= w; px += 4) {
            const x = px / ppu;
            const y = lower(x) + (upper(x) - lower(x)) * f + Math.sin(x * 2.3 + f * 9) * 0.025;
            if (y < surf[px] - 0.56) {
                if (pen) g.lineTo(px, Y(y));
                else g.moveTo(px, Y(y));
                pen = true;
            } else {
                pen = false;
            }
        }
        g.stroke();
    }

    for (let k = 0; k < 6; k++) {
        const f = 0.12 + k * 0.15 + r() * 0.04;
        strokeBand(b2, b1, f, k % 2 ? 'rgba(244, 216, 164, 0.5)' : 'rgba(146, 92, 50, 0.38)', 1.4);
    }
    for (let k = 0; k < 4; k++) {
        const f = 0.2 + k * 0.2 + r() * 0.05;
        strokeBand(() => BASE, b3, f, 'rgba(32, 42, 38, 0.32)', 1.2);
    }

    const palette = ['#beb6a6', '#928e83', '#aa9e89', '#7f8a83', '#cac2af', '#6f7a74'];
    const cobbleCount = Math.round(length * 15);
    for (let i = 0; i < cobbleCount; i++) {
        const px = r() * w;
        const x = px / ppu;
        const top = Math.min(b2(x), surf[Math.floor(px)] - 0.56);
        const bottom = b3(x);
        if (top - bottom < 0.12) continue;
        const y = bottom + (top - bottom) * (0.1 + r() * 0.8);
        const rx = 3 + r() * 9;
        const ry = rx * (0.55 + r() * 0.3);
        const cy = Y(y);
        const rot = (r() - 0.5) * 0.6;
        g.fillStyle = palette[Math.floor(r() * palette.length)];
        g.beginPath();
        g.ellipse(px, cy, rx, ry, rot, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = 'rgba(40, 30, 22, 0.38)';
        g.lineWidth = 1;
        g.stroke();
        g.fillStyle = 'rgba(255, 250, 235, 0.28)';
        g.beginPath();
        g.ellipse(px - rx * 0.25, cy - ry * 0.3, rx * 0.45, ry * 0.35, rot, 0, Math.PI * 2);
        g.fill();
    }

    const crackCount = Math.round(length * 1.8);
    for (let i = 0; i < crackCount; i++) {
        let px = r() * w;
        let y = BASE + 0.2 + r() * Math.max(0.2, b3(px / ppu) - BASE - 0.4);
        g.strokeStyle = r() > 0.35 ? 'rgba(26, 34, 32, 0.55)' : 'rgba(190, 208, 194, 0.38)';
        g.lineWidth = 0.8 + r() * 1.3;
        g.beginPath();
        g.moveTo(px, Y(y));
        const steps = 3 + Math.floor(r() * 5);
        for (let k = 0; k < steps; k++) {
            px += (r() - 0.5) * 34;
            y -= 0.1 + r() * 0.22;
            if (y < BASE) break;
            g.lineTo(px, Y(y));
        }
        g.stroke();
    }

    const fine = Math.round(length * 3.2);
    for (let i = 0; i < fine; i++) {
        const px0 = r() * w;
        const hs = surf[Math.floor(px0)];
        const len = 0.25 + r() * 0.85;
        const drift = (r() - 0.5) * 0.8;
        drawRoot(g, px0, Y(hs - 0.06), px0 + drift * ppu, Y(hs - len), 1 + r() * 1.6, 'rgba(34, 18, 10, 0.75)', (r() - 0.5) * 18);
    }

    for (const root of roots) {
        const px0 = root.u * w;
        if (px0 < -60 || px0 > w + 60) continue;
        const hs = heightAt(root.u);
        const count = 4 + Math.round(root.strength * 5);
        for (let k = 0; k < count; k++) {
            const spread = (k / (count - 1) - 0.5) * 2;
            const startX = px0 + spread * root.strength * 48;
            const endX = startX + spread * (30 + r() * 60) * root.strength;
            const depth = 0.7 + r() * 1.3 * root.strength;
            const width = (4 + r() * 6) * root.strength + 1.5;
            const bend = spread * 20;
            drawRoot(g, startX + 1.5, Y(hs - 0.05) + 1.5, endX + 1.5, Y(hs - depth) + 1.5, width, 'rgba(18, 9, 5, 0.45)', bend);
            drawRoot(g, startX, Y(hs - 0.05), endX, Y(hs - depth), width, '#6c3620', bend);
            drawRoot(g, startX - width * 0.2, Y(hs - 0.05), endX - width * 0.2, Y(hs - depth), Math.max(1, width * 0.3), 'rgba(200, 124, 82, 0.5)', bend);
        }
    }

    if (outletU !== null) {
        const px0 = outletU * w;
        const halfPx = 0.85 * ppu;
        const hs = heightAt(outletU);
        const grad = g.createLinearGradient(0, Y(hs), 0, h);
        grad.addColorStop(0, 'rgba(32, 52, 48, 0.6)');
        grad.addColorStop(1, 'rgba(32, 52, 48, 0.22)');
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(px0 - halfPx, Y(hs) - 6);
        g.lineTo(px0 + halfPx, Y(hs) - 6);
        g.lineTo(px0 + halfPx * 0.8, h);
        g.lineTo(px0 - halfPx * 0.8, h);
        g.closePath();
        g.fill();
        for (let i = 0; i < 90; i++) {
            const px = px0 + (r() - 0.5) * halfPx * 2.8;
            const y = heightAt(px / w) - r() * 0.7;
            g.fillStyle = r() > 0.5 ? 'rgba(78, 126, 62, 0.75)' : 'rgba(54, 98, 50, 0.75)';
            g.beginPath();
            g.arc(px, Y(y), 2 + r() * 4, 0, Math.PI * 2);
            g.fill();
        }
    }

    for (let i = 0; i < Math.round(length * 7); i++) {
        const px = r() * w;
        const y = surf[Math.floor(px)] - r() * 0.14;
        g.fillStyle = r() > 0.5 ? 'rgba(70, 112, 52, 0.8)' : 'rgba(110, 72, 40, 0.8)';
        g.beginPath();
        g.arc(px, Y(y), 1.5 + r() * 3, 0, Math.PI * 2);
        g.fill();
    }

    g.strokeStyle = 'rgba(14, 9, 5, 0.7)';
    g.lineWidth = 2;
    g.beginPath();
    for (let px = 0; px <= w; px += 3) {
        const y = Y(surf[px]);
        if (px === 0) g.moveTo(px, y);
        else g.lineTo(px, y);
    }
    g.stroke();

    const ao = g.createLinearGradient(0, Y(BASE + 1.5), 0, h);
    ao.addColorStop(0, 'rgba(10, 14, 12, 0)');
    ao.addColorStop(1, 'rgba(10, 14, 12, 0.34)');
    g.fillStyle = ao;
    g.fillRect(0, Y(BASE + 1.5), w, h);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
}

function drawRoot(g, x0, y0, x1, y1, width, color, bend = 0) {
    const cx = (x0 + x1) / 2 + bend;
    const cy = (y0 + y1) / 2;
    g.strokeStyle = color;
    g.lineCap = 'round';
    let px = x0;
    let py = y0;
    const n = 12;
    for (let i = 1; i <= n; i++) {
        const t = i / n;
        const qx = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1;
        const qy = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y1;
        g.lineWidth = Math.max(0.6, width * (1 - t * 0.85));
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(qx, qy);
        g.stroke();
        px = qx;
        py = qy;
    }
}

function buildPlinth() {
    const group = new THREE.Group();
    const pw = W + PLINTH_M * 2;
    const pd = D + PLINTH_M * 2;

    const slab = new THREE.Mesh(
        new THREE.BoxGeometry(pw, PLINTH_H, pd),
        new THREE.MeshStandardMaterial({ color: '#2e2824', roughness: 0.55 })
    );
    slab.position.y = BASE - PLINTH_H / 2;
    slab.castShadow = true;
    slab.receiveShadow = true;

    const foot = new THREE.Mesh(
        new THREE.BoxGeometry(pw + 0.16, 0.1, pd + 0.16),
        new THREE.MeshStandardMaterial({ color: '#3b332d', roughness: 0.5 })
    );
    foot.position.y = BASE - PLINTH_H + 0.05;

    const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(4.8, 0.36),
        new THREE.MeshStandardMaterial({ map: labelTexture(), metalness: 0.3, roughness: 0.42 })
    );
    plate.position.set(-6.6, BASE - PLINTH_H / 2, D / 2 + PLINTH_M + 0.006);

    const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(pw * 1.45, pd * 1.75),
        new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, fog: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = BASE - PLINTH_H - 0.02;

    group.add(slab, foot, plate, shadow);
    return group;
}

function labelTexture() {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 76;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 76);
    grd.addColorStop(0, '#cdb47a');
    grd.addColorStop(1, '#a08654');
    g.fillStyle = grd;
    g.fillRect(0, 0, 1024, 76);
    g.strokeStyle = 'rgba(70, 52, 24, 0.6)';
    g.lineWidth = 3;
    g.strokeRect(6, 6, 1012, 64);
    g.fillStyle = '#3b2e18';
    g.font = '600 32px "Helvetica Neue", Helvetica, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if ('letterSpacing' in g) g.letterSpacing = '7px';
    g.fillText('SEQUOIA SEMPERVIRENS', 512, 40);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
}

function blobTexture() {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(128, 128, 30, 128, 128, 128);
    grd.addColorStop(0, 'rgba(28, 34, 28, 0.42)');
    grd.addColorStop(0.55, 'rgba(28, 34, 28, 0.18)');
    grd.addColorStop(1, 'rgba(28, 34, 28, 0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(c);
}

// Trees

function placeTrees() {
    const specs = [
        { x: -6.0, z: -1.2, r: 1.32, h: 19.5 },
        { x: 6.8, z: -5.0, r: 1.12, h: 18 },
        { x: 0.9, z: -7.0, r: 0.92, h: 16.5 },
        { x: -8.2, z: 1.6, r: 0.68, h: 14.5 },
        { x: -8.0, z: -7.4, r: 0.55, h: 13.5 },
        { x: 8.6, z: -1.8, r: 0.5, h: 13 },
        { x: 8.4, z: -8.6, r: 0.45, h: 12 },
        { x: 9.0, z: 5.6, r: 0.4, h: 11.5 },
        { x: -4.4, z: -4.8, r: 0.3, h: 10.5 },
        { x: 3.6, z: -3.4, r: 0.27, h: 10 },
        { x: -3.2, z: -8.4, r: 0.34, h: 11 },
        { x: -2.4, z: D / 2 - 1.35, r: 1.1, h: 17, slice: true }
    ];
    const trees = specs.map((spec) => {
        const tree = { ...spec, taper: spec.r > 0.5 ? 0.34 : 0.42 };
        if (tree.slice) return tree;
        let { x, z } = shoveOutOfRiver(tree.x, tree.z, tree.r * 1.8 + 1.4);
        x = THREE.MathUtils.clamp(x, -W / 2 + tree.r * 1.8 + 0.3, W / 2 - tree.r * 1.8 - 0.3);
        z = THREE.MathUtils.clamp(z, -D / 2 + tree.r * 1.8 + 0.3, D / 2 - tree.r * 1.8 - 0.3);
        return { ...tree, x, z };
    });
    const ring = 5;
    for (let i = 0; i < ring; i++) {
        const a = (i / ring) * Math.PI * 2 + (rand() - 0.5) * 0.5;
        const rr = 1.6 + rand() * 0.35;
        trees.push({
            x: STUMP.x + Math.cos(a) * rr,
            z: STUMP.z + Math.sin(a) * rr,
            r: 0.14 + rand() * 0.08,
            h: 2.8 + rand() * 2.2,
            taper: 0.5,
            sapling: true
        });
    }
    return trees;
}

function shoveOutOfRiver(x, z, margin) {
    for (let k = 0; k < 12; k++) {
        const hit = distToRiver(x, z);
        if (hit.d >= margin) break;
        const { p, side } = frameAt(hit.t);
        const sign = Math.sign((x - p.x) * side.x + (z - p.z) * side.z) || 1;
        x += side.x * sign * 0.4;
        z += side.z * sign * 0.4;
    }
    return { x, z };
}

function trunkRadius(y, r, theta, h, taper) {
    const yy = Math.max(y, 0);
    const flare = 1 + 0.7 * Math.exp(-yy / (r * 2.2));
    const lobes = 1 + 0.16 * Math.sin(theta * 3 + 0.7) * Math.exp(-yy / (r * 3));
    const furrow = 1 + 0.085 * Math.sin(theta * 13 + yy * 0.4);
    const u = yy / h;
    return r * flare * lobes * furrow * Math.max(0.08, 1 - taper * (u + 0.6 * u * u * u));
}

function buildTree(tree) {
    const group = new THREE.Group();
    const yBase = surfaceHeight(tree.x, tree.z);
    const big = tree.r > 0.5;
    const radial = big ? 36 : 16;
    const rows = tree.stump ? 4 : big ? 56 : 20;
    const taper = tree.stump ? 0.04 : tree.taper;
    const trunkH = tree.stump ? tree.h : tree.h * 0.9;
    const clip = tree.slice ? [new THREE.Plane(new THREE.Vector3(0, 0, -1), D / 2)] : null;

    const geo = new THREE.CylinderGeometry(1, 1, trunkH, radial, rows, true);
    geo.translate(0, trunkH / 2, 0);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const ridge = new THREE.Color(tree.stump ? '#8a6250' : '#86513a');
    const groove = new THREE.Color('#2e1b13');
    const moss = new THREE.Color('#41703e');
    const lichen = new THREE.Color('#7f8b6c');
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        const theta = Math.atan2(pos.getZ(i), pos.getX(i));
        const rr = trunkRadius(y, tree.r, theta, tree.h, taper);
        pos.setXYZ(i, Math.cos(theta) * rr, y, Math.sin(theta) * rr);
        const furrow = Math.sin(theta * 13 + y * 0.4);
        const streak = noise2(theta * 2.2 + tree.x, y * 0.18);
        tmp.copy(ridge).lerp(groove, THREE.MathUtils.clamp(-furrow, 0, 1) * 0.85);
        tmp.multiplyScalar(0.8 + streak * 0.35);
        tmp.lerp(moss, Math.exp(-y / (tree.r * 1.1)) * 0.75);
        const shady = 0.5 - 0.5 * Math.cos(theta - 2.4);
        if (y > tree.h * 0.12) tmp.lerp(lichen, smoothstep(0.62, 0.9, noise2(theta * 3.1, y * 0.5)) * 0.55 * shady);
        if (hash2(theta * 4, y * 0.3) > 0.86 && y < tree.h * 0.3) tmp.lerp(moss, 0.35);
        colors[i * 3] = tmp.r;
        colors[i * 3 + 1] = tmp.g;
        colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const barkMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.88,
        metalness: 0
    });
    if (clip) {
        barkMat.clippingPlanes = clip;
        barkMat.clipShadows = true;
    }
    const trunk = new THREE.Mesh(geo, barkMat);
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    group.add(trunk);

    if (tree.stump) group.add(buildStumpCap(tree, radial, taper));
    else addCrown(group, tree);
    if (tree.slice) group.add(buildSliceCap(tree, radial, rows, taper, trunkH));

    group.position.set(tree.x, yBase - 0.05, tree.z);
    return group;
}

function addCrown(group, tree) {
    if (!sharedCrownMats) {
        sharedCrownMats = {
            foliage: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }),
            limb: new THREE.MeshStandardMaterial({ color: '#5b3121', roughness: 0.92 })
        };
    }
    const sapling = !!tree.sapling;
    const sf = sapling ? 0.4 : 1;
    const base = tree.h * (sapling ? 0.3 : 0.6);
    const top = tree.h * 1.04;
    const span = top - base;
    const maxR = sapling ? tree.r * 3.2 : Math.max(tree.r * 2.0, 0.9 + tree.r * 1.2);
    const step = sapling ? 0.3 : THREE.MathUtils.clamp(tree.h / 30, 0.3, 0.55);
    const foliage = [];
    const limbs = [];
    const up = new THREE.Vector3(0, 1, 0);
    const edgeX = W / 2 - 0.35;
    const edgeZ = D / 2 - 0.35;
    let a = rand() * Math.PI * 2;

    const pickColor = (k, outer) => {
        const idx = THREE.MathUtils.clamp(Math.floor(k * 2.2 + outer * 1.2 + rand() * 1.3), 0, 3);
        return CROWN_PALETTE[idx];
    };

    for (let y = base; y < top - span * 0.1; y += step * (0.8 + rand() * 0.4)) {
        const k = (y - base) / span;
        const env = maxR * Math.pow(1 - k, 0.78) * (0.5 + 0.5 * smoothstep(0, 0.28, k));
        const trunkR = y < tree.h * 0.9
            ? trunkRadius(y, tree.r, a, tree.h, tree.taper) * 0.85
            : tree.r * 0.12;
        const count = sapling ? 1 + (rand() < 0.4 ? 1 : 0) : k < 0.7 ? 2 : 1;

        for (let b = 0; b < count; b++) {
            a += 2.39996 + (rand() - 0.5) * 0.7;
            if (!sapling && k > 0.06 && rand() < 0.28) continue;
            const cx = Math.cos(a);
            const cz = Math.sin(a);
            const reach = !sapling && k < 0.6 && rand() < 0.14 ? 1.45 : 1;
            let len = Math.max(0.2 * sf, env * (0.55 + rand() * 0.5) * reach);
            const tx = (cx > 0 ? edgeX - tree.x : -edgeX - tree.x) / (cx || 1e-6);
            const tz = (cz > 0 ? edgeZ - tree.z : -edgeZ - tree.z) / (cz || 1e-6);
            len = Math.min(len, Math.max(0.15, Math.min(Math.abs(tx), Math.abs(tz)) - trunkR - 0.4 * sf));
            const rise = THREE.MathUtils.lerp(-0.42, 0.22, k) + (rand() - 0.5) * 0.15;
            const start = new THREE.Vector3(cx * trunkR, y, cz * trunkR);
            const dir = new THREE.Vector3(cx, rise, cz).normalize();
            const end = start.clone().addScaledVector(dir, len);

            if (!sapling && len > 0.45) {
                const lr = tree.r * 0.075 * (1 - k * 0.5);
                const limb = new THREE.CylinderGeometry(lr * 0.35, lr, len, 5, 1, true);
                limb.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir));
                limb.translate((start.x + end.x) / 2, (start.y + end.y) / 2, (start.z + end.z) / 2);
                limbs.push(limb);
            }

            const outer = Math.min(1, len / (maxR + 0.01));
            const c = start.clone().lerp(end, 0.8);
            foliage.push(foliageClump(
                (0.32 + len * 0.46) * sf,
                (0.13 + len * 0.06 + step * 0.3) * sf,
                (0.26 + len * 0.26) * sf,
                (0.16 + len * 0.12) * sf,
                pickColor(k, outer), rand() * 100, a, c
            ));
            if (len > 0.95) {
                const m = start.clone().lerp(end, 0.42);
                m.y += 0.08;
                foliage.push(foliageClump(
                    0.24 + len * 0.26, 0.2 + step * 0.3, 0.24 + len * 0.2, 0.06,
                    pickColor(k, outer * 0.5), rand() * 100, a + (rand() - 0.5) * 0.5, m
                ));
            }
        }

        if (k > (sapling ? 0.12 : 0.35) && rand() < (sapling ? 0.55 : 0.2)) {
            const s = (trunkR + env * 0.32) * (sapling ? 0.8 : 1);
            foliage.push(foliageClump(
                s, step * 1.1 * sf + 0.12, s * 0.9, 0.05 * sf,
                pickColor(k, 0), rand() * 100, rand() * 6.28,
                new THREE.Vector3(0, y, 0)
            ));
        }
    }

    if (!sapling) {
        const stubs = 3 + Math.floor(tree.h / 4);
        for (let i = 0; i < stubs; i++) {
            const y = tree.h * (0.3 + rand() * 0.28);
            const sa = rand() * Math.PI * 2;
            const tr = trunkRadius(y, tree.r, sa, tree.h, tree.taper) * 0.9;
            const len = 0.3 + rand() * (0.35 + tree.r * 0.4);
            const dir = new THREE.Vector3(Math.cos(sa), -0.25 - rand() * 0.4, Math.sin(sa)).normalize();
            const start = new THREE.Vector3(Math.cos(sa) * tr, y, Math.sin(sa) * tr);
            const lr = 0.025 + tree.r * 0.03;
            const stub = new THREE.CylinderGeometry(lr * 0.3, lr, len, 4, 1, true);
            stub.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir));
            stub.translate(start.x + dir.x * len / 2, start.y + dir.y * len / 2, start.z + dir.z * len / 2);
            limbs.push(stub);
        }

        const sprouts = 1 + Math.floor(rand() * (1 + tree.r * 2));
        for (let i = 0; i < sprouts; i++) {
            const y = tree.h * (0.15 + rand() * 0.35);
            const sa = rand() * Math.PI * 2;
            const tr = trunkRadius(y, tree.r, sa, tree.h, tree.taper);
            const s = 0.1 + rand() * 0.1;
            foliage.push(foliageClump(
                s * 1.5, s * 0.6, s * 1.1, s * 0.9, CROWN_PALETTE[2 + Math.floor(rand() * 2)], rand() * 100, sa,
                new THREE.Vector3(Math.cos(sa) * (tr + s * 0.6), y, Math.sin(sa) * (tr + s * 0.6))
            ));
        }
    }

    const leaderBase = top - span * 0.12;
    for (let i = 0; i < 3; i++) {
        const t = i / 3;
        const s = (0.26 - t * 0.12) * (sapling ? 0.55 : Math.min(1.3, 0.6 + tree.r * 0.5));
        foliage.push(foliageClump(
            s, s * 1.4, s, 0.02, CROWN_PALETTE[2 + (i > 0 ? 1 : 0)], rand() * 100, rand() * 6.28,
            new THREE.Vector3((rand() - 0.5) * 0.06, leaderBase + span * 0.12 * t, (rand() - 0.5) * 0.06)
        ));
    }
    const tipH = span * (sapling ? 0.16 : 0.09);
    const tip = new THREE.ConeGeometry(Math.max(0.06, tree.r * 0.12), tipH, 5).toNonIndexed();
    tip.deleteAttribute('uv');
    tip.translate(0, top + tipH * 0.35, 0);
    tip.computeVertexNormals();
    tintFoliage(tip, CROWN_PALETTE[3], 0.6);
    foliage.push(tip);

    const crown = new THREE.Mesh(mergeGeometries(foliage), sharedCrownMats.foliage);
    crown.castShadow = true;
    crown.receiveShadow = true;
    group.add(crown);
    foliage.forEach((g) => g.dispose());

    if (limbs.length) {
        const limbMesh = new THREE.Mesh(mergeGeometries(limbs), sharedCrownMats.limb);
        limbMesh.castShadow = true;
        group.add(limbMesh);
        limbs.forEach((g) => g.dispose());
    }
}

function foliageClump(len, thick, wide, droop, color, seed, angle, center) {
    if (!clumpBase) {
        clumpBase = new THREE.IcosahedronGeometry(1, 1);
        clumpBase.deleteAttribute('uv');
    }
    const g = clumpBase.clone();
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        let x = pos.getX(i);
        let y = pos.getY(i);
        let z = pos.getZ(i);
        const n = 0.78 + 0.36 * hash2(x * 2.1 + z * 1.3 + seed, y * 2.7 - seed * 0.31)
            + 0.12 * hash2(x * 5.3 - seed, z * 4.9 + y * 3.1);
        x *= n;
        y *= n;
        z *= n;
        if (y < 0) y *= 0.45;
        const fringe = y < -0.12 ? hash2(x * 7.3 + seed, z * 6.1 - y) * 0.7 : 0;
        pos.setXYZ(i, x * len, (y - fringe) * thick - droop * (x * x + z * z * 0.4), z * wide);
    }
    g.computeVertexNormals();
    tintFoliage(g, color, 0.35 + hash2(seed, 3.7) * 0.4);
    g.applyMatrix4(new THREE.Matrix4().makeRotationY(-angle).setPosition(center));
    return g;
}

function tintFoliage(g, color, tipAmount) {
    const nrm = g.attributes.normal;
    const count = g.attributes.position.count;
    const colors = new Float32Array(count * 3);
    const deep = color.clone().multiplyScalar(0.5);
    const tip = color.clone().lerp(CROWN_TIP, tipAmount);
    const c = new THREE.Color();
    for (let i = 0; i < count; i += 3) {
        const ny = nrm.getY(i);
        const nx = nrm.getX(i);
        const t = THREE.MathUtils.clamp(0.5 + 0.5 * ny + 0.18 * nx, 0, 1);
        c.copy(deep).lerp(color, smoothstep(0.05, 0.6, t));
        if (t > 0.72) c.lerp(tip, (t - 0.72) * 2.2);
        c.multiplyScalar(0.92 + hash2(i * 0.37, color.r * 10) * 0.16);
        for (let v = 0; v < 3 && i + v < count; v++) {
            colors[(i + v) * 3] = c.r;
            colors[(i + v) * 3 + 1] = c.g;
            colors[(i + v) * 3 + 2] = c.b;
        }
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function buildSliceCap(tree, radial, rows, taper, trunkH) {
    const d = D / 2 - tree.z;
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    for (let i = 0; i <= rows; i++) {
        const y = (trunkH * i) / rows;
        const pts = [];
        for (let k = 0; k <= radial; k++) {
            const theta = Math.PI / 2 - (k / radial) * Math.PI * 2;
            const rr = trunkRadius(y, tree.r, theta, tree.h, taper);
            pts.push([Math.cos(theta) * rr, Math.sin(theta) * rr]);
        }
        let lo = Infinity;
        let hi = -Infinity;
        for (let k = 0; k < radial; k++) {
            const [x0, z0] = pts[k];
            const [x1, z1] = pts[k + 1];
            if ((z0 - d) * (z1 - d) <= 0 && z0 !== z1) {
                const x = x0 + (x1 - x0) * ((d - z0) / (z1 - z0));
                lo = Math.min(lo, x);
                hi = Math.max(hi, x);
            }
        }
        if (!isFinite(lo)) {
            lo = 0;
            hi = 0;
        }
        const z = d + 0.015;
        positions.push(lo, y, z, hi, y, z);
        normals.push(0, 0, 1, 0, 0, 1);
        uvs.push(0, i / rows, 1, i / rows);
    }
    for (let i = 0; i < rows; i++) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        map: woodTexture(),
        roughness: 0.6,
        metalness: 0,
        side: THREE.DoubleSide
    }));
    mesh.receiveShadow = true;
    return mesh;
}

function buildStumpCap(tree, radial, taper) {
    const ring = [];
    let rmax = 0;
    for (let k = 0; k < radial; k++) {
        const theta = Math.PI / 2 - (k / radial) * Math.PI * 2;
        const rr = trunkRadius(tree.h, tree.r, theta, tree.h, taper);
        rmax = Math.max(rmax, rr);
        ring.push([Math.cos(theta) * rr, Math.sin(theta) * rr]);
    }
    const positions = [0, tree.h, 0];
    const normals = [0, 1, 0];
    const uvs = [0.5, 0.5];
    for (const [x, z] of ring) {
        positions.push(x, tree.h, z);
        normals.push(0, 1, 0);
        uvs.push(0.5 + x / (2 * rmax), 0.5 + z / (2 * rmax));
    }
    const indices = [];
    for (let k = 0; k < radial; k++) indices.push(0, 1 + k, 1 + ((k + 1) % radial));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        map: ringTexture(),
        roughness: 0.75,
        side: THREE.DoubleSide
    }));
    mesh.receiveShadow = true;
    return mesh;
}

function woodTexture() {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 512;
    const g = c.getContext('2d');
    const r = mulberry32(77);
    const grd = g.createLinearGradient(0, 0, 256, 0);
    grd.addColorStop(0, '#3a2116');
    grd.addColorStop(0.045, '#3a2116');
    grd.addColorStop(0.06, '#e8cd9a');
    grd.addColorStop(0.15, '#dcb47c');
    grd.addColorStop(0.2, '#b65e38');
    grd.addColorStop(0.5, '#c8714a');
    grd.addColorStop(0.8, '#b65e38');
    grd.addColorStop(0.85, '#dcb47c');
    grd.addColorStop(0.94, '#e8cd9a');
    grd.addColorStop(0.955, '#3a2116');
    grd.addColorStop(1, '#3a2116');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 512);
    for (let k = 1; k < 26; k++) {
        const off = Math.pow(k / 26, 0.85) * 112;
        g.strokeStyle = 'rgba(110, 46, 22, 0.34)';
        g.lineWidth = k % 4 === 0 ? 1.8 : 0.9;
        for (const sgn of [-1, 1]) {
            g.beginPath();
            for (let y = 0; y <= 512; y += 8) {
                const x = 128 + sgn * off + Math.sin(y * 0.015 + k) * 1.5;
                if (y === 0) g.moveTo(x, y);
                else g.lineTo(x, y);
            }
            g.stroke();
        }
    }
    g.strokeStyle = 'rgba(80, 30, 14, 0.5)';
    g.lineWidth = 2;
    g.beginPath();
    for (let y = 0; y <= 512; y += 8) {
        const x = 128 + Math.sin(y * 0.02) * 2;
        if (y === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
    }
    g.stroke();
    for (let i = 0; i < 1600; i++) {
        g.fillStyle = r() > 0.5 ? 'rgba(255, 230, 200, 0.06)' : 'rgba(60, 20, 8, 0.07)';
        g.fillRect(16 + r() * 224, r() * 512, 1, 3 + r() * 8);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
}

function ringTexture() {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const g = c.getContext('2d');
    const r = mulberry32(91);
    g.fillStyle = '#3b2216';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#d9bc8a';
    g.beginPath();
    g.arc(128, 128, 118, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ab5d3a';
    g.beginPath();
    g.arc(128, 128, 104, 0, Math.PI * 2);
    g.fill();
    for (let rr = 100; rr > 4; rr -= 3 + r() * 4) {
        g.strokeStyle = 'rgba(96, 40, 20, 0.45)';
        g.lineWidth = r() > 0.8 ? 1.8 : 1;
        g.beginPath();
        for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.1) {
            const w = rr + Math.sin(a * 3 + rr) * 1.6;
            const x = 128 + Math.cos(a) * w;
            const y = 128 + Math.sin(a) * w;
            if (a === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
        }
        g.stroke();
    }
    g.strokeStyle = 'rgba(40, 18, 8, 0.7)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(128, 128);
    g.lineTo(196, 70);
    g.stroke();
    g.fillStyle = '#4a2214';
    g.beginPath();
    g.arc(128, 128, 3, 0, Math.PI * 2);
    g.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

// Rocks

function clearOfThings(x, z, radius) {
    if (Math.abs(x) > W / 2 - radius - 0.2 || Math.abs(z) > D / 2 - radius - 0.2) return false;
    if (Math.hypot(x - CABIN.x, z - CABIN.z) < 2.0 + radius) return false;
    if (Math.hypot(x - STUMP.x, z - STUMP.z) < 2.3 + radius) return false;
    for (const tree of TREES) {
        if (Math.hypot(x - tree.x, z - tree.z) < tree.r * 1.9 + radius) return false;
    }
    for (const p of PATH) {
        if (Math.hypot(x - p.x, z - p.z) < 0.4 + radius) return false;
    }
    return true;
}

function placeRocks() {
    const specs = [
        { t: 0.0, back: 0.75, scale: 1.75, kind: 'boulder' },
        { t: 0.3, side: 0.2, scale: 0.85, kind: 'river' },
        { t: 0.5, side: -0.3, scale: 1.2, kind: 'river' },
        { t: 0.56, side: 0.45, scale: 0.6, kind: 'river' },
        { t: 0.7, side: 0.15, scale: 0.75, kind: 'river' },
        { t: 0.86, side: -0.25, scale: 0.95, kind: 'river' },
        { t: 0.2, bank: 1, dist: 2.75, scale: 1.4, kind: 'boulder' },
        { t: 0.42, bank: -1, dist: 2.6, scale: 1.1, kind: 'boulder' },
        { t: 0.62, bank: 1, dist: 2.95, scale: 1.55, kind: 'boulder' },
        { t: 0.78, bank: -1, dist: 2.45, scale: 0.9, kind: 'boulder' },
        { t: 0.14, bank: -1, dist: 2.3, scale: 0.7, kind: 'boulder' }
    ];
    const rocks = [];
    specs.forEach((spec, index) => {
        const f = frameAt(Math.max(spec.t, 0.001));
        const seed = 10 + index * 3.1;
        if (spec.back) {
            rocks.push({ ...spec, seed, x: f.p.x - f.tan.x * spec.back, z: f.p.z - f.tan.z * spec.back });
            return;
        }
        if (spec.kind === 'river') {
            const off = spec.side * channelWidth(spec.t);
            rocks.push({ ...spec, seed, x: f.p.x + f.side.x * off, z: f.p.z + f.side.z * off });
            return;
        }
        for (const sign of [spec.bank, -spec.bank]) {
            const x = f.p.x + f.side.x * spec.dist * sign;
            const z = f.p.z + f.side.z * spec.dist * sign;
            if (clearOfThings(x, z, spec.scale * 1.05)) {
                rocks.push({ ...spec, seed, x, z });
                return;
            }
        }
    });
    return rocks;
}

function createRockGeometry(seed, kind) {
    const river = kind === 'river';
    let geo = new THREE.IcosahedronGeometry(1, river ? 3 : 1);
    if (river) {
        geo.deleteAttribute('normal');
        geo.deleteAttribute('uv');
        geo = mergeVertices(geo);
    }
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const n = fbm2(x * 1.3 + seed, y * 1.3 + z * 0.7);
        const r = river ? 0.9 + n * 0.22 : 0.78 + n * 0.5;
        let yy = y * r * (river ? 0.78 : 0.74);
        if (yy < -0.3) yy = -0.3 + (yy + 0.3) * 0.3;
        pos.setXYZ(i, x * r * (river ? 1.15 : 1.05), yy, z * r * (river ? 0.92 : 1));
    }
    geo.computeVertexNormals();

    const norm = geo.attributes.normal;
    const colors = new Float32Array(pos.count * 3);
    const stones = river
        ? ['#6e7a73', '#66726c', '#78827b']
        : ['#8c958d', '#7e8984', '#999b90', '#848f86'];
    const stone = new THREE.Color(stones[Math.floor(hash2(seed, 1.7) * stones.length)]);
    const moss = new THREE.Color('#5c8840');
    const wet = new THREE.Color('#6c7a74');
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
        const ny = norm.getY(i);
        const y = pos.getY(i);
        tmp.copy(stone);
        if (!river) tmp.lerp(moss, smoothstep(0.38, 0.72, ny) * 0.92);
        if (river && y < 0.02) tmp.lerp(wet, 0.5);
        tmp.multiplyScalar(0.86 + fbm2(pos.getX(i) * 3 + seed, pos.getZ(i) * 3) * 0.24);
        colors[i * 3] = tmp.r;
        colors[i * 3 + 1] = tmp.g;
        colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geo;
}

function buildRocks(rocks) {
    const group = new THREE.Group();
    const riverMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62 });
    const boulderMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
    for (const rock of rocks) {
        const river = rock.kind === 'river';
        const mesh = new THREE.Mesh(createRockGeometry(rock.seed, rock.kind), river ? riverMat : boulderMat);
        mesh.scale.setScalar(rock.scale);
        mesh.rotation.y = rock.seed;
        const y = river
            ? waterLevel(rock.t) - rock.scale * 0.04
            : surfaceHeight(rock.x, rock.z) - rock.scale * 0.3;
        mesh.position.set(rock.x, y, rock.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
    }
    return group;
}

function pebbleMesh(count, colors, place) {
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) * 0.55);
    geo.computeVertexNormals();
    const mesh = new THREE.InstancedMesh(
        geo,
        new THREE.MeshStandardMaterial({ roughness: 0.75, flatShading: true }),
        count
    );
    const palette = colors.map((c) => new THREE.Color(c));
    const dummy = new THREE.Object3D();
    let placed = 0;
    let guard = 0;
    while (placed < count && guard < count * 20) {
        guard++;
        const p = place();
        if (!p) continue;
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(rand() * 0.4, rand() * Math.PI * 2, rand() * 0.4);
        dummy.scale.set(p.s * (0.8 + rand() * 0.6), p.s, p.s * (0.8 + rand() * 0.5));
        dummy.updateMatrix();
        mesh.setMatrixAt(placed, dummy.matrix);
        mesh.setColorAt(placed, palette[Math.floor(rand() * palette.length)]);
        placed++;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

function buildBedPebbles() {
    return pebbleMesh(110, ['#8d9a8f', '#a4a596', '#6f7d77', '#b7b0a0', '#7a8a6f', '#c2bcae'], () => {
        const t = 0.05 + rand() * 0.92;
        const f = frameAt(t);
        const off = (rand() * 2 - 1) * channelWidth(t) * 1.05;
        const x = f.p.x + f.side.x * off;
        const z = f.p.z + f.side.z * off;
        if (Math.abs(z) > D / 2 - 0.25) return null;
        const s = 0.07 + rand() * 0.15;
        return { x, z, y: surfaceHeight(x, z) + s * 0.2, s };
    });
}

function buildShorePebbles() {
    return pebbleMesh(60, ['#b9b4a6', '#9fa39a', '#c9c3b4', '#8b938b'], () => {
        const t = 0.06 + rand() * 0.9;
        const f = frameAt(t);
        const sign = rand() > 0.5 ? 1 : -1;
        const off = (channelWidth(t) + 0.45 + rand() * 0.55) * sign;
        const x = f.p.x + f.side.x * off;
        const z = f.p.z + f.side.z * off;
        if (Math.abs(z) > D / 2 - 0.25 || Math.abs(x) > W / 2 - 0.25) return null;
        const s = 0.08 + rand() * 0.14;
        return { x, z, y: surfaceHeight(x, z) + s * 0.25, s };
    });
}

// Water

function buildWater(rocks) {
    const samples = 100;
    const across = 6;
    const positions = [];
    const uvs = [];
    const foam = [];
    const indices = [];
    const riverRocks = rocks.filter((rock) => rock.kind === 'river');
    for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const frame = frameAt(t);
        const w = channelWidth(t) + 0.55;
        const y = waterLevel(t) + 0.02;
        for (let k = 0; k <= across; k++) {
            const u = k / across;
            const side = 1 - u * 2;
            const x = frame.p.x + frame.side.x * w * side;
            const z = Math.min(frame.p.z + frame.side.z * w * side, D / 2 - 0.01);
            positions.push(x, y, z);
            uvs.push(u, t);
            let f = 0;
            for (const rock of riverRocks) {
                const d = Math.hypot(x - rock.x, z - rock.z);
                f = Math.max(f, smoothstep(rock.scale * 1.12, rock.scale * 0.85, d) * 0.7);
            }
            if (t > 0.95) f = Math.max(f, (t - 0.95) / 0.05 * 0.6);
            foam.push(f);
        }
    }
    const stride = across + 1;
    for (let i = 0; i < samples; i++) {
        for (let k = 0; k < across; k++) {
            const a = i * stride + k;
            indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('foam', new THREE.Float32BufferAttribute(foam, 1));
    geo.setIndex(indices);

    const uTime = { value: 0 };
    timeUniforms.push(uTime);
    const mat = new THREE.ShaderMaterial({
        uniforms: { uTime },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: `
            uniform float uTime;
            attribute float foam;
            varying vec2 vUv;
            varying float vFoam;
            varying vec3 vWorld;
            void main() {
                vUv = uv;
                vFoam = foam;
                vec3 p = position;
                p.y += sin(uv.y * 40.0 - uTime * 2.2) * 0.012
                    + sin(uv.x * 9.0 + uv.y * 17.0 + uTime * 1.3) * 0.008;
                vec4 w = modelMatrix * vec4(p, 1.0);
                vWorld = w.xyz;
                gl_Position = projectionMatrix * viewMatrix * w;
            }
        `,
        fragmentShader: `
            precision highp float;
            uniform float uTime;
            varying vec2 vUv;
            varying float vFoam;
            varying vec3 vWorld;
            ${NOISE_GLSL}
            void main() {
                float edge = 1.0 - abs(vUv.x - 0.5) * 2.0;
                vec2 flow = vec2(vUv.x * 4.0, vUv.y * 22.0 - uTime * 0.8);
                float n = noise(flow) * 0.6 + noise(flow * 2.3 + 3.7) * 0.4;
                vec3 shallow = vec3(0.45, 0.76, 0.66);
                vec3 deep = vec3(0.07, 0.4, 0.37);
                vec3 col = mix(shallow, deep, smoothstep(0.15, 0.85, edge));
                col += (n - 0.5) * 0.07;
                float s = noise(vec2(vUv.x * 16.0, vUv.y * 6.0 - uTime * 0.7));
                float streak = smoothstep(0.68, 0.76, s) * (1.0 - smoothstep(0.76, 0.86, s));
                col = mix(col, vec3(0.9, 0.98, 0.95), streak * 0.5 * smoothstep(0.1, 0.5, edge));
                vec3 viewDir = normalize(cameraPosition - vWorld);
                float fres = pow(1.0 - clamp(viewDir.y, 0.0, 1.0), 3.0);
                col = mix(col, vec3(0.9, 0.93, 0.88), fres * 0.35);
                float f = smoothstep(0.3, 0.75, vFoam * (0.45 + 0.55 * noise(flow * 1.7)));
                col = mix(col, vec3(0.95, 0.98, 0.96), f);
                float alpha = mix(0.5, 0.84, smoothstep(0.0, 0.6, edge));
                alpha = max(alpha, f * 0.95);
                alpha *= smoothstep(0.0, 0.05, vUv.y);
                gl_FragColor = vec4(col, alpha);
            }
        `
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;
    return mesh;
}

function buildWaterfall() {
    const group = new THREE.Group();
    const half = 0.8;
    const top = outlet.y + 0.02;
    const bottom = BASE + 0.02;
    const rows = 32;
    const positions = [];
    const uvs = [];
    const indices = [];
    for (let i = 0; i <= rows; i++) {
        const t = i / rows;
        const y = top + (bottom - top) * t;
        const z = D / 2 + 0.03 + 0.5 * Math.sqrt(t);
        const w = half * (1 - 0.14 * t);
        positions.push(outlet.x - w, y, z, outlet.x + w, y, z);
        uvs.push(0, t, 1, t);
    }
    for (let i = 0; i < rows; i++) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);

    const uTime = { value: 0 };
    timeUniforms.push(uTime);
    const fall = new THREE.Mesh(geo, new THREE.ShaderMaterial({
        uniforms: { uTime },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            precision highp float;
            uniform float uTime;
            varying vec2 vUv;
            ${NOISE_GLSL}
            void main() {
                float s = noise(vec2(vUv.x * 10.0, vUv.y * 7.0 - uTime * 2.4));
                float s2 = noise(vec2(vUv.x * 23.0 + 4.0, vUv.y * 13.0 - uTime * 3.1));
                float edge = smoothstep(0.0, 0.16, vUv.x) * smoothstep(1.0, 0.84, vUv.x);
                vec3 col = mix(vec3(0.36, 0.64, 0.58), vec3(0.94, 0.98, 0.97), clamp(s * 0.7 + s2 * 0.5, 0.0, 1.0));
                col = mix(col, vec3(0.96, 0.99, 0.98), smoothstep(0.75, 1.0, vUv.y));
                float alpha = edge * (0.55 + 0.35 * s2);
                gl_FragColor = vec4(col, alpha);
            }
        `
    }));
    fall.renderOrder = 3;

    const poolTime = { value: 0 };
    timeUniforms.push(poolTime);
    const poolGeo = new THREE.CircleGeometry(1, 48);
    poolGeo.rotateX(-Math.PI / 2);
    const pool = new THREE.Mesh(poolGeo, new THREE.ShaderMaterial({
        uniforms: { uTime: poolTime },
        transparent: true,
        depthWrite: false,
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            precision highp float;
            uniform float uTime;
            varying vec2 vUv;
            void main() {
                vec2 p = vUv - vec2(0.5, 0.6);
                float r = length(p);
                float rings = sin(r * 48.0 - uTime * 5.0) * 0.5 + 0.5;
                vec3 col = mix(vec3(0.12, 0.42, 0.39), vec3(0.62, 0.84, 0.78), rings * 0.35);
                col = mix(col, vec3(0.95, 0.98, 0.97), smoothstep(0.2, 0.05, r));
                float alpha = smoothstep(0.5, 0.36, length(vUv - 0.5)) * 0.85;
                gl_FragColor = vec4(col, alpha);
            }
        `
    }));
    pool.scale.set(1.3, 1, 0.4);
    pool.position.set(outlet.x, BASE + 0.012, D / 2 + 0.48);
    pool.renderOrder = 2;

    const mist = new THREE.Sprite(new THREE.SpriteMaterial({
        map: softSpriteTexture(),
        transparent: true,
        depthWrite: false,
        opacity: 0.4,
        color: 0xf2f6f2
    }));
    mist.scale.set(2.2, 1.0, 1);
    mist.position.set(outlet.x, BASE + 0.5, D / 2 + 0.5);
    mist.renderOrder = 4;

    group.add(fall, pool, mist);
    return group;
}

function softSpriteTexture() {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 6, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255, 255, 255, 0.85)');
    grd.addColorStop(0.5, 'rgba(255, 255, 255, 0.3)');
    grd.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
}

// Plants

function fernTexture() {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 512;
    const g = c.getContext('2d');
    g.lineCap = 'round';
    g.strokeStyle = '#21522e';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(128, 500);
    g.quadraticCurveTo(124, 280, 136, 28);
    g.stroke();
    const pairs = 16;
    for (let i = 0; i < pairs; i++) {
        const t = (i + 0.6) / pairs;
        const y = 486 - t * 450;
        const reach = Math.sin(t * Math.PI) * 108;
        const lift = 18 + t * 36;
        g.lineWidth = 11 - t * 5;
        for (const s of [-1, 1]) {
            const grd = g.createLinearGradient(128, y, 128 + s * reach, y - lift);
            grd.addColorStop(0, '#255d33');
            grd.addColorStop(1, i % 2 ? '#4b8a48' : '#3f7d40');
            g.strokeStyle = grd;
            g.beginPath();
            g.moveTo(128, y);
            g.quadraticCurveTo(128 + s * reach * 0.45, y - lift * 0.25, 128 + s * reach, y - lift);
            g.stroke();
        }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
}

function fernCrownGeometry() {
    const plane = new THREE.PlaneGeometry(1.15, 1.85, 1, 3);
    plane.translate(0, 0.92, 0);
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    const srcPos = plane.attributes.position;
    const srcNor = plane.attributes.normal;
    const srcUv = plane.attributes.uv;
    const srcIndex = plane.index;
    const fronds = 7;
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let f = 0; f < fronds; f++) {
        const matrix = new THREE.Matrix4()
            .makeRotationY((f / fronds) * Math.PI * 2)
            .multiply(new THREE.Matrix4().makeRotationX(0.62 + (f % 2) * 0.18));
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
        const origin = positions.length / 3;
        for (let i = 0; i < srcPos.count; i++) {
            v.fromBufferAttribute(srcPos, i).applyMatrix4(matrix);
            n.fromBufferAttribute(srcNor, i).applyMatrix3(normalMatrix).normalize();
            positions.push(v.x, v.y, v.z);
            normals.push(n.x, n.y, n.z);
            uvs.push(srcUv.getX(i), srcUv.getY(i));
        }
        for (let i = 0; i < srcIndex.count; i++) indices.push(srcIndex.getX(i) + origin);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    return geo;
}

function buildFerns(rocks) {
    const mat = new THREE.MeshStandardMaterial({
        map: fernTexture(),
        roughness: 0.72,
        metalness: 0,
        side: THREE.DoubleSide,
        alphaTest: 0.35,
        emissive: new THREE.Color('#163a20'),
        emissiveIntensity: 0.35
    });
    mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = { value: 0 };
        timeUniforms.push(shader.uniforms.uTime);
        shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            #ifdef USE_INSTANCING
              float swayPhase = instanceMatrix[3].x + instanceMatrix[3].z;
            #else
              float swayPhase = 0.0;
            #endif
            float swayAmp = transformed.y * transformed.y;
            transformed.x += sin(uTime * 1.05 + swayPhase) * swayAmp * 0.04;
            transformed.z += cos(uTime * 0.8 + swayPhase) * swayAmp * 0.03;`
        );
    };

    const count = 190;
    const mesh = new THREE.InstancedMesh(fernCrownGeometry(), mat, count);
    const dummy = new THREE.Object3D();
    const allTrees = [...TREES, STUMP];
    let placed = 0;
    let guard = 0;
    while (placed < count && guard < 6000) {
        guard++;
        const x = (rand() - 0.5) * (W - 1.6);
        const z = (rand() - 0.5) * (D - 1.6);
        const hit = distToRiver(x, z);
        if (hit.d < 1.75) continue;
        if (Math.hypot(x - CABIN.x, z - CABIN.z) < 1.9) continue;
        if (allTrees.some((tree) => Math.hypot(x - tree.x, z - tree.z) < tree.r * 1.7 + 0.2)) continue;
        if (rocks.some((rock) => Math.hypot(x - rock.x, z - rock.z) < rock.scale * 0.9)) continue;
        if (distToTrail(x, z) < 1.0) continue;
        const nearTree = allTrees.some((tree) => Math.hypot(x - tree.x, z - tree.z) < tree.r * 1.7 + 2.4);
        const nearWater = hit.d < 2.9;
        if (!nearTree && !nearWater && rand() > 0.6) continue;
        const s = 0.5 + rand() * 0.55;
        dummy.position.set(x, surfaceHeight(x, z) - 0.02, z);
        dummy.rotation.set((rand() - 0.5) * 0.12, rand() * Math.PI * 2, (rand() - 0.5) * 0.12);
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        mesh.setMatrixAt(placed, dummy.matrix);
        placed++;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
}

function cloverGeometry() {
    const positions = [];
    const normals = [];
    for (let i = 0; i < 3; i++) {
        const leaf = new THREE.CircleGeometry(0.5, 7);
        leaf.scale(1, 0.85, 1);
        leaf.rotateX(-Math.PI / 2 + 0.3);
        leaf.translate(0, 0, 0.42);
        leaf.rotateY((i / 3) * Math.PI * 2);
        const flat = leaf.toNonIndexed();
        positions.push(...flat.attributes.position.array);
        normals.push(...flat.attributes.normal.array);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    return geo;
}

function buildSorrel(rocks) {
    const count = 1500;
    const mesh = new THREE.InstancedMesh(
        cloverGeometry(),
        new THREE.MeshStandardMaterial({ roughness: 0.6, side: THREE.DoubleSide }),
        count
    );
    const palette = ['#6aa046', '#5e9640', '#79ad50', '#558b3a'].map((c) => new THREE.Color(c));
    const dummy = new THREE.Object3D();
    let placed = 0;
    let guard = 0;
    while (placed < count && guard < 40000) {
        guard++;
        const x = (rand() - 0.5) * (W - 0.6);
        const z = (rand() - 0.5) * (D - 0.6);
        const k = sorrelAmount(x, z);
        if (k <= 0 || rand() > k) continue;
        if (rocks.some((rock) => Math.hypot(x - rock.x, z - rock.z) < rock.scale)) continue;
        const s = 0.1 + rand() * 0.07;
        dummy.position.set(x, surfaceHeight(x, z) + 0.04 + s * 0.25, z);
        dummy.rotation.set(0, rand() * Math.PI * 2, 0);
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        mesh.setMatrixAt(placed, dummy.matrix);
        mesh.setColorAt(placed, palette[Math.floor(rand() * palette.length)]);
        placed++;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.receiveShadow = true;
    return mesh;
}

function buildShrubs(rocks) {
    const palette = ['#2b5230', '#325c34', '#3c683a', '#2f5a3a'].map((c) => new THREE.Color(c));
    const allTrees = [...TREES, STUMP];
    const parts = [];
    let placed = 0;
    let guard = 0;
    while (placed < 46 && guard < 8000) {
        guard++;
        const x = (rand() - 0.5) * (W - 1.4);
        const z = (rand() - 0.5) * (D - 1.4);
        if (distToRiver(x, z).d < 2.2) continue;
        if (distToTrail(x, z) < 0.95) continue;
        if (Math.hypot(x - CABIN.x, z - CABIN.z) < 2.3) continue;
        if (allTrees.some((tree) => Math.hypot(x - tree.x, z - tree.z) < tree.r * 1.6 + 0.35)) continue;
        if (rocks.some((rock) => Math.hypot(x - rock.x, z - rock.z) < rock.scale + 0.4)) continue;
        const edge = Math.max(Math.abs(x) / (W / 2), Math.abs(z) / (D / 2));
        if (edge < 0.7 && rand() > 0.45) continue;
        const y0 = surfaceHeight(x, z);
        const size = 0.35 + rand() * 0.4;
        const clumps = 3 + Math.floor(rand() * 4);
        for (let i = 0; i < clumps; i++) {
            const a = rand() * Math.PI * 2;
            const d = rand() * size * 0.8;
            const s = size * (0.45 + rand() * 0.4);
            parts.push(foliageClump(
                s * 1.1, s * 0.75, s, s * 0.3,
                palette[Math.floor(rand() * palette.length)], rand() * 100, a,
                new THREE.Vector3(x + Math.cos(a) * d, y0 + s * 0.45 + rand() * size * 0.5, z + Math.sin(a) * d)
            ));
        }
        placed++;
    }
    const mesh = new THREE.Mesh(
        mergeGeometries(parts),
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, flatShading: true })
    );
    parts.forEach((g) => g.dispose());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

function buildLog() {
    const x = -4.6;
    const z = 1.6;
    const len = 3.4;
    const geo = new THREE.CylinderGeometry(0.32, 0.28, len, 14, 6);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const bark = new THREE.Color('#7a4a34');
    const moss = new THREE.Color('#4f7d3e');
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
        tmp.copy(bark);
        if (pos.getZ(i) > 0.04) tmp.lerp(moss, 0.65);
        tmp.multiplyScalar(0.9 + hash2(pos.getX(i) * 9, pos.getY(i) * 3) * 0.2);
        colors[i * 3] = tmp.r;
        colors[i * 3 + 1] = tmp.g;
        colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.rotateZ(Math.PI / 2);
    geo.rotateY(0.85);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
    mesh.position.set(x, surfaceHeight(x, z) + 0.12, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const group = new THREE.Group();
    group.add(mesh);
    const capMat = new THREE.MeshStandardMaterial({ color: '#e0a35a', roughness: 0.55 });
    const stemMat = new THREE.MeshStandardMaterial({ color: '#f1e6d4', roughness: 0.6 });
    for (let i = 0; i < 4; i++) {
        const m = new THREE.Group();
        const s = 0.7 + rand() * 0.6;
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025 * s, 0.035 * s, 0.12 * s, 6), stemMat);
        stem.position.y = 0.06 * s;
        const cap = new THREE.Mesh(new THREE.SphereGeometry(0.08 * s, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), capMat);
        cap.position.y = 0.11 * s;
        m.add(stem, cap);
        const t = (i - 1.5) * 0.5;
        const mx = x + Math.cos(0.85) * t;
        const mz = z - Math.sin(0.85) * t + 0.3;
        m.position.set(mx, surfaceHeight(mx, mz), mz);
        group.add(m);
    }
    return group;
}

// Cabin and path

function placePath() {
    const hit = distToRiver(CABIN.x, CABIN.z);
    const target = frameAt(hit.t).p;
    CABIN.yaw = Math.atan2(target.x - CABIN.x, target.z - CABIN.z);
    const dir = new THREE.Vector2(target.x - CABIN.x, target.z - CABIN.z).normalize();
    const door = new THREE.Vector3(CABIN.x + dir.x * 1.25, 0, CABIN.z + dir.y * 1.25);
    const curve = new THREE.CatmullRomCurve3([
        door,
        new THREE.Vector3(door.x + dir.x * 0.8, 0, door.z + dir.y * 0.8 + 1.2),
        new THREE.Vector3(5.6, 0, 4.5),
        new THREE.Vector3(6.9, 0, 6.7),
        new THREE.Vector3(7.3, 0, 8.9),
        new THREE.Vector3(7.7, 0, D / 2 + 0.4)
    ], false, 'catmullrom', 0.5);
    return curve.getSpacedPoints(90).map((p) => shoveOutOfRiver(p.x, p.z, 2.35));
}

function distToTrail(x, z) {
    let best = Infinity;
    for (let i = 0; i < PATH.length - 1; i++) {
        const a = PATH[i];
        const b = PATH[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const u = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1), 0, 1);
        const d = Math.hypot(x - a.x - dx * u, z - a.z - dz * u);
        if (d < best) best = d;
    }
    return best;
}

function buildPath() {
    const group = new THREE.Group();
    const i = Math.floor(PATH.length * 0.5);
    const p = PATH[i];
    const q = PATH[i - 3];
    const hiker = buildHiker();
    hiker.scale.setScalar(1.3);
    hiker.position.set(p.x, surfaceHeight(p.x, p.z), p.z);
    hiker.rotation.y = Math.atan2(q.x - p.x, q.z - p.z) + 0.5;
    group.add(hiker);

    const mat = new THREE.MeshStandardMaterial({ color: '#8f948c', roughness: 0.9, flatShading: true });
    const geo = new THREE.DodecahedronGeometry(1, 0);
    for (let k = 2; k < PATH.length - 2; k += 3) {
        if (rand() > 0.35) continue;
        const a = PATH[k];
        const b = PATH[k + 1];
        const nx = -(b.z - a.z);
        const nz = b.x - a.x;
        const nl = Math.hypot(nx, nz) || 1;
        const side = rand() < 0.5 ? -1 : 1;
        const x = a.x + (nx / nl) * side * (0.48 + rand() * 0.12);
        const z = a.z + (nz / nl) * side * (0.48 + rand() * 0.12);
        const s = 0.06 + rand() * 0.07;
        const stone = new THREE.Mesh(geo, mat);
        stone.scale.set(s * 1.3, s * 0.7, s);
        stone.rotation.set(rand(), rand() * 6, rand());
        stone.position.set(x, surfaceHeight(x, z) + s * 0.2, z);
        stone.castShadow = true;
        stone.receiveShadow = true;
        group.add(stone);
    }
    return group;
}

function buildHiker() {
    const g = new THREE.Group();
    const jacket = new THREE.MeshStandardMaterial({ color: '#2f80c8', roughness: 0.7 });
    const pants = new THREE.MeshStandardMaterial({ color: '#3b3a3e', roughness: 0.85 });
    const pack = new THREE.MeshStandardMaterial({ color: '#4a4636', roughness: 0.85 });
    const skin = new THREE.MeshStandardMaterial({ color: '#d9a882', roughness: 0.7 });
    const legGeo = new THREE.BoxGeometry(0.035, 0.16, 0.04);
    for (const sx of [-0.024, 0.024]) {
        const leg = new THREE.Mesh(legGeo, pants);
        leg.position.set(sx, 0.08, 0);
        g.add(leg);
    }
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.13, 0.065), jacket);
    torso.position.y = 0.225;
    const bag = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.045), pack);
    bag.position.set(0, 0.235, -0.05);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.034, 10, 8), skin);
    head.position.set(0, 0.32, 0.006);
    const hood = new THREE.Mesh(new THREE.SphereGeometry(0.038, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), jacket);
    hood.position.copy(head.position);
    hood.rotation.x = -0.6;
    const armGeo = new THREE.BoxGeometry(0.026, 0.11, 0.026);
    for (const sx of [-0.06, 0.06]) {
        const arm = new THREE.Mesh(armGeo, jacket);
        arm.position.set(sx * 0.8, 0.27, 0.04);
        arm.rotation.x = -1.9;
        arm.rotation.z = -sx * 2.5;
        g.add(arm);
    }
    g.add(torso, bag, head, hood);
    g.traverse((o) => {
        if (o.isMesh) o.castShadow = true;
    });
    return g;
}

function sidingTexture() {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const g = c.getContext('2d');
    for (let y = 0; y < 128; y += 10) {
        g.fillStyle = (y / 10) % 2 === 0 ? '#9e623c' : '#b97d50';
        g.fillRect(0, y, 128, 10);
        g.fillStyle = 'rgba(50, 24, 12, 0.32)';
        g.fillRect(0, y + 9, 128, 1);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 1.4);
    tex.anisotropy = 8;
    return tex;
}

function buildCabin() {
    const group = new THREE.Group();
    group.position.set(CABIN.x, surfaceHeight(CABIN.x, CABIN.z), CABIN.z);
    group.rotation.y = CABIN.yaw;

    const wallMat = new THREE.MeshStandardMaterial({ map: sidingTexture(), roughness: 0.82 });
    const trimMat = new THREE.MeshStandardMaterial({ color: '#5e3e2a', roughness: 0.82 });
    const roofMat = new THREE.MeshStandardMaterial({ color: '#46503f', roughness: 0.9 });
    const stoneMat = new THREE.MeshStandardMaterial({ color: '#7f7a72', roughness: 0.95 });
    const doorMat = new THREE.MeshStandardMaterial({ color: '#2a1f17', roughness: 0.72 });
    const glassMat = new THREE.MeshBasicMaterial({ color: '#ffc271' });

    const found = new THREE.Mesh(new THREE.BoxGeometry(2.25, 0.16, 1.75), stoneMat);
    found.position.y = 0.08;
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.05, 1.18, 1.55), wallMat);
    body.position.y = 0.75;
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.76, 0.05), doorMat);
    door.position.set(0.18, 0.54, 0.79);
    const frame1 = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.48, 0.04), trimMat);
    frame1.position.set(-0.5, 0.9, 0.78);
    const win1 = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.05), glassMat);
    win1.position.set(-0.5, 0.9, 0.81);
    const frame2 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.4, 0.4), trimMat);
    frame2.position.set(1.03, 0.88, 0.05);
    const win2 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.28, 0.28), glassMat);
    win2.position.set(1.05, 0.88, 0.05);

    const shape = new THREE.Shape();
    shape.moveTo(-1.32, 0);
    shape.lineTo(1.32, 0);
    shape.lineTo(0, 0.66);
    const roofGeo = new THREE.ExtrudeGeometry(shape, { depth: 2.0, bevelEnabled: false });
    roofGeo.translate(0, 0, -1.0);
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.y = 1.34;

    const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.62, 0.28), stoneMat);
    chimney.position.set(-0.72, 1.66, -0.28);

    const postGeo = new THREE.CylinderGeometry(0.035, 0.04, 1.18, 6);
    const postA = new THREE.Mesh(postGeo, trimMat);
    postA.position.set(-0.88, 0.75, 0.9);
    const postB = new THREE.Mesh(postGeo, trimMat);
    postB.position.set(0.88, 0.75, 0.9);
    const step = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.1, 0.32), trimMat);
    step.position.set(0.18, 0.05, 1.02);

    const woodpile = new THREE.Group();
    const logMat = new THREE.MeshStandardMaterial({ color: '#8a5a3a', roughness: 0.85 });
    const endMat = new THREE.MeshStandardMaterial({ color: '#d9b07a', roughness: 0.8 });
    const logGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.6, 7);
    logGeo.rotateX(Math.PI / 2);
    for (let row = 0; row < 3; row++) {
        for (let i = 0; i < 4 - row; i++) {
            const piece = new THREE.Mesh(logGeo, [logMat, endMat, endMat]);
            piece.position.set(-0.21 + i * 0.14 + row * 0.07, 0.07 + row * 0.12, 0);
            piece.castShadow = true;
            woodpile.add(piece);
        }
    }
    woodpile.position.set(1.25, 0.02, -0.35);

    const lamp = new THREE.PointLight(0xffaa55, 5, 6, 2);
    lamp.position.set(-0.5, 0.9, 1.1);

    group.add(found, body, door, frame1, win1, frame2, win2, roof, chimney, postA, postB, step, woodpile, lamp);
    group.traverse((obj) => {
        if (obj.isMesh) {
            obj.castShadow = obj.material !== glassMat;
            obj.receiveShadow = true;
        }
    });

    const smokeTex = softSpriteTexture();
    const puffs = [];
    for (let i = 0; i < 7; i++) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: smokeTex,
            color: 0xeeeeea,
            transparent: true,
            depthWrite: false,
            opacity: 0
        }));
        sprite.renderOrder = 7;
        group.add(sprite);
        puffs.push(sprite);
    }
    updaters.push((t) => {
        puffs.forEach((sprite, i) => {
            const p = (t * 0.16 + i / puffs.length) % 1;
            sprite.position.set(-0.72 + Math.sin(p * 4 + i) * 0.12 + p * 0.4, 2.0 + p * 2.3, -0.28);
            const sc = 0.22 + p * 0.8;
            sprite.scale.set(sc, sc, 1);
            sprite.material.opacity = Math.sin(p * Math.PI) * 0.34;
        });
    });

    return group;
}

// Atmosphere

function buildShafts() {
    const uTime = { value: 0 };
    timeUniforms.push(uTime);
    const mat = new THREE.ShaderMaterial({
        uniforms: { uTime },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            precision highp float;
            uniform float uTime;
            varying vec2 vUv;
            void main() {
                float v = smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
                float h = smoothstep(0.0, 0.5, vUv.x) * smoothstep(1.0, 0.5, vUv.x);
                float flick = 0.85 + 0.15 * sin(uTime * 0.6 + vUv.y * 5.0);
                gl_FragColor = vec4(1.0, 0.94, 0.8, v * h * 0.1 * flick);
            }
        `
    });
    const geo = new THREE.PlaneGeometry(1, 1);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), SUN_DIR);
    const specs = [
        { p: [-1.2, 9.8, 0.6], w: 2.0, l: 13 },
        { p: [3.4, 9.4, -2.0], w: 1.4, l: 11.5 },
        { p: [-6.8, 10.2, -3.6], w: 1.3, l: 12 },
        { p: [6.0, 9.0, 2.6], w: 1.1, l: 10 }
    ];
    const group = new THREE.Group();
    for (const spec of specs) {
        for (const twist of [0, Math.PI / 2]) {
            const mesh = new THREE.Mesh(geo, mat);
            mesh.quaternion.copy(q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), twist));
            mesh.scale.set(spec.w, spec.l, 1);
            mesh.position.set(...spec.p);
            mesh.renderOrder = 6;
            group.add(mesh);
        }
    }
    return group;
}

function mistTexture() {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const g = c.getContext('2d');
    for (let i = 0; i < 18; i++) {
        const x = 50 + rand() * 156;
        const y = 40 + rand() * 48;
        const r = 26 + rand() * 34;
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
        grd.addColorStop(1, 'rgba(255, 255, 255, 0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, 256, 128);
    }
    return new THREE.CanvasTexture(c);
}

function buildMist() {
    const group = new THREE.Group();
    const tex = mistTexture();
    const banks = [];
    for (let i = 0; i < 11; i++) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: tex,
            color: 0xf3f5f0,
            transparent: true,
            depthWrite: false,
            fog: false,
            opacity: 0.5 + rand() * 0.35
        }));
        const w = 7 + rand() * 6;
        sprite.scale.set(w, w * 0.36, 1);
        const home = new THREE.Vector3((rand() - 0.5) * 13, 7.5 + rand() * 8, (rand() - 0.5) * 13);
        sprite.position.copy(home);
        sprite.renderOrder = 5;
        group.add(sprite);
        banks.push({ sprite, home, phase: rand() * 6.28, speed: 0.04 + rand() * 0.05 });
    }
    updaters.push((t) => {
        for (const b of banks) {
            b.sprite.position.x = b.home.x + Math.sin(t * b.speed + b.phase) * 2.2;
            b.sprite.position.y = b.home.y + Math.sin(t * b.speed * 1.7 + b.phase) * 0.3;
        }
    });
    return group;
}

function buildMotes(renderer) {
    const count = 160;
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        const x = (rand() - 0.5) * (W - 3);
        const z = (rand() - 0.5) * (D - 3);
        positions[i * 3] = x;
        positions[i * 3 + 1] = surfaceHeight(x, z) + 0.6 + rand() * 5.5;
        positions[i * 3 + 2] = z;
        seeds[i] = rand();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    const uTime = { value: 0 };
    timeUniforms.push(uTime);
    const mat = new THREE.ShaderMaterial({
        uniforms: { uTime, uPR: { value: renderer.getPixelRatio() } },
        transparent: true,
        depthWrite: false,
        vertexShader: `
            attribute float aSeed;
            uniform float uTime;
            uniform float uPR;
            varying float vAlpha;
            void main() {
                vec3 p = position;
                p.x += sin(uTime * 0.25 + aSeed * 6.28) * 0.35;
                p.y += sin(uTime * 0.18 + aSeed * 12.0) * 0.45;
                p.z += cos(uTime * 0.22 + aSeed * 9.0) * 0.35;
                vec4 mv = modelViewMatrix * vec4(p, 1.0);
                gl_Position = projectionMatrix * mv;
                gl_PointSize = (1.5 + aSeed * 2.5) * uPR * (40.0 / -mv.z);
                vAlpha = 0.3 + 0.45 * (0.5 + 0.5 * sin(uTime * 1.3 + aSeed * 30.0));
            }
        `,
        fragmentShader: `
            precision highp float;
            varying float vAlpha;
            void main() {
                float d = length(gl_PointCoord - 0.5);
                gl_FragColor = vec4(1.0, 0.94, 0.8, smoothstep(0.5, 0.0, d) * vAlpha);
            }
        `
    });
    const points = new THREE.Points(geo, mat);
    points.renderOrder = 8;
    return points;
}

// Utilities

function smoothstep(e0, e1, x) {
    const t = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
}

function hash2(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
}

function noise2(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy);
    const b = hash2(ix + 1, iy);
    const c = hash2(ix, iy + 1);
    const d = hash2(ix + 1, iy + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm2(x, y) {
    let v = 0;
    let a = 0.5;
    let f = 1;
    for (let i = 0; i < 4; i++) {
        v += a * noise2(x * f, y * f);
        f *= 2;
        a *= 0.5;
    }
    return v;
}

function mulberry32(seed) {
    let a = seed;
    return function () {
        a |= 0;
        a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function showError(target, err) {
    console.error(err);
    target.classList.add('has-error');
    const note = document.createElement('p');
    note.className = 'redwood-error';
    note.textContent = 'The redwood scene could not load in this browser.';
    target.appendChild(note);
}
