import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQrMatrix, renderQrSvg } from './qr.js';

test('encodeQrMatrix produces valid finder, timing, and dark modules across versions', () => {
  const short = encodeQrMatrix('https://pyria.dev');
  assert.equal(short.version, 2);
  assert.equal(short.size, 25);

  // Top-left 7x7 finder pattern border & 3x3 center
  for (let i = 0; i < 7; i += 1) {
    assert.equal(short.modules[0][i], 1);
    assert.equal(short.modules[6][i], 1);
    assert.equal(short.modules[i][0], 1);
    assert.equal(short.modules[i][6], 1);
  }
  for (let r = 2; r <= 4; r += 1) {
    for (let c = 2; c <= 4; c += 1) {
      assert.equal(short.modules[r][c], 1);
    }
  }
  // White separator around top-left finder
  for (let i = 0; i < 8; i += 1) {
    assert.equal(short.modules[7][i], 0);
    assert.equal(short.modules[i][7], 0);
  }
  // Dark module at (4*V + 9, 8)
  assert.equal(short.modules[short.size - 8][8], 1);
  // Timing patterns on row 6 and col 6
  for (let i = 8; i < short.size - 8; i += 1) {
    assert.equal(short.modules[6][i], i % 2 === 0 ? 1 : 0);
    assert.equal(short.modules[i][6], i % 2 === 0 ? 1 : 0);
  }
});

test('encodeQrMatrix handles realistic signed parent-link URLs (version >= 7)', () => {
  const token = `${'A'.repeat(110)}.${'B'.repeat(43)}`;
  const url = `https://pyria.dev/console?link=${encodeURIComponent(token)}`;
  const qr = encodeQrMatrix(url);
  assert.ok(qr.version >= 7 && qr.version <= 14);
  assert.equal(qr.size, qr.version * 4 + 17);
  assert.equal(qr.modules.length, qr.size);
  assert.equal(qr.modules[0].length, qr.size);
});

test('renderQrSvg outputs crisp white-padded SVG and escapes aria-label', () => {
  const svg = renderQrSvg('https://pyria.dev/console?link=abc123', {
    size: 180,
    quietZone: 4,
    label: 'Scan <Parent> "Link"',
  });
  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.includes('fill="#ffffff"'));
  assert.ok(svg.includes('shape-rendering="crispEdges"'));
  assert.ok(svg.includes('aria-label="Scan &lt;Parent&gt; &quot;Link&quot;"'));
  assert.ok(svg.includes('<path d="M'));
});

test('encodeQrMatrix rejects empty or oversized input', () => {
  assert.throws(() => encodeQrMatrix(''), /non-empty/);
  assert.throws(() => encodeQrMatrix('x'.repeat(500)), /maximum supported length/);
});
