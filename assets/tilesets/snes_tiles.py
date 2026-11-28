#!/usr/bin/env python3
"""
Museum-Grade 16-Bit SNES (ALTTP / Chrono Trigger / Seiken Densetsu 3) Tileset Generator.

Core art-direction principles:
  1. Unified 5-stop hue-shifted SNES material ramps under an 11-o'clock top-left light source
     (cool indigo/teal/plum shadows, warm cream/ochre/gold highlights — zero Tailwind web hexes).
  2. Organic pixel-cluster rendering & selective outlining (sel-out) instead of raw ellipses/rects.
  3. True 3/4 top-down RPG perspective (35-40% top plane, 60-65% front face) on props & walls.
  4. Seamless 64x64 world-space floor textures sliced into 4 variants (_v0.._v3) to kill
     wallpaper repetition on 1,000-2,700 tile R3-R16 maps.
  5. N/S/E/W wall autotile sets (_top, _mid, front face, sparse _accent) for stone, ice, obsidian.
"""

from __future__ import annotations

import math
from typing import Callable, Dict, List, Tuple

RGBA = Tuple[int, int, int, int]
TRANSPARENT: RGBA = (0, 0, 0, 0)


def hx(h: str, a: int = 255) -> RGBA:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


# ---------------------------------------------------------------------------
# Hue-Shifted 5-Stop SNES Material Ramps (0=Outline/Deep, 1=Shadow, 2=Mid, 3=Lit, 4=Specular)
# ---------------------------------------------------------------------------
RAMP = {
    "grass":    (hx("#143029"), hx("#1E5C35"), hx("#3C8D3B"), hx("#70BD3F"), hx("#ACD954")),
    "stone":    (hx("#1C2038"), hx("#39415E"), hx("#636E82"), hx("#949BA3"), hx("#CCC7B6")),
    "marble":   (hx("#252B42"), hx("#505A78"), hx("#8792A8"), hx("#C2C7D1"), hx("#F2EFE4")),
    "brass":    (hx("#2E1414"), hx("#6E301B"), hx("#B36320"), hx("#DE9E32"), hx("#FCE494")),
    "steel":    (hx("#151829"), hx("#2F354F"), hx("#55607D"), hx("#8793AB"), hx("#C7CFE0")),
    "ice":      (hx("#10244D"), hx("#1B5891"), hx("#3B97C9"), hx("#8FD4F0"), hx("#E6FAFF")),
    "obsidian": (hx("#120C21"), hx("#261C40"), hx("#3F3461"), hx("#635785"), hx("#958AB5")),
    "basalt":   (hx("#18101E"), hx("#2C1C29"), hx("#452C36"), hx("#63414A"), hx("#8A6268")),
    "magma":    (hx("#75141E"), hx("#B82520"), hx("#EB5D17"), hx("#FAD03C"), hx("#FFF7B8")),
    "sand":     (hx("#4D2F23"), hx("#855537"), hx("#BA8352"), hx("#DDA96F"), hx("#F7D79C")),
    "earth":    (hx("#36201D"), hx("#633D2B"), hx("#966341"), hx("#C28C5C"), hx("#E6BD8A")),
    "water":    (hx("#103263"), hx("#185794"), hx("#2682BD"), hx("#5CB8DE"), hx("#CBEFF7")),
    "wood":     (hx("#291614"), hx("#572E20"), hx("#874D2E"), hx("#B87846"), hx("#E3AF74")),
    "coral_r":  (hx("#3D112B"), hx("#8C1F47"), hx("#D9486E"), hx("#F5899A"), hx("#FFD2CC")),
    "coral_t":  (hx("#0D3338"), hx("#166B6B"), hx("#29A89B"), hx("#6AD9BE"), hx("#C7FAEA")),
    "cloud":    (hx("#4E6A99"), hx("#86A8D4"), hx("#C4DEF2"), hx("#EBF5FC"), hx("#FFFDF5")),
    "astral":   (hx("#090C1C"), hx("#141936"), hx("#242B57"), hx("#49548F"), hx("#A6B4F0")),
    "rune_v":   (hx("#28104A"), hx("#5E249E"), hx("#9E4CE0"), hx("#D98FFF"), hx("#FCE8FF")),
    "rune_c":   (hx("#0E2A4D"), hx("#1A669E"), hx("#32B3DE"), hx("#8CE8FF"), hx("#F0FDFF")),
}

# Floors that get 4 seamless 32x32 variants sliced from a 64x64 world-space canvas
VARIANT_FLOOR_IDS = [
    "grass",
    "dirt_path",
    "sand",
    "water",
    "stone_floor",
    "brass_floor",
    "obsidian_floor",
    "ice_floor",
    "lava",
    "cloud_floor",
    "star_tile",
]

# Walls that get N/S/E/W autotile sub-tiles (_top, _mid, _accent)
AUTOTILE_WALL_IDS = [
    "stone_wall",
    "ice_wall",
    "obsidian_wall",
]


# ---------------------------------------------------------------------------
# Deterministic Tileable Noise & Cluster Helpers (Zero external deps)
# ---------------------------------------------------------------------------
def _h2(ix: int, iy: int, seed: int = 0) -> float:
    n = (ix * 374761393 + iy * 668265263 + seed * 1442695041) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 0xFFFF) / 65535.0


def tileable_value_noise(x: float, y: float, period: int, seed: int = 0) -> float:
    x0 = int(math.floor(x))
    y0 = int(math.floor(y))
    fx = x - x0
    fy = y - y0
    # Smoothstep
    u = fx * fx * (3.0 - 2.0 * fx)
    v = fy * fy * (3.0 - 2.0 * fy)
    ix0 = x0 % period
    iy0 = y0 % period
    ix1 = (ix0 + 1) % period
    iy1 = (iy0 + 1) % period
    a = _h2(ix0, iy0, seed)
    b = _h2(ix1, iy0, seed)
    c = _h2(ix0, iy1, seed)
    d = _h2(ix1, iy1, seed)
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v


def fbm_tileable(x: float, y: float, base_period: int = 8, seed: int = 0) -> float:
    v1 = tileable_value_noise(x / (64.0 / base_period), y / (64.0 / base_period), base_period, seed)
    v2 = tileable_value_noise(x / (64.0 / (base_period * 2)), y / (64.0 / (base_period * 2)), base_period * 2, seed + 17)
    return v1 * 0.65 + v2 * 0.35


def slice_64_to_4(canvas_cls, big) -> List:
    """Slice a seamless 64x64 Canvas into 4 32x32 Canvas variants [v0, v1, v2, v3]."""
    out = []
    for gy in (0, 32):
        for gx in (0, 32):
            sub = canvas_cls(32, 32, TRANSPARENT)
            for y in range(32):
                for x in range(32):
                    sub.set(x, y, big.get(gx + x, gy + y))
            out.append(sub)
    return out


def paint_cluster(c, cx: int, cy: int, pattern: List[str], pal: Dict[str, RGBA], wrap: bool = False) -> None:
    """Stamp a small organic pixel-cluster matrix centered on (cx, cy)."""
    ph = len(pattern)
    pw = len(pattern[0])
    ox = cx - pw // 2
    oy = cy - ph // 2
    for y, row in enumerate(pattern):
        for x, ch in enumerate(row):
            if ch in (".", " "):
                continue
            tx = (ox + x) % c.w if wrap else ox + x
            ty = (oy + y) % c.h if wrap else oy + y
            c.set(tx, ty, pal[ch])


def apply_sel_out(c, out_dk: RGBA, out_lt: RGBA) -> None:
    """Add 1px selective outline (warm/midtone on top-left rim, cool deep shadow on bottom-right)."""
    orig = c.copy()
    for y in range(c.h):
        for x in range(c.w):
            if orig.get(x, y)[3] > 0:
                continue
            has_n = orig.get(x, y - 1)[3] > 0
            has_s = orig.get(x, y + 1)[3] > 0
            has_w = orig.get(x - 1, y)[3] > 0
            has_e = orig.get(x + 1, y)[3] > 0
            if not (has_n or has_s or has_w or has_e):
                continue
            # Top-left sunlit rim gets lighter outline; bottom-right shadow rim gets deep outline
            if (has_s or has_e) and not (has_n or has_w):
                c.set(x, y, out_lt)
            else:
                c.set(x, y, out_dk)


# ---------------------------------------------------------------------------
# 64x64 Seamless 4-Variant Floor Generators
# ---------------------------------------------------------------------------
def _make_grass_64(canvas_cls):
    g0, g1, g2, g3, g4 = RAMP["grass"]
    c = canvas_cls(64, 64, g2)
    # Soft organic sunlit meadow dapples via tileable fBM
    for y in range(64):
        for x in range(64):
            n = fbm_tileable(x, y, 8, seed=11)
            if n > 0.64:
                c.set(x, y, g3)
            elif n < 0.34:
                c.set(x, y, g1)
    # Organic hand-pixelled clover & grass-blade clusters (varied across 64x64)
    tuft_a = [
        ".H..H.",
        "HL.LH.",
        ".DDDD.",
    ]
    tuft_b = [
        "..H..",
        "H.L.L",
        ".DDD.",
    ]
    pal = {"H": g4, "L": g3, "D": g1}
    spots = [
        (6, 8, tuft_a), (22, 5, tuft_b), (38, 12, tuft_a), (55, 7, tuft_b),
        (13, 23, tuft_b), (28, 27, tuft_a), (47, 25, tuft_b), (59, 21, tuft_a),
        (5, 39, tuft_b), (19, 44, tuft_a), (35, 37, tuft_b), (51, 42, tuft_a),
        (11, 57, tuft_a), (27, 54, tuft_b), (42, 58, tuft_a), (58, 55, tuft_b),
    ]
    for sx, sy, pat in spots:
        paint_cluster(c, sx, sy, pat, pal, wrap=True)
    return c


def _make_dirt_64(canvas_cls):
    e0, e1, e2, e3, e4 = RAMP["earth"]
    c = canvas_cls(64, 64, e2)
    for y in range(64):
        for x in range(64):
            n = fbm_tileable(x, y, 8, seed=23)
            if n > 0.62:
                c.set(x, y, e3)
            elif n < 0.35:
                c.set(x, y, e1)
    # Sparse smooth pebbles & subtle compacted earth marks
    peb = [
        ".HL.",
        "LDD.",
    ]
    pal = {"H": e4, "L": e3, "D": e1}
    for sx, sy in ((8, 10), (26, 7), (44, 15), (57, 26), (16, 36), (37, 42), (52, 51), (11, 56), (29, 59)):
        paint_cluster(c, sx, sy, peb, pal, wrap=True)
    return c


def _make_sand_64(canvas_cls):
    s0, s1, s2, s3, s4 = RAMP["sand"]
    c = canvas_cls(64, 64, s2)
    # Organic tapering wind-rippled dunes (curved S-waves with noise break-up, zero cardboard stripes)
    for y in range(64):
        for x in range(64):
            warp = fbm_tileable(x, y, 4, seed=31) * 5.0
            wave = math.sin((y + warp) * (2 * math.pi / 16.0) + math.sin(x * (2 * math.pi / 64.0)) * 1.4)
            mask = fbm_tileable(x, y, 8, seed=37)
            if wave > 0.45 and mask > 0.35:
                c.set(x, y, s3 if wave < 0.78 else s4)
            elif wave < -0.52 and mask > 0.38:
                c.set(x, y, s1)
    # Two tiny pearlescent seashells across the 64x64 expanse
    shell = [
        ".H.",
        "HLD",
    ]
    paint_cluster(c, 19, 22, shell, {"H": hx("#FFF7E6"), "L": s4, "D": s1}, wrap=True)
    paint_cluster(c, 51, 47, shell, {"H": hx("#FFF7E6"), "L": s3, "D": s1}, wrap=True)
    return c


def _make_water_64(canvas_cls):
    w0, w1, w2, w3, w4 = RAMP["water"]
    c = canvas_cls(64, 64, w2)
    # Organic layered lagoon depth & caustic eddies (exact integer period=8 -> 0px wrap seam!)
    for y in range(64):
        for x in range(64):
            n = fbm_tileable(x, y, 8, seed=41)
            if n < 0.38:
                c.set(x, y, w1)
            elif n > 0.67:
                c.set(x, y, w3)
    # Staggered delicate curved SNES wavelets
    wave_pat = [
        "..HHH..",
        ".LLLLL.",
        "DD...DD",
    ]
    pal = {"H": w4, "L": w3, "D": w1}
    for sx, sy in ((9, 9), (37, 6), (55, 19), (22, 26), (46, 36), (11, 44), (31, 53), (57, 58)):
        paint_cluster(c, sx, sy, wave_pat, pal, wrap=True)
    return c


def _make_stone_floor_64(canvas_cls):
    s0, s1, s2, s3, s4 = RAMP["stone"]
    g1, g2, g3 = RAMP["grass"][1], RAMP["grass"][2], RAMP["grass"][3]
    c = canvas_cls(64, 64, s2)
    # Irregular weathered flagstone courses (varied widths, soft sel-out mortar, zero grid wallpaper)
    courses = [
        (0, 16, [(0, 18), (18, 14), (32, 20), (52, 12)]),
        (16, 16, [(0, 11), (11, 21), (32, 15), (47, 17)]),
        (32, 16, [(0, 22), (22, 16), (38, 12), (50, 14)]),
        (48, 16, [(0, 15), (15, 17), (32, 19), (51, 13)]),
    ]
    for cy, ch, segs in courses:
        for idx, (sx, sw) in enumerate(segs):
            # Subtle per-stone value & surface grain
            stone_col = s2 if (idx + cy) % 3 != 0 else s3
            for y in range(cy, cy + ch):
                for x in range(sx, sx + sw):
                    n = fbm_tileable(x, y, 16, seed=53)
                    col = stone_col
                    if n < 0.32:
                        col = s1
                    elif n > 0.72:
                        col = s3
                    c.set(x, y, col)
            # Soft 1px recessed mortar (cool indigo-slate, broken slightly at corners)
            c.rect(sx, cy, sw, 1, s0)
            c.rect(sx, cy, 1, ch, s0)
            # Warm sunlit 1px inner top/left rim (never harsh 2px bars)
            if sw > 3:
                c.rect(sx + 2, cy + 1, sw - 3, 1, s4 if stone_col == s3 else s3)
            if ch > 3:
                c.rect(sx + 1, cy + 2, 1, ch - 3, s3)
            # Subtle bottom-right shadow
            c.rect(sx + 1, cy + ch - 1, sw - 1, 1, s1)
    # Sparse hairline cracks & subtle moss tucked into only 2 crevices across 64x64
    for cx, cy in ((18, 16), (47, 32)):
        paint_cluster(c, cx, cy, [".L.", "DML", ".D."], {"L": g3, "M": g2, "D": g1}, wrap=True)
    for x0, y0 in ((24, 6), (25, 7), (26, 7), (41, 40), (42, 41), (42, 42)):
        c.set(x0, y0, s0)
    return c


def _make_brass_floor_64(canvas_cls):
    b0, b1, b2, b3, b4 = RAMP["brass"]
    c = canvas_cls(64, 64, b2)
    # Large staggered clockwork bronze deck plates wrapped cleanly across x=64 (zero vent spam!)
    plates = [
        (0, 0, 32, 22), (32, 0, 32, 22),
        (16, 22, 32, 20), (48, 22, 32, 20),
        (0, 42, 32, 22), (32, 42, 32, 22),
    ]
    for px, py, pw, ph in plates:
        for dy in range(ph):
            y = (py + dy) % 64
            for dx in range(pw):
                x = (px + dx) % 64
                n = fbm_tileable(x, y, 8, seed=67)
                col = b2
                if n > 0.66:
                    col = b3
                elif n < 0.30:
                    col = b1
                c.set(x, y, col)
        # Clean 1px wrapped plate seam + warm top-left chamfer
        for dx in range(pw):
            c.set((px + dx) % 64, py % 64, b0)
            c.set((px + dx) % 64, (py + ph - 1) % 64, b1)
            if 1 <= dx < pw - 1:
                c.set((px + dx) % 64, (py + 1) % 64, b3)
        for dy in range(ph):
            c.set(px % 64, (py + dy) % 64, b0)
            if 1 <= dy < ph - 1:
                c.set((px + 1) % 64, (py + dy) % 64, b3)
        # Muted aged rivets at plate corners
        for rx_off, ry_off in ((3, 3), (pw - 4, 3), (3, ph - 4), (pw - 4, ph - 4)):
            rx, ry = (px + rx_off) % 64, (py + ry_off) % 64
            c.set(rx, ry, b4)
            c.set((rx + 1) % 64, (ry + 1) % 64, b0)
    return c


def _make_obsidian_floor_64(canvas_cls):
    o0, o1, o2, o3, o4 = RAMP["obsidian"]
    rv2, rv3 = RAMP["rune_v"][2], RAMP["rune_v"][3]
    c = canvas_cls(64, 64, o1)
    # Irregular dark volcanic glass-basalt flagstones with cool plum-indigo sheen
    slabs = [
        (0, 0, 22, 18), (22, 0, 20, 18), (42, 0, 22, 18),
        (0, 18, 14, 22), (14, 18, 26, 22), (40, 18, 24, 22),
        (0, 40, 28, 24), (28, 40, 18, 24), (46, 40, 18, 24),
    ]
    for sx, sy, sw, sh in slabs:
        for y in range(sy, sy + sh):
            for x in range(sx, sx + sw):
                n = fbm_tileable(x, y, 8, seed=79)
                c.set(x, y, o2 if n > 0.45 else o1)
        c.rect(sx, sy, sw, 1, o0)
        c.rect(sx, sy, 1, sh, o0)
        # Subtle glassy top-left bevel
        c.rect(sx + 1, sy + 1, sw - 2, 1, o3)
        c.rect(sx + 1, sy + 1, 1, sh - 2, o3)
        c.set(sx + 2, sy + 2, o4)
    # Sparse glassy fracture + 1 subtle amethyst vein across the entire 64x64
    for fx, fy in ((24, 25), (25, 26), (26, 26), (27, 27), (28, 28)):
        c.set(fx, fy, o0)
    c.set(25, 25, rv2); c.set(26, 27, rv3)
    return c


def _make_ice_floor_64(canvas_cls):
    i0, i1, i2, i3, i4 = RAMP["ice"]
    i_soft = hx("#63B8E0")  # gentle translucent mid-ice between i2 and i3
    c = canvas_cls(64, 64, i3)
    # Soft translucent subsurface glacial depth shifts (zero harsh puddle blobs or diagonal stripes!)
    for y in range(64):
        for x in range(64):
            n = fbm_tileable(x, y, 6, seed=89)
            if n < 0.34:
                c.set(x, y, i_soft)
            elif n > 0.66:
                c.set(x, y, i4)
    # Organic branching hairline frost fractures (subtle i2 + i4 shimmer, zero straight needles)
    cracks = [
        [(9, 10), (10, 10), (11, 11), (13, 11), (14, 12), (14, 13), (12, 12), (11, 13)],
        [(43, 18), (42, 19), (42, 20), (40, 21), (39, 21), (41, 22), (41, 23)],
        [(20, 45), (21, 45), (22, 46), (24, 46), (25, 45), (23, 47)],
    ]
    for path in cracks:
        for cx, cy in path:
            c.set(cx, cy, i2)
            c.set((cx + 1) % 64, cy, i4)
    return c


def _make_lava_64(canvas_cls):
    ba0, ba1, ba2, ba3, _ = RAMP["basalt"]
    m0, m1, m2, m3, m4 = RAMP["magma"]
    c = canvas_cls(64, 64, m2)
    # Tileable Voronoi/cellular basalt crust islands floating over glowing convective magma veins!
    # 12 organic cell centers in [0, 64)
    pts = [
        (8, 9), (26, 6), (48, 10), (60, 22),
        (16, 25), (37, 23), (53, 36), (6, 41),
        (24, 44), (41, 49), (58, 56), (14, 58),
    ]
    for y in range(64):
        for x in range(64):
            # Subtle organic domain warp so crust edges look molten, not polygonal
            wx = x + (fbm_tileable(x, y, 8, seed=97) - 0.5) * 4.5
            wy = y + (fbm_tileable(x, y, 8, seed=103) - 0.5) * 4.5
            d1 = 1e9
            d2 = 1e9
            for px, py in pts:
                dx = abs(wx - px)
                if dx > 32:
                    dx = 64 - dx
                dy = abs(wy - py)
                if dy > 32:
                    dy = 64 - dy
                d = math.hypot(dx, dy)
                if d < d1:
                    d2 = d1
                    d1 = d
                elif d < d2:
                    d2 = d
            edge = d2 - d1
            if edge < 1.3:
                c.set(x, y, m4 if edge < 0.55 else m3)
            elif edge < 2.6:
                c.set(x, y, m2)
            elif edge < 3.7:
                c.set(x, y, m1)
            elif edge < 4.7:
                c.set(x, y, m0)
            else:
                # Cooled dark basalt crust plate with subtle top-left bevel
                c.set(x, y, ba2 if edge < 6.4 else (ba1 if (x + y) % 5 != 0 else ba0))
    return c


def _make_cloud_64(canvas_cls):
    c0, c1, c2, c3, c4 = RAMP["cloud"]
    c = canvas_cls(64, 64, c2)
    # Volumetric 3/4 billowy cumulus puffs (warm cream tops, cool periwinkle undersides)
    for y in range(64):
        for x in range(64):
            n = fbm_tileable(x, y, 6, seed=113)
            n_up = fbm_tileable(x, (y - 3) % 64, 6, seed=113)
            if n > 0.62:
                c.set(x, y, c4 if n > 0.74 else c3)
            elif n < 0.36:
                c.set(x, y, c0 if n < 0.25 else c1)
            elif n - n_up > 0.08:
                c.set(x, y, c3)
            elif n_up - n > 0.08:
                c.set(x, y, c1)
    return c


def _make_star_64(canvas_cls):
    a0, a1, a2, a3, a4 = RAMP["astral"]
    c = canvas_cls(64, 64, a0)
    # Deep organic cosmic indigo-violet nebula wisps (zero repeating diamond plaid!)
    for y in range(64):
        for x in range(64):
            n = fbm_tileable(x, y, 4, seed=127)
            if n > 0.64:
                c.set(x, y, a2)
            elif n > 0.48:
                c.set(x, y, a1)
    # Fine varied 1px star dust
    for i in range(28):
        sx = int(_h2(i, 1, 131) * 64) % 64
        sy = int(_h2(i, 2, 131) * 64) % 64
        c.set(sx, sy, a4 if i % 3 == 0 else a3)
    # Just 3 delicate 4-point twinkles across the full 64x64
    for sx, sy, core, halo in (
        (14, 12, hx("#FFF7D6"), hx("#DE9E32")),
        (46, 27, hx("#E6FAFF"), hx("#5CB8DE")),
        (26, 51, hx("#FCE8FF"), hx("#9E4CE0")),
    ):
        c.set(sx, sy, core)
        for ox, oy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            c.set((sx + ox) % 64, (sy + oy) % 64, halo)
    return c


# ---------------------------------------------------------------------------
# N/S/E/W Autotiled Wall Sets (front face, _top cap, _mid interior roof, sparse _accent)
# ---------------------------------------------------------------------------
def _build_stone_walls(canvas_cls) -> Dict[str, object]:
    s0, s1, s2, s3, s4 = RAMP["stone"]
    g1, g2, g3, g4 = RAMP["grass"][1], RAMP["grass"][2], RAMP["grass"][3], RAMP["grass"][4]

    # Front masonry cliff face (irregular weathered boulders, cohesive roof transition at y=0..5)
    front = canvas_cls(32, 32, s0)
    for y in range(6):
        for x in range(32):
            n = fbm_tileable(x * 2, y * 2, 8, seed=141)
            front.set(x, y, s3 if (y == 0 or n > 0.56) else s2)
    front.rect(0, 5, 32, 1, s0)
    rows = [
        (6, 8, [(0, 10), (10, 13), (23, 9)]),
        (14, 9, [(0, 6), (6, 14), (20, 12)]),
        (23, 8, [(0, 12), (12, 11), (23, 9)]),
    ]
    for ry, rh, segs in rows:
        for sx, sw in segs:
            front.rect(sx + 1, ry + 1, sw - 2, rh - 2, s2)
            front.rect(sx + 2, ry + 1, max(1, sw - 4), 2, s3)
            front.set(sx + 2, ry + 1, s4)
            front.rect(sx + 1, ry + rh - 2, sw - 2, 1, s1)
            front.rect(sx + sw - 2, ry + 2, 1, rh - 3, s1)
            front.set(sx + 1, ry + 1, s1)
            front.set(sx + sw - 2, ry + 1, s1)
    front.rect(0, 31, 32, 1, s0)

    # Interior wall roof (unified value with _top so multi-row walls read as one solid stone mass)
    mid = canvas_cls(32, 32, s2)
    for y in range(32):
        for x in range(32):
            n = fbm_tileable(x * 2, y * 2, 8, seed=151)
            mid.set(x, y, s3 if n > 0.68 else (s1 if n < 0.34 else s2))

    # Top cap (same stone roof plane as _mid, with sunlit carved north parapet rim — no indoor lime bar!)
    top = mid.copy()
    top.rect(0, 0, 32, 2, s0)
    top.rect(0, 2, 32, 2, s4)
    top.rect(0, 4, 32, 1, s3)

    # Sparse front-face accent with hanging ivy vine (used 1-in-6 tiles)
    accent = front.copy()
    for vx, vl in ((7, 12), (9, 9), (22, 11)):
        for dy in range(vl):
            accent.set(vx, 4 + dy, g4 if dy < 2 else (g3 if dy < vl - 3 else g1))
            if dy < vl - 2:
                accent.set(vx + 1, 4 + dy, g2)

    return {"stone_wall": front, "stone_wall_top": top, "stone_wall_mid": mid, "stone_wall_accent": accent}


def _build_ice_walls(canvas_cls) -> Dict[str, object]:
    i0, i1, i2, i3, i4 = RAMP["ice"]

    # Solid continuous translucent glacier cliff wall (exact 32px periodic wrap -> ZERO seam!)
    front = canvas_cls(32, 32, i1)
    for x in range(32):
        ridge_bot = 5 + int(math.sin(x * (2 * math.pi / 32.0)) * 1.5)
        for y in range(ridge_bot):
            front.set(x, y, i4 if y < ridge_bot - 1 else i3)
        front.set(x, ridge_bot, i2)
    for y in range(6, 32):
        for x in range(32):
            if front.get(x, y) in (i4, i3) and y < 7:
                continue
            # Exact 32px periodic crystalline cliff facets (period 8 & 16 divide 32 cleanly)
            facet = ((x + (y // 4) * 2) // 8) % 2
            n = fbm_tileable(x * 2, y * 2, 8, seed=163)
            if facet == 0:
                col = i3 if n > 0.56 else i2
            else:
                col = i2 if n > 0.52 else i1
            front.set(x, y, col)
    # Soft crystalline glint dots along top cliff edge
    for gx, gy in ((6, 9), (15, 13), (24, 10), (11, 21), (22, 23)):
        front.set(gx, gy, i4); front.set(gx, gy + 1, i3)
    front.rect(0, 30, 32, 2, i0)

    # Unified snow-packed glacier roof (_mid & _top match in value -> zero zebra stripes!)
    mid = canvas_cls(32, 32, i3)
    for y in range(32):
        for x in range(32):
            n = fbm_tileable(x * 2, y * 2, 8, seed=173)
            mid.set(x, y, i4 if n > 0.58 else (i2 if n < 0.25 else i3))

    top = mid.copy()
    top.rect(0, 0, 32, 2, i1)
    top.rect(0, 2, 32, 2, i4)

    # Sparse dark-outlined icicle cluster accent on front face
    accent = front.copy()
    for ix, ilen in ((10, 9), (15, 12), (20, 8)):
        for dy in range(ilen):
            accent.set(ix - 1, 6 + dy, i0)
            accent.set(ix + 1, 6 + dy, i1)
            accent.set(ix, 6 + dy, i4 if dy < ilen - 3 else i3)
        accent.set(ix, 6 + ilen, i0)

    return {"ice_wall": front, "ice_wall_top": top, "ice_wall_mid": mid, "ice_wall_accent": accent}


def _build_obsidian_walls(canvas_cls) -> Dict[str, object]:
    o0, o1, o2, o3, o4 = RAMP["obsidian"]
    rv1, rv2, rv3, rv4 = RAMP["rune_v"][1], RAMP["rune_v"][2], RAMP["rune_v"][3], RAMP["rune_v"][4]

    # Clean chiseled dark volcanic ashlar (cohesive top lip -> no harsh bright o4 bar)
    front = canvas_cls(32, 32, o0)
    front.rect(0, 0, 32, 5, o2)
    front.rect(0, 0, 32, 1, o3)
    front.rect(0, 5, 32, 1, o0)
    for ry, rh, segs in ((6, 8, [(0, 12), (12, 10), (22, 10)]), (14, 9, [(0, 7), (7, 15), (22, 10)]), (23, 8, [(0, 14), (14, 18)])):
        for sx, sw in segs:
            front.rect(sx + 1, ry + 1, sw - 2, rh - 2, o2)
            front.rect(sx + 1, ry + 1, sw - 2, 1, o3)
            front.rect(sx + 1, ry + rh - 2, sw - 2, 1, o1)
    front.rect(0, 31, 32, 1, o0)

    # Unified obsidian roof mass (_mid & _top match in value)
    mid = canvas_cls(32, 32, o2)
    for y in range(32):
        for x in range(32):
            n = fbm_tileable(x * 2, y * 2, 8, seed=191)
            mid.set(x, y, o3 if n > 0.72 else (o1 if n < 0.34 else o2))

    top = mid.copy()
    top.rect(0, 0, 32, 2, o0)
    top.rect(0, 2, 32, 2, o4)

    # Sparse carved geometric diamond-crystal rune (zero stick-figure!)
    accent = front.copy()
    accent.rect(11, 11, 10, 10, o0)
    accent.rect(12, 12, 8, 8, rv1)
    # Clean diamond shard sigil
    diamond = [
        "...WW...",
        "..WQQW..",
        ".WQQQQW.",
        "..WQQW..",
        "...WW...",
    ]
    paint_cluster(accent, 16, 16, diamond, {"W": rv3, "Q": rv4})
    accent.set(16, 16, rv2)

    return {"obsidian_wall": front, "obsidian_wall_top": top, "obsidian_wall_mid": mid, "obsidian_wall_accent": accent}


# ---------------------------------------------------------------------------
# Hand-Pixelled 3/4 RPG Props & Foliage (Organic Pixel Clusters, Zero Primitives)
# ---------------------------------------------------------------------------
def _build_snes_tree(canvas_cls):
    g0, g1, g2, g3, g4 = RAMP["grass"]
    w0, w1, w2, w3, w4 = RAMP["wood"]
    c = canvas_cls(32, 32, TRANSPARENT)

    # Gnarled rooted bark trunk (3/4 flare at base)
    trunk = [
        "...WWWWWW...",
        "...WLLMDW...",
        "...WLLMDW...",
        "...WLMMDW...",
        "..WWLMMDWW..",
        ".WWLMMDMDDW.",
        ".WLLDWWDDDW.",
        "..WW....WW..",
    ]
    paint_cluster(c, 16, 26, trunk, {"W": w0, "L": w3, "M": w2, "D": w1})

    # Lush jagged organic leaf clusters (ALTTP style — layered back-to-front, zero balloon ellipses!)
    leaf_puff_dk = [
        "..DDDD..",
        ".DDDDDD.",
        "DDDDDDDD",
        ".DDDDDD.",
        "..DDDD..",
    ]
    leaf_puff_md = [
        "..MMMM..",
        ".MMLLMM.",
        "MMLLLLMM",
        ".MMMMMM.",
        "..DDDD..",
    ]
    leaf_puff_hi = [
        "..HHHH..",
        ".HHLLHH.",
        "HLLLLLLM",
        ".LLMMMM.",
    ]
    pal = {"D": g1, "M": g2, "L": g3, "H": g4}
    # Deep shadowed lower canopy skirt
    for cx, cy in ((8, 17), (15, 18), (23, 17), (12, 19), (20, 19)):
        paint_cluster(c, cx, cy, leaf_puff_dk, pal)
    # Lush mid-canopy irregular boughs
    for cx, cy in ((7, 13), (13, 14), (20, 14), (24, 13), (11, 10), (19, 10), (15, 7)):
        paint_cluster(c, cx, cy, leaf_puff_md, pal)
    # Sunlit 11-o'clock crown clusters
    for cx, cy in ((13, 6), (8, 10), (18, 9), (12, 12)):
        paint_cluster(c, cx, cy, leaf_puff_hi, pal)
    apply_sel_out(c, g0, g1)
    return c


def _build_snes_pine(canvas_cls):
    g0, g1, g2, g3, g4 = RAMP["grass"]
    w0, w1, w2, w3, _ = RAMP["wood"]
    c = canvas_cls(32, 32, TRANSPARENT)
    # Textured trunk
    c.rect(13, 25, 6, 5, w0)
    c.rect(14, 25, 4, 4, w2)
    c.rect(14, 25, 2, 4, w3)
    # Serrated irregular evergreen boughs (3 solidly overlapping jagged tiers — zero floating split!)
    c.rect(14, 11, 4, 15, g1)  # solid inner pine spine connecting all 3 tiers
    tiers = [
        (24, [
            "......MMMMMM......",
            "....MMLLLLMMMM....",
            "..MLLLHHLLLLMMMD..",
            ".MLLHHLLLLMMDDDDD.",
            "DDMLLLLMMMDDDDDDDD",
            ".DD..DDDD..DD..DD.",
        ]),
        (17, [
            ".....MMMMMM.....",
            "...MMLLHHLLMM...",
            "..MLLHHLLLLMMD..",
            ".MLLLLLLMMDDDDD.",
            "DD.DD..DDD..DD.D",
        ]),
        (11, [
            ".....HH.....",
            "....HHLH....",
            "...HLLLLL...",
            "..HLLLLMMD..",
            ".MLLLMMMDDD.",
            "DD..DDDD..DD",
        ]),
    ]
    pal = {"D": g1, "M": g2, "L": g3, "H": g4}
    for cy, pat in tiers:
        paint_cluster(c, 16, cy, pat, pal)
    apply_sel_out(c, g0, g1)
    return c


def _build_snes_bush(canvas_cls):
    g0, g1, g2, g3, g4 = RAMP["grass"]
    c = canvas_cls(32, 32, TRANSPARENT)
    pat = [
        ".....HHHH..LLL......",
        "...HHLLLLHHLLLL.....",
        "..HLLLLLLLLLLMMM....",
        ".HLLLLMMLLLLMMMMM...",
        ".LLLLMMMMLLMMMMDDD..",
        "MMMMMMDDDMMMMDDDDDD.",
        ".MMMMDDDDDDDDDDDDDD.",
        "..DDDDDDDDDDDDDDDD..",
        "....DDDDDDDDDDDD....",
    ]
    paint_cluster(c, 16, 18, pat, {"H": g4, "L": g3, "M": g2, "D": g1})
    # Shaded ruby berries (warm glint + cool plum shadow)
    for bx, by in ((10, 17), (19, 16), (14, 20), (22, 19)):
        c.set(bx, by, hx("#FFD2CC"))
        c.set(bx + 1, by, hx("#D9486E"))
        c.set(bx, by + 1, hx("#8C1F47"))
        c.set(bx + 1, by + 1, hx("#3D112B"))
    apply_sel_out(c, g0, g1)
    return c


def _build_snes_coral(canvas_cls):
    r0, r1, r2, r3, r4 = RAMP["coral_r"]
    t0, t1, t2, t3, t4 = RAMP["coral_t"]
    c = canvas_cls(32, 32, TRANSPARENT)
    # Jagged branching staghorn coral + seafoam fan fronds (zero marshmallow blobs!)
    pat = [
        "....RR......RR..........",
        "...RHR.....RHR.....TT...",
        "...RMR..R..RMR....THT...",
        "..RRMR.RHR.RMR...TTMT.T.",
        "..RHMHRRMRRRMR...TMT.THT",
        "...RMMMRMMMRM...TTMMTTMT",
        "....RMMMRMMM....TMMTTMMT",
        "....DDMMMMDD...DDTMMMMTD",
        "...DDDMMMMDDDDDDTTMMMMTD",
        "....DDDDMMMMDDDDDTTTTDD.",
        ".....DDDDDDDDDDDDDDDD...",
    ]
    pal = {"R": r2, "H": r4, "M": r3, "D": r1, "T": t2}
    # Map seafoam highlights properly
    for y, row in enumerate(pat):
        for x, ch in enumerate(row):
            if ch == ".":
                continue
            px, py = 4 + x, 13 + y
            if ch == "H" and x > 14:
                c.set(px, py, t4)
            elif ch == "M" and x > 14:
                c.set(px, py, t3)
            elif ch == "D" and x > 14:
                c.set(px, py, t1)
            else:
                c.set(px, py, pal[ch])
    apply_sel_out(c, r0, r1)
    return c


def _build_snes_statue(canvas_cls):
    s0, s1, s2, s3, s4 = RAMP["stone"]
    rc2, rc3, rc4 = RAMP["rune_c"][2], RAMP["rune_c"][3], RAMP["rune_c"][4]
    c = canvas_cls(32, 32, TRANSPARENT)
    # True 3/4 carved hooded dragon-knight / sage statue on stepped stone plinth (ZERO snowman!)
    pat = [
        "........HHHH........",
        "......HHLLLLMM......",
        ".....HLLMMMMMDD.....",
        ".....HLDDDDDDMD.....",
        ".....HLDCCDDCCD.....",
        ".....HLDDDDDDMD.....",
        "......MMLLLLMM......",
        "....HHLLLLLLLLMM....",
        "...HLLLLMMMMMMMDD...",
        "...HLLMMCCCCMMMDD...",
        "...HLLMMCCCCMMMDD...",
        "...HLLMMMMMMMMMDD...",
        "....HLLMDDDDMMDD....",
        "....HLLMM..MMMDD....",
        "....HLLMM..MMMDD....",
        "....HLLMM..MMMDD....",
        "...HHLLLLLLLLMMDD...",
        "..HHLLLLLLLLLLMMDD..",
        "..MMMMMMMMMMMMDDDD..",
        "..DDDDDDDDDDDDDDDD..",
    ]
    paint_cluster(c, 16, 17, pat, {"H": s4, "L": s3, "M": s2, "D": s1, "C": rc2})
    # Bright cyan eye & chest rune highlights
    c.set(14, 11, rc4); c.set(18, 11, rc4)
    c.rect(15, 16, 2, 2, rc3); c.set(15, 16, rc4)
    apply_sel_out(c, s0, s1)
    return c


def _build_snes_vault_shrine(canvas_cls):
    s0, s1, s2, s3, s4 = RAMP["stone"]
    b1, b2, b3, b4 = RAMP["brass"][1], RAMP["brass"][2], RAMP["brass"][3], RAMP["brass"][4]
    rc1, rc2, rc3, rc4 = RAMP["rune_c"][1], RAMP["rune_c"][2], RAMP["rune_c"][3], RAMP["rune_c"][4]
    c = canvas_cls(32, 32, TRANSPARENT)
    # True 3/4 carved stone-and-bronze Dragon Altar (ZERO washing machine!)
    pat = [
        "......GGGGGGGG......",
        "....GGHHHHHHHHGG....",
        "...GHHLLLLLLLLHHG...",
        "..GHLBBBBBBBBBBMDG..",
        "..GHBCCCCCCCCCCBMD..",
        "..GHBCQQQQQQQQCBMD..",
        "..GHBCQCCCCCCQCBMD..",
        "..GHBCQCQWWQCQCBMD..",
        "..GHBCQCCCCCCQCBMD..",
        "..GHBCCCCCCCCCCBMD..",
        "..GHBBBBBBBBBBBBMD..",
        "..GHLLLLLLLLLLLLMD..",
        ".GHHLLLLLLLLLLLLMDG.",
        ".GMMMMMMMMMMMMMMMDG.",
        ".GDDDDDDDDDDDDDDDDG.",
        "..GGGGGGGGGGGGGGGG..",
    ]
    pal = {
        "G": b2, "H": s4, "L": s3, "M": s2, "D": s1,
        "B": b3, "C": rc1, "Q": rc2, "W": rc4,
    }
    paint_cluster(c, 16, 18, pat, pal)
    # Sculpted golden dragon crest finials at top corners
    for fx in (10, 21):
        c.rect(fx, 8, 2, 3, b4)
        c.set(fx, 10, b1)
    c.rect(14, 15, 4, 2, rc3)
    apply_sel_out(c, s0, s1)
    return c


def _build_snes_crystal_pillar(canvas_cls):
    s0, s1, s2, s3, s4 = RAMP["stone"]
    i1, i2, i3, i4 = RAMP["ice"][1], RAMP["ice"][2], RAMP["ice"][3], RAMP["ice"][4]
    rv2, rv3 = RAMP["rune_v"][2], RAMP["rune_v"][3]
    c = canvas_cls(32, 32, TRANSPARENT)
    # Sharp faceted hexagonal crystal prism in a 3/4 octagonal socket plinth (ZERO Easter egg!)
    pat = [
        "........WW........",
        ".......WQQ........",
        "......WQQCC.......",
        ".....WQQQCCC......",
        "....WQQQQCCCC.....",
        "....WQQQCCCVV.....",
        "....WQQQCCCVV.....",
        "....WQQQCCVVV.....",
        "....WQQQCCVVV.....",
        "....WQQCCCVVD.....",
        "....WQQCCCVVD.....",
        "....WQQCCCVVD.....",
        ".....QQCCCVVD.....",
        ".....QQCCVVDD.....",
        "...HHLLLLLLMMDD...",
        "..HHLLLLLLLLMMDD..",
        "..MMMMMMMMMMDDDD..",
        "...DDDDDDDDDDDD...",
    ]
    pal = {"W": i4, "Q": i3, "C": i2, "V": rv2, "D": i1, "H": s4, "L": s3, "M": s2}
    paint_cluster(c, 16, 17, pat, pal)
    # Crisp internal prism specular ridge
    for y in range(11, 20):
        c.set(15, y, i4 if y % 2 == 0 else rv3)
    apply_sel_out(c, s0, i1)
    return c


def _build_snes_anvil(canvas_cls):
    st0, st1, st2, st3, st4 = RAMP["steel"]
    c = canvas_cls(32, 32, TRANSPARENT)
    # True 3/4 forged blacksmith anvil (trapezoidal top striking face + pointed horn + hardy hole)
    pat = [
        "......HHHHHHHHHHHHHH....",
        "....HHLLLLLLLLLLLLLLMM..",
        "..HHLLLLLLLLDDLLLLLLMM..",
        "HHLLLLLLLLLLLLLLLLLLMM..",
        "...MMMMMMLLLLLLLLLMMMM..",
        ".....DDDDMMMMMMMMMDDDD..",
        "........DDMMMMMMMDD.....",
        "........DDMMMMMMMDD.....",
        "........DDMMMMMDDDD.....",
        ".......DDMMMMMMMDDDD....",
        ".....HHLLLLMMMMMMMDDDD..",
        "....HHLLLLMMMMMMMMDDDD..",
        "....DDDDDDDDDDDDDDDDDD..",
    ]
    paint_cluster(c, 16, 18, pat, {"H": st4, "L": st3, "M": st2, "D": st1})
    apply_sel_out(c, st0, st1)
    return c


def _build_snes_column(canvas_cls):
    m0, m1, m2, m3, m4 = RAMP["marble"]
    c = canvas_cls(32, 32, TRANSPARENT)
    # 3/4 weathered classical marble pillar with curved Doric capital, cylindrical flutes & plinth
    pat = [
        "..HHHHHHHHHHHHHHHH..",
        ".HHLLLLLLLLLLLLLLMM.",
        ".HLLLLLLLLLLLLLMMMM.",
        "..MMMMMMMMMMMMDDDD..",
        "....HHLMMHLMDDMD....",
        "....HHLMMHLMDDMD....",
        "....HHLMMHLMDDMD....",
        "....HHLMMHLMDDMD....",
        "....HHLMMHLMDDMD....",
        "....HHLMMHLMDDMD....",
        "....HHLMMHLMDDMD....",
        "....HHLMMHLMDDMD....",
        "....HHLMMHLMDDMD....",
        "....HHLMMHLMDDMD....",
        "...HHLLLLLLLLMMDD...",
        "..HHLLLLLLLLLLMMDD..",
        ".HHLLLLLLLLLLLLMMDD.",
        ".MMMMMMMMMMMMMMDDDD.",
        "..DDDDDDDDDDDDDDDD..",
    ]
    paint_cluster(c, 16, 16, pat, {"H": m4, "L": m3, "M": m2, "D": m1})
    # Subtle weathered chip on right flute
    c.set(20, 14, m0); c.set(21, 15, m1)
    apply_sel_out(c, m0, m1)
    return c


def _build_snes_gear(canvas_cls):
    b0, b1, b2, b3, b4 = RAMP["brass"]
    st0, st1, st2, st3, st4 = RAMP["steel"]
    c = canvas_cls(32, 32, TRANSPARENT)
    # 3/4 tilted clockwork brass cogwheel seated in a recessed axle pit (clean connected teeth!)
    pat = [
        "........HHHH........",
        "....HHH.HLLM.HHH....",
        "...HLLLHLLLLHLLLM...",
        "...HLLLLLLLLLLLLM...",
        ".HHLLLLLDDDDLLLLLMM.",
        ".HLLLLDDSSSSDDLLLLM.",
        "HLLLLDDSWWWWSDDLLMMD",
        "HLLLLDDSWSSWSDDLLMMD",
        "MLLLLDDSSSSSSDDLLMMD",
        ".MLLLLDDSSSSDDLLMMD.",
        ".DDLLLLLDDDDLLLLDDD.",
        "...MLLLLLLLLLLLLDD..",
        "...DDMLLMMMMLLDDDD..",
        "....DD..MMMM..DD....",
        "........DDDD........",
    ]
    paint_cluster(c, 16, 17, pat, {"H": b4, "L": b3, "M": b2, "D": b1, "S": st2, "W": st4})
    # Symmetric recessed 3D bottom lip under gear teeth
    c.rect(11, 25, 10, 2, b0)
    apply_sel_out(c, b0, b1)
    return c


def _build_snes_campfire(canvas_cls):
    s0, s1, s2, s3, s4 = RAMP["stone"]
    w0, w1, w2, w3, _ = RAMP["wood"]
    m0, m1, m2, m3, m4 = RAMP["magma"]
    c = canvas_cls(32, 32, TRANSPARENT)
    # 3/4 stone ring over dark ash + diagonally crossed charred logs + asymmetrical licking flames
    pat = [
        "..........O...........",
        ".........OYO..........",
        ".......O.OYYO.........",
        "......OYOYYWYO........",
        "......OYYWWWWYO.......",
        ".....ROYYWWWWYO.......",
        ".....ROYYYWWYYOR......",
        "....BBROYYYYYORBB.....",
        "...BWWBROYYYYORWWB....",
        "..SLLBWWBRRRRBWWBLS...",
        ".SLMMDDBWWWWWWBDDMLS..",
        ".SMDD..BBWWWWBB..DMS..",
        "..SDD.SLLMMMMLLS.DDS..",
        ".....SLMMDDDDMMLS.....",
        "......DDDDDDDDDD......",
    ]
    pal = {
        "O": m2, "Y": m3, "W": m4, "R": m1,
        "B": w0, "L": s3, "M": s2, "D": s1, "S": s4,
    }
    # Map 'W' inside logs vs flame cleanly
    for y, row in enumerate(pat):
        for x, ch in enumerate(row):
            if ch == ".":
                continue
            px, py = 5 + x, 11 + y
            if ch == "W" and y >= 8:
                c.set(px, py, w2 if x % 2 == 0 else w3)
            else:
                c.set(px, py, pal[ch])
    apply_sel_out(c, s0, s1)
    return c


def _build_snes_portal(canvas_cls):
    rv0, rv1, rv2, rv3, rv4 = RAMP["rune_v"]
    rc1, rc2, rc3, rc4 = RAMP["rune_c"][1], RAMP["rune_c"][2], RAMP["rune_c"][3], RAMP["rune_c"][4]
    c = canvas_cls(32, 32, TRANSPARENT)
    # Foreshortened 3/4 swirling dimensional rift (curved spiral arms, ZERO bullseye target!)
    cx, cy = 15.5, 16.5
    for y in range(32):
        for x in range(32):
            dx = (x - cx) / 12.5
            dy = (y - cy) / 9.5
            r = math.hypot(dx, dy)
            if r > 1.05:
                continue
            ang = math.atan2(dy, dx)
            spiral = math.sin(ang * 3.0 - r * 7.5)
            if r < 0.22:
                c.set(x, y, rc4)
            elif r < 0.45:
                c.set(x, y, rc3 if spiral > -0.2 else rc2)
            elif r < 0.72:
                c.set(x, y, rc2 if spiral > 0.1 else rv2)
            elif r < 0.92:
                c.set(x, y, rv3 if spiral > 0.25 else rv1)
            elif spiral > -0.35:
                c.set(x, y, rv0)
    # Trailing magic wisps rising off the rift
    for wx, wy, col in ((8, 6, rc3), (23, 7, rv3), (15, 4, rc4), (26, 13, rc3), (5, 12, rv3)):
        c.set(wx, wy, col)
    return c


def _build_snes_chest(canvas_cls, opened: bool):
    w0, w1, w2, w3, w4 = RAMP["wood"]
    b0, b1, b2, b3, b4 = RAMP["brass"]
    rc2, rc3, rc4 = RAMP["rune_c"][2], RAMP["rune_c"][3], RAMP["rune_c"][4]
    c = canvas_cls(32, 32, TRANSPARENT)
    if not opened:
        pat = [
            "..BBBBBBBBBBBBBBBBBB..",
            ".BGGHHHHHHHHHHHHHHGGB.",
            ".BGLLLLLLLLLLLLLLLLGB.",
            "BGGMMMMMMMMMMMMMMMMGGB",
            "BGGGGGGGGGGGGGGGGGGGGB",
            "BGMMMMMMBBGGGBBMMMMMGB",
            "BGMMMMMMBGGGGGBMMMMMGB",
            "BGDDDDDDBGGKGGBDDDDDGB",
            "BGDDDDDDBBGGGBBDDDDDGB",
            "BGGGGGGGGGGGGGGGGGGGGB",
            ".BBBBBBBBBBBBBBBBBBBB.",
        ]
    else:
        pat = [
            "..BBBBBBBBBBBBBBBBBB..",
            ".BGGHHHHHHHHHHHHHHGGB.",
            ".BGLLLLLLLLLLLLLLLLGB.",
            ".BDDDDDDDDDDDDDDDDDDB.",
            "BGCQQQQGGQQQQGGQQQQCGB",
            "BGCQWWQGGQWWQGGQWWQCGB",
            "BGGGGGGGGGGGGGGGGGGGGB",
            "BGMMMMMMBBGGGBBMMMMMGB",
            "BGDDDDDDBGGKGGBDDDDDGB",
            "BGDDDDDDBBGGGBBDDDDDGB",
            "BGGGGGGGGGGGGGGGGGGGGB",
            ".BBBBBBBBBBBBBBBBBBBB.",
        ]
    pal = {
        "B": w0, "H": w4, "L": w3, "M": w2, "D": w1,
        "G": b3, "K": b0, "C": rc2, "Q": rc3, "W": rc4,
    }
    paint_cluster(c, 16, 18, pat, pal)
    # Specular glint on brass clasp & top rim
    c.set(15, 17 if not opened else 19, b4)
    c.rect(7, 13 if not opened else 12, 18, 1, b4)
    return c


def _build_snes_gate(canvas_cls, closed: bool):
    s0, s1, s2, s3, s4 = RAMP["stone"]
    w0, w1, w2, w3, _ = RAMP["wood"]
    b2, b3, b4 = RAMP["brass"][2], RAMP["brass"][3], RAMP["brass"][4]
    g1, g2, g3 = RAMP["grass"][1], RAMP["grass"][2], RAMP["grass"][3]
    c = canvas_cls(32, 32, TRANSPARENT)
    # Weathered stone arch lintel & pillars
    c.rect(0, 0, 32, 6, s0); c.rect(1, 1, 30, 4, s2); c.rect(1, 1, 30, 2, s3); c.rect(2, 1, 28, 1, s4)
    for px in (0, 25):
        c.rect(px, 6, 7, 26, s0)
        c.rect(px + 1, 6, 5, 25, s2)
        c.rect(px + 1, 6, 2, 25, s3)
        c.rect(px + 5, 6, 1, 25, s1)
    # Asymmetric hanging moss clump on left arch corner only
    paint_cluster(c, 4, 5, ["LL.", "MML", ".DM", "..D"], {"L": g3, "M": g2, "D": g1})
    if closed:
        c.rect(7, 6, 18, 26, w0)
        for bx in (8, 12, 16, 20):
            c.rect(bx, 6, 3, 25, w2)
            c.rect(bx, 6, 1, 25, w3)
        for by in (10, 18, 26):
            c.rect(7, by, 18, 3, s1)
            c.rect(7, by, 18, 1, s3)
        c.rect(13, 13, 6, 6, w0)
        c.rect(14, 14, 4, 4, b3)
        c.set(14, 14, b4); c.set(17, 17, b2)
    return c


def _build_snes_torch(canvas_cls):
    w0, w1, w2, w3, _ = RAMP["wood"]
    st0, st1, st2, st3, _ = RAMP["steel"]
    m1, m2, m3, m4 = RAMP["magma"][1], RAMP["magma"][2], RAMP["magma"][3], RAMP["magma"][4]
    c = canvas_cls(32, 32, TRANSPARENT)
    # Carved wooden sconce + iron brazier cup + asymmetrical flame
    c.rect(13, 14, 6, 15, w0); c.rect(14, 15, 4, 13, w2); c.rect(14, 15, 2, 13, w3)
    c.rect(11, 27, 10, 3, st0); c.rect(12, 28, 8, 1, st2)
    c.rect(10, 11, 12, 5, st0); c.rect(11, 12, 10, 3, st1); c.rect(11, 12, 10, 1, st3)
    flame = [
        "...O...",
        "..OYO..",
        ".OYYYO.",
        "ROYWYOR",
        ".ROYYO.",
    ]
    paint_cluster(c, 16, 8, flame, {"R": m1, "O": m2, "Y": m3, "W": m4})
    return c


def _build_snes_bridge(canvas_cls, water_v0, broken: bool):
    w0, w1, w2, w3, w4 = RAMP["wood"]
    c = water_v0.copy() if broken else canvas_cls(32, 32, w1)
    y_ranges = (0, 4, 24, 28) if broken else range(0, 32, 4)
    for y in y_ranges:
        c.rect(3, y, 26, 1, w0)
        c.rect(3, y + 1, 26, 1, w4 if (y // 4) % 2 == 0 else w3)
        c.rect(3, y + 2, 26, 1, w2)
        c.rect(3, y + 3, 26, 1, w1)
        c.set(5, y + 2, w0); c.set(26, y + 2, w0)
        gx = 9 + ((y * 5) % 11)
        c.rect(gx, y + 2, 4, 1, w1)
    # Rounded 3/4 side timber rails & sturdy corner posts
    for rx in (0, 28):
        for y in (range(0, 8) if broken else range(0, 32)):
            c.rect(rx, y, 4, 1, w0)
            c.rect(rx + 1, y, 2, 1, w2)
            c.set(rx + 1, y, w3)
        if broken:
            for y in range(24, 32):
                c.rect(rx, y, 4, 1, w0)
                c.rect(rx + 1, y, 2, 1, w2)
                c.set(rx + 1, y, w3)
        for py in ((2, 25) if broken else (2, 18)):
            c.rect(rx, py, 4, 5, w0)
            c.rect(rx + 1, py + 1, 2, 3, w3)
            c.rect(rx + 1, py + 1, 2, 1, w4)
    if broken:
        # Jagged organic wood splinters jutting over water + foam on both broken edges
        for sx, sw, sh in ((3, 6, 4), (10, 3, 2), (22, 7, 3)):
            c.rect(sx, 8, sw, sh, w3); c.rect(sx, 8 + sh - 1, sw, 1, w0)
            c.rect(sx, 8 + sh, sw, 1, RAMP["water"][4])
        for sx, sw, sh in ((4, 5, 3), (20, 8, 4)):
            c.rect(sx, 24 - sh - 1, sw, 1, RAMP["water"][4])
            c.rect(sx, 24 - sh, sw, sh, w2)
            c.rect(sx, 24 - sh, sw, 1, w0)
            c.rect(sx + 1, 24 - sh + 1, max(1, sw - 2), 1, w4)
    else:
        c.rect(4, 0, 2, 32, (20, 12, 10, 75), blend=True)
    return c


# ---------------------------------------------------------------------------
# Public Entrypoint: Build All 35 Base SNES Tiles + Variants + Wall Autotiles
# ---------------------------------------------------------------------------
def build_all_snes_tiles(canvas_cls) -> Tuple[Dict[str, object], Dict[str, List[str]]]:
    """Returns (tiles_by_id, variant_groups) where:
      - tiles_by_id contains all 35 base TILE_IDS PLUS seamless floor variants (<id>_v1..v3)
        and N/S/E/W wall autotiles (<wall>_top, <wall>_mid, <wall>_accent).
      - variant_groups maps base floor id -> [base_id, <id>_v1, <id>_v2, <id>_v3].
    """
    tiles: Dict[str, object] = {}
    variants: Dict[str, List[str]] = {}

    floor_builders: Dict[str, Callable] = {
        "grass": _make_grass_64,
        "dirt_path": _make_dirt_64,
        "sand": _make_sand_64,
        "water": _make_water_64,
        "stone_floor": _make_stone_floor_64,
        "brass_floor": _make_brass_floor_64,
        "obsidian_floor": _make_obsidian_floor_64,
        "ice_floor": _make_ice_floor_64,
        "lava": _make_lava_64,
        "cloud_floor": _make_cloud_64,
        "star_tile": _make_star_64,
    }

    for fid, builder in floor_builders.items():
        big = builder(canvas_cls)
        subs = slice_64_to_4(canvas_cls, big)
        tiles[fid] = subs[0]
        group = [fid]
        for idx in (1, 2, 3):
            vid = f"{fid}_v{idx}"
            tiles[vid] = subs[idx]
            group.append(vid)
        variants[fid] = group

    # Wildflower meadow & lush flower_bed built on top of our SNES grass
    def draw_flower(c, fx: int, fy: int, pet: RGBA, hi: RGBA, ctr: RGBA) -> None:
        g1 = RAMP["grass"][1]
        c.set(fx - 1, fy + 2, g1); c.set(fx, fy + 2, g1); c.set(fx + 1, fy + 2, g1)
        for ox, oy, col in ((0, -2, hi), (-1, -1, hi), (1, -1, pet), (-2, 0, pet), (2, 0, pet), (-1, 1, pet), (1, 1, pet), (0, 2, pet)):
            c.set(fx + ox, fy + oy, col)
        c.set(fx, fy, ctr)

    gf = tiles["grass"].copy()
    draw_flower(gf, 15, 11, hx("#E8E4D8"), hx("#FFFDF5"), hx("#FAD03C"))
    draw_flower(gf, 23, 21, hx("#F5899A"), hx("#FFD2CC"), hx("#FFF7B8"))
    draw_flower(gf, 10, 24, hx("#8FD4F0"), hx("#E6FAFF"), hx("#FFF7B8"))
    tiles["grass_flower"] = gf

    fb = gf.copy()
    draw_flower(fb, 24, 7, hx("#D98FFF"), hx("#FCE8FF"), hx("#FAD03C"))
    draw_flower(fb, 6, 16, hx("#D9486E"), hx("#FFD2CC"), hx("#FFF7B8"))
    # Tiny hand-pixelled red-capped toadstool tucked into flower_bed
    paint_cluster(fb, 18, 25, [".RRR.", "RWRWR", ".BBB.", "..WW."], {
        "R": hx("#D9486E"), "W": hx("#FFFDF5"), "B": hx("#3D112B"),
    })
    tiles["flower_bed"] = fb

    # Bridges
    tiles["bridge_wood"] = _build_snes_bridge(canvas_cls, tiles["water"], broken=False)
    tiles["bridge_broken"] = _build_snes_bridge(canvas_cls, tiles["water"], broken=True)

    # N/S/E/W autotiled wall sets
    tiles.update(_build_stone_walls(canvas_cls))
    tiles.update(_build_ice_walls(canvas_cls))
    tiles.update(_build_obsidian_walls(canvas_cls))

    # Hand-pixelled 3/4 RPG foliage & props
    tiles["tree"] = _build_snes_tree(canvas_cls)
    tiles["pine_tree"] = _build_snes_pine(canvas_cls)
    tiles["bush"] = _build_snes_bush(canvas_cls)
    tiles["coral"] = _build_snes_coral(canvas_cls)
    tiles["statue"] = _build_snes_statue(canvas_cls)
    tiles["vault_shrine"] = _build_snes_vault_shrine(canvas_cls)
    tiles["crystal_pillar"] = _build_snes_crystal_pillar(canvas_cls)
    tiles["anvil"] = _build_snes_anvil(canvas_cls)
    tiles["column"] = _build_snes_column(canvas_cls)
    tiles["gear_prop"] = _build_snes_gear(canvas_cls)
    tiles["campfire"] = _build_snes_campfire(canvas_cls)
    tiles["portal"] = _build_snes_portal(canvas_cls)
    tiles["chest_closed"] = _build_snes_chest(canvas_cls, opened=False)
    tiles["chest_open"] = _build_snes_chest(canvas_cls, opened=True)
    tiles["mossy_gate_closed"] = _build_snes_gate(canvas_cls, closed=True)
    tiles["mossy_gate_open"] = _build_snes_gate(canvas_cls, closed=False)
    tiles["torch"] = _build_snes_torch(canvas_cls)

    return tiles, variants
