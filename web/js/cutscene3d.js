// High-Resolution WebGL 3D Switch-Era → 8-Bit NES Time-Kick Cutscene Renderer
// Uses a real-time WebGL Parallax Occlusion Mapping (POM) 3D depth shader + 3D particles
// for the Switch-era opening vista, then collapses the 3rd dimension and kicks Pyria
// backward through every console era down to flat blocky 8-bit NES!

const ERA_SEQUENCE = [
  {
    key: 'switch3d',
    src: '/assets/cutscenes/eras/era-06-hd-era.jpg',
    label: '⚠ GLITCH STORM!  SWITCH-ERA HD 3D',
    shortLabel: 'SWITCH HD 3D',
    bits: 1.0,
    color: '#38bdf8',
    pixelated: false,
    maxT: 0.65,
  },
  {
    key: '128bit',
    src: '/assets/cutscenes/eras/era-05-128bit-gamecube-ps2.jpg',
    label: '▼ BIT-DRAIN!  KICKED BACK TO 128-BIT',
    shortLabel: '128-BIT 3D',
    bits: 0.80,
    color: '#facc15',
    pixelated: false,
    maxT: 1.20,
  },
  {
    key: '64bit',
    src: '/assets/cutscenes/eras/era-04-64bit-n64.jpg',
    label: '▼ BIT-DRAIN!  KICKED BACK TO 64-BIT N64',
    shortLabel: '64-BIT N64',
    bits: 0.60,
    color: '#fb923c',
    pixelated: false,
    maxT: 1.75,
  },
  {
    key: '32bit',
    src: '/assets/cutscenes/eras/era-03-32bit-ps1-isometric.jpg',
    label: '▼ BIT-DRAIN!  KICKED BACK TO 32-BIT ISO',
    shortLabel: '32-BIT ISO',
    bits: 0.42,
    color: '#e879f9',
    pixelated: false,
    maxT: 2.30,
  },
  {
    key: '16bit',
    src: '/assets/cutscenes/eras/era-02-16bit-snes.jpg',
    label: '▼ CRITICAL!  FLATTENED TO 16-BIT SNES',
    shortLabel: '16-BIT SNES',
    bits: 0.24,
    color: '#f472b6',
    pixelated: true,
    maxT: 2.85,
  },
  {
    key: '8bit',
    src: '/assets/cutscenes/eras/era-01-8bit-nes.jpg',
    label: '✖ TIME-KICKED TO 8-BIT NES  •  0/8 BITS',
    shortLabel: '8-BIT NES',
    bits: 0.08,
    color: '#f43f5e',
    pixelated: true,
    maxT: Infinity,
  },
];

const IMG_CACHE = new Map();
function getEraImage(src) {
  if (!src) return null;
  if (IMG_CACHE.has(src)) {
    const entry = IMG_CACHE.get(src);
    return entry.loaded ? entry.img : null;
  }
  const entry = { img: new Image(), loaded: false, failed: false };
  entry.img.onload = () => {
    entry.loaded = true;
  };
  entry.img.onerror = () => {
    entry.failed = true;
  };
  entry.img.src = src;
  IMG_CACHE.set(src, entry);
  return null;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function drawCoverWithCamera(ctx, img, w, h, { zoom = 1, panX = 0, panY = 0, alignY = 0.5, pixelated = false } = {}) {
  if (!img || !img.naturalWidth || !img.naturalHeight) return;
  const baseScale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const scale = baseScale * zoom;
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  const dx = (w - dw) / 2 + panX;
  const dy = (h - dh) * alignY + panY;

  ctx.save();
  ctx.imageSmoothingEnabled = !pixelated;
  if (!pixelated) {
    ctx.imageSmoothingQuality = 'high';
  }
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

/**
 * Generates a smooth spatial 3D depth map calibrated to the exact composition of era-06-hd-era.jpg:
 *   0.00 = far sky / horizon mountains
 *   0.25 = floating sky-islands
 *   0.40 = valley waterfall & river
 *   0.58 = Rune Temple citadel & arched stone bridge
 *   0.68 = soaring crimson dragon
 *   0.85 = hovering Pip & Hero with glowing spellbook
 *   1.00 = foreground rocky cliff, cobblestone path, and overhanging left tree
 */
function buildSwitch3DDepthMap() {
  const w = 512;
  const h = 256;
  const raw = document.createElement('canvas');
  raw.width = w;
  raw.height = h;
  const c = raw.getContext('2d');

  // 1. Base sky & distant horizon gradient (far = dark)
  const base = c.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0.0, 'rgb(12,12,12)');
  base.addColorStop(0.45, 'rgb(28,28,28)');
  base.addColorStop(0.65, 'rgb(76,76,76)');
  base.addColorStop(1.0, 'rgb(235,235,235)');
  c.fillStyle = base;
  c.fillRect(0, 0, w, h);

  // 2. Floating sky-islands (upper left)
  c.fillStyle = 'rgb(70,70,70)';
  c.beginPath();
  c.ellipse(w * 0.19, h * 0.25, w * 0.055, h * 0.095, 0, 0, Math.PI * 2);
  c.ellipse(w * 0.33, h * 0.34, w * 0.036, h * 0.07, 0, 0, Math.PI * 2);
  c.fill();

  // 3. Valley waterfall & river recess (mid-far)
  c.fillStyle = 'rgb(96,96,96)';
  c.beginPath();
  c.ellipse(w * 0.44, h * 0.62, w * 0.11, h * 0.20, 0, 0, Math.PI * 2);
  c.fill();

  // 4. Rune Temple Citadel & arched stone bridge (mid-ground)
  c.fillStyle = 'rgb(148,148,148)';
  c.beginPath();
  c.roundRect(w * 0.15, h * 0.29, w * 0.22, h * 0.34, 18);
  c.fill();
  c.fillStyle = 'rgb(165,165,165)';
  c.beginPath();
  c.moveTo(w * 0.04, h * 0.68);
  c.lineTo(w * 0.28, h * 0.56);
  c.lineTo(w * 0.28, h * 0.80);
  c.lineTo(w * 0.04, h * 0.88);
  c.closePath();
  c.fill();

  // 5. Soaring Crimson Dragon (mid-near sky plane)
  c.fillStyle = 'rgb(176,176,176)';
  c.beginPath();
  c.ellipse(w * 0.50, h * 0.17, w * 0.15, h * 0.13, -0.15, 0, Math.PI * 2);
  c.fill();

  // 6. Foreground right cliff & cobblestone path rising toward viewer
  const rightCliff = c.createLinearGradient(w * 0.66, h * 0.40, w, h * 0.95);
  rightCliff.addColorStop(0, 'rgb(190,190,190)');
  rightCliff.addColorStop(1, 'rgb(252,252,252)');
  c.fillStyle = rightCliff;
  c.beginPath();
  c.moveTo(w * 0.68, h * 0.58);
  c.lineTo(w * 0.88, h * 0.0);
  c.lineTo(w, 0);
  c.lineTo(w, h);
  c.lineTo(w * 0.42, h);
  c.closePath();
  c.fill();

  // 7. Foreground Hero + glowing Spellbook (strong near plane!)
  c.fillStyle = 'rgb(228,228,228)';
  c.beginPath();
  c.ellipse(w * 0.615, h * 0.68, w * 0.068, h * 0.30, 0, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  c.ellipse(w * 0.555, h * 0.58, w * 0.048, h * 0.085, -0.15, 0, Math.PI * 2);
  c.fill();

  // 8. Hovering Pip (near plane on right)
  c.fillStyle = 'rgb(220,220,220)';
  c.beginPath();
  c.ellipse(w * 0.765, h * 0.40, w * 0.088, h * 0.145, 0.1, 0, Math.PI * 2);
  c.fill();

  // 9. Closest foreground left tree & mossy cliff ledge
  c.fillStyle = 'rgb(248,248,248)';
  c.beginPath();
  c.ellipse(w * 0.06, h * 0.45, w * 0.11, h * 0.34, 0, 0, Math.PI * 2);
  c.ellipse(w * 0.10, h * 0.88, w * 0.18, h * 0.22, 0, 0, Math.PI * 2);
  c.fill();

  // Soft Gaussian blur pass so depth transitions wrap smoothly in POM raymarching
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const oCtx = out.getContext('2d');
  oCtx.filter = 'blur(9px)';
  oCtx.drawImage(raw, 0, 0);
  oCtx.filter = 'none';
  return out;
}

const VERT_SHADER = `
  attribute vec2 aPos;
  varying vec2 vUv;
  void main() {
    vUv = aPos * 0.5 + 0.5;
    vUv.y = 1.0 - vUv.y;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }
`;

const FRAG_SHADER = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uColorTex;
  uniform sampler2D uDepthTex;
  uniform vec2 uCamera;      // 3D camera orbit + pointer offset
  uniform vec2 uImgScale;    // cover aspect fit
  uniform float uZoom;
  uniform float uTime;
  uniform float uDepthStrength;
  uniform float uStorm;

  vec2 toCoverUv(vec2 uv) {
    // Slight upward vertical framing bias (-0.032) so the soaring dragon's wings have clean headroom
    return (uv - vec2(0.5, 0.532)) * uImgScale / uZoom + vec2(0.5, 0.5);
  }

  void main() {
    vec2 baseUv = toCoverUv(vUv);

    // 16-step Parallax Occlusion Mapping (POM) raymarch for true 3D depth displacement
    const int STEPS = 16;
    float strength = 0.046 * uDepthStrength;
    vec2 rayDir = uCamera * strength;

    // Start from near plane (depth = 1.0) and march backward to far plane (depth = 0.0)
    float curLayer = 1.0;
    float layerStep = 1.0 / float(STEPS);
    vec2 curUv = baseUv - rayDir * 0.5;
    vec2 uvStep = rayDir * layerStep;

    float prevDepth = texture2D(uDepthTex, clamp(curUv, 0.002, 0.998)).r;
    float hitDepth = prevDepth;
    vec2 hitUv = curUv;

    for (int i = 0; i < STEPS; i++) {
      float d = texture2D(uDepthTex, clamp(curUv, 0.002, 0.998)).r;
      if (d >= curLayer) {
        // Linear refinement between this step and previous step
        float afterD = d - curLayer;
        float beforeD = (curLayer + layerStep) - prevDepth;
        float w = clamp(afterD / max(0.0001, afterD + beforeD), 0.0, 1.0);
        hitUv = curUv - uvStep * w;
        hitDepth = mix(d, prevDepth, w);
        break;
      }
      prevDepth = d;
      curUv += uvStep;
      curLayer -= layerStep;
      hitUv = curUv;
      hitDepth = d;
    }

    vec2 sampleUv = clamp(hitUv, 0.002, 0.998);

    // Subtle live animated ripple on the valley waterfall & river region
    float riverMask = smoothstep(0.32, 0.42, sampleUv.x) * (1.0 - smoothstep(0.49, 0.56, sampleUv.x))
                    * smoothstep(0.46, 0.56, sampleUv.y) * (1.0 - smoothstep(0.76, 0.88, sampleUv.y));
    if (riverMask > 0.01 && uDepthStrength > 0.2) {
      sampleUv.x += sin(sampleUv.y * 95.0 - uTime * 5.2) * 0.0018 * riverMask;
      sampleUv.y += cos(sampleUv.x * 70.0 - uTime * 3.8) * 0.0012 * riverMask;
    }

    // Subtle chromatic aberration during Lord Null's storm
    vec3 col;
    if (uStorm > 0.01) {
      float ca = uStorm * 0.008;
      col.r = texture2D(uColorTex, clamp(sampleUv + vec2(ca, 0.0), 0.002, 0.998)).r;
      col.g = texture2D(uColorTex, sampleUv).g;
      col.b = texture2D(uColorTex, clamp(sampleUv - vec2(ca, 0.0), 0.002, 0.998)).b;
    } else {
      col = texture2D(uColorTex, sampleUv).rgb;
    }

    // Real-time pulsing spellbook golden bloom (centered around Hero's open book)
    float bookDist = length((sampleUv - vec2(0.555, 0.575)) * vec2(1.6, 1.0));
    float bookPulse = (0.55 + 0.45 * sin(uTime * 3.4)) * smoothstep(0.16, 0.0, bookDist) * uDepthStrength;
    col += vec3(0.45, 0.72, 1.0) * bookPulse * 0.34;

    // Pulsing cyan emissive glow on the Rune Temple arches
    float runeDist = length((sampleUv - vec2(0.245, 0.42)) * vec2(1.4, 1.0));
    float runePulse = (0.5 + 0.5 * sin(uTime * 2.6 + 1.2)) * smoothstep(0.16, 0.0, runeDist) * uDepthStrength;
    col += vec3(0.15, 0.75, 1.0) * runePulse * 0.18;

    // Subtle depth-based atmospheric aerial perspective (adds rich 3D separation!)
    float farHaze = (1.0 - hitDepth) * 0.10 * uDepthStrength;
    col = mix(col, vec3(0.68, 0.88, 1.0), farHaze);

    // Subtle warm sunlit rim bloom near sky sunbeams
    float sunDist = length((sampleUv - vec2(0.50, 0.14)) * vec2(1.1, 1.4));
    float sunGlow = (0.7 + 0.3 * sin(uTime * 1.5)) * smoothstep(0.45, 0.0, sunDist) * uDepthStrength;
    col += vec3(1.0, 0.95, 0.76) * sunGlow * 0.14;

    // Soft cinema vignette
    float vig = smoothstep(0.92, 0.32, length((vUv - 0.5) * vec2(1.15, 1.05)));
    col *= mix(0.72, 1.0, vig);

    gl_FragColor = vec4(col, 1.0);
  }
`;

class WebGLSwitch3DRenderer {
  constructor(width, height) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl = this.canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.ready = false;
    this.colorUploaded = false;

    if (!this.gl) return;

    const gl = this.gl;
    const vs = this.compile(gl.VERTEX_SHADER, VERT_SHADER);
    const fs = this.compile(gl.FRAGMENT_SHADER, FRAG_SHADER);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;

    this.prog = prog;
    this.vs = vs;
    this.fs = fs;
    gl.useProgram(prog);

    // Fullscreen quad
    const buf = gl.createBuffer();
    this.vbo = buf;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // Uniform locations
    this.uColorTex = gl.getUniformLocation(prog, 'uColorTex');
    this.uDepthTex = gl.getUniformLocation(prog, 'uDepthTex');
    this.uCamera = gl.getUniformLocation(prog, 'uCamera');
    this.uImgScale = gl.getUniformLocation(prog, 'uImgScale');
    this.uZoom = gl.getUniformLocation(prog, 'uZoom');
    this.uTime = gl.getUniformLocation(prog, 'uTime');
    this.uDepthStrength = gl.getUniformLocation(prog, 'uDepthStrength');
    this.uStorm = gl.getUniformLocation(prog, 'uStorm');

    // Create textures
    this.colorTex = this.createTexture(0);
    this.depthTex = this.createTexture(1);

    // Upload procedural spatial depth map right away
    const depthCanvas = buildSwitch3DDepthMap();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, depthCanvas);

    gl.uniform1i(this.uColorTex, 0);
    gl.uniform1i(this.uDepthTex, 1);
    this.ready = true;
  }

  compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('WebGL cutscene shader compile error:', gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  }

  createTexture(unit) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  render(img, { camX, camY, zoom, time, depthStrength = 1.0, storm = 0.0 }) {
    if (!this.ready || !img || !img.naturalWidth) return false;
    const gl = this.gl;

    if (!this.colorUploaded) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      this.colorUploaded = true;
    }

    const canvasAspect = this.canvas.width / this.canvas.height;
    const imgAspect = img.naturalWidth / img.naturalHeight;
    let sx = 1.0;
    let sy = 1.0;
    if (canvasAspect > imgAspect) {
      sy = imgAspect / canvasAspect;
    } else {
      sx = canvasAspect / imgAspect;
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.prog);
    gl.uniform2f(this.uCamera, camX, camY);
    gl.uniform2f(this.uImgScale, sx, sy);
    gl.uniform1f(this.uZoom, zoom);
    gl.uniform1f(this.uTime, time);
    gl.uniform1f(this.uDepthStrength, depthStrength);
    gl.uniform1f(this.uStorm, storm);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  dispose() {
    if (!this.gl) return;
    const gl = this.gl;
    if (this.colorTex) gl.deleteTexture(this.colorTex);
    if (this.depthTex) gl.deleteTexture(this.depthTex);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.prog) gl.deleteProgram(this.prog);
    if (this.vs) gl.deleteShader(this.vs);
    if (this.fs) gl.deleteShader(this.fs);
    const loseExt = gl.getExtension('WEBGL_lose_context');
    if (loseExt) loseExt.loseContext();
    this.gl = null;
    this.ready = false;
  }
}

export class OpeningCutsceneRenderer {
  constructor() {
    for (const era of ERA_SEQUENCE) {
      getEraImage(era.src);
    }

    this.webgl3d = new WebGLSwitch3DRenderer(1280, 592);

    this.workCanvas = document.createElement('canvas');
    this.workCanvas.width = 1280;
    this.workCanvas.height = 592;
    this.workCtx = this.workCanvas.getContext('2d');

    this.crushCanvas = document.createElement('canvas');
    this.crushCtx = this.crushCanvas.getContext('2d');

    // True 3D (x, y, z) floating magic motes & sunlit dust in perspective space
    this.motes3D = Array.from({ length: 56 }, (_, i) => ({
      x: ((i * 197.3) % 1) * 2.0 - 1.0,
      y: ((i * 83.7) % 1) * 2.0 - 1.0,
      z: 0.25 + ((i * 47.1) % 1) * 1.4, // 0.25 = very near camera, 1.65 = far
      vx: 0.015 + (i % 5) * 0.006,
      vy: -0.025 - (i % 4) * 0.01,
      phase: i * 1.23,
      color: ['#fef9c3', '#bae6fd', '#fde68a', '#7dd3fc', '#ffffff'][i % 5],
    }));

    // Glitch debris shards for Beat 2 era drops
    this.shards = Array.from({ length: 38 }, (_, i) => ({
      x: ((i * 173) % 100) / 100,
      y: ((i * 67 + 19) % 100) / 100,
      w: 16 + (i % 5) * 18,
      h: 6 + (i % 4) * 8,
      color: ['#c084fc', '#38bdf8', '#f43f5e', '#facc15', '#ffffff'][i % 5],
    }));

    // Smoothed interactive pointer state
    this.smoothPtrX = 0;
    this.smoothPtrY = 0;
    this.isCoarsePointer = Boolean(window.matchMedia?.('(pointer: coarse)')?.matches);
  }

  dispose() {
    this.webgl3d?.dispose();
  }

  /**
   * Main entry point called every frame by cutscene.js when a beat has `sceneMode`.
   */
  render(ctx, width, height, {
    mode,
    elapsedSec,
    nowSec,
    appearance,
    sprites,
    beat,
    rightSpriteKey,
    rightSlide,
    pointer = { x: 0, y: 0 },
  }) {
    // Smoothly interpolate pointer for buttery 3D camera response
    this.smoothPtrX += (clamp(pointer.x || 0, -1, 1) - this.smoothPtrX) * 0.08;
    this.smoothPtrY += (clamp(pointer.y || 0, -1, 1) - this.smoothPtrY) * 0.08;

    ctx.save();

    if (mode === 'switch3d') {
      this.renderSwitch3D(ctx, width, height, elapsedSec, nowSec);
      ctx.restore();
      return;
    }

    if (mode === 'downgrade') {
      this.renderDowngradeSequence(ctx, width, height, {
        elapsedSec,
        nowSec,
        appearance,
        sprites,
        beat,
        rightSpriteKey,
        rightSlide,
      });
      ctx.restore();
      return;
    }

    // mode === 'meadow8bit' (post-shattering blocky 8-bit NES world)
    this.renderMeadow8Bit(ctx, width, height, {
      elapsedSec,
      nowSec,
      sprites,
      beat,
      rightSpriteKey,
      rightSlide,
    });
    ctx.restore();
  }

  /**
   * Beat 1: True WebGL 3D Parallax-Displaced Switch-Era HD Vista + 3D Perspective Particles.
   */
  renderSwitch3D(ctx, width, height, elapsedSec, nowSec) {
    const img = getEraImage(ERA_SEQUENCE[0].src);

    // Smooth figure-8 cinematic 3D camera orbit + interactive mouse tilt!
    const orbitX = Math.sin(nowSec * 0.65) * 0.72 + this.smoothPtrX * 0.55;
    const orbitY = Math.sin(nowSec * 0.95) * 0.36 + this.smoothPtrY * 0.35;
    const zoom = 1.07 + Math.min(0.05, elapsedSec * 0.008) + Math.sin(nowSec * 0.45) * 0.01;

    let renderedWebGL = false;
    if (img && this.webgl3d.ready) {
      renderedWebGL = this.webgl3d.render(img, {
        camX: orbitX,
        camY: orbitY,
        zoom,
        time: nowSec,
        depthStrength: 1.0,
        storm: 0.0,
      });
    }

    if (renderedWebGL) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.webgl3d.canvas, 0, 0, width, height);
    } else {
      const fallback = ctx.createLinearGradient(0, 0, 0, height);
      fallback.addColorStop(0, '#0ea5e9');
      fallback.addColorStop(1, '#14532d');
      ctx.fillStyle = fallback;
      ctx.fillRect(0, 0, width, height);
      if (img) {
        drawCoverWithCamera(ctx, img, width, height, {
          zoom,
          panX: orbitX * 18,
          panY: orbitY * 10,
          pixelated: false,
        });
      }
    }

    // True 3D perspective-projected floating magic particles & sunlit motes
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const m of this.motes3D) {
      const wx = ((m.x + nowSec * m.vx + 10) % 2) - 1;
      const wy = ((m.y + nowSec * m.vy + 10) % 2) - 1;
      const depthFactor = 1.0 / m.z;
      // Project 3D particle with matching camera parallax so near motes sweep faster!
      const sx = width * (0.5 + (wx - orbitX * 0.12 * depthFactor) * 0.56);
      const sy = height * (0.5 + (wy - orbitY * 0.08 * depthFactor) * 0.56);
      const radius = clamp(1.4 * depthFactor, 1.0, 4.8);
      const alpha = (0.28 + 0.45 * Math.sin(nowSec * 2.8 + m.phase)) * clamp(depthFactor * 0.65, 0.2, 0.9);

      ctx.fillStyle = m.color;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    this.drawSwitchEraBadge(ctx, width, nowSec);
  }

  /**
   * Beat 2: Lord Null's Glitch Storm collapses the 3rd dimension and kicks Pyria backward
   * through EVERY console era down to flat blocky 8-bit NES!
   */
  renderDowngradeSequence(ctx, width, height, {
    elapsedSec,
    nowSec,
    sprites,
    beat,
    rightSpriteKey,
    rightSlide,
  }) {
    let stageIdx = ERA_SEQUENCE.findIndex((s) => elapsedSec < s.maxT);
    if (stageIdx < 0) stageIdx = ERA_SEQUENCE.length - 1;
    const stage = ERA_SEQUENCE[stageIdx];
    const prevBoundary = stageIdx === 0 ? 0 : ERA_SEQUENCE[stageIdx - 1].maxT;
    const stageElapsed = elapsedSec - prevBoundary;
    const isFinal8Bit = stageIdx === ERA_SEQUENCE.length - 1;

    const dropImpact = stageIdx > 0 && stageElapsed < 0.26 ? 1 - stageElapsed / 0.26 : 0;
    const stormActive = !isFinal8Bit || stageElapsed < 0.45;

    const shakeMag = isFinal8Bit
      ? (stageElapsed < 0.45 ? 14 * (1 - stageElapsed / 0.45) : 1.5)
      : (4 + dropImpact * 14);
    const shakeX = Math.round((Math.random() - 0.5) * shakeMag * 2);
    const shakeY = Math.round((Math.random() - 0.5) * shakeMag * 2);

    ctx.save();
    ctx.translate(shakeX, shakeY);

    const wCtx = this.workCtx;
    wCtx.clearRect(0, 0, width, height);
    wCtx.fillStyle = '#09071a';
    wCtx.fillRect(0, 0, width, height);

    const img = getEraImage(stage.src);
    if (stageIdx === 0 && img && this.webgl3d.ready) {
      // Stage 0 still uses the live WebGL 3D depth shader while the 3D depth violently destabilizes!
      const collapse = clamp(stageElapsed / 0.65, 0, 1);
      const ok = this.webgl3d.render(img, {
        camX: Math.sin(nowSec * 14) * 0.45 * (1 - collapse * 0.4),
        camY: Math.cos(nowSec * 11) * 0.25,
        zoom: 1.07 - collapse * 0.04,
        time: nowSec,
        depthStrength: 1.0 - collapse * 0.55,
        storm: 0.35 + collapse * 0.65,
      });
      if (ok) {
        wCtx.drawImage(this.webgl3d.canvas, 0, 0, width, height);
      }
    } else if (img) {
      const zoom = isFinal8Bit ? 1.0 : 1.04 - stageIdx * 0.008;
      drawCoverWithCamera(wCtx, img, width, height, {
        zoom,
        panX: 0,
        panY: 0,
        alignY: isFinal8Bit ? 0.22 : 0.45,
        pixelated: stage.pixelated,
      });
    }

    // Live pixel-mosaic crush right before/during each era drop
    const crushBlock = dropImpact > 0.15
      ? Math.round(4 + dropImpact * 16)
      : (stageIdx === 4 && stageElapsed > 0.35 ? 10 : 1);

    let sliceSource = this.workCanvas;
    let sliceSrcW = width;
    let sliceSrcH = height;

    if (crushBlock > 1) {
      const cw = Math.max(48, Math.round(width / crushBlock));
      const ch = Math.max(24, Math.round(height / crushBlock));
      if (this.crushCanvas.width !== cw || this.crushCanvas.height !== ch) {
        this.crushCanvas.width = cw;
        this.crushCanvas.height = ch;
      }
      this.crushCtx.imageSmoothingEnabled = false;
      this.crushCtx.drawImage(this.workCanvas, 0, 0, cw, ch);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.crushCanvas, 0, 0, width, height);
      sliceSource = this.crushCanvas;
      sliceSrcW = cw;
      sliceSrcH = ch;
    } else {
      ctx.imageSmoothingEnabled = !stage.pixelated;
      ctx.drawImage(this.workCanvas, 0, 0, width, height);
    }

    if (stormActive) {
      const tintAlpha = isFinal8Bit ? 0.25 * (1 - stageElapsed / 0.45) : 0.18 + dropImpact * 0.28;
      ctx.fillStyle = `rgba(88, 28, 135, ${tintAlpha.toFixed(2)})`;
      ctx.fillRect(0, 0, width, height);

      // Blit glitch tear slices from offscreen source (never self-blitting ctx.canvas)
      const sliceCount = Math.round(5 + dropImpact * 10);
      for (let i = 0; i < sliceCount; i++) {
        const sy = Math.floor(((nowSec * 420 + i * 83) % height));
        const sh = 6 + (i % 4) * 10;
        const srcSy = (sy / height) * sliceSrcH;
        const srcSh = Math.max(1, (sh / height) * sliceSrcH);
        const dx = Math.round(Math.sin(nowSec * 31 + i * 2.7) * (14 + dropImpact * 48));
        ctx.drawImage(sliceSource, 0, srcSy, sliceSrcW, srcSh, dx, sy, width, sh);
        ctx.fillStyle = i % 2 === 0 ? 'rgba(192, 132, 252, 0.30)' : 'rgba(56, 189, 248, 0.28)';
        ctx.fillRect(0, sy, width, 4);
      }

      if (elapsedSec > 0.15 && !isFinal8Bit) {
        this.drawGlitchLightning(ctx, width, height, nowSec, stageIdx);
      }
    }

    if (dropImpact > 0.05) {
      ctx.save();
      ctx.globalAlpha = dropImpact;
      for (const s of this.shards) {
        const px = s.x * width + Math.sin(nowSec * 20 + s.y * 10) * 60;
        const py = s.y * height;
        ctx.fillStyle = s.color;
        ctx.fillRect(Math.round(px), Math.round(py), s.w, s.h);
      }
      ctx.restore();
    }

    if (dropImpact > 0.35) {
      const flashStrength = isFinal8Bit ? 0.85 : 0.42;
      const flashAlpha = ((dropImpact - 0.35) / 0.65) * flashStrength;
      ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha.toFixed(2)})`;
      ctx.fillRect(0, 0, width, height);
    }

    if (isFinal8Bit) {
      for (let i = 0; i < 4; i++) {
        const gy = Math.floor(((nowSec * 150 + i * 147) % height));
        ctx.fillStyle = i % 2 === 0 ? 'rgba(192, 132, 252, 0.28)' : 'rgba(56, 189, 248, 0.24)';
        ctx.fillRect(0, gy, width, 6);
      }
      const revealAlpha = clamp(stageElapsed / 0.35, 0, 1);
      ctx.save();
      ctx.globalAlpha = revealAlpha;
      this.draw8BitStageCharacters(ctx, width, height, {
        nowSec,
        sprites,
        beat,
        rightSpriteKey,
        rightSlide,
      });
      ctx.restore();
    }

    ctx.restore();

    this.drawBitDrainBanner(ctx, width, height, stage, stageIdx, isFinal8Bit && stageElapsed > 0.5, nowSec);
  }

  /**
   * Beats 3-5: Trapped in blocky 8-bit NES Whispering Meadow.
   */
  renderMeadow8Bit(ctx, width, height, { elapsedSec, nowSec, sprites, beat, rightSpriteKey, rightSlide }) {
    const img = getEraImage(ERA_SEQUENCE[ERA_SEQUENCE.length - 1].src);
    ctx.fillStyle = '#38b820';
    ctx.fillRect(0, 0, width, height);

    if (img) {
      drawCoverWithCamera(ctx, img, width, height, { zoom: 1.0, alignY: 0.22, pixelated: true });
    }

    const vig = ctx.createLinearGradient(0, height * 0.62, 0, height);
    vig.addColorStop(0, 'rgba(6, 10, 22, 0)');
    vig.addColorStop(1, 'rgba(6, 10, 22, 0.42)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, height * 0.62, width, height * 0.38);

    this.draw8BitStageCharacters(ctx, width, height, {
      nowSec,
      sprites,
      beat,
      rightSpriteKey,
      rightSlide,
    });

    if (beat?.vfx === 'celebrate') {
      this.draw8BitSparkles(ctx, width, height, elapsedSec);
    }

    this.draw8BitEraBadge(ctx, '8-BIT NES  •  0/8 BITS RESTORED', '#38bdf8');
  }

  drawGlitchLightning(ctx, width, height, nowSec, stageIdx) {
    ctx.save();
    for (let b = 0; b < 3; b++) {
      const seed = Math.floor(nowSec * 16 + b * 11 + stageIdx * 5);
      ctx.strokeStyle = b % 2 === 0 ? '#e879f9' : '#38bdf8';
      ctx.lineWidth = 4;
      ctx.beginPath();
      let lx = width * (0.25 + b * 0.25);
      let ly = 0;
      ctx.moveTo(lx, ly);
      for (let s = 1; s <= 7; s++) {
        lx += Math.sin(seed * 3.7 + s * 4.3) * 58;
        ly += height / 7;
        ctx.lineTo(lx, ly);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  draw8BitStageCharacters(ctx, width, height, { nowSec, sprites, beat, rightSpriteKey, rightSlide }) {
    if (!sprites || !rightSpriteKey) return;
    ctx.save();
    ctx.imageSmoothingEnabled = false;

    const bob = Math.round(Math.sin(nowSec * 5.2) * 5);
    const scale = width / 320;

    const slideOffset = Math.round((1 - rightSlide) * 44 * scale);
    const npcX = Math.round(218 * scale) + slideOffset;
    const npcY = Math.round(52 * scale) + bob;
    const npcSize = Math.round(42 * scale);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.30)';
    ctx.beginPath();
    ctx.ellipse(npcX + npcSize / 2, Math.round(52 * scale) + npcSize - 2, npcSize * 0.36, 9, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = beat?.side === 'right' ? 1.0 : 0.86;
    sprites.drawNpc(ctx, rightSpriteKey, '8bit', npcX, npcY, npcSize, npcSize);
    ctx.globalAlpha = 1.0;

    ctx.restore();
  }

  draw8BitSparkles(ctx, width, height, elapsedSec) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const colors = ['#facc15', '#38bdf8', '#4ade80', '#fb7185', '#fef08a'];
    for (let i = 0; i < 28; i++) {
      const px = ((i * 97 + Math.sin(elapsedSec * 2.2 + i) * 36) % width + width) % width;
      const py = ((i * 53 - elapsedSec * 120) % height + height) % height;
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(Math.round(px / 8) * 8, Math.round(py / 8) * 8, 8, 8);
    }
    ctx.restore();
  }

  drawSwitchEraBadge(ctx, width, t) {
    ctx.save();
    const padX = 24;
    const padY = 20;
    const bw = 344;
    const bh = 42;
    ctx.fillStyle = 'rgba(10, 16, 34, 0.72)';
    ctx.beginPath();
    ctx.roundRect(padX, padY, bw, bh, 21);
    ctx.fill();
    ctx.strokeStyle = 'rgba(254, 240, 138, 0.8)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const pulse = 0.65 + 0.35 * Math.sin(t * 4);
    ctx.fillStyle = `rgba(74, 222, 128, ${pulse.toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(padX + 22, padY + bh / 2, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#fef9c3';
    ctx.font = '800 16px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('PYRIA  •  SWITCH-ERA HD 3D', padX + 38, padY + bh / 2 + 1);

    // Subtle top-right live 3D camera pill
    if (this.webgl3d.ready) {
      const rw = 228;
      const rx = width - rw - 24;
      ctx.fillStyle = 'rgba(10, 16, 34, 0.62)';
      ctx.beginPath();
      ctx.roundRect(rx, padY, rw, 36, 18);
      ctx.fill();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#bae6fd';
      ctx.font = '700 13px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        this.isCoarsePointer ? 'LIVE 3D  •  TOUCH & DRAG' : 'LIVE 3D  •  MOVE MOUSE TO TILT',
        rx + rw / 2,
        padY + 19
      );
    }

    ctx.restore();
  }

  draw8BitEraBadge(ctx, text, accentColor = '#38bdf8') {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const padX = 24;
    const padY = 20;
    const bw = 356;
    const bh = 38;
    ctx.fillStyle = 'rgba(8, 12, 24, 0.9)';
    ctx.fillRect(padX, padY, bw, bh);
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 4;
    ctx.strokeRect(padX, padY, bw, bh);

    ctx.fillStyle = '#fef08a';
    ctx.font = 'bold 16px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, padX + 16, padY + bh / 2 + 1);
    ctx.restore();
  }

  drawBitDrainBanner(ctx, width, height, stage, stageIdx, settledBottom, nowSec) {
    ctx.save();
    const bw = 560;
    const bh = 56;
    const bx = Math.round((width - bw) / 2);
    const by = settledBottom ? height - bh - 16 : 18;

    ctx.fillStyle = 'rgba(10, 8, 24, 0.9)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = stage.color;
    ctx.lineWidth = 3;
    ctx.strokeRect(bx, by, bw, bh);

    const blink = !settledBottom && Math.floor(nowSec * 14) % 2 === 0;
    ctx.fillStyle = blink ? '#ffffff' : stage.color;
    ctx.font = 'bold 17px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(stage.label, width / 2, by + 22);

    const barX = bx + 22;
    const barY = by + 38;
    const barW = bw - 44;
    const barH = 10;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = stage.color;
    ctx.fillRect(barX, barY, Math.round(barW * stage.bits), barH);

    ctx.fillStyle = 'rgba(10, 8, 24, 0.85)';
    for (let i = 1; i < ERA_SEQUENCE.length; i++) {
      ctx.fillRect(barX + Math.round((barW / ERA_SEQUENCE.length) * i), barY, 3, barH);
    }

    ctx.restore();
  }
}
