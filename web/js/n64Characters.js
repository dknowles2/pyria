// Detailed Low-Poly Nintendo 64 Character Models (Hero, Pip, NPCs, Dragons)
// Features:
//  - Articulated 2-segment arms (upper arm + bent elbow + forearm + bracer + hand)
//    and legs (thigh + knee + calf + cuffed boot with sole & toe cap)
//  - Layered curved hair locks sweeping around forehead, temples, and nape
//  - Expressive sculpted faces (eyebrows, sclera + iris eyes, nose, chin, ears)
//  - Tunic V-collar, cross-strap baldric, hip pouch, belt buckle, and glowing spellbook
//  - Ribbed dragon wings, dorsal spine crests, Elder Ada's crystal staff, Bram's beard & goggles
//  - Per-pixel N64 Gouraud + sky-hemisphere + backlight rim shading
// Vertex format: 9 floats per vertex -> x, y, z, nx, ny, nz, r, g, b

export const CHAR_STRIDE_FLOATS = 9;

export const CHAR_VS = `
  precision highp float;
  attribute vec3 aPos;
  attribute vec3 aNorm;
  attribute vec3 aColor;

  uniform mat4 uVP;

  varying vec3 vNorm;
  varying vec3 vColor;
  varying float vDepth;

  void main() {
    vec4 clip = uVP * vec4(aPos, 1.0);
    gl_Position = clip;
    vNorm = aNorm;
    vColor = aColor;
    vDepth = clip.w;
  }
`;

export const CHAR_FS = `
  #ifdef GL_FRAGMENT_PRECISION_HIGH
  precision highp float;
  #else
  precision mediump float;
  #endif
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform vec3 uFogColor;
  uniform float uFogStart;
  uniform float uFogEnd;

  varying vec3 vNorm;
  varying vec3 vColor;
  varying float vDepth;

  void main() {
    float nLen = length(vNorm);
    vec3 n = (nLen > 0.0001 ? vNorm / nLen : vec3(0.0, 1.0, 0.0)) * (gl_FrontFacing ? 1.0 : -1.0);
    vec3 sun = normalize(uSunDir);
    float ndl = max(0.0, dot(n, sun));
    float wrap = max(0.0, (dot(n, sun) + 0.32) / 1.32);
    float hemi = 0.5 + 0.5 * n.y;
    // Cool opposite-side fill / rim so character silhouettes pop crisply against terrain
    float rim = pow(max(0.0, dot(n, normalize(vec3(-0.5, 0.35, -0.75)))), 2.2);

    vec3 light = uAmbient * (0.64 + 0.42 * hemi)
               + uSunColor * (ndl * 0.62 + wrap * 0.22)
               + vec3(0.20, 0.24, 0.32) * rim;

    vec3 lit = vColor * light;
    float fogT = clamp((vDepth - uFogStart) / max(0.001, uFogEnd - uFogStart), 0.0, 1.0);
    fogT = fogT * fogT * (3.0 - 2.0 * fogT);
    vec3 rgb = mix(lit, uFogColor, fogT * 0.68);
    gl_FragColor = vec4(rgb, 1.0);
  }
`;

// ---- Color Palettes matching assets/sprites/manifest.json ----
const SKIN_RGB = {
  ivory:      [0.97, 0.86, 0.78],
  peach:      [0.95, 0.76, 0.62],
  olive:      [0.80, 0.65, 0.47],
  warm_tan:   [0.87, 0.65, 0.46],
  bronze:     [0.67, 0.44, 0.28],
  deep_brown: [0.44, 0.27, 0.18],
};

const TUNIC_RGB = {
  emerald: [0.16, 0.62, 0.32],
  crimson: [0.78, 0.18, 0.24],
  navy:    [0.16, 0.30, 0.64],
  amber:   [0.86, 0.56, 0.14],
  violet:  [0.52, 0.26, 0.78],
  slate:   [0.36, 0.44, 0.54],
};

const HAIR_RGB = {
  spiky:     [0.48, 0.26, 0.10],
  windswept: [0.42, 0.24, 0.12],
  curly:     [0.24, 0.15, 0.10],
  braided:   [0.52, 0.28, 0.14],
  ponytail:  [0.46, 0.24, 0.12],
  cropped:   [0.30, 0.18, 0.10],
};

const DRAGON_PALETTES = {
  spark:     { body: [0.95, 0.68, 0.16], belly: [0.99, 0.92, 0.58], wing: [0.92, 0.36, 0.12], horn: [0.98, 0.88, 0.36] },
  pebble:    { body: [0.54, 0.58, 0.64], belly: [0.78, 0.80, 0.82], wing: [0.36, 0.42, 0.48], horn: [0.92, 0.74, 0.34] },
  emberwing: { body: [0.78, 0.16, 0.16], belly: [0.96, 0.72, 0.34], wing: [0.56, 0.10, 0.12], horn: [0.98, 0.84, 0.38] },
  glacier:   { body: [0.28, 0.72, 0.94], belly: [0.82, 0.95, 1.00], wing: [0.16, 0.46, 0.78], horn: [0.90, 0.98, 1.00] },
  bramble:   { body: [0.20, 0.62, 0.32], belly: [0.76, 0.88, 0.54], wing: [0.14, 0.42, 0.22], horn: [0.72, 0.52, 0.26] },
  mire:      { body: [0.38, 0.54, 0.24], belly: [0.74, 0.82, 0.48], wing: [0.24, 0.36, 0.18], horn: [0.84, 0.78, 0.48] },
};

export function dirToYaw(dir) {
  switch (dir) {
    case 'up':    return Math.PI;
    case 'left':  return -Math.PI * 0.5;
    case 'right': return Math.PI * 0.5;
    case 'down':
    default:      return 0;
  }
}

function norm3(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

function tint(c, k) {
  return [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];
}

// ---- Sculpted Low-Poly Character Mesh Builder ----
export class CharMeshBuilder {
  constructor() {
    this.data = [];
    this.wx = 0;
    this.wy = 0;
    this.wz = 0;
    this.cosY = 1;
    this.sinY = 0;
    this.scale = 1;
  }

  setRoot(wx, wy, wz, yaw, scale = 1) {
    this.wx = wx;
    this.wy = wy;
    this.wz = wz;
    this.cosY = Math.cos(yaw);
    this.sinY = Math.sin(yaw);
    this.scale = scale;
  }

  xfPt(lx, ly, lz) {
    const sx = lx * this.scale;
    const sy = ly * this.scale;
    const sz = lz * this.scale;
    return [
      this.wx + sx * this.cosY + sz * this.sinY,
      this.wy + sy,
      this.wz - sx * this.sinY + sz * this.cosY,
    ];
  }

  xfNorm(nx, ny, nz) {
    return [
      nx * this.cosY + nz * this.sinY,
      ny,
      -nx * this.sinY + nz * this.cosY,
    ];
  }

  pushTri(p0, p1, p2, n0, n1, n2, col) {
    this.data.push(
      p0[0], p0[1], p0[2], n0[0], n0[1], n0[2], col[0], col[1], col[2],
      p1[0], p1[1], p1[2], n1[0], n1[1], n1[2], col[0], col[1], col[2],
      p2[0], p2[1], p2[2], n2[0], n2[1], n2[2], col[0], col[1], col[2]
    );
  }

  makeLocalXform(rx, rz, pivot) {
    const px = pivot ? pivot[0] : 0;
    const py = pivot ? pivot[1] : 0;
    const pz = pivot ? pivot[2] : 0;
    const crx = Math.cos(rx), srx = Math.sin(rx);
    const crz = Math.cos(rz), srz = Math.sin(rz);

    const pt = (x, y, z) => {
      let dx = x - px, dy = y - py, dz = z - pz;
      if (rz !== 0) {
        const tx = dx * crz - dy * srz;
        const ty = dx * srz + dy * crz;
        dx = tx; dy = ty;
      }
      if (rx !== 0) {
        const ty = dy * crx - dz * srx;
        const tz = dy * srx + dz * crx;
        dy = ty; dz = tz;
      }
      return this.xfPt(px + dx, py + dy, pz + dz);
    };

    const nm = (nx, ny, nz) => {
      let dx = nx, dy = ny, dz = nz;
      if (rz !== 0) {
        const tx = dx * crz - dy * srz;
        const ty = dx * srz + dy * crz;
        dx = tx; dy = ty;
      }
      if (rx !== 0) {
        const ty = dy * crx - dz * srx;
        const tz = dy * srx + dz * crx;
        dy = ty; dz = tz;
      }
      return this.xfNorm(dx, dy, dz);
    };

    return { pt, nm };
  }

  // Sculpted multi-ring lathe with smooth Gouraud normals + optional xOff/zOff spine curve
  addLathe(cx, cy, cz, profile, sides, defaultCol, rx = 0, rz = 0, pivot = null) {
    const xf = this.makeLocalXform(rx, rz, pivot || [cx, cy, cz]);

    for (let ri = 0; ri < profile.length - 1; ri++) {
      const a = profile[ri];
      const b = profile[ri + 1];
      const col = b.col || a.col || defaultCol;
      const xa = a.xOff || 0, xb = b.xOff || 0;
      const za = a.zOff || 0, zb = b.zOff || 0;
      const dy = b.y - a.y;
      const dr = ((b.rx + b.rz) - (a.rx + a.rz)) * 0.5;
      const slopeY = -dr / (Math.hypot(dy, dr) || 1);

      for (let i = 0; i < sides; i++) {
        const t0 = (i / sides) * Math.PI * 2;
        const t1 = ((i + 1) / sides) * Math.PI * 2;
        const c0 = Math.cos(t0), s0 = Math.sin(t0);
        const c1 = Math.cos(t1), s1 = Math.sin(t1);

        const pA0 = xf.pt(cx + xa + c0 * a.rx, cy + a.y, cz + za + s0 * a.rz);
        const pA1 = xf.pt(cx + xa + c1 * a.rx, cy + a.y, cz + za + s1 * a.rz);
        const pB0 = xf.pt(cx + xb + c0 * b.rx, cy + b.y, cz + zb + s0 * b.rz);
        const pB1 = xf.pt(cx + xb + c1 * b.rx, cy + b.y, cz + zb + s1 * b.rz);

        const n0raw = norm3(c0, slopeY, s0);
        const n1raw = norm3(c1, slopeY, s1);
        const nA0 = a.rx <= 0.0005 && a.rz <= 0.0005 ? xf.nm(0, -1, 0) : xf.nm(n0raw[0], n0raw[1], n0raw[2]);
        const nA1 = a.rx <= 0.0005 && a.rz <= 0.0005 ? xf.nm(0, -1, 0) : xf.nm(n1raw[0], n1raw[1], n1raw[2]);
        const nB0 = b.rx <= 0.0005 && b.rz <= 0.0005 ? xf.nm(0,  1, 0) : xf.nm(n0raw[0], n0raw[1], n0raw[2]);
        const nB1 = b.rx <= 0.0005 && b.rz <= 0.0005 ? xf.nm(0,  1, 0) : xf.nm(n1raw[0], n1raw[1], n1raw[2]);

        if (a.rx <= 0.0005 && a.rz <= 0.0005) {
          this.pushTri(pA0, pB1, pB0, nA0, nB1, nB0, col);
        } else if (b.rx <= 0.0005 && b.rz <= 0.0005) {
          this.pushTri(pB0, pA0, pA1, nB0, nA0, nA1, col);
        } else {
          this.pushTri(pB0, pA0, pA1, nB0, nA0, nA1, col);
          this.pushTri(pB0, pA1, pB1, nB0, nA1, nB1, col);
        }
      }
    }
  }

  // Smooth faceted ellipsoid
  addBall(cx, cy, cz, rx, ry, rz, col, segs = 8, rotX = 0, rotZ = 0, pivot = null) {
    this.addLathe(cx, cy, cz, [
      { y: -ry,        rx: 0,         rz: 0 },
      { y: -ry * 0.72, rx: rx * 0.68, rz: rz * 0.68 },
      { y: -ry * 0.22, rx: rx * 0.98, rz: rz * 0.98 },
      { y:  ry * 0.28, rx: rx * 0.96, rz: rz * 0.96 },
      { y:  ry * 0.74, rx: rx * 0.66, rz: rz * 0.66 },
      { y:  ry,        rx: 0,         rz: 0 },
    ], segs, col, rotX, rotZ, pivot);
  }

  // Curved 2-segment tapered tube between 3 points (p0 -> pMid -> pTip) for organic hair locks, limbs, tails!
  addCurvedLock(p0, p1, p2, r0, r1, sides, col) {
    const seg = (a, b, ra, rb) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      const ux = dx / len, uy = dy / len, uz = dz / len;
      // Pick perpendicular basis (t1, t2)
      const ref = Math.abs(uy) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const t1 = norm3(
        uy * ref[2] - uz * ref[1],
        uz * ref[0] - ux * ref[2],
        ux * ref[1] - uy * ref[0]
      );
      const t2 = norm3(
        uy * t1[2] - uz * t1[1],
        uz * t1[0] - ux * t1[2],
        ux * t1[1] - uy * t1[0]
      );

      for (let i = 0; i < sides; i++) {
        const a0 = (i / sides) * Math.PI * 2;
        const a1 = ((i + 1) / sides) * Math.PI * 2;
        const c0 = Math.cos(a0), s0 = Math.sin(a0);
        const c1 = Math.cos(a1), s1 = Math.sin(a1);

        const d0 = [t1[0] * c0 + t2[0] * s0, t1[1] * c0 + t2[1] * s0, t1[2] * c0 + t2[2] * s0];
        const d1 = [t1[0] * c1 + t2[0] * s1, t1[1] * c1 + t2[1] * s1, t1[2] * c1 + t2[2] * s1];

        const pa0 = this.xfPt(a[0] + d0[0] * ra, a[1] + d0[1] * ra, a[2] + d0[2] * ra);
        const pa1 = this.xfPt(a[0] + d1[0] * ra, a[1] + d1[1] * ra, a[2] + d1[2] * ra);
        const n0 = this.xfNorm(d0[0], d0[1], d0[2]);
        const n1 = this.xfNorm(d1[0], d1[1], d1[2]);

        if (rb <= 0.001) {
          const pb = this.xfPt(b[0], b[1], b[2]);
          const nb = this.xfNorm(ux, uy, uz);
          this.pushTri(pb, pa0, pa1, nb, n0, n1, col);
        } else {
          const pb0 = this.xfPt(b[0] + d0[0] * rb, b[1] + d0[1] * rb, b[2] + d0[2] * rb);
          const pb1 = this.xfPt(b[0] + d1[0] * rb, b[1] + d1[1] * rb, b[2] + d1[2] * rb);
          this.pushTri(pb0, pa0, pa1, n0, n0, n1, col);
          this.pushTri(pb0, pa1, pb1, n0, n1, n1, col);
        }
      }
    };
    seg(p0, p1, r0, r1);
    seg(p1, p2, r1, 0);
  }

  // Tapered cone
  addCone(cx, yBase, cz, radius, height, sides, col, tiltX = 0, tiltZ = 0, rx = 0, rz = 0, pivot = null) {
    const xf = this.makeLocalXform(rx, rz, pivot || [cx, yBase, cz]);
    const tip = xf.pt(cx + tiltX, yBase + height, cz + tiltZ);
    const baseCenter = xf.pt(cx, yBase, cz);
    const nDown = xf.nm(0, -1, 0);
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0);
      const c1 = Math.cos(a1), s1 = Math.sin(a1);
      const p0 = xf.pt(cx + c0 * radius, yBase, cz + s0 * radius);
      const p1 = xf.pt(cx + c1 * radius, yBase, cz + s1 * radius);
      const n0 = xf.nm(c0, 0.45, s0);
      const n1 = xf.nm(c1, 0.45, s1);
      const nt = xf.nm((c0 + c1) * 0.5, 0.7, (s0 + s1) * 0.5);
      this.pushTri(tip, p0, p1, nt, n0, n1, col);
      this.pushTri(baseCenter, p1, p0, nDown, nDown, nDown, tint(col, 0.78));
    }
  }

  // Box primitive (for belt buckle, spellbook, pouches, straps)
  addBox(cx, cy, cz, hx, hy, hz, col, rx = 0, rz = 0, pivot = null) {
    const xf = this.makeLocalXform(rx, rz, pivot || [cx, cy, cz]);
    const x0 = cx - hx, x1 = cx + hx;
    const y0 = cy - hy, y1 = cy + hy;
    const z0 = cz - hz, z1 = cz + hz;

    const p000 = xf.pt(x0, y0, z0), p100 = xf.pt(x1, y0, z0);
    const p110 = xf.pt(x1, y1, z0), p010 = xf.pt(x0, y1, z0);
    const p001 = xf.pt(x0, y0, z1), p101 = xf.pt(x1, y0, z1);
    const p111 = xf.pt(x1, y1, z1), p011 = xf.pt(x0, y1, z1);

    const emitQuad = (a, b, c, d, nx, ny, nz, shade = 1.0) => {
      const n = xf.nm(nx, ny, nz);
      const sc = shade === 1.0 ? col : tint(col, shade);
      this.pushTri(a, b, c, n, n, n, sc);
      this.pushTri(a, c, d, n, n, n, sc);
    };

    emitQuad(p011, p111, p101, p001,  0,  0,  1, 1.0);
    emitQuad(p110, p010, p000, p100,  0,  0, -1, 0.94);
    emitQuad(p010, p110, p111, p011,  0,  1,  0, 1.06);
    emitQuad(p001, p101, p100, p000,  0, -1,  0, 0.78);
    emitQuad(p111, p110, p100, p101,  1,  0,  0, 0.96);
    emitQuad(p010, p011, p001, p000, -1,  0,  0, 0.92);
  }

  // Ribbed multi-panel dragon wing (wing bone + 2 scalloped web membranes)
  addDragonWing(side, rootX, rootY, rootZ, span, chord, webCol, boneCol, flapAngle) {
    const xf = this.makeLocalXform(0, side * flapAngle, [rootX, rootY, rootZ]);
    const pRootF = xf.pt(rootX, rootY + 0.02, rootZ + chord * 0.25);
    const pRootB = xf.pt(rootX, rootY - 0.04, rootZ - chord * 0.45);
    const pElbow = xf.pt(rootX + side * span * 0.48, rootY + 0.14, rootZ + chord * 0.22);
    const pTip   = xf.pt(rootX + side * span, rootY + 0.06, rootZ - chord * 0.22);
    const pMid1  = xf.pt(rootX + side * span * 0.64, rootY - 0.04, rootZ - chord * 0.56);
    const pMid2  = xf.pt(rootX + side * span * 0.30, rootY - 0.05, rootZ - chord * 0.52);

    const nUp = xf.nm(0, 1, 0.18);
    const nDn = xf.nm(0, -1, -0.18);
    const dark = tint(webCol, 0.80);

    // 4 scalloped wing panels (single-sided geometry; CHAR_FS flips normal via gl_FrontFacing for crisp two-sided shading!)
    const tris = [
      [pRootF, pElbow, pMid2],
      [pRootF, pMid2, pRootB],
      [pElbow, pTip, pMid1],
      [pElbow, pMid1, pMid2],
    ];
    for (const [a, b, c] of tris) {
      this.pushTri(a, b, c, nUp, nUp, nUp, webCol);
    }

    // Leading-edge wing arm ridge
    this.addBox(rootX + side * span * 0.24, rootY + 0.08, rootZ + chord * 0.23, span * 0.26, 0.022, 0.022, boneCol, 0, side * (flapAngle + 0.25), [rootX, rootY, rootZ]);
  }

  toFloat32Array() {
    return new Float32Array(this.data);
  }
}

// ---- 1. HERO 3D MODEL (Detailed N64 Ocarina-of-Time / Concept-Art Hero) ----
export function buildHero3D(builder, wx, wy, wz, yaw, appearance, moving, time) {
  const app = appearance || {};
  const skin = SKIN_RGB[app.skin] || SKIN_RGB.warm_tan;
  const skinShade = tint(skin, 0.88);
  const tunicKey = (app.tunic || 'emerald').replace(/^tunic_/, '');
  const tunic = TUNIC_RGB[tunicKey] || TUNIC_RGB.emerald;
  const tunicDark = tint(tunic, 0.76);
  const tunicLight = tint(tunic, 1.15);
  const undershirt = [0.92, 0.90, 0.82];
  const hairKey = app.hair || 'spiky';
  const hair = HAIR_RGB[hairKey] || HAIR_RGB.spiky;
  const hairLight = tint(hair, 1.20);
  const hairDark = tint(hair, 0.78);
  const isSwift = app.boots === 'boots_swift';
  const bootCol = isSwift ? [0.18, 0.56, 0.72] : [0.36, 0.20, 0.10];
  const bootSole = [0.18, 0.12, 0.08];
  const bootCuff = isSwift ? [0.96, 0.80, 0.24] : [0.50, 0.31, 0.16];
  const pantsCol = [0.28, 0.26, 0.30];
  const beltCol = [0.32, 0.18, 0.08];
  const bracerCol = [0.44, 0.26, 0.13];
  const goldCol = [0.96, 0.80, 0.24];
  const irisCol = [0.14, 0.36, 0.58];
  const eyeDark = [0.08, 0.09, 0.14];

  const walkPhase = moving ? Math.sin(time * 11.5) : 0;
  const bob = moving ? Math.abs(Math.sin(time * 11.5)) * 0.055 : Math.sin(time * 2.8) * 0.015;
  const legSwing = walkPhase * 0.52;
  const armSwing = walkPhase * 0.48;

  builder.setRoot(wx, wy + bob, wz, yaw, 1.06);

  // ---- Articulated Legs: Thigh -> Knee -> Calf -> Cuffed Adventure Boot with Sole & Toe ----
  const drawLeg = (side, swing) => {
    const hx = side * 0.095;
    const piv = [hx, 0.42, 0];
    builder.addLathe(hx, 0.00, 0, [
      { y: 0.00, rx: 0.068, rz: 0.098, zOff: 0.025, col: bootSole }, // thick boot sole
      { y: 0.03, rx: 0.068, rz: 0.096, zOff: 0.025, col: bootCol },  // lower boot
      { y: 0.09, rx: 0.064, rz: 0.074, zOff: 0.008, col: bootCol },  // ankle
      { y: 0.16, rx: 0.068, rz: 0.072, zOff: 0.000, col: bootCol },  // boot shaft
      { y: 0.18, rx: 0.076, rz: 0.080, zOff: 0.000, col: bootCuff }, // folded leather boot cuff
      { y: 0.21, rx: 0.060, rz: 0.062, zOff: 0.005, col: pantsCol }, // calf
      { y: 0.27, rx: 0.066, rz: 0.070, zOff: 0.014, col: pantsCol }, // knee cap
      { y: 0.42, rx: 0.076, rz: 0.076, zOff: 0.000, col: pantsCol }, // upper thigh
    ], 8, pantsCol, swing, 0, piv);
    // Rounded boot toe cap
    builder.addBall(hx, 0.042, 0.082, 0.058, 0.042, 0.058, bootCol, 6, swing, 0, piv);
    if (isSwift) {
      builder.addCone(hx + side * 0.075, 0.15, -0.02, 0.026, 0.09, 4, goldCol, side * 0.05, -0.06, swing, 0, piv);
    }
  };
  drawLeg(-1, legSwing);
  drawLeg( 1, -legSwing);

  // ---- Heroic Sculpted Tunic Torso (Flared Skirt -> Belt -> Chest -> V-Collar -> Neck) ----
  builder.addLathe(0, 0.31, 0, [
    { y: 0.00, rx: 0.220, rz: 0.165, col: tunicDark },  // flared tunic hem
    { y: 0.09, rx: 0.185, rz: 0.138, col: tunic },      // lower hip
    { y: 0.15, rx: 0.156, rz: 0.118, col: beltCol },    // cinched leather belt
    { y: 0.19, rx: 0.162, rz: 0.122, col: beltCol },    // upper belt edge
    { y: 0.25, rx: 0.175, rz: 0.128, col: tunic },      // mid waist
    { y: 0.37, rx: 0.205, rz: 0.142, zOff: 0.006, col: tunicLight }, // sculpted chest
    { y: 0.44, rx: 0.195, rz: 0.128, col: tunic },      // upper shoulders
    { y: 0.47, rx: 0.125, rz: 0.102, col: tunicDark },  // collar rim
    { y: 0.50, rx: 0.088, rz: 0.084, col: undershirt }, // cream undershirt collar
    { y: 0.53, rx: 0.068, rz: 0.068, col: skinShade },  // neck
    { y: 0.58, rx: 0.065, rz: 0.065, col: skin },
  ], 10, tunic);

  // Tunic V-neck front gusset + Gold belt buckle + Adventurer hip pouch & Spellbook!
  builder.addBox(0, 0.735, 0.132, 0.042, 0.048, 0.012, undershirt);
  builder.addBox(0, 0.48, 0.125, 0.044, 0.036, 0.018, goldCol);
  // Leather belt pouch on right hip
  builder.addBox(0.165, 0.45, 0.03, 0.042, 0.052, 0.042, bracerCol);
  builder.addBox(0.165, 0.48, 0.055, 0.018, 0.014, 0.022, goldCol);
  // Iconic blue & gold Pyria Spellbook holstered on left hip (from concept art!)
  builder.addBox(-0.18, 0.44, -0.02, 0.026, 0.072, 0.062, [0.16, 0.38, 0.86], 0, 0.18);
  builder.addBox(-0.195, 0.44, -0.02, 0.012, 0.048, 0.038, goldCol, 0, 0.18);
  // Diagonal leather baldric strap across chest
  builder.addBox(0, 0.62, 0.128, 0.026, 0.18, 0.014, beltCol, 0, 0.68);
  builder.addBox(0, 0.62, -0.125, 0.026, 0.18, 0.014, beltCol, 0, -0.68);

  // ---- Articulated 2-Segment Arms (Shoulder -> Upper Arm -> Bent Elbow -> Forearm -> Bracer -> Hand) ----
  const drawArm = (side, swing) => {
    const sx = side * 0.22;
    const piv = [sx, 0.72, 0];
    const elbowBend = 0.24 + (moving ? Math.max(0, swing) * 0.42 : 0.04);
    // Rounded puffed shoulder sleeve
    builder.addBall(sx, 0.72, 0, 0.082, 0.078, 0.078, tunicLight, 7, swing, side * -0.15, piv);
    // Upper arm sleeve -> elbow -> forward-angled forearm -> leather wrist bracer
    builder.addLathe(sx + side * 0.02, 0.44, 0, [
      { y: 0.00, rx: 0.044, rz: 0.044, zOff: 0.055, col: skin },       // wrist
      { y: 0.04, rx: 0.052, rz: 0.052, zOff: 0.045, col: bracerCol },  // leather bracer cuff
      { y: 0.10, rx: 0.054, rz: 0.054, zOff: 0.028, col: bracerCol },  // upper bracer
      { y: 0.15, rx: 0.056, rz: 0.056, zOff: 0.008, col: skin },       // elbow joint
      { y: 0.18, rx: 0.068, rz: 0.068, zOff: 0.002, col: tunicDark },  // rolled sleeve hem
      { y: 0.28, rx: 0.072, rz: 0.072, zOff: 0.000, col: tunic },      // upper sleeve
    ], 7, tunic, swing - elbowBend * 0.35, side * -0.16, piv);
    // Sculpted hand + thumb
    builder.addBall(sx + side * 0.025, 0.415, 0.062, 0.048, 0.050, 0.054, skin, 6, swing - elbowBend * 0.35, side * -0.16, piv);
    builder.addBall(sx + side * 0.002, 0.425, 0.095, 0.022, 0.022, 0.028, skin, 5, swing - elbowBend * 0.35, side * -0.16, piv);
  };
  drawArm(-1, -armSwing);
  drawArm( 1,  armSwing);

  // Sculpted Curved Shield (left arm)
  if (app.shield) {
    const isCoral = app.shield === 'shield_coral';
    const shMain = isCoral ? [0.95, 0.44, 0.54] : [0.58, 0.36, 0.18];
    const shRim = isCoral ? [0.20, 0.80, 0.74] : [0.68, 0.72, 0.78];
    const piv = [-0.22, 0.72, 0];
    builder.addBall(-0.33, 0.53, 0.08, 0.036, 0.17, 0.145, shRim, 8, -armSwing * 0.5, 0, piv);
    builder.addBall(-0.35, 0.53, 0.08, 0.024, 0.13, 0.105, shMain, 8, -armSwing * 0.5, 0, piv);
    builder.addBall(-0.365, 0.53, 0.08, 0.018, 0.045, 0.045, goldCol, 6, -armSwing * 0.5, 0, piv);
  }

  // Flowing Sculpted Cape
  if (app.cloak) {
    const cloakCol = [0.16, 0.48, 0.80];
    const cloakSway = 0.22 + (moving ? 0.20 + Math.sin(time * 9) * 0.08 : Math.sin(time * 2.5) * 0.04);
    builder.addLathe(0, 0.26, -0.14, [
      { y: 0.00, rx: 0.25, rz: 0.030, zOff: -0.05, col: [0.11, 0.34, 0.64] },
      { y: 0.24, rx: 0.21, rz: 0.028, zOff: -0.02, col: cloakCol },
      { y: 0.47, rx: 0.15, rz: 0.026, zOff:  0.00, col: cloakCol },
    ], 7, cloakCol, cloakSway, 0, [0, 0.73, -0.12]);
  }

  // ---- Sculpted N64 Protagonist Head (Tapered Chin -> Cheekbones -> Forehead -> Crown) ----
  builder.addLathe(0, 0.84, 0, [
    { y: 0.00, rx: 0.00,  rz: 0.00 },
    { y: 0.03, rx: 0.082, rz: 0.088, zOff: 0.022 }, // sculpted chin
    { y: 0.10, rx: 0.152, rz: 0.150, zOff: 0.014 }, // jaw & cheeks
    { y: 0.19, rx: 0.168, rz: 0.165, zOff: 0.004 }, // eye/brow level
    { y: 0.28, rx: 0.152, rz: 0.154, zOff: -0.006 }, // forehead
    { y: 0.34, rx: 0.00,  rz: 0.00 },
  ], 10, skin);

  // Subtle nose, angled ears, expressive brows, sclera + colored iris eyes!
  builder.addCone(0, 0.96, 0.154, 0.020, 0.032, 4, skinShade, 0, 0.026);
  builder.addBall(-0.165, 0.99, -0.01, 0.030, 0.042, 0.024, skin, 5);
  builder.addBall( 0.165, 0.99, -0.01, 0.030, 0.042, 0.024, skin, 5);

  // Expressive Eyes (white sclera -> colored iris -> dark pupil -> bright catchlight)
  for (const s of [-1, 1]) {
    builder.addBall(s * 0.066, 1.005, 0.148, 0.032, 0.036, 0.016, [0.98, 0.98, 1.0], 6);
    builder.addBall(s * 0.064, 1.005, 0.159, 0.022, 0.028, 0.012, irisCol, 6);
    builder.addBall(s * 0.064, 1.005, 0.167, 0.014, 0.018, 0.008, eyeDark, 5);
    builder.addBall(s * 0.056, 1.016, 0.172, 0.008, 0.009, 0.006, [1, 1, 1], 4);
    // Expressive eyebrow
    builder.addBox(s * 0.068, 1.052, 0.154, 0.034, 0.010, 0.012, hairDark, 0, s * -0.10);
  }
  // Warm subtle smile
  builder.addBox(0, 0.922, 0.156, 0.028, 0.007, 0.008, [0.58, 0.34, 0.26]);

  // ---- Layered Sweeping Curved Hair (Matches era-04-64bit-n64.jpg instead of spiky cones!) ----
  const hat = app.hat || null;
  if (hat !== 'hat_dragon_helm') {
    // Full sculpted hair crown hugging the back & top of head
    builder.addBall(0, 1.06, -0.036, 0.190, 0.152, 0.188, hair, 10);

    // Sweeping back-of-head layered locks curving outward & downward (like concept art!)
    const backLocks = [
      { x: -0.12, z: -0.12, midX: -0.17, midY: 0.94, midZ: -0.17, tipX: -0.14, tipY: 0.83, tipZ: -0.15 },
      { x: -0.05, z: -0.15, midX: -0.07, midY: 0.92, midZ: -0.21, tipX: -0.05, tipY: 0.81, tipZ: -0.18 },
      { x:  0.05, z: -0.15, midX:  0.07, midY: 0.92, midZ: -0.21, tipX:  0.05, tipY: 0.81, tipZ: -0.18 },
      { x:  0.12, z: -0.12, midX:  0.17, midY: 0.94, midZ: -0.17, tipX:  0.14, tipY: 0.83, tipZ: -0.15 },
    ];
    for (const l of backLocks) {
      builder.addCurvedLock([l.x, 1.08, l.z], [l.midX, l.midY, l.midZ], [l.tipX, l.tipY, l.tipZ], 0.068, 0.048, 5, hair);
    }

    // Side locks framing the cheeks
    builder.addCurvedLock([-0.15, 1.07, 0.02], [-0.20, 0.97, 0.06], [-0.16, 0.88, 0.08], 0.052, 0.036, 5, hair);
    builder.addCurvedLock([ 0.15, 1.07, 0.02], [ 0.20, 0.97, 0.06], [ 0.16, 0.88, 0.08], 0.052, 0.036, 5, hair);

    if (hairKey === 'spiky' || hairKey === 'windswept') {
      const sweep = hairKey === 'windswept' ? 0.07 : 0.0;
      // Layered bangs sweeping forward & slightly downward over the brow + feathered crown locks
      builder.addCurvedLock([-0.08, 1.15, 0.06], [-0.13 + sweep, 1.12, 0.16], [-0.11 + sweep, 1.03, 0.19], 0.058, 0.038, 5, hairLight);
      builder.addCurvedLock([ 0.00, 1.17, 0.06], [ 0.01 + sweep, 1.14, 0.17], [ 0.02 + sweep, 1.04, 0.20], 0.064, 0.042, 5, hairLight);
      builder.addCurvedLock([ 0.09, 1.15, 0.05], [ 0.14 + sweep, 1.11, 0.15], [ 0.13 + sweep, 1.03, 0.18], 0.056, 0.036, 5, hair);
      // Softly swept crown tufts (curved back/out, not straight vertical spikes)
      builder.addCurvedLock([-0.06, 1.16, -0.02], [-0.14 + sweep, 1.22, -0.04], [-0.19 + sweep, 1.17, -0.08], 0.056, 0.034, 5, hairLight);
      builder.addCurvedLock([ 0.06, 1.16, -0.02], [ 0.14 + sweep, 1.22, -0.04], [ 0.19 + sweep, 1.17, -0.08], 0.056, 0.034, 5, hair);
      builder.addCurvedLock([ 0.00, 1.17, -0.06], [ 0.00 + sweep, 1.23, -0.14], [ 0.00 + sweep, 1.16, -0.22], 0.060, 0.036, 5, hairLight);
    } else if (hairKey === 'curly') {
      builder.addBall(-0.12, 1.14,  0.07, 0.095, 0.085, 0.095, hairLight, 6);
      builder.addBall( 0.12, 1.14,  0.07, 0.095, 0.085, 0.095, hair,      6);
      builder.addBall( 0.00, 1.19,  0.03, 0.115, 0.095, 0.115, hairLight, 6);
      builder.addBall(-0.11, 1.13, -0.10, 0.095, 0.085, 0.095, hair,      6);
      builder.addBall( 0.11, 1.13, -0.10, 0.095, 0.085, 0.095, hair,      6);
    } else if (hairKey === 'ponytail') {
      builder.addCurvedLock([0, 1.14, 0.06], [0, 1.12, 0.16], [0.02, 1.04, 0.19], 0.056, 0.036, 5, hairLight);
      builder.addBall(0, 1.06, -0.21, 0.055, 0.055, 0.055, goldCol, 5);
      builder.addCurvedLock([0, 1.05, -0.22], [0, 0.95, -0.32], [0, 0.78, -0.28], 0.065, 0.048, 6, hair);
    } else if (hairKey === 'braided') {
      builder.addCurvedLock([0, 1.14, 0.06], [-0.04, 1.11, 0.16], [-0.08, 1.03, 0.18], 0.055, 0.035, 5, hairLight);
      builder.addCurvedLock([-0.15, 0.96, -0.08], [-0.18, 0.82, -0.08], [-0.16, 0.68, -0.06], 0.046, 0.036, 5, hair);
      builder.addCurvedLock([ 0.15, 0.96, -0.08], [ 0.18, 0.82, -0.08], [ 0.16, 0.68, -0.06], 0.046, 0.036, 5, hair);
    }
  }

  // Sculpted Headgear
  if (hat === 'hat_explorer') {
    const hatCol = [0.56, 0.38, 0.20];
    builder.addLathe(0, 1.12, -0.01, [
      { y: 0.00, rx: 0.32, rz: 0.30, col: hatCol },
      { y: 0.03, rx: 0.31, rz: 0.29, col: hatCol },
      { y: 0.04, rx: 0.18, rz: 0.18, col: goldCol },
      { y: 0.08, rx: 0.18, rz: 0.18, col: goldCol },
      { y: 0.18, rx: 0.15, rz: 0.15, col: hatCol },
      { y: 0.21, rx: 0.00, rz: 0.00, col: hatCol },
    ], 10, hatCol);
  } else if (hat === 'hat_wizard_cap') {
    const wizCol = [0.24, 0.20, 0.68];
    builder.addLathe(0, 1.12, -0.01, [
      { y: 0.00, rx: 0.30, rz: 0.30, col: wizCol },
      { y: 0.03, rx: 0.29, rz: 0.29, col: wizCol },
      { y: 0.05, rx: 0.18, rz: 0.18, col: goldCol },
      { y: 0.09, rx: 0.17, rz: 0.17, col: wizCol },
    ], 10, wizCol);
    builder.addCurvedLock([0, 1.18, -0.01], [0.04, 1.40, -0.05], [0.12, 1.56, -0.14], 0.17, 0.085, 8, wizCol);
  } else if (hat === 'hat_dragon_helm') {
    const helmCol = [0.68, 0.20, 0.22];
    builder.addBall(0, 1.05, -0.02, 0.21, 0.18, 0.21, helmCol, 9);
    builder.addCurvedLock([-0.14, 1.14, -0.02], [-0.22, 1.24, -0.06], [-0.20, 1.35, -0.12], 0.045, 0.028, 5, goldCol);
    builder.addCurvedLock([ 0.14, 1.14, -0.02], [ 0.22, 1.24, -0.06], [ 0.20, 1.35, -0.12], 0.045, 0.028, 5, goldCol);
  }

  // Aura orbiting sparkles
  if (app.aura) {
    const auraCol = app.aura.includes('courage') ? [0.99, 0.80, 0.22] : [0.94, 0.54, 0.98];
    for (let i = 0; i < 3; i++) {
      const ang = time * 3.2 + (i * Math.PI * 2) / 3;
      const ax = Math.cos(ang) * 0.44;
      const az = Math.sin(ang) * 0.44;
      const ay = 0.62 + Math.sin(time * 4.5 + i * 2) * 0.18;
      builder.addBall(ax, ay, az, 0.042, 0.042, 0.042, auraCol, 5);
    }
  }
}

// ---- 2. PIP 3D MODEL (Detailed Sculpted Teal Baby Dragon Sidekick matching concept art!) ----
export function buildPip3D(builder, wx, wy, wz, yaw, appearance, time) {
  const teal = [0.14, 0.72, 0.68];
  const tealDark = [0.09, 0.50, 0.52];
  const belly = [0.97, 0.89, 0.58];
  const wingCol = [0.96, 0.52, 0.18];
  const hornCol = [0.98, 0.76, 0.22];
  const eyeCol = [0.08, 0.10, 0.14];

  const hover = 0.18 + Math.sin(time * 5.2) * 0.07;
  const flap = Math.sin(time * 11.0) * 0.56;
  const wag = Math.sin(time * 6.5) * 0.20;

  builder.setRoot(wx, wy + hover, wz, yaw, 0.98);

  // Pear-shaped dragon body + segmented cream belly + S-curved neck
  builder.addLathe(0, 0.10, 0, [
    { y: 0.00, rx: 0.00,  rz: 0.00 },
    { y: 0.06, rx: 0.145, rz: 0.170, zOff: -0.02 },
    { y: 0.18, rx: 0.165, rz: 0.185, zOff:  0.00 },
    { y: 0.30, rx: 0.125, rz: 0.140, zOff:  0.03 },
    { y: 0.40, rx: 0.088, rz: 0.096, zOff:  0.06 },
  ], 8, teal);
  builder.addBall(0, 0.26, 0.10, 0.12, 0.14, 0.11, belly, 7);

  // Cute hind legs & little forepaws
  for (const s of [-1, 1]) {
    builder.addBall(s * 0.11, 0.14, -0.02, 0.068, 0.078, 0.078, tealDark, 6);
    builder.addBall(s * 0.11, 0.06,  0.04, 0.052, 0.042, 0.072, tealDark, 6);
    builder.addBall(s * 0.13, 0.32,  0.11, 0.042, 0.040, 0.058, teal, 5);
  }

  // Expressive Dragon Head + Rounded Snout + Cheek Ridges + Large Bright Eyes + Twin Curved Horns
  builder.addBall(0, 0.55, 0.08, 0.165, 0.150, 0.165, teal, 8);
  builder.addBall(0, 0.51, 0.22, 0.092, 0.068, 0.095, teal, 7);
  for (const s of [-1, 1]) {
    builder.addBall(s * 0.082, 0.58, 0.20, 0.034, 0.040, 0.022, [0.98, 0.99, 1.0], 6);
    builder.addBall(s * 0.080, 0.58, 0.214, 0.022, 0.028, 0.014, eyeCol, 5);
    builder.addBall(s * 0.074, 0.592, 0.224, 0.009, 0.010, 0.006, [1, 1, 1], 4);
    builder.addCurvedLock([s * 0.07, 0.66, 0.04], [s * 0.11, 0.75, -0.02], [s * 0.13, 0.82, -0.09], 0.042, 0.024, 5, hornCol);
  }

  // Little orange dorsal spine ridge down Pip's back
  builder.addCone(0, 0.44, -0.06, 0.032, 0.075, 4, hornCol, 0, -0.04);
  builder.addCone(0, 0.34, -0.14, 0.030, 0.070, 4, hornCol, 0, -0.04);

  // Optional Ember Scarf
  if (appearance?.pipScarf === 'pip_scarf_ember') {
    builder.addLathe(0, 0.39, 0.05, [
      { y: 0.00, rx: 0.13, rz: 0.13 },
      { y: 0.06, rx: 0.12, rz: 0.12 },
    ], 8, [0.92, 0.24, 0.16]);
  }

  // Ribbed Scalloped Flapping Dragon Wings
  builder.addDragonWing(-1, -0.13, 0.36, -0.02, 0.36, 0.26, wingCol, hornCol, flap);
  builder.addDragonWing( 1,  0.13, 0.36, -0.02, 0.36, 0.26, wingCol, hornCol, flap);

  // S-curved Wagging Tail + Orange Spade Tip
  builder.addCurvedLock([0, 0.20, -0.14], [wag * 0.20, 0.18, -0.32], [wag * 0.38, 0.24, -0.48], 0.075, 0.038, 6, tealDark);
  builder.addCone(wag * 0.36, 0.22, -0.46, 0.058, 0.13, 5, wingCol, wag * 0.18, -0.10);
}

// ---- 3. NPCs & VAULT DRAGONS ----
export function buildNpc3D(builder, spriteKey, wx, wy, wz, time) {
  const bob = Math.sin(time * 2.5 + wx * 1.7 + wz) * 0.02;

  // Vault Dragons (majestic sculpted N64 dragons with ribbed wings & curved tails!)
  if (DRAGON_PALETTES[spriteKey]) {
    const pal = DRAGON_PALETTES[spriteKey];
    const flap = Math.sin(time * 5.2 + wx) * 0.42;
    const hover = 0.24 + Math.sin(time * 3.0 + wx) * 0.10;
    builder.setRoot(wx, wy + hover, wz, 0, 1.32);

    builder.addBall(0, 0.36, 0, 0.24, 0.24, 0.32, pal.body, 8);
    builder.addBall(0, 0.32, 0.10, 0.16, 0.18, 0.22, pal.belly, 7);
    builder.addCurvedLock([0, 0.46, 0.12], [0, 0.64, 0.22], [0, 0.80, 0.20], 0.12, 0.085, 7, pal.body);
    builder.addBall(0, 0.78, 0.22, 0.15, 0.13, 0.18, pal.body, 8);
    builder.addBall(0, 0.74, 0.37, 0.10, 0.075, 0.11, pal.body, 7);
    for (const s of [-1, 1]) {
      builder.addBall(s * 0.085, 0.81, 0.34, 0.028, 0.032, 0.020, [1.0, 0.94, 0.36], 5);
      builder.addCurvedLock([s * 0.08, 0.88, 0.16], [s * 0.14, 1.00, 0.08], [s * 0.18, 1.12, -0.02], 0.048, 0.026, 5, pal.horn);
    }
    builder.addDragonWing(-1, -0.20, 0.48, -0.02, 0.68, 0.48, pal.wing, pal.horn, flap);
    builder.addDragonWing( 1,  0.20, 0.48, -0.02, 0.68, 0.48, pal.wing, pal.horn, flap);
    builder.addCurvedLock([0, 0.26, -0.24], [0, 0.22, -0.48], [0, 0.30, -0.72], 0.11, 0.055, 6, pal.body);
    builder.addCone(0, 0.28, -0.70, 0.075, 0.18, 5, pal.horn, 0, -0.10);
    return;
  }

  // Lord Null (towering sculpted dark obsidian/violet villain with spiked mantle)
  if (spriteKey === 'lord_null') {
    builder.setRoot(wx, wy + bob, wz, 0, 1.25);
    const robe = [0.14, 0.08, 0.24];
    const trim = [0.56, 0.18, 0.88];
    const glow = [0.98, 0.22, 0.32];
    builder.addLathe(0, 0.02, 0, [
      { y: 0.00, rx: 0.32, rz: 0.28, col: robe },
      { y: 0.45, rx: 0.20, rz: 0.18, col: robe },
      { y: 0.72, rx: 0.28, rz: 0.21, col: trim },
      { y: 0.82, rx: 0.12, rz: 0.12, col: robe },
    ], 9, robe);
    builder.addBall(0, 0.96, 0, 0.17, 0.18, 0.17, [0.10, 0.08, 0.16], 8);
    builder.addBall(-0.068, 0.97, 0.165, 0.034, 0.020, 0.015, glow, 5);
    builder.addBall( 0.068, 0.97, 0.165, 0.034, 0.020, 0.015, glow, 5);
    builder.addCone(-0.11, 1.12, 0, 0.04, 0.22, 5, trim, -0.04, 0);
    builder.addCone( 0.00, 1.14, 0, 0.05, 0.28, 5, glow);
    builder.addCone( 0.11, 1.12, 0, 0.04, 0.22, 5, trim,  0.04, 0);
    return;
  }

  // Elder Ada (detailed sage in layered shoulder mantle, pleated teal/gold robe, draped hair, crystal staff)
  if (spriteKey === 'elder_ada') {
    builder.setRoot(wx, wy + bob, wz, 0, 1.04);
    const robe = [0.12, 0.54, 0.56];
    const robeLight = [0.18, 0.66, 0.66];
    const gold = [0.95, 0.80, 0.28];
    const skin = SKIN_RGB.peach;
    const silver = [0.90, 0.92, 0.96];
    const eyeCol = [0.10, 0.14, 0.22];
    // Flowing pleated robe + flared shoulder shawl/mantle
    builder.addLathe(0, 0.02, 0, [
      { y: 0.00, rx: 0.27, rz: 0.25, col: robe },
      { y: 0.26, rx: 0.21, rz: 0.19, col: robe },
      { y: 0.48, rx: 0.17, rz: 0.15, col: robeLight },
      { y: 0.58, rx: 0.24, rz: 0.18, col: robeLight }, // draped shoulder shawl
      { y: 0.66, rx: 0.20, rz: 0.15, col: gold },      // golden mantle trim
      { y: 0.72, rx: 0.10, rz: 0.10, col: robe },
      { y: 0.78, rx: 0.068, rz: 0.068, col: skin },
    ], 10, robe);
    // Gold front stole
    builder.addBox(0, 0.36, 0.17, 0.055, 0.28, 0.028, gold, -0.14, 0);
    // Articulated draped sleeves + hands
    for (const s of [-1, 1]) {
      builder.addLathe(s * 0.22, 0.42, 0.03, [
        { y: 0.00, rx: 0.044, rz: 0.044, zOff: 0.05, col: skin },
        { y: 0.04, rx: 0.082, rz: 0.082, zOff: 0.03, col: gold },      // gold bell-sleeve rim
        { y: 0.12, rx: 0.074, rz: 0.074, zOff: 0.01, col: robe },
        { y: 0.26, rx: 0.068, rz: 0.068, zOff: 0.00, col: robeLight },
      ], 7, robe, -0.15, s * -0.16, [s * 0.22, 0.66, 0.03]);
    }
    // Sculpted Head + Gentle Face + Draped Silver Hair + Jeweled Bun
    builder.addLathe(0, 0.79, 0, [
      { y: 0.00, rx: 0.00, rz: 0.00 },
      { y: 0.03, rx: 0.08, rz: 0.085, zOff: 0.015 },
      { y: 0.10, rx: 0.145, rz: 0.142, zOff: 0.010 },
      { y: 0.19, rx: 0.158, rz: 0.155, zOff: 0.000 },
      { y: 0.28, rx: 0.140, rz: 0.142, zOff: -0.005 },
      { y: 0.32, rx: 0.00, rz: 0.00 },
    ], 10, skin);
    for (const s of [-1, 1]) {
      builder.addBall(s * 0.058, 0.94, 0.144, 0.024, 0.026, 0.014, [0.98, 0.98, 1.0], 5);
      builder.addBall(s * 0.056, 0.94, 0.154, 0.016, 0.020, 0.010, eyeCol, 5);
      builder.addCurvedLock([s * 0.12, 1.04, 0.04], [s * 0.16, 0.95, 0.04], [s * 0.14, 0.85, 0.00], 0.052, 0.034, 5, silver);
    }
    builder.addBall(0, 1.01, -0.03, 0.175, 0.128, 0.172, silver, 9);
    builder.addBall(0, 1.11, -0.12, 0.085, 0.078, 0.085, silver, 7);
    builder.addBall(0, 1.13, -0.06, 0.036, 0.036, 0.036, gold, 5);
    // Ornate Crystal-Topped Staff in right hand
    builder.addLathe(0.30, 0.02, 0.09, [
      { y: 0.00, rx: 0.026, rz: 0.026 },
      { y: 1.04, rx: 0.032, rz: 0.032 },
      { y: 1.09, rx: 0.058, rz: 0.058, col: gold },
    ], 7, [0.46, 0.28, 0.14]);
    builder.addBall(0.30, 1.17, 0.09, 0.068, 0.080, 0.068, [0.36, 0.82, 0.99], 7);
    return;
  }

  // Bram the Tinkerer (sturdy sculpted blacksmith with beard, goggles, rolled sleeves & gloves)
  builder.setRoot(wx, wy + bob, wz, 0, 1.02);
  const apron = [0.68, 0.36, 0.16];
  const apronDark = [0.48, 0.24, 0.11];
  const shirt = [0.42, 0.24, 0.14];
  const beard = [0.32, 0.18, 0.10];
  const skin = SKIN_RGB.warm_tan;
  const goggle = [0.36, 0.80, 0.98];
  const brass = [0.90, 0.74, 0.28];
  // Sturdy cuffed boots + legs
  for (const s of [-1, 1]) {
    builder.addLathe(s * 0.11, 0.00, 0, [
      { y: 0.00, rx: 0.080, rz: 0.102, zOff: 0.02, col: [0.20, 0.12, 0.08] },
      { y: 0.14, rx: 0.076, rz: 0.080, zOff: 0.00, col: [0.30, 0.18, 0.10] },
      { y: 0.30, rx: 0.082, rz: 0.082, zOff: 0.00, col: [0.24, 0.22, 0.26] },
    ], 7, [0.26, 0.16, 0.10]);
  }
  // Broad sculpted smith torso + leather apron + brass toolbelt
  builder.addLathe(0, 0.26, 0, [
    { y: 0.00, rx: 0.23, rz: 0.175, col: apronDark },
    { y: 0.12, rx: 0.22, rz: 0.172, col: brass },
    { y: 0.16, rx: 0.22, rz: 0.172, col: apron },
    { y: 0.34, rx: 0.24, rz: 0.168, col: apron },
    { y: 0.44, rx: 0.22, rz: 0.155, col: shirt },
    { y: 0.50, rx: 0.10, rz: 0.095, col: skin },
  ], 10, apron);
  // Articulated muscular arms with rolled sleeves & leather gloves
  for (const s of [-1, 1]) {
    builder.addBall(s * 0.26, 0.65, 0, 0.086, 0.082, 0.082, shirt, 6);
    builder.addLathe(s * 0.27, 0.36, 0, [
      { y: 0.00, rx: 0.058, rz: 0.060, zOff: 0.05, col: apronDark }, // leather glove
      { y: 0.08, rx: 0.064, rz: 0.064, zOff: 0.03, col: skin },      // forearm
      { y: 0.18, rx: 0.078, rz: 0.078, zOff: 0.00, col: shirt },     // rolled sleeve
      { y: 0.29, rx: 0.082, rz: 0.082, zOff: 0.00, col: shirt },
    ], 7, shirt, -0.14, s * -0.12, [s * 0.27, 0.65, 0]);
  }
  // Sculpted Head + Bushy Beard + Cap + Brass-Rimmed Blue Tinkerer Goggles
  builder.addBall(0, 0.87, 0, 0.172, 0.162, 0.162, skin, 9);
  // Sculpted beard & mustache
  builder.addLathe(0, 0.72, 0.055, [
    { y: 0.00, rx: 0.035, rz: 0.030 },
    { y: 0.08, rx: 0.135, rz: 0.115 },
    { y: 0.15, rx: 0.150, rz: 0.120 },
  ], 8, beard);
  builder.addBall(0, 0.87, 0.165, 0.032, 0.025, 0.030, skin, 5); // sturdy nose
  for (const s of [-1, 1]) {
    builder.addBall(s * 0.066, 0.895, 0.150, 0.024, 0.026, 0.014, [0.98, 0.98, 1.0], 5);
    builder.addBall(s * 0.064, 0.895, 0.160, 0.015, 0.018, 0.010, [0.1, 0.1, 0.14], 5);
    // Brass rim + glowing blue goggle lens
    builder.addBall(s * 0.072, 0.975, 0.158, 0.058, 0.046, 0.028, brass, 7);
    builder.addBall(s * 0.072, 0.975, 0.174, 0.044, 0.034, 0.020, goggle, 7);
  }
  builder.addBall(0, 0.97, -0.02, 0.188, 0.112, 0.184, shirt, 9);
}
