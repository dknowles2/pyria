// Lightweight Offscreen WebGL 3D Portrait Renderer for 64-Bit Era UI, Modals, Workshop & Cutscenes
// Reuses the exact sculpted low-poly N64 character models from n64Characters.js with clean studio lighting.

import {
  CHAR_FS,
  CHAR_STRIDE_FLOATS,
  CHAR_VS,
  CharMeshBuilder,
  buildHero3D,
  buildNpc3D,
  buildPip3D,
  dirToYaw,
} from './n64Characters.js?v=20261127v';

const PORTRAIT_SIZE = 160;
const DRAGON_KEYS = new Set(['spark', 'pebble', 'emberwing', 'glacier', 'bramble', 'mire']);

function mat4Perspective(fovRad, aspect, near, far) {
  const f = 1.0 / Math.tan(fovRad * 0.5);
  const nf = 1.0 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function mat4LookAt(eye, target, up) {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4];
    const b1 = b[col * 4 + 1];
    const b2 = b[col * 4 + 2];
    const b3 = b[col * 4 + 3];
    out[col * 4]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
    out[col * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
    out[col * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[col * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

class N64PortraitRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = PORTRAIT_SIZE;
    this.canvas.height = PORTRAIT_SIZE;
    this.contextLost = false;
    this.available = false;

    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.initGL();
    });

    this.gl = this.canvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      depth: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!this.gl) return;
    this.initGL();
  }

  initGL() {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) {
      this.available = false;
      return;
    }
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      this.available = false;
      return;
    }
    gl.shaderSource(vs, CHAR_VS);
    gl.compileShader(vs);
    gl.shaderSource(fs, CHAR_FS);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS) || !gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      this.available = false;
      return;
    }
    const prog = gl.createProgram();
    if (!prog) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      this.available = false;
      return;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog);
      this.available = false;
      return;
    }

    this.prog = prog;
    this.buf = gl.createBuffer();
    if (!this.buf) {
      this.available = false;
      return;
    }
    this.loc = {
      aPos: gl.getAttribLocation(prog, 'aPos'),
      aNorm: gl.getAttribLocation(prog, 'aNorm'),
      aColor: gl.getAttribLocation(prog, 'aColor'),
      uVP: gl.getUniformLocation(prog, 'uVP'),
      uSunDir: gl.getUniformLocation(prog, 'uSunDir'),
      uSunColor: gl.getUniformLocation(prog, 'uSunColor'),
      uAmbient: gl.getUniformLocation(prog, 'uAmbient'),
      uFogColor: gl.getUniformLocation(prog, 'uFogColor'),
      uFogStart: gl.getUniformLocation(prog, 'uFogStart'),
      uFogEnd: gl.getUniformLocation(prog, 'uFogEnd'),
    };
    this.available = true;
  }

  renderMeshToCanvas(mesh, camDist, camY, lookY) {
    if (!this.available || this.contextLost || !this.gl || this.gl.isContextLost()) {
      return false;
    }
    if (mesh.data.length === 0) return false;
    const gl = this.gl;
    gl.viewport(0, 0, PORTRAIT_SIZE, PORTRAIT_SIZE);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    const proj = mat4Perspective((34 * Math.PI) / 180, 1.0, 0.2, 30.0);
    const view = mat4LookAt([0, camY, camDist], [0, lookY, 0], [0, 1, 0]);
    const vp = mat4Multiply(proj, view);

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc.uVP, false, vp);
    gl.uniform3f(this.loc.uSunDir, 0.45, 0.72, 0.65);
    gl.uniform3f(this.loc.uSunColor, 1.12, 1.06, 0.98);
    gl.uniform3f(this.loc.uAmbient, 0.56, 0.58, 0.66);
    gl.uniform3f(this.loc.uFogColor, 0.0, 0.0, 0.0);
    gl.uniform1f(this.loc.uFogStart, 50.0);
    gl.uniform1f(this.loc.uFogEnd, 100.0);

    const verts = mesh.toFloat32Array();
    const stride = CHAR_STRIDE_FLOATS * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this.loc.aPos);
    gl.vertexAttribPointer(this.loc.aPos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.loc.aNorm);
    gl.vertexAttribPointer(this.loc.aNorm, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(this.loc.aColor);
    gl.vertexAttribPointer(this.loc.aColor, 3, gl.FLOAT, false, stride, 24);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.data.length / CHAR_STRIDE_FLOATS);
    gl.disableVertexAttribArray(this.loc.aPos);
    gl.disableVertexAttribArray(this.loc.aNorm);
    gl.disableVertexAttribArray(this.loc.aColor);
    return true;
  }

  blit(ctx, dx, dy, dw, dh) {
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.canvas, 0, 0, PORTRAIT_SIZE, PORTRAIT_SIZE, Math.round(dx), Math.round(dy), Math.round(dw), Math.round(dh));
    ctx.imageSmoothingEnabled = prevSmooth;
  }
}

let portraitSingleton = null;

function getRenderer() {
  if (!portraitSingleton) {
    portraitSingleton = new N64PortraitRenderer();
  }
  return portraitSingleton;
}

function portraitYawForDirection(direction) {
  switch (direction) {
    case 'right': return 0.78;   // Heroic 3/4 right pose for cutscenes & previews
    case 'left':  return -0.78;  // Heroic 3/4 left pose
    case 'up':    return Math.PI;
    case 'down':
    default:      return 0.16;   // Slight N64 3/4 turn so depth & gear pop
  }
}

export function drawHero3DPortrait(ctx, appearance, direction, frameIndex, dx, dy, dw, dh) {
  try {
    const r = getRenderer();
    if (!r.available || r.contextLost) return false;
    const mesh = new CharMeshBuilder();
    const yaw = portraitYawForDirection(direction);
    const t = ((typeof performance !== 'undefined' ? performance.now() : 0) * 0.001) % 628.31853;
    const moving = frameIndex > 0 && (frameIndex % 2 === 1);
    buildHero3D(mesh, 0, 0, 0, yaw, appearance, moving, t);
    if (!r.renderMeshToCanvas(mesh, 2.75, 0.92, 0.72)) return false;
    r.blit(ctx, dx, dy, dw, dh);
    return true;
  } catch {
    return false;
  }
}

export function drawPip3DPortrait(ctx, appearance, direction, frameIndex, dx, dy, dw, dh) {
  try {
    const r = getRenderer();
    if (!r.available || r.contextLost) return false;
    const mesh = new CharMeshBuilder();
    const yaw = portraitYawForDirection(direction);
    const t = ((typeof performance !== 'undefined' ? performance.now() : 0) * 0.001) % 628.31853;
    buildPip3D(mesh, 0, 0, 0, yaw, appearance, t);
    if (!r.renderMeshToCanvas(mesh, 2.15, 0.72, 0.56)) return false;
    r.blit(ctx, dx, dy, dw, dh);
    return true;
  } catch {
    return false;
  }
}

export function drawNpc3DPortrait(ctx, npcKey, direction, dx, dy, dw, dh) {
  try {
    const r = getRenderer();
    if (!r.available || r.contextLost) return false;
    const mesh = new CharMeshBuilder();
    const t = ((typeof performance !== 'undefined' ? performance.now() : 0) * 0.001) % 628.31853;
    const yaw = direction ? portraitYawForDirection(direction) : -0.22;
    buildNpc3D(mesh, npcKey, 0, 0, 0, t, yaw);
    const isDragon = DRAGON_KEYS.has(npcKey);
    const isNull = npcKey === 'lord_null';
    const camDist = isDragon ? 3.85 : isNull ? 3.25 : 2.65;
    const camY = isDragon ? 1.12 : isNull ? 1.05 : 0.88;
    const lookY = isDragon ? 0.88 : isNull ? 0.82 : 0.68;
    if (!r.renderMeshToCanvas(mesh, camDist, camY, lookY)) return false;
    r.blit(ctx, dx, dy, dw, dh);
    return true;
  } catch {
    return false;
  }
}
