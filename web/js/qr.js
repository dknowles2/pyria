// Zero-dependency ISO/IEC 18004 QR Code generator (Byte mode, ECC Level M, Versions 1-14)
// Outputs crisp SVG with a white quiet zone for reliable scanning on dark UI themes.

const ECC_M_TABLE = [
  // [version, totalCodewords, ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data]
  null,
  [1, 26, 10, 1, 16, 0, 0],
  [2, 44, 16, 1, 28, 0, 0],
  [3, 70, 26, 1, 44, 0, 0],
  [4, 100, 18, 2, 32, 0, 0],
  [5, 134, 24, 2, 43, 0, 0],
  [6, 172, 16, 4, 27, 0, 0],
  [7, 196, 18, 4, 31, 0, 0],
  [8, 242, 22, 2, 38, 2, 39],
  [9, 292, 22, 3, 36, 2, 37],
  [10, 346, 26, 4, 43, 1, 44],
  [11, 404, 30, 1, 50, 4, 51],
  [12, 466, 22, 6, 36, 2, 37],
  [13, 532, 22, 8, 37, 1, 38],
  [14, 581, 24, 4, 40, 5, 41],
];

const ALIGNMENT_PATTERNS = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
];

// GF(256) tables with primitive polynomial 0x11D
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const rem = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ rem[0];
    for (let j = 0; j < ecCount - 1; j += 1) {
      rem[j] = rem[j + 1] ^ gfMul(gen[j + 1], factor);
    }
    rem[ecCount - 1] = gfMul(gen[ecCount], factor);
  }
  return rem;
}

function selectVersion(byteLen) {
  for (let v = 1; v < ECC_M_TABLE.length; v += 1) {
    const [, , , g1b, g1d, g2b, g2d] = ECC_M_TABLE[v];
    const dataCodewords = g1b * g1d + g2b * g2d;
    const countBits = v <= 9 ? 8 : 16;
    const maxBytes = Math.floor((dataCodewords * 8 - 4 - countBits) / 8);
    if (byteLen <= maxBytes) return v;
  }
  throw new Error('QR payload exceeds maximum supported length');
}

function buildCodewords(bytes, version) {
  const [, , ecPerBlock, g1b, g1d, g2b, g2d] = ECC_M_TABLE[version];
  const totalData = g1b * g1d + g2b * g2d;
  const countBits = version <= 9 ? 8 : 16;

  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i -= 1) {
      bits.push((val >>> i) & 1);
    }
  };

  // Byte mode indicator (0100)
  pushBits(0b0100, 4);
  pushBits(bytes.length, countBits);
  for (let i = 0; i < bytes.length; i += 1) {
    pushBits(bytes[i], 8);
  }

  // Terminator (up to 4 zero bits)
  const totalDataBits = totalData * 8;
  const termLen = Math.min(4, totalDataBits - bits.length);
  pushBits(0, termLen);

  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  const dataBytes = new Uint8Array(totalData);
  const writtenBytes = bits.length / 8;
  for (let i = 0; i < writtenBytes; i += 1) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) {
      b = (b << 1) | bits[i * 8 + j];
    }
    dataBytes[i] = b;
  }

  // Pad codewords 0xEC, 0x11 alternating
  const padCycle = [0xec, 0x11];
  for (let i = writtenBytes; i < totalData; i += 1) {
    dataBytes[i] = padCycle[(i - writtenBytes) % 2];
  }

  // Split into blocks and compute Reed-Solomon EC per block
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < g1b; i += 1) {
    const block = dataBytes.subarray(offset, offset + g1d);
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, ecPerBlock));
    offset += g1d;
  }
  for (let i = 0; i < g2b; i += 1) {
    const block = dataBytes.subarray(offset, offset + g2d);
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, ecPerBlock));
    offset += g2d;
  }

  // Interleave data codewords, then EC codewords
  const out = [];
  const maxDataLen = Math.max(g1d, g2d);
  for (let i = 0; i < maxDataLen; i += 1) {
    for (let b = 0; b < dataBlocks.length; b += 1) {
      if (i < dataBlocks[b].length) out.push(dataBlocks[b][i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (let b = 0; b < ecBlocks.length; b += 1) {
      out.push(ecBlocks[b][i]);
    }
  }
  return new Uint8Array(out);
}

function makeFunctionMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunc = (r, c, dark) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = dark ? 1 : 0;
    isFunc[r][c] = 1;
  };

  // Finder patterns + 1-module separators
  const drawFinder = (top, left) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunc(r, c, inOuter && (onBorder || inCore));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    setFunc(6, i, dark);
    setFunc(i, 6, dark);
  }

  // Alignment patterns
  const centers = ALIGNMENT_PATTERNS[version];
  for (let i = 0; i < centers.length; i += 1) {
    for (let j = 0; j < centers.length; j += 1) {
      const cr = centers[i];
      const cc = centers[j];
      // Skip corners overlapping finder patterns
      if ((i === 0 && j === 0) || (i === 0 && j === centers.length - 1) || (i === centers.length - 1 && j === 0)) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunc(cr + dr, cc + dc, dist !== 1);
        }
      }
    }
  }

  // Reserve format info areas
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setFunc(8, i, false);
      setFunc(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    setFunc(8, size - 1 - i, false);
  }
  for (let i = 0; i < 7; i += 1) {
    setFunc(size - 1 - i, 8, false);
  }
  // Dark module
  setFunc(size - 8, 8, true);

  // Version info (versions >= 7)
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const vBits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const bit = Boolean((vBits >>> i) & 1);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunc(a, b, bit);
      setFunc(b, a, bit);
    }
  }

  return { size, modules, isFunc };
}

function placeDataBits(modules, isFunc, codewords) {
  const size = modules.length;
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step;
      for (let dc = 0; dc < 2; dc += 1) {
        const c = right - dc;
        if (isFunc[r][c]) continue;
        let dark = 0;
        if (bitIdx < totalBits) {
          dark = (codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
          bitIdx += 1;
        }
        modules[r][c] = dark;
      }
    }
    upward = !upward;
  }
}

function maskBit(pattern, r, c) {
  switch (pattern) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

function drawFormatBits(modules, maskPattern) {
  // ECC Level M indicator = 00
  const data = (0b00 << 3) | (maskPattern & 7);
  let rem = data;
  for (let i = 0; i < 10; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;
  const size = modules.length;

  for (let i = 0; i <= 5; i += 1) modules[8][i] = (bits >>> (14 - i)) & 1;
  modules[8][7] = (bits >>> 8) & 1;
  modules[8][8] = (bits >>> 7) & 1;
  modules[7][8] = (bits >>> 6) & 1;
  for (let i = 0; i <= 5; i += 1) modules[5 - i][8] = (bits >>> (5 - i)) & 1;

  for (let i = 0; i < 8; i += 1) modules[8][size - 1 - i] = (bits >>> i) & 1;
  for (let i = 0; i < 7; i += 1) modules[size - 1 - i][8] = (bits >>> (14 - i)) & 1;
}

function computePenalty(modules) {
  const size = modules.length;
  let penalty = 0;

  // Rule 1: adjacent runs of 5+ same color
  for (let r = 0; r < size; r += 1) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < size; c += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }
  for (let c = 0; c < size; c += 1) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < size; r += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  // Rule 2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }

  // Rule 4: dark module balance
  let dark = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      dark += modules[r][c];
    }
  }
  const pct = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(pct - 50) / 5) * 10;

  return penalty;
}

/**
 * Encodes a UTF-8 string into a QR code boolean matrix (ECC Level M).
 * @param {string} text
 * @returns {{ version: number, size: number, modules: Uint8Array[] }}
 */
export function encodeQrMatrix(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('QR payload must be a non-empty string');
  }
  const bytes = new TextEncoder().encode(text);
  const version = selectVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);
  const { size, modules: baseModules, isFunc } = makeFunctionMatrix(version);
  placeDataBits(baseModules, isFunc, codewords);

  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestMatrix = null;

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = baseModules.map((row) => new Uint8Array(row));
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (!isFunc[r][c] && maskBit(mask, r, c)) {
          candidate[r][c] ^= 1;
        }
      }
    }
    drawFormatBits(candidate, mask);
    const p = computePenalty(candidate);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMask = mask;
      bestMatrix = candidate;
    }
  }

  return { version, size, mask: bestMask, modules: bestMatrix };
}

/**
 * Renders a QR code as a crisp inline SVG with a pure white quiet zone.
 * @param {string} text
 * @param {{ size?: number, quietZone?: number, label?: string }} [options]
 * @returns {string}
 */
export function renderQrSvg(text, { size = 180, quietZone = 4, label = 'QR Code' } = {}) {
  const { size: dim, modules } = encodeQrMatrix(text);
  const total = dim + quietZone * 2;
  const parts = [];
  for (let r = 0; r < dim; r += 1) {
    for (let c = 0; c < dim; c += 1) {
      if (modules[r][c]) {
        parts.push(`M${c + quietZone},${r + quietZone}h1v1h-1z`);
      }
    }
  }
  const safeLabel = String(label || 'QR Code')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const px = Math.max(96, Math.min(512, Math.round(Number(size) || 180)));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `width="${px}" height="${px}" role="img" aria-label="${safeLabel}" ` +
    `shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path d="${parts.join('')}" fill="#0b1020"/>` +
    `</svg>`
  );
}
