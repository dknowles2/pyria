// Zero-Dependency WebGL Nintendo 64 3D Renderer
// Features:
//  - Bilinear-filtered 512x512 procedural N64 texture atlas (4px wrapped gutters, zero bleeding)
//  - Continuous vertex-shaded heightfield terrain with soft two-texture biome edge blending
//  - Automatic textured cliff extrusion where elevation changes
//  - True low-poly 3D textured props (3-tier pines, leafy trees, connected ramparts, gates, shrines,
//    columns, crystal pillars, chests, torches, campfires, portals, bridges, statues, anvils)
//  - Per-biome N64 skybox gradient, drifting chunky clouds, distant low-poly mountains & distance fog
//  - Z-buffered 3D character billboards (Hero, Pip, NPCs) with ground contact shadows

import {
  ATLAS_GRID,
  ATLAS_SIZE,
  CELL_CORE,
  CELL_PAD,
  CELL_SIZE,
  GROUND_TO_TEX,
  TEX,
  getN64TextureAtlas,
} from './n64Textures.js?v=20261127u';
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

function lerpAngle(current, target, t) {
  let diff = ((target - current + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return current + diff * t;
}

// ---- Minimal 4x4 Column-Major Matrix Math ----
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

function projectPoint(vp, x, y, z, width, height) {
  const cx = vp[0] * x + vp[4] * y + vp[8]  * z + vp[12];
  const cy = vp[1] * x + vp[5] * y + vp[9]  * z + vp[13];
  const cz = vp[2] * x + vp[6] * y + vp[10] * z + vp[14];
  const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
  if (cw <= 0.1) return null;
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  const ndcZ = cz / cw;
  if (ndcZ < -1 || ndcZ > 1) return null;
  return {
    sx: (ndcX * 0.5 + 0.5) * width,
    sy: (0.5 - ndcY * 0.5) * height,
    scale: height / cw,
    depth: cw,
  };
}

// ---- Biome Sky & Fog Themes ----
const BIOME_THEMES = {
  valley: {
    skyTop: '#1d4ed8',
    skyMid: '#38bdf8',
    skyHorizon: '#bae6fd',
    mountainFar: '#60a5fa',
    mountainNear: '#3b82f6',
    cloudColor: 'rgba(255, 255, 255, 0.92)',
    cloudShade: 'rgba(186, 230, 253, 0.85)',
    fogColor: [0.68, 0.86, 0.98],
    fogStart: 12.5,
    fogEnd: 29.0,
    sunDir: [0.45, 0.82, 0.35],
    sunColor: [1.06, 1.02, 0.92],
    ambient: [0.44, 0.48, 0.56],
    cliffTex: TEX.CLIFF_ROCK,
    stars: false,
  },
  courtyard: {
    skyTop: '#1e40af',
    skyMid: '#60a5fa',
    skyHorizon: '#fde68a',
    mountainFar: '#7c93b8',
    mountainNear: '#4e6485',
    cloudColor: 'rgba(255, 251, 235, 0.9)',
    cloudShade: 'rgba(253, 230, 138, 0.72)',
    fogColor: [0.76, 0.84, 0.92],
    fogStart: 13.0,
    fogEnd: 30.0,
    sunDir: [0.55, 0.76, 0.34],
    sunColor: [1.08, 1.0, 0.86],
    ambient: [0.46, 0.46, 0.52],
    cliffTex: TEX.STONE_WALL,
    stars: false,
  },
  observatory: {
    skyTop: '#0b1026',
    skyMid: '#1e1b4b',
    skyHorizon: '#4c3f91',
    mountainFar: '#312e81',
    mountainNear: '#1e1b4b',
    cloudColor: 'rgba(165, 180, 252, 0.35)',
    cloudShade: 'rgba(99, 102, 241, 0.25)',
    fogColor: [0.22, 0.2, 0.44],
    fogStart: 12.0,
    fogEnd: 28.0,
    sunDir: [0.3, 0.86, 0.4],
    sunColor: [0.88, 0.94, 1.12],
    ambient: [0.44, 0.46, 0.64],
    cliffTex: TEX.ICE_WALL,
    stars: true,
  },
  sanctum: {
    skyTop: '#14081f',
    skyMid: '#3b0764',
    skyHorizon: '#991b1b',
    mountainFar: '#4c1d95',
    mountainNear: '#2e1065',
    cloudColor: 'rgba(192, 132, 252, 0.26)',
    cloudShade: 'rgba(127, 29, 29, 0.3)',
    fogColor: [0.28, 0.14, 0.36],
    fogStart: 11.5,
    fogEnd: 27.0,
    sunDir: [0.35, 0.82, 0.45],
    sunColor: [1.05, 0.84, 1.08],
    ambient: [0.42, 0.34, 0.52],
    cliffTex: TEX.OBSIDIAN_WALL,
    stars: true,
  },
};

function pickBiomeTheme(map) {
  const id = (map?.id || '').toLowerCase();
  const name = (map?.name || '').toLowerCase();
  if (
    id.includes('sanctum') || id.includes('crypt') || id.includes('keep') ||
    id.includes('citadel') || id.includes('throne') || id.includes('core') ||
    name.includes('sanctum')
  ) {
    return BIOME_THEMES.sanctum;
  }
  if (
    id.includes('observatory') || id.includes('star') || id.includes('cloud') ||
    id.includes('cavern') || name.includes('observatory')
  ) {
    return BIOME_THEMES.observatory;
  }
  if (id.includes('courtyard') || id.includes('ruins') || id.includes('foundry') || name.includes('courtyard')) {
    return BIOME_THEMES.courtyard;
  }
  return BIOME_THEMES.valley;
}

// ---- Shaders ----
const WORLD_VS = `
  precision highp float;
  attribute vec3 aPos;
  attribute vec2 aUV;
  attribute vec3 aColor;
  attribute vec3 aTexInfo; // x: texA, y: texB, z: blend
  attribute float aAnim;   // -1: cutaway-eligible wall/prop, 0: static terrain, 1: water, 2: lava, 3: emissive

  uniform mat4 uVP;
  uniform float uTime;

  varying vec2 vUV;
  varying vec3 vColor;
  varying vec3 vTexInfo;
  varying float vAnim;
  varying float vDepth;
  varying vec3 vWorldPos;

  void main() {
    vec3 pos = aPos;
    if (aAnim > 0.5 && aAnim < 1.5) {
      // Gentle N64 water ripple wave
      pos.y += sin(uTime * 2.6 + pos.x * 1.4 + pos.z * 1.1) * 0.045;
    } else if (aAnim > 1.5 && aAnim < 2.5) {
      // Slow lava swell
      pos.y += sin(uTime * 1.8 + pos.x * 1.1 - pos.z * 1.3) * 0.035;
    }
    vec4 clip = uVP * vec4(pos, 1.0);
    gl_Position = clip;
    vUV = aUV;
    vColor = aColor;
    vTexInfo = aTexInfo;
    vAnim = aAnim;
    vDepth = clip.w;
    vWorldPos = pos;
  }
`;

const WORLD_FS = `
  #ifdef GL_FRAGMENT_PRECISION_HIGH
  precision highp float;
  #else
  precision mediump float;
  #endif
  uniform sampler2D uAtlas;
  uniform float uTime;
  uniform vec3 uFogColor;
  uniform float uFogStart;
  uniform float uFogEnd;
  uniform vec3 uHeroPos;

  varying vec2 vUV;
  varying vec3 vColor;
  varying vec3 vTexInfo;
  varying float vAnim;
  varying float vDepth;
  varying vec3 vWorldPos;

  const float GRID = ${ATLAS_GRID.toFixed(1)};
  const float PAD_UV = ${(CELL_PAD / CELL_SIZE).toFixed(6)};
  const float CORE_UV = ${(CELL_CORE / CELL_SIZE).toFixed(6)};

  vec4 sampleSlot(float slot, vec2 uv) {
    float s = floor(slot + 0.5);
    float col = mod(s, GRID);
    float row = floor(s / GRID);
    vec2 f = fract(uv);
    vec2 cellUV = PAD_UV + f * CORE_UV;
    vec2 atlasUV = (vec2(col, row) + cellUV) / GRID;
    return texture2D(uAtlas, atlasUV);
  }

  void main() {
    // Authentic N64 4x4 Bayer screen-door translucency ONLY for foreground walls/props (vAnim < -0.5)
    // standing between the camera and the Hero — ground floors & cliffs are never punched with holes!
    if (vAnim < -0.5) {
      float dz = vWorldPos.z - uHeroPos.z;
      float dy = vWorldPos.y - uHeroPos.y;
      if (dz > 0.20 && dy > 0.08) {
        float zMask = smoothstep(0.20, 0.70, dz);
        float yMask = smoothstep(0.08, 0.30, dy);
        float dx = abs(vWorldPos.x - uHeroPos.x);
        float xMask = 1.0 - smoothstep(3.8, 7.2, dx);
        float fade = zMask * yMask * xMask * 0.84;
        if (fade > 0.02) {
          vec2 p = mod(floor(gl_FragCoord.xy), 4.0);
          vec2 b2 = mod(p, 2.0);
          vec2 b4 = floor(p * 0.5);
          float t0 = mod(b2.x + b2.y, 2.0) * 2.0 + b2.y;
          float t1 = mod(b4.x + b4.y, 2.0) * 2.0 + b4.y;
          float bayer = (t0 * 4.0 + t1 + 0.5) / 16.0;
          if (fade > bayer) discard;
        }
      }
    }
    vec2 uvA = vUV;
    vec2 uvB = vUV;
    float glowBoost = 0.0;

    if (vAnim > 0.5 && vAnim < 1.5) {
      // Scrolling water caustics
      uvA = vUV + vec2(uTime * 0.14, uTime * 0.09);
      glowBoost = 0.08 + 0.06 * sin(uTime * 3.0 + vUV.x * 5.0 + vUV.y * 4.0);
    } else if (vAnim > 1.5 && vAnim < 2.5) {
      // Scrolling lava magma
      uvA = vUV + vec2(uTime * 0.06, -uTime * 0.05);
      glowBoost = 0.25 + 0.12 * sin(uTime * 3.5 + vUV.x * 3.0);
    } else if (vAnim > 2.5) {
      // Emissive flame / crystal / portal
      uvA = vUV + vec2(0.0, -uTime * 0.45);
      glowBoost = 0.32;
    }

    vec4 colA = sampleSlot(vTexInfo.x, uvA);
    vec3 texRgb = colA.rgb;
    if (vTexInfo.z > 0.01) {
      vec4 colB = sampleSlot(vTexInfo.y, uvB);
      texRgb = mix(colA.rgb, colB.rgb, vTexInfo.z);
    }

    // Gouraud vertex lighting + optional emissive boost
    vec3 lit = texRgb * (vColor + vec3(glowBoost));

    // Iconic N64 linear distance fog
    float fogT = clamp((vDepth - uFogStart) / max(0.001, uFogEnd - uFogStart), 0.0, 1.0);
    fogT = fogT * fogT * (3.0 - 2.0 * fogT);
    vec3 finalRgb = mix(lit, uFogColor, fogT * 0.92);

    gl_FragColor = vec4(finalRgb, 1.0);
  }
`;

const BILLBOARD_VS = `
  precision highp float;
  attribute vec3 aPos;
  attribute vec2 aUV;
  uniform mat4 uVP;
  varying vec2 vUV;
  varying float vDepth;
  void main() {
    vec4 clip = uVP * vec4(aPos, 1.0);
    gl_Position = clip;
    vUV = aUV;
    vDepth = clip.w;
  }
`;

const BILLBOARD_FS = `
  #ifdef GL_FRAGMENT_PRECISION_HIGH
  precision highp float;
  #else
  precision mediump float;
  #endif
  uniform sampler2D uTex;
  uniform vec3 uFogColor;
  uniform float uFogStart;
  uniform float uFogEnd;
  varying vec2 vUV;
  varying float vDepth;
  void main() {
    vec4 c = texture2D(uTex, vUV);
    if (c.a < 0.15) discard;
    float fogT = clamp((vDepth - uFogStart) / max(0.001, uFogEnd - uFogStart), 0.0, 1.0);
    vec3 rgb = mix(c.rgb, uFogColor, fogT * 0.65);
    gl_FragColor = vec4(rgb, c.a);
  }
`;

// ---- Mesh Builder Helper ----
// Vertex stride: 12 floats: x, y, z, u, v, r, g, b, texA, texB, blend, anim
const STRIDE_FLOATS = 12;

class MeshBuilder {
  constructor() {
    this.data = [];
  }

  vertex(x, y, z, u, v, r, g, b, texA, texB = texA, blend = 0, anim = 0) {
    this.data.push(x, y, z, u, v, r, g, b, texA, texB, blend, anim);
  }

  tri(v0, v1, v2) {
    this.vertex(...v0);
    this.vertex(...v1);
    this.vertex(...v2);
  }

  quad(v0, v1, v2, v3) {
    this.tri(v0, v1, v2);
    this.tri(v0, v2, v3);
  }

  // Push a flat-shaded / Gouraud-lit 3D box [x0..x1, y0..y1, z0..z1]
  addBox(x0, y0, z0, x1, y1, z1, tex, sunDir, sunCol, amb, skipFaces = {}, uvScale = 1, tint = [1, 1, 1], anim = 0) {
    const shadeFace = (nx, ny, nz) => {
      const ndl = Math.max(0, nx * sunDir[0] + ny * sunDir[1] + nz * sunDir[2]);
      return [
        (amb[0] + sunCol[0] * ndl * 0.72) * tint[0],
        (amb[1] + sunCol[1] * ndl * 0.72) * tint[1],
        (amb[2] + sunCol[2] * ndl * 0.72) * tint[2],
      ];
    };
    const w = (x1 - x0) * uvScale;
    const h = (y1 - y0) * uvScale;
    const d = (z1 - z0) * uvScale;

    if (!skipFaces.top) {
      const c = shadeFace(0, 1, 0);
      this.quad(
        [x0, y1, z0, 0, 0, c[0], c[1], c[2], tex, tex, 0, anim],
        [x1, y1, z0, w, 0, c[0], c[1], c[2], tex, tex, 0, anim],
        [x1, y1, z1, w, d, c[0], c[1], c[2], tex, tex, 0, anim],
        [x0, y1, z1, 0, d, c[0], c[1], c[2], tex, tex, 0, anim]
      );
    }
    if (!skipFaces.south) {
      const c = shadeFace(0, 0, 1);
      this.quad(
        [x0, y1, z1, 0, 0, c[0], c[1], c[2], tex, tex, 0, anim],
        [x1, y1, z1, w, 0, c[0], c[1], c[2], tex, tex, 0, anim],
        [x1, y0, z1, w, h, c[0] * 0.82, c[1] * 0.82, c[2] * 0.82, tex, tex, 0, anim],
        [x0, y0, z1, 0, h, c[0] * 0.82, c[1] * 0.82, c[2] * 0.82, tex, tex, 0, anim]
      );
    }
    if (!skipFaces.north) {
      const c = shadeFace(0, 0, -1);
      this.quad(
        [x1, y1, z0, 0, 0, c[0], c[1], c[2], tex, tex, 0, anim],
        [x0, y1, z0, w, 0, c[0], c[1], c[2], tex, tex, 0, anim],
        [x0, y0, z0, w, h, c[0] * 0.82, c[1] * 0.82, c[2] * 0.82, tex, tex, 0, anim],
        [x1, y0, z0, 0, h, c[0] * 0.82, c[1] * 0.82, c[2] * 0.82, tex, tex, 0, anim]
      );
    }
    if (!skipFaces.west) {
      const c = shadeFace(-1, 0, 0);
      this.quad(
        [x0, y1, z0, 0, 0, c[0], c[1], c[2], tex, tex, 0, anim],
        [x0, y1, z1, d, 0, c[0], c[1], c[2], tex, tex, 0, anim],
        [x0, y0, z1, d, h, c[0] * 0.82, c[1] * 0.82, c[2] * 0.82, tex, tex, 0, anim],
        [x0, y0, z0, 0, h, c[0] * 0.82, c[1] * 0.82, c[2] * 0.82, tex, tex, 0, anim]
      );
    }
    if (!skipFaces.east) {
      const c = shadeFace(1, 0, 0);
      this.quad(
        [x1, y1, z1, 0, 0, c[0], c[1], c[2], tex, tex, 0, anim],
        [x1, y1, z0, d, 0, c[0], c[1], c[2], tex, tex, 0, anim],
        [x1, y0, z0, d, h, c[0] * 0.82, c[1] * 0.82, c[2] * 0.82, tex, tex, 0, anim],
        [x1, y0, z1, 0, h, c[0] * 0.82, c[1] * 0.82, c[2] * 0.82, tex, tex, 0, anim]
      );
    }
  }

  // Push a tapered cylinder / cone / prism around (cx, y0..y1, cz)
  addCylinder(cx, y0, cz, rBottom, rTop, height, sides, tex, sunDir, sunCol, amb, rotOffset = 0, tint = [1, 1, 1], anim = 0, capTop = true) {
    const y1 = y0 + height;
    for (let i = 0; i < sides; i++) {
      const a0 = rotOffset + (i / sides) * Math.PI * 2;
      const a1 = rotOffset + ((i + 1) / sides) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0);
      const c1 = Math.cos(a1), s1 = Math.sin(a1);
      const slopeY = rBottom > rTop ? 0.42 : 0.0;
      const shade = (nx, ny, nz, bottomDim) => {
        const len = Math.hypot(nx, ny, nz) || 1;
        const ndl = Math.max(0, (nx * sunDir[0] + ny * sunDir[1] + nz * sunDir[2]) / len);
        return [
          (amb[0] + sunCol[0] * ndl * 0.78) * tint[0] * bottomDim,
          (amb[1] + sunCol[1] * ndl * 0.78) * tint[1] * bottomDim,
          (amb[2] + sunCol[2] * ndl * 0.78) * tint[2] * bottomDim,
        ];
      };
      const k0Top = shade(c0, slopeY, s0, 1.05);
      const k1Top = shade(c1, slopeY, s1, 1.05);
      const k0Bot = shade(c0, slopeY, s0, 0.76);
      const k1Bot = shade(c1, slopeY, s1, 0.76);
      const u0 = i / sides;
      const u1 = (i + 1) / sides;

      if (rTop <= 0.001) {
        // Pointed cone
        this.tri(
          [cx, y1, cz, (u0 + u1) * 0.5, 0, k0Top[0], k0Top[1], k0Top[2], tex, tex, 0, anim],
          [cx + c0 * rBottom, y0, cz + s0 * rBottom, u0, 1, k0Bot[0], k0Bot[1], k0Bot[2], tex, tex, 0, anim],
          [cx + c1 * rBottom, y0, cz + s1 * rBottom, u1, 1, k1Bot[0], k1Bot[1], k1Bot[2], tex, tex, 0, anim]
        );
      } else {
        this.quad(
          [cx + c0 * rTop, y1, cz + s0 * rTop, u0, 0, k0Top[0], k0Top[1], k0Top[2], tex, tex, 0, anim],
          [cx + c1 * rTop, y1, cz + s1 * rTop, u1, 0, k1Top[0], k1Top[1], k1Top[2], tex, tex, 0, anim],
          [cx + c1 * rBottom, y0, cz + s1 * rBottom, u1, 1, k1Bot[0], k1Bot[1], k1Bot[2], tex, tex, 0, anim],
          [cx + c0 * rBottom, y0, cz + s0 * rBottom, u0, 1, k0Bot[0], k0Bot[1], k0Bot[2], tex, tex, 0, anim]
        );
        if (capTop) {
          const topCol = shade(0, 1, 0, 1.0);
          this.tri(
            [cx, y1, cz, 0.5, 0.5, topCol[0], topCol[1], topCol[2], tex, tex, 0, anim],
            [cx + c1 * rTop, y1, cz + s1 * rTop, 0.5 + c1 * 0.4, 0.5 + s1 * 0.4, topCol[0], topCol[1], topCol[2], tex, tex, 0, anim],
            [cx + c0 * rTop, y1, cz + s0 * rTop, 0.5 + c0 * 0.4, 0.5 + s0 * 0.4, topCol[0], topCol[1], topCol[2], tex, tex, 0, anim]
          );
        }
      }
    }
  }

  // Low-poly N64 faceted sphere/dome (for leafy tree canopies & bushes)
  addCrown(cx, cy, cz, rx, ry, rz, tex, sunDir, sunCol, amb, tint = [1, 1, 1]) {
    const segs = 7;
    const rings = [
      { y: -ry * 0.72, r: 0.45, v: 1.0, dim: 0.62 },
      { y: -ry * 0.15, r: 1.0,  v: 0.66, dim: 0.92 },
      { y:  ry * 0.48, r: 0.76, v: 0.32, dim: 1.08 },
    ];
    const shade = (nx, ny, nz, dim) => {
      const len = Math.hypot(nx, ny, nz) || 1;
      const ndl = Math.max(0, (nx * sunDir[0] + ny * sunDir[1] + nz * sunDir[2]) / len);
      return [
        (amb[0] + sunCol[0] * ndl * 0.8) * tint[0] * dim,
        (amb[1] + sunCol[1] * ndl * 0.8) * tint[1] * dim,
        (amb[2] + sunCol[2] * ndl * 0.8) * tint[2] * dim,
      ];
    };

    for (let r = 0; r < rings.length - 1; r++) {
      const a = rings[r];
      const b = rings[r + 1];
      for (let i = 0; i < segs; i++) {
        const t0 = (i / segs) * Math.PI * 2;
        const t1 = ((i + 1) / segs) * Math.PI * 2;
        const c0 = Math.cos(t0), s0 = Math.sin(t0);
        const c1 = Math.cos(t1), s1 = Math.sin(t1);
        const ca0 = shade(c0, a.y / ry, s0, a.dim);
        const ca1 = shade(c1, a.y / ry, s1, a.dim);
        const cb0 = shade(c0, b.y / ry, s0, b.dim);
        const cb1 = shade(c1, b.y / ry, s1, b.dim);
        const u0 = i / segs;
        const u1 = (i + 1) / segs;
        this.quad(
          [cx + c0 * rx * b.r, cy + b.y, cz + s0 * rz * b.r, u0, b.v, cb0[0], cb0[1], cb0[2], tex, tex, 0, 0],
          [cx + c1 * rx * b.r, cy + b.y, cz + s1 * rz * b.r, u1, b.v, cb1[0], cb1[1], cb1[2], tex, tex, 0, 0],
          [cx + c1 * rx * a.r, cy + a.y, cz + s1 * rz * a.r, u1, a.v, ca1[0], ca1[1], ca1[2], tex, tex, 0, 0],
          [cx + c0 * rx * a.r, cy + a.y, cz + s0 * rz * a.r, u0, a.v, ca0[0], ca0[1], ca0[2], tex, tex, 0, 0]
        );
      }
    }
    // Top cap to apex
    const topRing = rings[rings.length - 1];
    const apexCol = shade(0, 1, 0, 1.15);
    for (let i = 0; i < segs; i++) {
      const t0 = (i / segs) * Math.PI * 2;
      const t1 = ((i + 1) / segs) * Math.PI * 2;
      const c0 = Math.cos(t0), s0 = Math.sin(t0);
      const c1 = Math.cos(t1), s1 = Math.sin(t1);
      const cb0 = shade(c0, 0.5, s0, topRing.dim);
      const cb1 = shade(c1, 0.5, s1, topRing.dim);
      this.tri(
        [cx, cy + ry, cz, 0.5, 0, apexCol[0], apexCol[1], apexCol[2], tex, tex, 0, 0],
        [cx + c1 * rx * topRing.r, cy + topRing.y, cz + s1 * rz * topRing.r, (i + 1) / segs, topRing.v, cb1[0], cb1[1], cb1[2], tex, tex, 0, 0],
        [cx + c0 * rx * topRing.r, cy + topRing.y, cz + s0 * rz * topRing.r, i / segs, topRing.v, cb0[0], cb0[1], cb0[2], tex, tex, 0, 0]
      );
    }
  }

  toFloat32Array() {
    return new Float32Array(this.data);
  }
}

// ---- Terrain Height & Helpers ----
const NATURAL_TILES = new Set(['grass', 'grass_flower', 'flower_bed', 'dirt_path', 'sand']);
const LIQUID_TILES = new Set(['water', 'lava']);
const WALL_TILES = new Set(['stone_wall', 'ice_wall', 'obsidian_wall']);

function getRawElev(map, x, y, groundTile) {
  const elevLayer = map?.layers?.elevation;
  if (elevLayer && elevLayer[y] && typeof elevLayer[y][x] === 'number') {
    return elevLayer[y][x];
  }
  if (groundTile === 'water' || groundTile === 'lava') return 0;
  if (groundTile === 'stone_floor') return 1.25;
  return 1;
}

function organicUndulation(wx, wz) {
  return (
    Math.sin(wx * 0.42 + wz * 0.31) * 0.08 +
    Math.cos(wx * 0.77 - wz * 0.63) * 0.05
  );
}

function getEffective(map, dynamicOverrides, x, y) {
  const cx = Math.max(0, Math.min(map.width - 1, x));
  const cy = Math.max(0, Math.min(map.height - 1, y));
  const ov = dynamicOverrides.get(`${cx},${cy}`);
  let groundTile = map.layers.ground[cy][cx];
  if (ov && ov.layer === 'ground') groundTile = ov.tile;
  let decorTile = map.layers.decor[cy][cx];
  if (ov && ov.layer === 'decor') decorTile = ov.tile;
  return { groundTile, decorTile };
}

function buildWorldGeometry(map, dynamicOverrides, openedChests, theme) {
  const W = map.width;
  const H = map.height;
  const ELEV_SCALE = 0.52;
  const sunDir = theme.sunDir;
  const sunCol = theme.sunColor;
  const amb = theme.ambient;

  // Map opened chest coordinates + fallback portal/workshop entity coordinates
  const openedChestCoords = new Set();
  const extraEntityDecor = new Map();
  for (const ent of map.entities || []) {
    const key = `${ent.x},${ent.y}`;
    if (ent.type === 'chest' && openedChests && openedChests.has(ent.id)) {
      openedChestCoords.add(key);
    } else if (ent.type === 'portal') {
      extraEntityDecor.set(key, 'portal');
    } else if (ent.type === 'workshop') {
      extraEntityDecor.set(key, 'anvil');
    }
  }

  // Precompute ground, decor, void-chasm flag, and base height per tile
  const ground = new Array(W * H);
  const decor = new Array(W * H);
  const tileH = new Float32Array(W * H);
  const isVoid = new Uint8Array(W * H);
  const colLayer = map?.layers?.collision;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const key = `${x},${y}`;
      const eff = getEffective(map, dynamicOverrides, x, y);
      ground[idx] = eff.groundTile;
      let d = eff.decorTile;
      if (d === 'chest_closed' && openedChestCoords.has(key)) {
        d = 'chest_open';
      } else if (!d && extraEntityDecor.has(key)) {
        d = extraEntityDecor.get(key);
      }
      decor[idx] = d;
      const rawE = getRawElev(map, x, y, eff.groundTile);
      const blocked = colLayer && colLayer[y] && colLayer[y][x] === 1;
      let h = rawE * ELEV_SCALE;
      if (eff.groundTile === 'star_tile' && rawE === 0 && blocked && !d) {
        // Deep cosmic chasm surrounding floating Observatory platforms!
        isVoid[idx] = 1;
        h = -0.85;
      } else if (LIQUID_TILES.has(eff.groundTile)) {
        h = Math.max(0, h - 0.22);
      } else if (eff.groundTile === 'bridge_wood' || eff.groundTile === 'bridge_broken') {
        h = Math.max(0.32, h);
      }
      tileH[idx] = h;
    }
  }

  // Align each connected bridge component flush with the highest adjacent non-bridge walkable platform
  // so bridges spanning elevated platforms (elev 2..4) never sit down in a pit!
  const visitedBridge = new Uint8Array(W * H);
  const isBridgeTile = (g) => g === 'bridge_wood' || g === 'bridge_broken';
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const startIdx = y * W + x;
      if (visitedBridge[startIdx] || !isBridgeTile(ground[startIdx])) continue;
      const comp = [];
      const queue = [[x, y]];
      visitedBridge[startIdx] = 1;
      let maxNeighborH = tileH[startIdx];
      while (queue.length > 0) {
        const [cx, cy] = queue.pop();
        const cIdx = cy * W + cx;
        comp.push(cIdx);
        for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nIdx = ny * W + nx;
          if (isBridgeTile(ground[nIdx])) {
            if (!visitedBridge[nIdx]) {
              visitedBridge[nIdx] = 1;
              queue.push([nx, ny]);
            }
          } else if (!LIQUID_TILES.has(ground[nIdx]) && !isVoid[nIdx]) {
            if (tileH[nIdx] > maxNeighborH) maxNeighborH = tileH[nIdx];
          }
        }
      }
      for (const cIdx of comp) {
        tileH[cIdx] = maxNeighborH;
      }
    }
  }

  // Helper: get smooth corner height for a specific tile (x, y) at corner (vx, vz)
  // Smoothly averages adjacent tiles that are within 0.65 height units so gentle hills
  // flow organically while steep cliffs and cosmic void edges stay crisp!
  const cornerHeight = (tx, ty, vx, vz) => {
    const idx = ty * W + tx;
    const baseH = tileH[idx];
    const g = ground[idx];
    if (LIQUID_TILES.has(g) || isVoid[idx]) return baseH;
    let sum = baseH;
    let count = 1;
    let allNatural = NATURAL_TILES.has(g);
    const neighbors = [
      [vx - 1, vz - 1],
      [vx, vz - 1],
      [vx - 1, vz],
      [vx, vz],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx === tx && ny === ty) continue;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const nIdx = ny * W + nx;
      const ng = ground[nIdx];
      if (LIQUID_TILES.has(ng) || isVoid[nIdx]) continue;
      const nh = tileH[nIdx];
      if (Math.abs(nh - baseH) <= 0.68) {
        sum += nh;
        count++;
        if (!NATURAL_TILES.has(ng)) allNatural = false;
      }
    }
    let h = sum / count;
    if (allNatural) h += organicUndulation(vx, vz);
    return h;
  };

  // Helper: get blendable neighbor texture for a specific tile edge (constant per triangle!)
  const edgeNeighborTex = (nx, ny, selfGround, selfTex, selfVoid) => {
    if (selfVoid || LIQUID_TILES.has(selfGround) || selfGround === 'bridge_wood' || selfGround === 'bridge_broken') {
      return { texB: selfTex, blend: 0 };
    }
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) {
      return { texB: selfTex, blend: 0 };
    }
    const nIdx = ny * W + nx;
    const ng = ground[nIdx];
    if (isVoid[nIdx] || LIQUID_TILES.has(ng) || ng === 'bridge_wood' || ng === 'bridge_broken') {
      return { texB: selfTex, blend: 0 };
    }
    const nt = GROUND_TO_TEX[ng] ?? TEX.GRASS;
    if (nt === selfTex) return { texB: selfTex, blend: 0 };
    return { texB: nt, blend: 0.48 };
  };

  // Helper: ambient occlusion darkening near walls, trees, and higher cliffs
  const cornerAO = (tx, ty, vx, vz) => {
    const baseH = tileH[ty * W + tx];
    let ao = 1.0;
    const neighbors = [
      [vx - 1, vz - 1],
      [vx, vz - 1],
      [vx - 1, vz],
      [vx, vz],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const nd = decor[ny * W + nx];
      if (WALL_TILES.has(nd) || nd === 'vault_shrine' || nd === 'mossy_gate_closed') {
        ao -= 0.08;
      } else if (nd === 'tree' || nd === 'pine_tree') {
        ao -= 0.055;
      }
      if (tileH[ny * W + nx] - baseH > 0.35) {
        ao -= 0.07;
      }
    }
    return Math.max(0.62, ao);
  };

  const mesh = new MeshBuilder();
  const animProps = []; // Dynamic props (torches, campfires, portals, floating crystals)
  const UV_TILE_SCALE = 0.42; // ~2.4 tiles per texture repeat -> eliminates repetitive tiling!

  // 1. Continuous Ground Mesh + Automatic Cliff Walls
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const g = ground[idx];
      const texA = GROUND_TO_TEX[g] ?? TEX.GRASS;
      const anim = g === 'water' ? 1 : g === 'lava' ? 2 : 0;

      const h00 = cornerHeight(x, y, x, y);
      const h10 = cornerHeight(x, y, x + 1, y);
      const h11 = cornerHeight(x, y, x + 1, y + 1);
      const h01 = cornerHeight(x, y, x, y + 1);
      const hc = (h00 + h10 + h11 + h01) * 0.25;

      // Approximate surface normal for Gouraud slope shading
      const dxH = (h10 + h11) * 0.5 - (h00 + h01) * 0.5;
      const dzH = (h01 + h11) * 0.5 - (h00 + h10) * 0.5;
      let nx = -dxH, ny = 1.0, nz = -dzH;
      const nLen = Math.hypot(nx, ny, nz) || 1;
      nx /= nLen; ny /= nLen; nz /= nLen;
      const ndl = Math.max(0, nx * sunDir[0] + ny * sunDir[1] + nz * sunDir[2]);

      const shadeAt = (wx, wz, ao) => {
        // Gentle macro-scale organic N64 vertex color variation (sun patches & meadow dappling)
        const patch = 0.94 + 0.09 * Math.sin(wx * 0.37 + wz * 0.29) * Math.cos(wx * 0.21 - wz * 0.43);
        const voidDim = isVoid[idx] ? 0.48 : 1.0;
        const k = ao * patch * voidDim;
        return [
          (amb[0] + sunCol[0] * ndl * 0.72) * k,
          (amb[1] + sunCol[1] * ndl * 0.72) * k,
          (amb[2] + sunCol[2] * ndl * 0.72) * k,
        ];
      };

      const c00 = shadeAt(x, y, cornerAO(x, y, x, y));
      const c10 = shadeAt(x + 1, y, cornerAO(x, y, x + 1, y));
      const c11 = shadeAt(x + 1, y + 1, cornerAO(x, y, x + 1, y + 1));
      const c01 = shadeAt(x, y + 1, cornerAO(x, y, x, y + 1));
      const cc = shadeAt(x + 0.5, y + 0.5, 1.0);

      const uScale = g === 'bridge_wood' || g === 'bridge_broken' ? 1.0 : UV_TILE_SCALE;
      const bN = edgeNeighborTex(x, y - 1, g, texA, isVoid[idx]);
      const bE = edgeNeighborTex(x + 1, y, g, texA, isVoid[idx]);
      const bS = edgeNeighborTex(x, y + 1, g, texA, isVoid[idx]);
      const bW = edgeNeighborTex(x - 1, y, g, texA, isVoid[idx]);

      // 4-triangle fan per tile: texA and texB are constant across all 3 vertices of each triangle
      // so vTexInfo.y never interpolates across unrelated atlas slots!
      const emitFanTri = (ax, ah, az, ac, bx, bh, bz, bc, edgeB) => {
        mesh.tri(
          [x + 0.5, hc, y + 0.5, (x + 0.5) * uScale, (y + 0.5) * uScale, cc[0], cc[1], cc[2], texA, edgeB.texB, 0, anim],
          [ax, ah, az, ax * uScale, az * uScale, ac[0], ac[1], ac[2], texA, edgeB.texB, edgeB.blend, anim],
          [bx, bh, bz, bx * uScale, bz * uScale, bc[0], bc[1], bc[2], texA, edgeB.texB, edgeB.blend, anim]
        );
      };
      emitFanTri(x, h00, y, c00, x + 1, h10, y, c10, bN);
      emitFanTri(x + 1, h10, y, c10, x + 1, h11, y + 1, c11, bE);
      emitFanTri(x + 1, h11, y + 1, c11, x, h01, y + 1, c01, bS);
      emitFanTri(x, h01, y + 1, c01, x, h00, y, c00, bW);

      // Bridge railings / support posts on any outer bridge edge bordering liquid, cosmic void, or lower drop-off
      if (g === 'bridge_wood' || g === 'bridge_broken') {
        const isBridgeAt = (bx, by) => {
          if (bx < 0 || by < 0 || bx >= W || by >= H) return false;
          return isBridgeTile(ground[by * W + bx]);
        };
        const isDropOff = (bx, by) => {
          if (bx < 0 || by < 0 || bx >= W || by >= H) return true;
          const bIdx = by * W + bx;
          return LIQUID_TILES.has(ground[bIdx]) || isVoid[bIdx] === 1 || tileH[bIdx] < hc - 0.12;
        };
        const postH = g === 'bridge_wood' ? 0.44 : 0.24;
        if (isDropOff(x, y - 1) && !isBridgeAt(x, y - 1)) {
          mesh.addBox(x + 0.06, hc, y + 0.04, x + 0.18, hc + postH, y + 0.16, TEX.TREE_BARK, sunDir, sunCol, amb);
          mesh.addBox(x + 0.82, hc, y + 0.04, x + 0.94, hc + postH, y + 0.16, TEX.TREE_BARK, sunDir, sunCol, amb);
          if (g === 'bridge_wood') {
            mesh.addBox(x, hc + postH - 0.1, y + 0.06, x + 1, hc + postH - 0.02, y + 0.14, TEX.BRIDGE_WOOD, sunDir, sunCol, amb);
          }
        }
        if (isDropOff(x, y + 1) && !isBridgeAt(x, y + 1)) {
          mesh.addBox(x + 0.06, hc, y + 0.84, x + 0.18, hc + postH, y + 0.96, TEX.TREE_BARK, sunDir, sunCol, amb);
          mesh.addBox(x + 0.82, hc, y + 0.84, x + 0.94, hc + postH, y + 0.96, TEX.TREE_BARK, sunDir, sunCol, amb);
          if (g === 'bridge_wood') {
            mesh.addBox(x, hc + postH - 0.1, y + 0.86, x + 1, hc + postH - 0.02, y + 0.94, TEX.BRIDGE_WOOD, sunDir, sunCol, amb);
          }
        }
        if (isDropOff(x - 1, y) && !isBridgeAt(x - 1, y)) {
          mesh.addBox(x + 0.04, hc, y + 0.06, x + 0.16, hc + postH, y + 0.18, TEX.TREE_BARK, sunDir, sunCol, amb);
          mesh.addBox(x + 0.04, hc, y + 0.82, x + 0.16, hc + postH, y + 0.94, TEX.TREE_BARK, sunDir, sunCol, amb);
          if (g === 'bridge_wood') {
            mesh.addBox(x + 0.06, hc + postH - 0.1, y, x + 0.14, hc + postH - 0.02, y + 1, TEX.BRIDGE_WOOD, sunDir, sunCol, amb);
          }
        }
        if (isDropOff(x + 1, y) && !isBridgeAt(x + 1, y)) {
          mesh.addBox(x + 0.84, hc, y + 0.06, x + 0.96, hc + postH, y + 0.18, TEX.TREE_BARK, sunDir, sunCol, amb);
          mesh.addBox(x + 0.84, hc, y + 0.82, x + 0.96, hc + postH, y + 0.94, TEX.TREE_BARK, sunDir, sunCol, amb);
          if (g === 'bridge_wood') {
            mesh.addBox(x + 0.86, hc + postH - 0.1, y, x + 0.94, hc + postH - 0.02, y + 1, TEX.BRIDGE_WOOD, sunDir, sunCol, amb);
          }
        }
      }

      // Sculpted glowing observatory balustrade/parapet along floating platform edges bordering cosmic void
      if (!isVoid[idx] && g !== 'bridge_wood' && g !== 'bridge_broken') {
        const rimH = 0.34;
        const rimT = 0.14;
        const isVoidAt = (vx, vy) => vx >= 0 && vy >= 0 && vx < W && vy < H && isVoid[vy * W + vx] === 1;
        if (isVoidAt(x, y - 1)) {
          mesh.addBox(x, hc, y, x + 1, hc + rimH, y + rimT, TEX.MARBLE_COLUMN, sunDir, sunCol, amb, {}, 1.0, [0.92, 0.96, 1.15]);
          mesh.addBox(x, hc + rimH, y, x + 1, hc + rimH + 0.06, y + rimT + 0.02, TEX.ICE_WALL, sunDir, sunCol, amb, {}, 1.0, [1.1, 1.2, 1.35]);
        }
        if (isVoidAt(x, y + 1)) {
          mesh.addBox(x, hc, y + 1 - rimT, x + 1, hc + rimH, y + 1, TEX.MARBLE_COLUMN, sunDir, sunCol, amb, {}, 1.0, [0.92, 0.96, 1.15]);
          mesh.addBox(x, hc + rimH, y + 1 - rimT - 0.02, x + 1, hc + rimH + 0.06, y + 1, TEX.ICE_WALL, sunDir, sunCol, amb, {}, 1.0, [1.1, 1.2, 1.35]);
        }
        // Slight 0.003 vertical offset on E/W caps prevents corner Z-fighting with N/S caps
        if (isVoidAt(x - 1, y)) {
          mesh.addBox(x, hc, y, x + rimT, hc + rimH + 0.003, y + 1, TEX.MARBLE_COLUMN, sunDir, sunCol, amb, {}, 1.0, [0.92, 0.96, 1.15]);
          mesh.addBox(x, hc + rimH + 0.003, y, x + rimT + 0.02, hc + rimH + 0.063, y + 1, TEX.ICE_WALL, sunDir, sunCol, amb, {}, 1.0, [1.1, 1.2, 1.35]);
        }
        if (isVoidAt(x + 1, y)) {
          mesh.addBox(x + 1 - rimT, hc, y, x + 1, hc + rimH + 0.003, y + 1, TEX.MARBLE_COLUMN, sunDir, sunCol, amb, {}, 1.0, [0.92, 0.96, 1.15]);
          mesh.addBox(x + 1 - rimT - 0.02, hc + rimH + 0.003, y, x + 1, hc + rimH + 0.063, y + 1, TEX.ICE_WALL, sunDir, sunCol, amb, {}, 1.0, [1.1, 1.2, 1.35]);
        }
      }

      // Automatic Cliff / Bank Walls along edges where a non-bridge tile is higher than neighbor
      // (Skip bridges so they span cleanly over water/void instead of extruding rock walls underneath!)
      if (!isBridgeTile(g)) {
        const cliffTex = g === 'stone_floor' ? TEX.STONE_WALL
          : g === 'obsidian_floor' ? TEX.OBSIDIAN_WALL
          : g === 'ice_floor' ? TEX.ICE_WALL
          : theme.cliffTex;

        const emitCliff = (ax, az, ha, bx, bz, hb, lowH, cnx, cnz) => {
          if (Math.min(ha, hb) - lowH < 0.08) return;
          const cndl = Math.max(0, cnx * sunDir[0] + 0.2 * sunDir[1] + cnz * sunDir[2]);
          const tr = amb[0] + sunCol[0] * cndl * 0.72;
          const tg = amb[1] + sunCol[1] * cndl * 0.72;
          const tb = amb[2] + sunCol[2] * cndl * 0.72;
          const botH = lowH - 0.08;
          // Clamp v to 0.98 so vertically directional cliff textures (grass/snow lip) never wrap mid-cliff!
          mesh.quad(
            [ax, ha, az, 0, 0, tr, tg, tb, cliffTex, cliffTex, 0, 0],
            [bx, hb, bz, 0.8, 0, tr, tg, tb, cliffTex, cliffTex, 0, 0],
            [bx, botH, bz, 0.8, 0.98, tr * 0.68, tg * 0.68, tb * 0.68, cliffTex, cliffTex, 0, 0],
            [ax, botH, az, 0, 0.98, tr * 0.68, tg * 0.68, tb * 0.68, cliffTex, cliffTex, 0, 0]
          );
        };

        // Compare against neighbor's base elevation only when there is a real step (not smooth undulation)
        if (y + 1 < H) {
          const nIdx = (y + 1) * W + x;
          if (tileH[idx] - tileH[nIdx] > 0.20) emitCliff(x, y + 1, h01, x + 1, y + 1, h11, tileH[nIdx], 0, 1);
        } else if (!isVoid[idx]) {
          emitCliff(x, y + 1, h01, x + 1, y + 1, h11, -0.5, 0, 1);
        }
        if (y - 1 >= 0) {
          const nIdx = (y - 1) * W + x;
          if (tileH[idx] - tileH[nIdx] > 0.20) emitCliff(x + 1, y, h10, x, y, h00, tileH[nIdx], 0, -1);
        }
        if (x - 1 >= 0) {
          const nIdx = y * W + (x - 1);
          if (tileH[idx] - tileH[nIdx] > 0.20) emitCliff(x, y, h00, x, y + 1, h01, tileH[nIdx], -1, 0);
        } else if (!isVoid[idx]) {
          emitCliff(x, y, h00, x, y + 1, h01, -0.5, -1, 0);
        }
        if (x + 1 < W) {
          const nIdx = y * W + (x + 1);
          if (tileH[idx] - tileH[nIdx] > 0.20) emitCliff(x + 1, y + 1, h11, x + 1, y, h10, tileH[nIdx], 1, 0);
        } else if (!isVoid[idx]) {
          emitCliff(x + 1, y + 1, h11, x + 1, y, h10, -0.5, 1, 0);
        }
      }

      // 2. True Low-Poly 3D Props on top of terrain
      const d = decor[idx];
      if (!d) continue;
      const cx = x + 0.5;
      const cz = y + 0.5;
      const seed = (x * 73 + y * 139) % 100;

      if (d === 'pine_tree') {
        const sc = 0.88 + (seed % 25) * 0.01;
        // Trunk & 3 stacked N64 evergreen cones (anim = -1 enables foreground cutaway!)
        mesh.addCylinder(cx, hc - 0.04, cz, 0.14 * sc, 0.1 * sc, 0.62 * sc, 6, TEX.TREE_BARK, sunDir, sunCol, amb, seed, [1, 1, 1], -1);
        mesh.addCylinder(cx, hc + 0.42 * sc, cz, 0.56 * sc, 0, 0.82 * sc, 6, TEX.FOLIAGE_PINE, sunDir, sunCol, amb, seed, [1, 1, 1], -1);
        mesh.addCylinder(cx, hc + 0.92 * sc, cz, 0.45 * sc, 0, 0.76 * sc, 6, TEX.FOLIAGE_PINE, sunDir, sunCol, amb, seed + 0.5, [1, 1, 1], -1);
        mesh.addCylinder(cx, hc + 1.38 * sc, cz, 0.32 * sc, 0, 0.65 * sc, 6, TEX.FOLIAGE_PINE, sunDir, sunCol, amb, seed + 1.0, [1, 1, 1], -1);
      } else if (d === 'tree') {
        const sc = 0.9 + (seed % 22) * 0.01;
        mesh.addCylinder(cx, hc - 0.04, cz, 0.17 * sc, 0.11 * sc, 0.95 * sc, 6, TEX.TREE_BARK, sunDir, sunCol, amb, seed, [1, 1, 1], -1);
        mesh.addCrown(cx, hc + 1.32 * sc, cz, 0.58 * sc, 0.46 * sc, 0.56 * sc, TEX.FOLIAGE_LEAF, sunDir, sunCol, amb);
        mesh.addCrown(cx - 0.24 * sc, hc + 1.12 * sc, cz + 0.16 * sc, 0.38 * sc, 0.32 * sc, 0.36 * sc, TEX.FOLIAGE_LEAF, sunDir, sunCol, amb, [0.94, 1.0, 0.94]);
        mesh.addCrown(cx + 0.25 * sc, hc + 1.16 * sc, cz - 0.14 * sc, 0.36 * sc, 0.3 * sc, 0.36 * sc, TEX.FOLIAGE_LEAF, sunDir, sunCol, amb, [1.04, 1.04, 0.96]);
      } else if (WALL_TILES.has(d)) {
        const wTex = d === 'ice_wall' ? TEX.ICE_WALL : d === 'obsidian_wall' ? TEX.OBSIDIAN_WALL : TEX.STONE_WALL;
        const skip = {
          north: y > 0 && WALL_TILES.has(decor[(y - 1) * W + x]),
          south: y < H - 1 && WALL_TILES.has(decor[(y + 1) * W + x]),
          west: x > 0 && WALL_TILES.has(decor[y * W + (x - 1)]),
          east: x < W - 1 && WALL_TILES.has(decor[y * W + (x + 1)]),
        };
        const wallH = 1.28;
        mesh.addBox(x, hc - 0.05, y, x + 1, hc + wallH, y + 1, wTex, sunDir, sunCol, amb, skip, 0.95, [1, 1, 1], -1);
        // Subtle N64 castle battlement merlon on alternating wall tops
        if ((x + y) % 2 === 0 && !skip.south) {
          mesh.addBox(x + 0.14, hc + wallH, y + 0.68, x + 0.86, hc + wallH + 0.24, y + 0.98, wTex, sunDir, sunCol, amb, {}, 0.9, [1, 1, 1], -1);
        }
      } else if (d === 'mossy_gate_closed' || d === 'mossy_gate_open') {
        mesh.addBox(x + 0.02, hc - 0.04, y + 0.34, x + 0.22, hc + 1.38, y + 0.66, TEX.STONE_WALL, sunDir, sunCol, amb, {}, 1, [1, 1, 1], -1);
        mesh.addBox(x + 0.78, hc - 0.04, y + 0.34, x + 0.98, hc + 1.38, y + 0.66, TEX.STONE_WALL, sunDir, sunCol, amb, {}, 1, [1, 1, 1], -1);
        mesh.addBox(x, hc + 1.24, y + 0.3, x + 1, hc + 1.52, y + 0.7, TEX.STONE_WALL, sunDir, sunCol, amb, {}, 1, [1, 1, 1], -1);
        if (d === 'mossy_gate_closed') {
          mesh.addBox(x + 0.2, hc - 0.02, y + 0.44, x + 0.8, hc + 1.24, y + 0.58, TEX.MOSSY_GATE, sunDir, sunCol, amb, {}, 1, [1, 1, 1], -1);
        }
      } else if (d === 'vault_shrine') {
        // Stepped temple pedestal + rear runic obelisk (leaving front of pedestal clear for the perched Vault Dragon!)
        mesh.addBox(x + 0.04, hc - 0.04, y + 0.04, x + 0.96, hc + 0.28, y + 0.96, TEX.STONE_FLOOR, sunDir, sunCol, amb);
        mesh.addBox(x + 0.16, hc + 0.28, y + 0.04, x + 0.84, hc + 0.56, y + 0.42, TEX.SHRINE_STONE, sunDir, sunCol, amb, {}, 1, [1, 1, 1], -1);
        mesh.addCylinder(cx, hc + 0.56, y + 0.22, 0.24, 0.12, 1.32, 4, TEX.SHRINE_STONE, sunDir, sunCol, amb, Math.PI * 0.25, [1, 1, 1], -1);
        animProps.push({ type: 'shrine_crystal', x: cx, y: hc + 2.12, z: y + 0.22 });
      } else if (d === 'column') {
        mesh.addBox(x + 0.18, hc - 0.04, y + 0.18, x + 0.82, hc + 0.2, y + 0.82, TEX.MARBLE_COLUMN, sunDir, sunCol, amb, {}, 1, [1, 1, 1], -1);
        mesh.addCylinder(cx, hc + 0.2, cz, 0.23, 0.2, 1.35, 6, TEX.MARBLE_COLUMN, sunDir, sunCol, amb, 0, [1, 1, 1], -1);
        mesh.addBox(x + 0.16, hc + 1.55, y + 0.16, x + 0.84, hc + 1.76, y + 0.84, TEX.MARBLE_COLUMN, sunDir, sunCol, amb, {}, 1, [1, 1, 1], -1);
      } else if (d === 'crystal_pillar') {
        // Glowing faceted amethyst/cyan crystal spire
        mesh.addCylinder(cx, hc - 0.04, cz, 0.28, 0.22, 1.15, 6, TEX.CRYSTAL, sunDir, sunCol, amb, 0.2, [1.1, 1.1, 1.2], 3, false);
        mesh.addCylinder(cx, hc + 1.11, cz, 0.22, 0, 0.62, 6, TEX.CRYSTAL, sunDir, sunCol, amb, 0.2, [1.2, 1.2, 1.3], 3);
        // Side crystal shard
        mesh.addCylinder(cx + 0.24, hc - 0.04, cz + 0.14, 0.14, 0, 0.72, 5, TEX.CRYSTAL, sunDir, sunCol, amb, 0.8, [1.0, 1.1, 1.2], 3);
      } else if (d === 'chest_closed' || d === 'chest_open') {
        const tint = d === 'chest_open' ? [0.78, 0.78, 0.78] : [1.08, 1.04, 0.96];
        mesh.addBox(x + 0.2, hc - 0.02, y + 0.26, x + 0.8, hc + 0.34, y + 0.74, TEX.CHEST_WOOD, sunDir, sunCol, amb, {}, 1.0, tint);
        if (d === 'chest_closed') {
          mesh.addBox(x + 0.18, hc + 0.34, y + 0.24, x + 0.82, hc + 0.5, y + 0.76, TEX.CHEST_WOOD, sunDir, sunCol, amb, {}, 1.0, [1.14, 1.08, 0.95]);
        } else {
          // Open lid tilted back
          mesh.addBox(x + 0.2, hc + 0.34, y + 0.16, x + 0.8, hc + 0.66, y + 0.32, TEX.CHEST_WOOD, sunDir, sunCol, amb, {}, 1.0, tint);
        }
      } else if (d === 'torch') {
        mesh.addCylinder(cx, hc - 0.02, cz, 0.07, 0.06, 0.82, 5, TEX.TREE_BARK, sunDir, sunCol, amb);
        mesh.addBox(cx - 0.1, hc + 0.78, cz - 0.1, cx + 0.1, hc + 0.9, cz + 0.1, TEX.STONE_WALL, sunDir, sunCol, amb);
        animProps.push({ type: 'flame', x: cx, y: hc + 0.9, z: cz, scale: 0.15 });
      } else if (d === 'campfire') {
        // Stone ring + crossed logs + animated flame
        for (let i = 0; i < 6; i++) {
          const ang = (i / 6) * Math.PI * 2;
          const sx = cx + Math.cos(ang) * 0.28;
          const sz = cz + Math.sin(ang) * 0.28;
          mesh.addBox(sx - 0.09, hc - 0.02, sz - 0.09, sx + 0.09, hc + 0.14, sz + 0.09, TEX.STONE_FLOOR, sunDir, sunCol, amb);
        }
        mesh.addBox(cx - 0.22, hc, cz - 0.07, cx + 0.22, hc + 0.12, cz + 0.07, TEX.TREE_BARK, sunDir, sunCol, amb);
        mesh.addBox(cx - 0.07, hc, cz - 0.22, cx + 0.07, hc + 0.12, cz + 0.22, TEX.TREE_BARK, sunDir, sunCol, amb);
        animProps.push({ type: 'flame', x: cx, y: hc + 0.12, z: cz, scale: 0.28 });
      } else if (d === 'portal') {
        // Carved twin portal pillars + arch + animated swirling vortex
        mesh.addBox(x + 0.06, hc - 0.04, y + 0.38, x + 0.24, hc + 1.38, y + 0.62, TEX.MARBLE_COLUMN, sunDir, sunCol, amb);
        mesh.addBox(x + 0.76, hc - 0.04, y + 0.38, x + 0.94, hc + 1.38, y + 0.62, TEX.MARBLE_COLUMN, sunDir, sunCol, amb);
        mesh.addBox(x + 0.04, hc + 1.28, y + 0.34, x + 0.96, hc + 1.5, y + 0.66, TEX.MARBLE_COLUMN, sunDir, sunCol, amb);
        animProps.push({ type: 'portal', x: cx, y: hc + 0.68, z: cz });
      } else if (d === 'bush') {
        mesh.addCrown(cx, hc + 0.26, cz, 0.38, 0.28, 0.36, TEX.BUSH_LEAF, sunDir, sunCol, amb);
      } else if (d === 'statue') {
        mesh.addBox(x + 0.16, hc - 0.04, y + 0.16, x + 0.84, hc + 0.32, y + 0.84, TEX.STONE_FLOOR, sunDir, sunCol, amb);
        mesh.addBox(x + 0.28, hc + 0.32, y + 0.28, x + 0.72, hc + 1.05, y + 0.72, TEX.MARBLE_COLUMN, sunDir, sunCol, amb);
        mesh.addCrown(cx, hc + 1.22, cz, 0.2, 0.22, 0.2, TEX.MARBLE_COLUMN, sunDir, sunCol, amb);
      } else if (d === 'anvil') {
        mesh.addBox(x + 0.26, hc - 0.02, y + 0.3, x + 0.74, hc + 0.22, y + 0.7, TEX.OBSIDIAN_FLOOR, sunDir, sunCol, amb);
        mesh.addBox(x + 0.16, hc + 0.22, y + 0.28, x + 0.86, hc + 0.44, y + 0.72, TEX.STONE_WALL, sunDir, sunCol, amb, {}, 1.0, [0.75, 0.8, 0.88]);
      } else if (d === 'coral') {
        mesh.addCylinder(cx - 0.12, hc - 0.02, cz, 0.14, 0.06, 0.62, 5, TEX.CORAL, sunDir, sunCol, amb);
        mesh.addCylinder(cx + 0.14, hc - 0.02, cz + 0.08, 0.12, 0.05, 0.48, 5, TEX.CORAL, sunDir, sunCol, amb);
      } else if (d === 'gear_prop') {
        mesh.addCylinder(cx, hc - 0.02, cz, 0.38, 0.38, 0.24, 8, TEX.GEAR_METAL, sunDir, sunCol, amb);
      }
    }
  }

  return {
    vertices: mesh.toFloat32Array(),
    vertexCount: mesh.data.length / STRIDE_FLOATS,
    tileH,
    animProps,
    W,
    H,
  };
}

// ---- N64 Sky, Drifting Clouds & Layered Low-Poly Mountain Backdrop ----
function drawN64SkyBackdrop(ctx, W, H, theme, heroX, time) {
  const horizonY = Math.round(H * 0.44);

  // Sky gradient
  const sky = ctx.createLinearGradient(0, 0, 0, horizonY + 30);
  sky.addColorStop(0, theme.skyTop);
  sky.addColorStop(0.58, theme.skyMid);
  sky.addColorStop(1, theme.skyHorizon);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, horizonY + 30);

  // Lower fog fill behind terrain edges
  const fc = theme.fogColor;
  ctx.fillStyle = `rgb(${Math.round(fc[0] * 255)}, ${Math.round(fc[1] * 255)}, ${Math.round(fc[2] * 255)})`;
  ctx.fillRect(0, horizonY + 28, W, H - horizonY - 28);

  // Twinkling cosmic stars for Observatory & Sanctum
  if (theme.stars) {
    for (let i = 0; i < 55; i++) {
      const sx = ((i * 197.3 - heroX * 4.5) % W + W) % W;
      const sy = ((i * 89.7) % (horizonY * 0.85));
      const twinkle = 0.4 + 0.6 * Math.abs(Math.sin(time * 2.2 + i * 1.7));
      ctx.fillStyle = `rgba(254, 249, 195, ${twinkle.toFixed(2)})`;
      const sz = i % 5 === 0 ? 3 : 2;
      ctx.fillRect(Math.round(sx), Math.round(sy), sz, sz);
    }
  }

  // Chunky low-poly N64 clouds drifting gently
  const cloudDrift = time * 6 - heroX * 8;
  for (let i = 0; i < 7; i++) {
    const cx = (((i * 230 + cloudDrift) % (W + 260)) + (W + 260)) % (W + 260) - 130;
    const cy = 28 + (i % 3) * 38 + Math.sin(i * 2.1) * 10;
    const cw = 72 + (i % 3) * 28;
    const ch = 20 + (i % 2) * 8;

    // Cloud underside shade
    ctx.fillStyle = theme.cloudShade;
    ctx.beginPath();
    ctx.moveTo(cx - cw * 0.55, cy + ch * 0.4);
    ctx.lineTo(cx - cw * 0.25, cy - ch * 0.35);
    ctx.lineTo(cx + cw * 0.2, cy - ch * 0.5);
    ctx.lineTo(cx + cw * 0.58, cy + ch * 0.35);
    ctx.closePath();
    ctx.fill();

    // Bright polygonal cloud top
    ctx.fillStyle = theme.cloudColor;
    ctx.beginPath();
    ctx.moveTo(cx - cw * 0.5, cy + ch * 0.2);
    ctx.lineTo(cx - cw * 0.22, cy - ch * 0.55);
    ctx.lineTo(cx + cw * 0.16, cy - ch * 0.68);
    ctx.lineTo(cx + cw * 0.52, cy + ch * 0.18);
    ctx.closePath();
    ctx.fill();
  }

  // Far mountain range (parallax with heroX)
  const drawRange = (color, baseH, amp, freq, parallax, seed) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, horizonY + 32);
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      const mx = (W / steps) * i;
      const sample = i + heroX * parallax;
      const peak = baseH + Math.abs(Math.sin(sample * freq + seed)) * amp + Math.cos(sample * (freq * 1.9) + seed) * (amp * 0.32);
      ctx.lineTo(mx, horizonY + 12 - peak);
    }
    ctx.lineTo(W, horizonY + 32);
    ctx.closePath();
    ctx.fill();
  };

  drawRange(theme.mountainFar, 26, 48, 0.62, 0.08, 1.2);
  drawRange(theme.mountainNear, 12, 34, 0.85, 0.16, 3.7);
}

// ---- WebGL N64 Renderer Singleton ----
class WebGLN64Renderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.contextLost = false;
    this.available = false;
    this.hitTargets = [];
    this.quadVerts = new Float32Array(30);
    this.lastRenderTime = null;

    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.cachedKey = null;
      this.cachedWorld = null;
      this.initGLResources();
    });

    this.gl = this.canvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      depth: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!this.gl) return;

    this.cam = { x: 0, y: 0, z: 0, init: false, mapId: null, saveId: null };
    this.heroYaw = 0;
    this.pipYaw = 0;
    this.cachedKey = null;
    this.cachedWorld = null;

    this.initGLResources();
  }

  initGLResources() {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) {
      this.available = false;
      return;
    }
    this.available = true;
    this.initPrograms();
    if (!this.available) return;
    this.initAtlasTexture();
    this.shadowTex = this.createShadowTexture();
    this.staticBuf = gl.createBuffer();
    this.dynamicBuf = gl.createBuffer();
    this.billboardBuf = gl.createBuffer();
    this.charBuf = gl.createBuffer();
    if (!this.atlasTex || !this.shadowTex || !this.staticBuf || !this.dynamicBuf || !this.billboardBuf || !this.charBuf) {
      this.available = false;
    }
  }

  compileShader(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('N64 shader compile error:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  createProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSrc);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      return null;
    }
    const prog = gl.createProgram();
    if (!prog) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return null;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('N64 program link error:', gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  }

  initPrograms() {
    const gl = this.gl;
    this.worldProg = this.createProgram(WORLD_VS, WORLD_FS);
    this.billboardProg = this.createProgram(BILLBOARD_VS, BILLBOARD_FS);
    this.charProg = this.createProgram(CHAR_VS, CHAR_FS);
    if (!this.worldProg || !this.billboardProg || !this.charProg) {
      this.available = false;
      return;
    }

    this.wLoc = {
      aPos: gl.getAttribLocation(this.worldProg, 'aPos'),
      aUV: gl.getAttribLocation(this.worldProg, 'aUV'),
      aColor: gl.getAttribLocation(this.worldProg, 'aColor'),
      aTexInfo: gl.getAttribLocation(this.worldProg, 'aTexInfo'),
      aAnim: gl.getAttribLocation(this.worldProg, 'aAnim'),
      uVP: gl.getUniformLocation(this.worldProg, 'uVP'),
      uTime: gl.getUniformLocation(this.worldProg, 'uTime'),
      uAtlas: gl.getUniformLocation(this.worldProg, 'uAtlas'),
      uFogColor: gl.getUniformLocation(this.worldProg, 'uFogColor'),
      uFogStart: gl.getUniformLocation(this.worldProg, 'uFogStart'),
      uFogEnd: gl.getUniformLocation(this.worldProg, 'uFogEnd'),
      uHeroPos: gl.getUniformLocation(this.worldProg, 'uHeroPos'),
    };

    this.bLoc = {
      aPos: gl.getAttribLocation(this.billboardProg, 'aPos'),
      aUV: gl.getAttribLocation(this.billboardProg, 'aUV'),
      uVP: gl.getUniformLocation(this.billboardProg, 'uVP'),
      uTex: gl.getUniformLocation(this.billboardProg, 'uTex'),
      uFogColor: gl.getUniformLocation(this.billboardProg, 'uFogColor'),
      uFogStart: gl.getUniformLocation(this.billboardProg, 'uFogStart'),
      uFogEnd: gl.getUniformLocation(this.billboardProg, 'uFogEnd'),
    };

    this.cLoc = {
      aPos: gl.getAttribLocation(this.charProg, 'aPos'),
      aNorm: gl.getAttribLocation(this.charProg, 'aNorm'),
      aColor: gl.getAttribLocation(this.charProg, 'aColor'),
      uVP: gl.getUniformLocation(this.charProg, 'uVP'),
      uSunDir: gl.getUniformLocation(this.charProg, 'uSunDir'),
      uSunColor: gl.getUniformLocation(this.charProg, 'uSunColor'),
      uAmbient: gl.getUniformLocation(this.charProg, 'uAmbient'),
      uFogColor: gl.getUniformLocation(this.charProg, 'uFogColor'),
      uFogStart: gl.getUniformLocation(this.charProg, 'uFogStart'),
      uFogEnd: gl.getUniformLocation(this.charProg, 'uFogEnd'),
    };
  }

  initAtlasTexture() {
    const gl = this.gl;
    const atlasCanvas = getN64TextureAtlas();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
    // Authentic Nintendo 64 bilinear texture filtering (no mipmaps so fract() atlas tiling has zero hairline seams)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.atlasTex = tex;
  }

  createShadowTexture() {
    const gl = this.gl;
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    const sctx = c.getContext('2d');
    const grad = sctx.createRadialGradient(16, 16, 2, 16, 16, 15);
    grad.addColorStop(0, 'rgba(10, 14, 24, 0.55)');
    grad.addColorStop(0.65, 'rgba(10, 14, 24, 0.28)');
    grad.addColorStop(1, 'rgba(10, 14, 24, 0.0)');
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, 32, 32);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  ensureWorldBuilt(map, dynamicOverrides, openedChests, theme) {
    let ovSig = '';
    for (const [k, v] of dynamicOverrides.entries()) {
      ovSig += `${k}:${v.layer}:${v.tile};`;
    }
    let chSig = '';
    if (openedChests && openedChests.size > 0) {
      chSig = [...openedChests].sort().join(',');
    }
    const cacheKey = `${map.id || map.name}|${map.width}x${map.height}|${ovSig}|${chSig}`;
    if (this.cachedKey === cacheKey && this.cachedWorld) {
      return this.cachedWorld;
    }

    const built = buildWorldGeometry(map, dynamicOverrides, openedChests, theme);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.staticBuf);
    gl.bufferData(gl.ARRAY_BUFFER, built.vertices, gl.STATIC_DRAW);
    this.cachedKey = cacheKey;
    this.cachedWorld = built;
    return built;
  }

  sampleGroundHeight(world, wx, wz) {
    const tx = Math.max(0, Math.min(world.W - 1, Math.floor(wx)));
    const ty = Math.max(0, Math.min(world.H - 1, Math.floor(wz)));
    return world.tileH[ty * world.W + tx];
  }

  bindWorldAttributes(buf) {
    const gl = this.gl;
    const stride = STRIDE_FLOATS * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(this.wLoc.aPos);
    gl.vertexAttribPointer(this.wLoc.aPos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.wLoc.aUV);
    gl.vertexAttribPointer(this.wLoc.aUV, 2, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(this.wLoc.aColor);
    gl.vertexAttribPointer(this.wLoc.aColor, 3, gl.FLOAT, false, stride, 20);
    gl.enableVertexAttribArray(this.wLoc.aTexInfo);
    gl.vertexAttribPointer(this.wLoc.aTexInfo, 3, gl.FLOAT, false, stride, 32);
    gl.enableVertexAttribArray(this.wLoc.aAnim);
    gl.vertexAttribPointer(this.wLoc.aAnim, 1, gl.FLOAT, false, stride, 44);
  }

  drawBillboardQuad(tex, cx, baseY, cz, width, height, flatGround = false) {
    const gl = this.gl;
    const hw = width * 0.5;
    const v = this.quadVerts;
    if (flatGround) {
      const y = baseY + 0.03;
      v[0]  = cx - hw; v[1]  = y; v[2]  = cz - hw; v[3]  = 0; v[4]  = 0;
      v[5]  = cx + hw; v[6]  = y; v[7]  = cz - hw; v[8]  = 1; v[9]  = 0;
      v[10] = cx + hw; v[11] = y; v[12] = cz + hw; v[13] = 1; v[14] = 1;
      v[15] = cx - hw; v[16] = y; v[17] = cz - hw; v[18] = 0; v[19] = 0;
      v[20] = cx + hw; v[21] = y; v[22] = cz + hw; v[23] = 1; v[24] = 1;
      v[25] = cx - hw; v[26] = y; v[27] = cz + hw; v[28] = 0; v[29] = 1;
    } else {
      v[0]  = cx - hw; v[1]  = baseY + height; v[2]  = cz; v[3]  = 0; v[4]  = 0;
      v[5]  = cx + hw; v[6]  = baseY + height; v[7]  = cz; v[8]  = 1; v[9]  = 0;
      v[10] = cx + hw; v[11] = baseY;          v[12] = cz; v[13] = 1; v[14] = 1;
      v[15] = cx - hw; v[16] = baseY + height; v[17] = cz; v[18] = 0; v[19] = 0;
      v[20] = cx + hw; v[21] = baseY;          v[22] = cz; v[23] = 1; v[24] = 1;
      v[25] = cx - hw; v[26] = baseY;          v[27] = cz; v[28] = 0; v[29] = 1;
    }

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.billboardBuf);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this.bLoc.aPos);
    gl.vertexAttribPointer(this.bLoc.aPos, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(this.bLoc.aUV);
    gl.vertexAttribPointer(this.bLoc.aUV, 2, gl.FLOAT, false, 20, 12);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  pickEntity(cx, cy) {
    let best = null;
    let bestDist = Infinity;
    for (const t of this.hitTargets) {
      const d = Math.hypot(t.sx - cx, t.sy - cy);
      if (d <= t.radius && d < bestDist) {
        bestDist = d;
        best = t.entity;
      }
    }
    return best;
  }

  render(engine, ctx, dynamicOverrides, completed, openedChests) {
    if (!this.available || this.contextLost || !this.gl || this.gl.isContextLost()) {
      return false;
    }
    const { map, hero, pip, save, time, canvas } = engine;
    const W = canvas.width;
    const H = canvas.height;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }

    const dt = this.lastRenderTime === null ? 0.016 : Math.max(0.001, Math.min(0.05, time - this.lastRenderTime));
    this.lastRenderTime = time;
    const safeTime = time % 628.31853;

    const theme = pickBiomeTheme(map);
    const world = this.ensureWorldBuilt(map, dynamicOverrides, openedChests, theme);

    // Smooth dt-scaled N64 3rd-person camera behind (+Z) and above (+Y) the Hero
    const heroY = this.sampleGroundHeight(world, hero.x, hero.y);
    const targetCamX = hero.x;
    const targetCamY = heroY + 4.9;
    const targetCamZ = hero.y + 6.8;
    const saveId = save?.id || save?.heroName || null;
    const farJump = Math.hypot(targetCamX - this.cam.x, targetCamZ - this.cam.z) > 6.5;

    if (!this.cam.init || this.cam.mapId !== map.id || this.cam.saveId !== saveId || farJump) {
      this.cam.x = targetCamX;
      this.cam.y = targetCamY;
      this.cam.z = targetCamZ;
      this.cam.init = true;
      this.cam.mapId = map.id;
      this.cam.saveId = saveId;
      this.heroYaw = typeof hero.facingAngle === 'number' ? hero.facingAngle : dirToYaw(hero.dir);
      this.pipYaw = typeof pip.facingAngle === 'number' ? pip.facingAngle : dirToYaw(pip.dir);
    } else {
      const kXZ = 1 - Math.exp(-10.5 * dt);
      const kY = 1 - Math.exp(-9.0 * dt);
      this.cam.x += (targetCamX - this.cam.x) * kXZ;
      this.cam.y += (targetCamY - this.cam.y) * kY;
      this.cam.z += (targetCamZ - this.cam.z) * kXZ;
    }

    const proj = mat4Perspective((46 * Math.PI) / 180, W / Math.max(1, H), 0.3, 60.0);
    const view = mat4LookAt(
      [this.cam.x, this.cam.y, this.cam.z],
      [this.cam.x, heroY + 0.65, this.cam.z - 8.2],
      [0, 1, 0]
    );
    const vp = mat4Multiply(proj, view);

    // 1. Draw N64 Sky, Drifting Clouds & Layered Low-Poly Mountains on 2D canvas
    drawN64SkyBackdrop(ctx, W, H, theme, this.cam.x, time);

    // 2. Render 3D World in WebGL (transparent background so sky shows cleanly!)
    const gl = this.gl;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    gl.useProgram(this.worldProg);
    gl.uniformMatrix4fv(this.wLoc.uVP, false, vp);
    gl.uniform1f(this.wLoc.uTime, safeTime);
    gl.uniform3fv(this.wLoc.uFogColor, theme.fogColor);
    gl.uniform1f(this.wLoc.uFogStart, theme.fogStart);
    gl.uniform1f(this.wLoc.uFogEnd, theme.fogEnd);
    gl.uniform3f(this.wLoc.uHeroPos, hero.x, heroY, hero.y);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.uniform1i(this.wLoc.uAtlas, 0);

    // Draw static terrain + 3D props
    this.bindWorldAttributes(this.staticBuf);
    gl.drawArrays(gl.TRIANGLES, 0, world.vertexCount);

    // Build & draw animated 3D props (flames, portals, floating shrine crystals)
    if (world.animProps.length > 0) {
      const dyn = new MeshBuilder();
      for (const p of world.animProps) {
        if (Math.abs(p.x - this.cam.x) > 18 || Math.abs(p.z - this.cam.z) > 26) continue;
        if (p.type === 'flame') {
          const flicker = 0.85 + 0.25 * Math.sin(time * 13 + p.x * 3.1 + p.z * 2.7);
          const s = p.scale * flicker;
          dyn.addCylinder(p.x, p.y, p.z, s, 0, s * 2.4, 4, TEX.FLAME, theme.sunDir, [1.2, 1.1, 0.9], [0.85, 0.75, 0.5], time * 3.2, [1.1, 1.1, 1.0], 3);
        } else if (p.type === 'shrine_crystal') {
          const bob = Math.sin(time * 3.2 + p.x) * 0.14;
          const rot = time * 1.6;
          dyn.addCylinder(p.x, p.y + bob, p.z, 0.2, 0, 0.36, 4, TEX.CRYSTAL, theme.sunDir, [1.2, 1.2, 1.3], [0.7, 0.7, 0.9], rot, [1.2, 1.2, 1.3], 3);
          dyn.addCylinder(p.x, p.y + bob - 0.28, p.z, 0.01, 0.2, 0.28, 4, TEX.CRYSTAL, theme.sunDir, [1.2, 1.2, 1.3], [0.6, 0.6, 0.8], rot, [1.1, 1.1, 1.2], 3, false);
        } else if (p.type === 'portal') {
          const pulse = 0.95 + 0.06 * Math.sin(time * 4.5);
          const hw = 0.34 * pulse;
          const hh = 0.56 * pulse;
          dyn.quad(
            [p.x - hw, p.y + hh, p.z, 0, 0, 1.1, 1.2, 1.3, TEX.PORTAL_VORTEX, TEX.PORTAL_VORTEX, 0, 3],
            [p.x + hw, p.y + hh, p.z, 1, 0, 1.1, 1.2, 1.3, TEX.PORTAL_VORTEX, TEX.PORTAL_VORTEX, 0, 3],
            [p.x + hw, p.y - hh, p.z, 1, 1, 1.0, 1.1, 1.3, TEX.PORTAL_VORTEX, TEX.PORTAL_VORTEX, 0, 3],
            [p.x - hw, p.y - hh, p.z, 0, 1, 1.0, 1.1, 1.3, TEX.PORTAL_VORTEX, TEX.PORTAL_VORTEX, 0, 3]
          );
        }
      }
      if (dyn.data.length > 0) {
        const arr = dyn.toFloat32Array();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamicBuf);
        gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STREAM_DRAW);
        this.bindWorldAttributes(this.dynamicBuf);
        gl.drawArrays(gl.TRIANGLES, 0, dyn.data.length / STRIDE_FLOATS);
      }
    }

    // Disable worldProg attribs before switching shaders
    gl.disableVertexAttribArray(this.wLoc.aPos);
    gl.disableVertexAttribArray(this.wLoc.aUV);
    gl.disableVertexAttribArray(this.wLoc.aColor);
    gl.disableVertexAttribArray(this.wLoc.aTexInfo);
    gl.disableVertexAttribArray(this.wLoc.aAnim);

    // 3. Ground Contact Shadows + True Low-Poly Gouraud-Shaded 3D Characters (Hero, Pip, NPCs, Dragons)
    gl.useProgram(this.billboardProg);
    gl.uniformMatrix4fv(this.bLoc.uVP, false, vp);
    gl.uniform3fv(this.bLoc.uFogColor, theme.fogColor);
    gl.uniform1f(this.bLoc.uFogStart, theme.fogStart);
    gl.uniform1f(this.bLoc.uFogEnd, theme.fogEnd);
    gl.uniform1i(this.bLoc.uTex, 0);
    gl.enable(gl.BLEND);
    // Preserve destination alpha=1.0 over opaque terrain so bright sky never bleeds through shadows!
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);

    const floatingMarkers = [];
    this.hitTargets = [];
    const charMesh = new CharMeshBuilder();

    // Smooth dt-scaled 360° yaw rotation toward continuous facing angle
    const targetHeroYaw = typeof hero.facingAngle === 'number' ? hero.facingAngle : dirToYaw(hero.dir);
    const targetPipYaw = typeof pip.facingAngle === 'number' ? pip.facingAngle : dirToYaw(pip.dir);
    this.heroYaw = lerpAngle(this.heroYaw, targetHeroYaw, 1 - Math.exp(-16 * dt));
    this.pipYaw = lerpAngle(this.pipYaw, targetPipYaw, 1 - Math.exp(-14 * dt));

    // NPCs, Vault Dragons, Interactive Hit Targets & Floating Markers
    for (const ent of map.entities || []) {
      if (Math.abs(ent.x - hero.x) > 16 || Math.abs(ent.y - hero.y) > 20) continue;
      const ex = ent.x + 0.5;
      const ez = ent.y + 0.5;
      const ey = this.sampleGroundHeight(world, ex, ez);
      const isSolved = ent.refId && completed.has(ent.refId);
      const isOpened = ent.type === 'chest' && openedChests.has(ent.id);

      // Record 3D-projected hit target for accurate click/tap interaction in 64-bit mode
      const hitP = projectPoint(vp, ex, ey + 0.7, ez, W, H);
      if (hitP && hitP.depth <= theme.fogEnd) {
        this.hitTargets.push({
          entity: ent,
          sx: hitP.sx,
          sy: hitP.sy,
          radius: Math.max(24, Math.min(64, hitP.scale * 0.55)),
        });
      }

      if (ent.type === 'npc') {
        this.drawBillboardQuad(this.shadowTex, ex, ey, ez, 0.78, 0.78, true);
        buildNpc3D(charMesh, ent.spriteKey, ex, ey, ez, safeTime);
      } else if (ent.type === 'vault') {
        // Perch Vault Dragon cleanly atop the stepped pedestal in front of the rear obelisk
        this.drawBillboardQuad(this.shadowTex, ex, ey + 0.28, ez + 0.14, 1.15, 1.15, true);
        buildNpc3D(charMesh, ent.spriteKey, ex, ey + 0.28, ez + 0.14, safeTime);
      }

      if (ent.type === 'trial' && !isSolved) {
        floatingMarkers.push({ kind: 'trial', x: ex, y: ey + 1.55, z: ez });
      } else if (ent.type === 'bonus_trial' && !isSolved) {
        floatingMarkers.push({ kind: 'bonus', x: ex, y: ey + 1.5, z: ez });
      } else if (ent.type === 'chest' && !isOpened) {
        floatingMarkers.push({ kind: 'chest', x: ex, y: ey + 0.95, z: ez });
      } else if (ent.type === 'easter_egg') {
        floatingMarkers.push({ kind: 'secret', x: ex, y: ey + 0.85, z: ez });
      }
    }

    // Pip shadow + 3D model
    const pipY = this.sampleGroundHeight(world, pip.x, pip.y);
    this.drawBillboardQuad(this.shadowTex, pip.x, pipY, pip.y, 0.58, 0.58, true);
    buildPip3D(charMesh, pip.x, pipY, pip.y, this.pipYaw, save.appearance, safeTime);

    // Hero shadow + 3D model
    this.drawBillboardQuad(this.shadowTex, hero.x, heroY, hero.y, 0.76, 0.76, true);
    buildHero3D(charMesh, hero.x, heroY, hero.y, this.heroYaw, save.appearance, hero.moving, safeTime);

    // Disable billboardProg attribs before switching shaders
    gl.disableVertexAttribArray(this.bLoc.aPos);
    gl.disableVertexAttribArray(this.bLoc.aUV);

    // Render all 3D character meshes in a single Z-buffered Gouraud-shaded WebGL pass!
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    if (charMesh.data.length > 0) {
      const charVerts = charMesh.toFloat32Array();
      gl.useProgram(this.charProg);
      gl.uniformMatrix4fv(this.cLoc.uVP, false, vp);
      gl.uniform3fv(this.cLoc.uSunDir, theme.sunDir);
      gl.uniform3fv(this.cLoc.uSunColor, theme.sunColor);
      gl.uniform3fv(this.cLoc.uAmbient, theme.ambient);
      gl.uniform3fv(this.cLoc.uFogColor, theme.fogColor);
      gl.uniform1f(this.cLoc.uFogStart, theme.fogStart);
      gl.uniform1f(this.cLoc.uFogEnd, theme.fogEnd);

      const stride = CHAR_STRIDE_FLOATS * 4;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.charBuf);
      gl.bufferData(gl.ARRAY_BUFFER, charVerts, gl.STREAM_DRAW);
      gl.enableVertexAttribArray(this.cLoc.aPos);
      gl.vertexAttribPointer(this.cLoc.aPos, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(this.cLoc.aNorm);
      gl.vertexAttribPointer(this.cLoc.aNorm, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(this.cLoc.aColor);
      gl.vertexAttribPointer(this.cLoc.aColor, 3, gl.FLOAT, false, stride, 24);
      gl.drawArrays(gl.TRIANGLES, 0, charMesh.data.length / CHAR_STRIDE_FLOATS);
      gl.disableVertexAttribArray(this.cLoc.aPos);
      gl.disableVertexAttribArray(this.cLoc.aNorm);
      gl.disableVertexAttribArray(this.cLoc.aColor);
    }

    // 4. Composite WebGL 3D scene onto the main 2D Canvas
    ctx.drawImage(this.canvas, 0, 0, W, H);

    // 5. Crisp 2D Quest / Trial Floating Markers projected into 3D space
    for (const m of floatingMarkers) {
      const bob = Math.sin(time * 5.5 + m.x) * 0.12;
      const p = projectPoint(vp, m.x, m.y + bob, m.z, W, H);
      if (!p || p.depth > theme.fogEnd) continue;
      const r = Math.max(7, Math.min(16, p.scale * 0.16));
      if (m.kind === 'trial') {
        ctx.fillStyle = '#facc15';
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#713f12';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#0f172a';
        ctx.font = `bold ${Math.max(10, Math.round(r * 1.25))}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', p.sx, p.sy + 1);
      } else if (m.kind === 'bonus') {
        ctx.fillStyle = '#c084fc';
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r * 0.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.max(9, Math.round(r * 1.1))}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('★', p.sx, p.sy + 1);
      } else if (m.kind === 'chest') {
        ctx.font = `${Math.max(12, Math.round(r * 1.25))}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('💎', p.sx, p.sy);
      } else if (m.kind === 'secret') {
        const pulse = 0.55 + 0.45 * Math.sin(time * 4.5 + m.x);
        ctx.fillStyle = `rgba(254, 240, 138, ${pulse.toFixed(2)})`;
        ctx.font = `bold ${Math.max(11, Math.round(r * 1.15))}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('✦', p.sx, p.sy);
      }
    }
    ctx.textBaseline = 'alphabetic';

    // 64-Bit N64 Era HUD stamp
    ctx.save();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.74)';
    ctx.fillRect(12, H - 34, 214, 22);
    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('64-BIT N64 TEXTURED 3D', 20, H - 19);
    ctx.restore();

    return true;
  }
}

let singleton = null;

export function pickN64Entity(cx, cy) {
  if (!singleton || !singleton.available) return null;
  return singleton.pickEntity(cx, cy);
}

export function renderN64WebGL(engine, ctx, dynamicOverrides, completed, openedChests) {
  try {
    if (!singleton) {
      singleton = new WebGLN64Renderer();
    }
    if (!singleton.available || singleton.contextLost) return false;
    return singleton.render(engine, ctx, dynamicOverrides, completed, openedChests);
  } catch (err) {
    console.warn('N64 WebGL renderer fell back to Canvas 2D:', err);
    if (singleton) singleton.available = false;
    return false;
  }
}
