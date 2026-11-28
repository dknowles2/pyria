#!/usr/bin/env python3
"""
Pyria 8-Bit & 16-Bit Tileset, NPC/Dragon Sheet, and World Map Comparison Renderer.
Pure Python 3 (stdlib only: zlib, struct, json, pathlib) — zero external dependencies.

Generates:
  - assets/tilesets/8bit/meadow_ruins.png       (80x64, 5x4 grid of 16x16 NES Zelda tiles)
  - assets/tilesets/16bit/meadow_ruins.png      (80x64, 5x4 grid of 16x16 SNES ALTTP tiles)
  - assets/tilesets/8bit/npcs_and_dragons.png   (144x16, 9x1 grid of 16x16 sprites)
  - assets/tilesets/16bit/npcs_and_dragons.png  (144x16, 9x1 grid of 16x16 sprites)
  - assets/tilesets/manifest.json               (exact coordinates for all 20 tiles + 9 NPCs/dragons)
  - assets/world/maps_bundle.js                 (file:// fallback bundle if content/maps/*.json exist)
  - assets/world/realm01_meadow_comparison.png  (8-bit vs 16-bit side-by-side Realm 1 render)
"""

from __future__ import annotations

import json
import struct
import zlib
from pathlib import Path
from typing import Dict, List, Optional, Tuple

RGBA = Tuple[int, int, int, int]
TRANSPARENT: RGBA = (0, 0, 0, 0)

TILESETS_DIR = Path(__file__).resolve().parent
ASSETS_DIR = TILESETS_DIR.parent
REPO_DIR = ASSETS_DIR.parent
WORLD_DIR = ASSETS_DIR / "world"
MAPS_DIR = REPO_DIR / "content" / "maps"

TILE_IDS = [
    "grass", "grass_flower", "dirt_path", "water", "bridge_wood",
    "bridge_broken", "stone_floor", "stone_wall", "tree", "bush",
    "campfire", "anvil", "statue", "mossy_gate_closed", "mossy_gate_open",
    "chest_closed", "chest_open", "vault_shrine", "torch", "portal",
    "lava", "ice_floor", "ice_wall", "sand", "coral",
    "obsidian_floor", "obsidian_wall", "brass_floor", "gear_prop", "cloud_floor",
    "star_tile", "crystal_pillar", "pine_tree", "column", "flower_bed",
]

NPC_KEYS = [
    "elder_ada",
    "bram",
    "spark",
    "pebble",
    "lord_null",
    "emberwing",
    "glacier",
    "bramble",
    "mire",
]

SHEET_COLS = 5
TILE_SIZE = 16


# ---------------------------------------------------------------------------
# Pure-Python PNG Encoder & Canvas
# ---------------------------------------------------------------------------
def write_png(path: Path, width: int, height: int, pixels: List[RGBA]) -> None:
    assert len(pixels) == width * height
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        row = y * width
        for x in range(width):
            r, g, b, a = pixels[row + x]
            raw.extend((r, g, b, a))

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), level=9)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    path.write_bytes(png)


class Canvas:
    def __init__(self, width: int, height: int, fill: RGBA = TRANSPARENT) -> None:
        self.w = width
        self.h = height
        self.px: List[RGBA] = [fill] * (width * height)

    def copy(self) -> "Canvas":
        c = Canvas(self.w, self.h)
        c.px = self.px.copy()
        return c

    def get(self, x: int, y: int) -> RGBA:
        if 0 <= x < self.w and 0 <= y < self.h:
            return self.px[y * self.w + x]
        return TRANSPARENT

    def set(self, x: int, y: int, color: RGBA) -> None:
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px[y * self.w + x] = color

    def blend(self, x: int, y: int, color: RGBA) -> None:
        if not (0 <= x < self.w and 0 <= y < self.h):
            return
        sr, sg, sb, sa = color
        if sa == 0:
            return
        if sa == 255:
            self.px[y * self.w + x] = color
            return
        dr, dg, db, da = self.px[y * self.w + x]
        if da == 0:
            self.px[y * self.w + x] = color
            return
        af = sa / 255.0
        inv = 1.0 - af
        out_a = sa + int(da * inv)
        if out_a == 0:
            return
        r = int((sr * sa + dr * da * inv) / out_a)
        g = int((sg * sa + dg * da * inv) / out_a)
        b = int((sb * sa + db * da * inv) / out_a)
        self.px[y * self.w + x] = (min(255, r), min(255, g), min(255, b), min(255, out_a))

    def rect(self, x: int, y: int, w: int, h: int, color: RGBA, blend: bool = False) -> None:
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                if blend:
                    self.blend(xx, yy, color)
                else:
                    self.set(xx, yy, color)

    def blit(self, src: "Canvas", dx: int = 0, dy: int = 0) -> None:
        for y in range(src.h):
            for x in range(src.w):
                c = src.px[y * src.w + x]
                if c[3] > 0:
                    self.blend(dx + x, dy + y, c)

    def blit_scaled(self, src: "Canvas", dx: int, dy: int, scale: int) -> None:
        for y in range(src.h):
            for x in range(src.w):
                c = src.px[y * src.w + x]
                if c[3] > 0:
                    for sy in range(scale):
                        for sx in range(scale):
                            self.blend(dx + x * scale + sx, dy + y * scale + sy, c)

    def save(self, path: Path) -> None:
        write_png(path, self.w, self.h, self.px)


def hx(h: str, a: int = 255) -> RGBA:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def from_grid(rows: List[str], pal: Dict[str, RGBA]) -> Canvas:
    h = len(rows)
    w = len(rows[0])
    c = Canvas(w, h)
    for y, row in enumerate(rows):
        assert len(row) == w, f"Row {y} len {len(row)} != {w}"
        for x, ch in enumerate(row):
            if ch not in (".", " "):
                c.set(x, y, pal[ch])
    return c


# ---------------------------------------------------------------------------
# 20 Tiles — 8-Bit (NES Zelda crisp limited palette) & 16-Bit (SNES ALTTP lush)
# ---------------------------------------------------------------------------
def build_tiles(era: str) -> Dict[str, Canvas]:
    is16 = era == "16bit"
    O = hx("#14121D") if is16 else hx("#101018")
    tiles: Dict[str, Canvas] = {}

    # 1. grass
    if not is16:
        g_bg, g_tuft, g_hi = hx("#28A428"), hx("#146C14"), hx("#58D854")
        c = Canvas(16, 16, g_bg)
        for tx, ty in ((2, 3), (10, 2), (6, 9), (13, 12), (2, 13)):
            c.set(tx, ty, g_tuft); c.set(tx + 1, ty + 1, g_tuft); c.set(tx + 2, ty, g_tuft)
        c.set(5, 4, g_hi); c.set(12, 7, g_hi)
        tiles["grass"] = c
    else:
        g_base, g_mid, g_dk, g_hi, g_sun = hx("#3DA847"), hx("#2F8E3B"), hx("#1F6B2E"), hx("#68C959"), hx("#96E36E")
        c = Canvas(16, 16, g_base)
        # Dappled SNES grass patches
        for y in range(16):
            for x in range(16):
                h = (x * 7 + y * 13 + x * y) % 19
                if h in (0, 5):
                    c.set(x, y, g_mid)
                elif h == 11:
                    c.set(x, y, g_hi)
        for tx, ty in ((2, 3), (10, 2), (6, 9), (12, 12), (2, 13)):
            c.set(tx, ty, g_dk); c.set(tx + 1, ty + 1, g_dk); c.set(tx + 2, ty, g_mid)
            c.set(tx + 1, ty, g_sun)
        tiles["grass"] = c

    # 2. grass_flower
    c = tiles["grass"].copy()
    if not is16:
        for fx, fy, pet, ctr in ((3, 4, hx("#F8FAFC"), hx("#FACC15")), (10, 10, hx("#FB7185"), hx("#FEF08A"))):
            c.set(fx, fy - 1, pet); c.set(fx, fy + 1, pet); c.set(fx - 1, fy, pet); c.set(fx + 1, fy, pet)
            c.set(fx, fy, ctr)
            c.set(fx, fy + 2, hx("#146C14"))
    else:
        for fx, fy, pet, hi, ctr in (
            (4, 4, hx("#F8FAFC"), hx("#BAE6FD"), hx("#FACC15")),
            (11, 10, hx("#F472B6"), hx("#FBCFE8"), hx("#FEF08A")),
            (4, 12, hx("#60A5FA"), hx("#DBEAFE"), hx("#FEF08A")),
        ):
            c.set(fx, fy - 1, hi); c.set(fx, fy + 1, pet); c.set(fx - 1, fy, pet); c.set(fx + 1, fy, hi)
            c.set(fx, fy, ctr); c.set(fx, fy + 2, hx("#14532D"))
    tiles["grass_flower"] = c

    # 3. dirt_path
    if not is16:
        c = Canvas(16, 16, hx("#E4B97B"))
        for px, py in ((2, 2), (11, 4), (5, 11), (13, 13)):
            c.set(px, py, hx("#C48F4E"))
        for px, py in ((7, 3), (3, 9), (10, 12)):
            c.set(px, py, hx("#F5D8A8"))
        tiles["dirt_path"] = c
    else:
        c = Canvas(16, 16, hx("#C99A63"))
        for y in range(16):
            for x in range(16):
                h = (x * 11 + y * 5 + x * y) % 17
                if h in (0, 6):
                    c.set(x, y, hx("#B07E49"))
                elif h in (3, 12):
                    c.set(x, y, hx("#DEB37D"))
        for px, py in ((3, 4), (11, 6), (6, 12), (13, 13)):
            c.set(px, py, hx("#8C5E32")); c.set(px + 1, py, hx("#E8C89B"))
        tiles["dirt_path"] = c

    # 4. water
    if not is16:
        c = Canvas(16, 16, hx("#2474E8"))
        for rx, ry in ((2, 3), (9, 5), (3, 10), (10, 13)):
            c.rect(rx, ry, 4, 1, hx("#7CC4FF"))
        tiles["water"] = c
    else:
        c = Canvas(16, 16, hx("#1B6EC2"))
        for y in range(0, 16, 2):
            c.rect(0, y, 16, 1, hx("#217CD6"))
        for rx, ry in ((1, 3), (8, 6), (3, 11), (9, 14)):
            c.rect(rx, ry, 5, 1, hx("#60B8FF"))
            c.rect(rx + 1, ry - 1, 3, 1, hx("#BAE6FD"))
            c.rect(rx, ry + 1, 4, 1, hx("#14539A"))
        tiles["water"] = c

    # 5. bridge_wood
    c = Canvas(16, 16, hx("#8B5A2B") if not is16 else hx("#7C4D25"))
    pl_l = hx("#C68B4B") if is16 else hx("#C88A4B")
    pl_d = hx("#4A2B11") if is16 else hx("#543014")
    rail = hx("#5E3818") if is16 else hx("#683C18")
    for y in range(0, 16, 4):
        c.rect(0, y, 16, 1, pl_d)
        c.rect(0, y + 1, 16, 1, pl_l)
        if is16:
            c.set(3, y + 2, pl_d); c.set(12, y + 2, pl_d)  # plank nails
    c.rect(0, 0, 2, 16, rail); c.rect(14, 0, 2, 16, rail)
    c.rect(1, 0, 1, 16, pl_l); c.rect(14, 0, 1, 16, pl_d)
    tiles["bridge_wood"] = c

    # 6. bridge_broken (over water with splintered gap in middle)
    c = tiles["water"].copy()
    for y in (0, 1, 2, 3, 12, 13, 14, 15):
        c.rect(0, y, 16, 1, hx("#8B5A2B") if not is16 else hx("#7C4D25"))
    c.rect(0, 0, 16, 1, pl_d); c.rect(0, 1, 16, 1, pl_l); c.rect(0, 3, 16, 1, pl_d)
    c.rect(0, 12, 16, 1, pl_d); c.rect(0, 13, 16, 1, pl_l); c.rect(0, 15, 16, 1, pl_d)
    # Splintered planks jutting into water
    c.rect(1, 4, 4, 2, pl_l); c.rect(11, 4, 4, 1, pl_d)
    c.rect(2, 10, 3, 2, pl_d); c.rect(10, 10, 5, 2, pl_l)
    tiles["bridge_broken"] = c

    # 7. stone_floor
    if not is16:
        c = Canvas(16, 16, hx("#78808C"))
        c.rect(0, 0, 16, 1, hx("#4E5562")); c.rect(0, 8, 16, 1, hx("#4E5562"))
        c.rect(0, 0, 1, 8, hx("#4E5562")); c.rect(8, 8, 1, 8, hx("#4E5562"))
        c.rect(1, 1, 14, 1, hx("#9CA3AF")); c.rect(9, 9, 6, 1, hx("#9CA3AF"))
        tiles["stone_floor"] = c
    else:
        c = Canvas(16, 16, hx("#6B7280"))
        c.rect(0, 0, 16, 1, hx("#374151")); c.rect(0, 8, 16, 1, hx("#374151"))
        c.rect(0, 0, 1, 8, hx("#374151")); c.rect(8, 8, 1, 8, hx("#374151"))
        c.rect(1, 1, 14, 1, hx("#9CA3AF")); c.rect(1, 9, 6, 1, hx("#9CA3AF")); c.rect(9, 9, 6, 1, hx("#9CA3AF"))
        # Subtle moss cracks
        for mx, my in ((1, 7), (2, 7), (8, 8), (9, 7), (14, 14)):
            c.set(mx, my, hx("#4ADE80") if (mx + my) % 2 == 0 else hx("#228B4E"))
        tiles["stone_floor"] = c

    # 8. stone_wall
    if not is16:
        c = Canvas(16, 16, hx("#4B5563"))
        for y in (0, 5, 10, 15):
            c.rect(0, y, 16, 1, hx("#1F2937"))
        for bx, by in ((4, 1), (12, 1), (0, 6), (8, 6), (4, 11), (12, 11)):
            c.rect(bx, by, 1, 4, hx("#1F2937"))
        c.rect(1, 1, 14, 1, hx("#9CA3AF")); c.rect(1, 6, 14, 1, hx("#6B7280"))
        tiles["stone_wall"] = c
    else:
        c = Canvas(16, 16, hx("#475569"))
        c.rect(0, 0, 16, 3, hx("#94A3B8"))
        c.rect(0, 3, 16, 1, hx("#64748B"))
        for y in (4, 9, 14):
            c.rect(0, y, 16, 1, hx("#1E293B"))
        for bx, by in ((5, 5), (12, 5), (2, 10), (9, 10)):
            c.rect(bx, by, 1, 4, hx("#1E293B"))
            c.rect(bx + 1, by, 2, 1, hx("#64748B"))
        # Hanging moss vines on wall
        for mx, my in ((2, 3), (3, 3), (3, 4), (3, 5), (11, 3), (12, 3), (12, 4)):
            c.set(mx, my, hx("#22C55E") if my == 3 else hx("#15803D"))
        tiles["stone_wall"] = c

    # 9. tree (transparent decor overlay on grass)
    t_pal = {
        "O": O,
        "H": hx("#86EFAC") if is16 else hx("#58D854"),
        "L": hx("#4ADE80") if is16 else hx("#38B838"),
        "M": hx("#16A34A") if is16 else hx("#208820"),
        "D": hx("#14532D") if is16 else hx("#0E540E"),
        "T": hx("#8B5A2B") if is16 else hx("#7C4820"),
        "t": hx("#543014"),
    }
    tiles["tree"] = from_grid([
        "....OOOOOOOO....",
        "..OOHHLLLLMMOO..",
        ".OHHLLLLMMLMMDO.",
        ".OLLLLMMMLMMMDO.",
        "OLLMMLMMMMMMMDDO",
        "OMMMMMMMMMMMMDDO",
        "OMMMMDMMMMDDDDDO",
        "ODDDDDDDDDDDDDDO",
        ".OODDDDDDDDDDOO.",
        "..OOODDDDDDOOO..",
        ".....OOTTOO.....",
        ".....OTTTtO.....",
        ".....OTTTtO.....",
        "....OOTTTtOO....",
        "....OOOOOOOO....",
        "................",
    ], t_pal)

    # 10. bush (transparent decor overlay)
    b_pal = {
        "O": O,
        "H": hx("#86EFAC") if is16 else hx("#58D854"),
        "L": hx("#4ADE80") if is16 else hx("#38B838"),
        "M": hx("#16A34A") if is16 else hx("#208820"),
        "D": hx("#14532D") if is16 else hx("#0E540E"),
        "R": hx("#F43F5E"),
    }
    tiles["bush"] = from_grid([
        "................",
        "................",
        "................",
        "....OOOOOOOO....",
        "..OOHHLLLLMMOO..",
        ".OHLLLRMMLMMMDO.",
        ".OLMMMMMMMRMMDO.",
        ".OMMMMDMMMMMDDO.",
        ".OMMRDDDDDDDDDO.",
        "..ODDDDDDDDDDO..",
        "...OOOOOOOOOO...",
        "................",
        "................",
        "................",
        "................",
        "................",
    ], b_pal)

    # 11. campfire
    cf_pal = {
        "O": O,
        "S": hx("#94A3B8") if is16 else hx("#78808C"),
        "s": hx("#475569"),
        "W": hx("#7C4820"),
        "R": hx("#EF4444"),
        "F": hx("#F97316"),
        "Y": hx("#FACC15"),
        "H": hx("#FEF9C3"),
    }
    tiles["campfire"] = from_grid([
        ".......Y........",
        "......YFY.......",
        ".....RFHFR......",
        "....RFYHYFR.....",
        "....RFYYYFR.....",
        ".....RFFFR......",
        "....OOWWWOO.....",
        "...OSWWWWWSO....",
        "..OSSOWWWOSSO...",
        "..OsSOOOOSsO....",
        "...OOsSSsOO.....",
        "....OOOOOO......",
        "................",
        "................",
        "................",
        "................",
    ], cf_pal)

    # 12. anvil (Bram's Workshop)
    an_pal = {
        "O": O,
        "H": hx("#CBD5E1") if is16 else hx("#9CA3AF"),
        "M": hx("#64748B"),
        "D": hx("#334155"),
    }
    tiles["anvil"] = from_grid([
        "................",
        "................",
        "................",
        "..OOOOOOOOOOOO..",
        ".OHHHHHHHHHHHMO.",
        "..OOMMMMMMMMO...",
        "....OOMMMMO.....",
        ".....OMMMO......",
        ".....OMDMO......",
        "....OOMDMOO.....",
        "...OMMMMMDMO....",
        "...ODDDDDDDO....",
        "...OOOOOOOOO....",
        "................",
        "................",
        "................",
    ], an_pal)

    # 13. statue (Password Statues)
    st_pal = {
        "O": O,
        "H": hx("#CBD5E1") if is16 else hx("#B8C0CC"),
        "M": hx("#94A3B8") if is16 else hx("#78808C"),
        "D": hx("#475569"),
        "C": hx("#38BDF8"),
    }
    tiles["statue"] = from_grid([
        ".....OOOOOO.....",
        "....OHHMMMD0....".replace("0", "O"),
        "....OHCMCMDO....",
        "....OMMMMMDO....",
        ".....OODDOO.....",
        "....OHMMMMDO....",
        "...OHMMCCMMDO...",
        "...OMMMMMMMDO...",
        "....OMMMMMDO....",
        "....ODDDDDDO....",
        "...OHHHHHHMDO...",
        "...OMMMMMMMDO...",
        "..OODDDDDDDDOO..",
        "..OOOOOOOOOOOO..",
        "................",
        "................",
    ], st_pal)

    # 14. mossy_gate_closed
    mg_pal = {
        "O": O,
        "S": hx("#94A3B8") if is16 else hx("#78808C"),
        "D": hx("#475569"),
        "B": hx("#92400E") if is16 else hx("#7C4820"),
        "b": hx("#451A03"),
        "G": hx("#22C55E") if is16 else hx("#28A428"),
        "Y": hx("#FACC15"),
    }
    tiles["mossy_gate_closed"] = from_grid([
        "OOGGSSSOOOSSGGOO",
        "OGSSDDBBBBDDSSGO",
        "OSDBB.B..B.BBDSO",
        "OSDBB.B..B.BBDSO",
        "OSDBBBBBBBBBBDSO",
        "OSDBb.BYYB.bBDSO",
        "OSDBb.BYYB.bBDSO",
        "OSDBBBBBBBBBBDSO",
        "OSDBb.B..B.bBDSO",
        "OSDBb.B..B.bBDSO",
        "OSDBBBBBBBBBBDSO",
        "OSDBb.B..B.bBDSO",
        "OSDBb.B..B.bBDSO",
        "OSDDDDDDDDDDDDSO",
        "OODDDDDDDDDDDDOO",
        "OOOOOOOOOOOOOOOO",
    ], mg_pal)

    # 15. mossy_gate_open
    tiles["mossy_gate_open"] = from_grid([
        "OOGGSSSOOOSSGGOO",
        "OGSSDD....DDSSGO",
        "OSDD........DDSO",
        "OSDD........DDSO",
        "OSDD........DDSO",
        "OSDD........DDSO",
        "OSDD........DDSO",
        "OSDD........DDSO",
        "OSDD........DDSO",
        "OSDD........DDSO",
        "OSDD........DDSO",
        "OSDD........DDSO",
        "OSDD........DDSO",
        "OSDD........DDSO",
        "OODD........DDOO",
        "OOOO........OOOO",
    ], mg_pal)

    # 16. chest_closed
    ch_pal = {
        "O": O,
        "L": hx("#D97706") if is16 else hx("#C88A4B"),
        "M": hx("#92400E") if is16 else hx("#8B5A2B"),
        "D": hx("#543014"),
        "G": hx("#FACC15"),
        "C": hx("#38BDF8"),
    }
    tiles["chest_closed"] = from_grid([
        "................",
        "................",
        "................",
        "..OOOOOOOOOOOO..",
        ".OGLLLLLLLLLLGO.",
        ".OGMMMMMMMMMMGO.",
        ".OOGGGGOOGGGGOO.",
        ".OMMMMOGGOMMMMO.",
        ".OMMMMOGGOMMMMO.",
        ".ODDDDDDDDDDDDO.",
        ".OGDDDDDDDDDDGO.",
        "..OOOOOOOOOOOO..",
        "................",
        "................",
        "................",
        "................",
    ], ch_pal)

    # 17. chest_open
    tiles["chest_open"] = from_grid([
        "................",
        "..OOOOOOOOOOOO..",
        ".OGLLLLLLLLLLGO.",
        ".OODDDDDDDDDDOO.",
        ".OCCCCCCCCCCCCO.",
        ".OCGGCCCCCCGGCO.",
        ".OOGGGGOOGGGGOO.",
        ".OMMMMOGGOMMMMO.",
        ".OMMMMOGGOMMMMO.",
        ".ODDDDDDDDDDDDO.",
        ".OGDDDDDDDDDDGO.",
        "..OOOOOOOOOOOO..",
        "................",
        "................",
        "................",
        "................",
    ], ch_pal)

    # 18. vault_shrine (Dragon Logic Vault)
    vs_pal = {
        "O": O,
        "S": hx("#CBD5E1") if is16 else hx("#9CA3AF"),
        "D": hx("#475569"),
        "G": hx("#FACC15"),
        "C": hx("#38BDF8"),
        "H": hx("#E0F2FE"),
    }
    tiles["vault_shrine"] = from_grid([
        "....OOOOOOOO....",
        "...OSSSSSSSSO...",
        "..OSGGCCCCGGSO..",
        ".OSGCHHHHHHCGSO.",
        ".OSGCHCCCCCHGSO.",
        ".OSGCHCHHCHCGSO.",
        ".OSGCHCCCCCHGSO.",
        ".OSGCCCCCCCCGSO.",
        ".OSGGGGGGGGGGSO.",
        "..ODDDDDDDDDDO..",
        "..OSSSSSSSSSSO..",
        ".OODDDDDDDDDDOO.",
        ".OOOOOOOOOOOOOO.",
        "................",
        "................",
        "................",
    ], vs_pal)

    # 19. torch
    tc_pal = {
        "O": O,
        "W": hx("#7C4820"),
        "d": hx("#451A03"),
        "R": hx("#EF4444"),
        "F": hx("#F97316"),
        "Y": hx("#FACC15"),
        "H": hx("#FEF9C3"),
    }
    tiles["torch"] = from_grid([
        ".......Y........",
        "......YFY.......",
        ".....RFHFR......",
        ".....RFYFR......",
        "......RFR.......",
        ".....OOOOO......",
        ".....OWWWd......",
        "......OWd.......",
        "......OWd.......",
        "......OWd.......",
        "......OWd.......",
        "......OWd.......",
        ".....OOWdO......",
        ".....OOOOO......",
        "................",
        "................",
    ], tc_pal)

    # 20. portal
    pt_pal = {
        "O": O,
        "V": hx("#7C3AED"),
        "M": hx("#A855F7"),
        "C": hx("#38BDF8"),
        "H": hx("#E0F2FE"),
    }
    tiles["portal"] = from_grid([
        "....OOOOOOOO....",
        "..OOVVMMMMVVOO..",
        ".OVMMCCCCCCMMVO.",
        ".OMMCHHHHHHCMMO.",
        "OVMCHHCCCCHHCMVO",
        "OVMCHCVVVCHHCMVO",
        "OVMCHCVHVCHHCMVO",
        "OVMCHCVVVCHHCMVO",
        "OVMCHHCCCCHHCMVO",
        ".OMMCHHHHHHCMMO.",
        ".OVMMCCCCCCMMVO.",
        "..OOVVMMMMVVOO..",
        "....OOOOOOOO....",
        "................",
        "................",
        "................",
    ], pt_pal)

    # 21. lava (glowing molten magma)
    lv = Canvas(16, 16, hx("#DC2626") if is16 else hx("#E53935"))
    for y in range(16):
        for x in range(16):
            v = (x * 5 + y * 7) % 13
            if v in (0, 1):
                lv.set(x, y, hx("#FACC15"))
            elif v in (2, 3, 4):
                lv.set(x, y, hx("#F97316"))
            elif v == 12:
                lv.set(x, y, hx("#7F1D1D"))
    tiles["lava"] = lv

    # 22. ice_floor (crystalline frozen ground)
    ic = Canvas(16, 16, hx("#BAE6FD") if is16 else hx("#93C5FD"))
    for y in range(16):
        for x in range(16):
            if (x + y) % 7 == 0:
                ic.set(x, y, hx("#F0F9FF"))
            elif (x * 3 + y * 5) % 11 == 0:
                ic.set(x, y, hx("#7DD3FC"))
    tiles["ice_floor"] = ic

    # 23. ice_wall (jagged glacial crystal wall)
    tiles["ice_wall"] = from_grid([
        "....OO....OO....",
        "...OHHO..OHHO...",
        "..OHCCHOOHCCHO..",
        ".OHCCCCHHCCCCHO.",
        ".OCCCCCCCCCCCCO.",
        "OHCCCHHCCCCHHCCO",
        "OCCCCHCCCCCHCCCO",
        "OCCBBCCCCCCBBCCO",
        "OCBBBBCCCCBBBBCO",
        "OBBBBBBBBBBBBBBO",
        "OBBDDDDDDBBDDDBO",
        "OBDDDDDDDDDDDDBO",
        "OODDDDDDDDDDDDOO",
        ".OOOOOOOOOOOOOO.",
        "................",
        "................",
    ], {"O": O, "H": hx("#F0F9FF"), "C": hx("#7DD3FC"), "B": hx("#0284C7"), "D": hx("#0369A1")})

    # 24. sand (warm tropical archipelago beach)
    sd = Canvas(16, 16, hx("#FDE68A") if is16 else hx("#FCD34D"))
    for y in range(16):
        for x in range(16):
            v = (x * 11 + y * 7) % 17
            if v == 0:
                sd.set(x, y, hx("#FEF3C7"))
            elif v in (1, 2):
                sd.set(x, y, hx("#D97706") if is16 else hx("#F59E0B"))
    tiles["sand"] = sd

    # 25. coral (vibrant reef coral cluster)
    tiles["coral"] = from_grid([
        "................",
        "....OO....OO....",
        "...OPPO..OTTO...",
        "..OPPPPOOTTTTO..",
        "..OPHHPOOTHHTO..",
        "...OPPO..OTTO...",
        ".OOOPPOOOOTTOOO.",
        "OPPPPPPTTTTTTTPO",
        "OPPHPPPTTHTTTTPO",
        ".OOPPPTTTTTTPOO.",
        "...OOPPTTTTPO...",
        "....OOOPPPPO....",
        ".....OOOOOO.....",
        "................",
        "................",
        "................",
    ], {"O": O, "P": hx("#FB7185"), "H": hx("#FECDD3"), "T": hx("#2DD4BF")})

    # 26. obsidian_floor (dark volcanic citadel tile)
    ob = Canvas(16, 16, hx("#1E1B2E"))
    for y in range(16):
        for x in range(16):
            if x == 0 or y == 0:
                ob.set(x, y, hx("#312E4A"))
            elif (x * 7 + y * 3) % 19 == 0:
                ob.set(x, y, hx("#6D28D9"))
    tiles["obsidian_floor"] = ob

    # 27. obsidian_wall (dark jagged fortress wall with purple runes)
    tiles["obsidian_wall"] = from_grid([
        "OOOOOOOOOOOOOOOO",
        "ODDDDDDDDDDDDDDO",
        "ODVVDDDDDDDDVVDO",
        "ODDDDDDDDDDDDDDO",
        "ODDDDDVVVVDDDDDO",
        "ODDDDDVPPVDDDDDO",
        "ODDDDDVVVVDDDDDO",
        "ODDDDDDDDDDDDDDO",
        "OODDDDDDDDDDDDOO",
        "ODDDDDDDDDDDDDDO",
        "ODVVDDDDDDDDVVDO",
        "ODDDDDDDDDDDDDDO",
        "ODBBBBBBBBBBBBDO",
        "ODBBBBBBBBBBBBDO",
        "OOOOOOOOOOOOOOOO",
        "................",
    ], {"O": O, "D": hx("#2E1065"), "B": hx("#1E1B4B"), "V": hx("#7C3AED"), "P": hx("#C084FC")})

    # 28. brass_floor (riveted bronze clockwork decking)
    br = Canvas(16, 16, hx("#92400E") if is16 else hx("#B45309"))
    for y in range(16):
        for x in range(16):
            if x == 0 or y == 0 or x == 8 or y == 8:
                br.set(x, y, hx("#78350F"))
            elif x in (2, 10) and y in (2, 10):
                br.set(x, y, hx("#FDE047"))
            elif (x + y) % 9 == 0:
                br.set(x, y, hx("#D97706"))
    tiles["brass_floor"] = br

    # 29. gear_prop (interlocking clockwork brass gear)
    tiles["gear_prop"] = from_grid([
        "......OOOO......",
        ".....OGGGGO.....",
        "..OO.OGGGGO.OO..",
        ".OGGOOGHHGOOGGO.",
        ".OGGGGOOOOGGGGO.",
        "..OGGO....OGGO..",
        "OOOGG..OO..GGOOO",
        "OGGGO.OSSO.OGGGO",
        "OGGGO.OSSO.OGGGO",
        "OOOGG..OO..GGOOO",
        "..OGGO....OGGO..",
        ".OGGGGOOOOGGGGO.",
        ".OGGOOGDDGOOGGO.",
        "..OO.OGDDGO.OO..",
        ".....OOOOOO.....",
        "................",
    ], {"O": O, "G": hx("#D97706"), "H": hx("#FDE047"), "D": hx("#78350F"), "S": hx("#94A3B8")})

    # 30. cloud_floor (fluffy sunlit skyway cloud)
    cl = Canvas(16, 16, hx("#E0F2FE"))
    for y in range(16):
        for x in range(16):
            if y >= 12 or (x + y) % 9 == 0:
                cl.set(x, y, hx("#BAE6FD"))
            elif y <= 4 and (x * 3 + y) % 5 == 0:
                cl.set(x, y, hx("#FFFFFF"))
    tiles["cloud_floor"] = cl

    # 31. star_tile (midnight starfield floor)
    st = Canvas(16, 16, hx("#0B1026"))
    for sx, sy, col in [(3, 3, "#FEF08A"), (11, 5, "#38BDF8"), (6, 12, "#F8FAFC"), (13, 11, "#C084FC"), (2, 9, "#7DD3FC")]:
        st.set(sx, sy, hx(col))
    tiles["star_tile"] = st

    # 32. crystal_pillar (glowing cyan/magenta prism spire)
    tiles["crystal_pillar"] = from_grid([
        ".......OO.......",
        "......OHHO......",
        ".....OHCCHO.....",
        "....OHCCCCHO....",
        "....OCHHHCCO....",
        "...OCCCCCCCCO...",
        "...OCCCMMCCCO...",
        "...OCCMMMHCCO...",
        "...OCCCCCCCCO...",
        "....OCCBBCCO....",
        "....OBBBBBBO....",
        "...OOBBBBBBOO...",
        "..OSSSSSSSSSSO..",
        "..OOOOOOOOOOOO..",
        "................",
        "................",
    ], {"O": O, "H": hx("#F0F9FF"), "C": hx("#38BDF8"), "M": hx("#E879F9"), "B": hx("#0284C7"), "S": hx("#64748B")})

    # 33. pine_tree (tall alpine evergreen pine)
    tiles["pine_tree"] = from_grid([
        ".......OO.......",
        "......OGGO......",
        ".....OGHHGO.....",
        "....OGGGGGGO....",
        "...OGGDDDDGGO...",
        "....OOGGGGOO....",
        "...OGGHHGGGGO...",
        "..OGGGGGGGGGGO..",
        ".OGGGDDDDDDGGGO.",
        "..OOOGGGGGGOOO..",
        ".OGGGGGGGGGGGGO.",
        "OGGDDDDDDDDDDGGO",
        ".OOOOOOTTOOOOOO.",
        "......OTTO......",
        "......OOOO......",
        "................",
    ], {"O": O, "G": hx("#15803D"), "H": hx("#4ADE80"), "D": hx("#14532D"), "T": hx("#78350F")})

    # 34. column (carved stone/marble classical pillar)
    tiles["column"] = from_grid([
        "..OOOOOOOOOOOO..",
        ".OHHHHHHHHHHHHO.",
        ".OLLLLLLLLLLLL0.".replace("0", "O"),
        "..OOLLLLLLLLOO..",
        "...OLHLLLLDLO...",
        "...OLHLLLLDLO...",
        "...OLHLLLLDLO...",
        "...OLHLLLLDLO...",
        "...OLHLLLLDLO...",
        "...OLHLLLLDLO...",
        "...OLHLLLLDLO...",
        "..OOLLLLLLLLOO..",
        ".OLLLLLLLLLLLLO.",
        ".ODDDDDDDDDDDDO.",
        "..OOOOOOOOOOOO..",
        "................",
    ], {"O": O, "H": hx("#F8FAFC"), "L": hx("#CBD5E1"), "D": hx("#64748B")})

    # 35. flower_bed (lush wildflower & mushroom patch)
    fb = tiles["grass"].copy()
    for fx, fy, col in [(3, 4, "#F43F5E"), (4, 4, "#FDE047"), (11, 3, "#C084FC"), (12, 3, "#F8FAFC"),
                        (6, 10, "#38BDF8"), (7, 10, "#FDE047"), (12, 11, "#FB7185"), (2, 12, "#FACC15")]:
        fb.set(fx, fy, hx(col))
    tiles["flower_bed"] = fb

    return tiles


# ---------------------------------------------------------------------------
# 5 NPC & Dragon Sprites (16x16 in both 8bit and 16bit)
# ---------------------------------------------------------------------------
def build_npcs(era: str) -> Dict[str, Canvas]:
    is16 = era == "16bit"
    O = hx("#14121D") if is16 else hx("#101018")
    E = hx("#1E1B2E")

    # 1. elder_ada
    ada = from_grid([
        ".....OOOOOO.....",
        "....OHHHHHHO....",
        "...OHHMMMMHHO...",
        "...OMESSSSEMO...",
        "...OMSSSSSSMO...",
        "....OSSSSSSO....",
        "....OOTTTTOO..G.",
        "...OTTTGGTTTO.W.",
        "...OTTTTTTTTO.W.",
        "...OTTDGGDTTO.W.",
        "....OTTTTTTO..W.",
        "....ODDDDDDO..W.",
        "....OOOOOOOO..O.",
        "................",
        "................",
        "................",
    ], {
        "O": O, "E": E,
        "H": hx("#F1F5F9"), "M": hx("#CBD5E1"),
        "S": hx("#E6B98A") if is16 else hx("#F0C8A0"),
        "T": hx("#0D9488") if is16 else hx("#14B8A6"),
        "D": hx("#115E59"),
        "G": hx("#FACC15"),
        "W": hx("#8B5A2B"),
    })

    # 2. bram
    bram = from_grid([
        ".....OOOOOO.....",
        "....OCCCCCC0....".replace("0", "O"),
        "...OCGGGGGGCO...",
        "...OBSSSSSSBO...",
        "...OBESSSSEBO...",
        "....OBBBBBBO....",
        "...OOLLLLLLOO...",
        "..OLLLLMMLLLLO..",
        "..OLLMMAAMMLLO..",
        "..OLLMMAAMMLLO..",
        "...OOMMMMMMOO...",
        "....ODDOODDO....",
        "....OOOOOOOO....",
        "................",
        "................",
        "................",
    ], {
        "O": O, "E": E,
        "C": hx("#7C4820"),
        "G": hx("#38BDF8"),
        "S": hx("#E6B98A"),
        "B": hx("#92400E"),
        "L": hx("#B45309") if is16 else hx("#C88A4B"),
        "M": hx("#78350F"),
        "A": hx("#94A3B8"),
        "D": hx("#451A03"),
    })

    # 3. spark (Realm 1 Lightning/Gold Dragon)
    spark = from_grid([
        "...Y........Y...",
        "..OYO.OOOO.OYO..",
        "...OOGGGGGGOO...",
        "..OGGGEGGEGGGO..",
        ".OWWOGGGGGGOOWW.",
        ".OwwOGYYYYGOwwO.",
        "..OOOGYYYYGOOO..",
        ".....OGGGGO.....",
        "....OGGYYGGO....",
        "....OGG..GGO....",
        "...OOG....GOO...",
        "....OO....OO....",
        "................",
        "................",
        "................",
        "................",
    ], {
        "O": O, "E": E,
        "G": hx("#F59E0B") if is16 else hx("#FACC15"),
        "Y": hx("#FEF08A"),
        "W": hx("#38BDF8"),
        "w": hx("#0284C7"),
    })

    # 4. pebble (Realm 2 Mossy Earth Dragon)
    pebble = from_grid([
        "......OOOO......",
        "...O.OCCCCC.O...",
        "..OSSOSSSSOSSO..",
        "..OSSESSSSESSSO.".replace("SSSO.", "SSO.."),
        ".OmmOSSSSSSOmmO.",
        ".OmmOSLLLLSOmmO.",
        "..OOOSSSSSSOOO..",
        "....OSSSSSSO....",
        "...OSSLLLLSSO...",
        "...OSS....SSO...",
        "...OOD....DOO...",
        "....OO....OO....",
        "................",
        "................",
        "................",
        "................",
    ], {
        "O": O, "E": E,
        "C": hx("#4ADE80"),
        "S": hx("#64748B") if is16 else hx("#78808C"),
        "L": hx("#CBD5E1"),
        "m": hx("#22C55E"),
        "D": hx("#334155"),
    })

    # 5. lord_null (Glitch-shadow villain)
    lord_null = from_grid([
        "....OOOOOOOO....",
        "...OVVVVVVVVO...",
        "..OVVOOOOOOVVO..",
        "..OVOMOOOOOMVO..",
        "..OVOOOOOOOOO0..".replace("0", "O"),
        "...OOVVVVVVOO...",
        "..OVVVCCCCVVVO..",
        ".OVVVVCCCCVVVVO.",
        ".OVVVVVCCVVVVVO.",
        "..OVVVVVVVVVVO..",
        "..OVVOOVVOOVVO..",
        "...OO..OO..OO...",
        "................",
        "................",
        "................",
        "................",
    ], {
        "O": O,
        "V": hx("#3B0764") if is16 else hx("#4C1D95"),
        "M": hx("#F43F5E"),
        "C": hx("#EC4899"),
    })

    # 6. emberwing (Realm 3 Crimson & Molten-Gold Flame Dragon Guardian)
    emberwing = from_grid([
        "..O..Y....Y..O..",
        ".OHO.ORRRRO.OHO.",
        "..OORRRRRRRROO..",
        ".OORRERGGERROO..",
        "OWFFORRRRRROFFWO",
        "OwwFORGGGGROFwwO",
        ".OOFORGGGGROFOO.",
        "..OO.ORGGRO.OO..",
        "....ORRGGRO..Y..",
        "....ORR..RROFY..",
        "...OOR....ROO...",
        "....OO....OO....",
        "................",
        "................",
        "................",
        "................",
    ], {
        "O": O, "E": E,
        "R": hx("#DC2626") if is16 else hx("#E11D48"),
        "F": hx("#F97316"),
        "W": hx("#FB923C") if is16 else hx("#F97316"),
        "w": hx("#991B1B"),
        "G": hx("#FACC15"),
        "Y": hx("#FEF08A"),
        "H": hx("#FDE68A"),
    })

    # 7. glacier (Realm 4 Icy Cyan, Frost-Blue & Silver-White Ice Wyvern)
    glacier = from_grid([
        "...W..OOOO..W...",
        "..OWO.OSSO.OWO..",
        "...OOCSSSSCOO...",
        "..OCCESSSSECCO..",
        "OWWCOCCSSCCOCWWO",
        "ObbCOCCWWCCOCbbO",
        ".OOOCOCCWWCOCOO.",
        "...OO.OCCO.OO...",
        "....OCCWWCCO....",
        "....OCC..CCO....",
        "...OOb....bOO...",
        "....OO....OO....",
        "................",
        "................",
        "................",
        "................",
    ], {
        "O": O, "E": E,
        "W": hx("#F8FAFC"),
        "S": hx("#BAE6FD") if is16 else hx("#E0F2FE"),
        "C": hx("#38BDF8") if is16 else hx("#0EA5E9"),
        "b": hx("#0369A1"),
    })

    # 8. bramble (Realm 5 Emerald, Moss-Green & Warm Bark Forest Dragon)
    bramble = from_grid([
        "..B..O....O..B..",
        ".OBBOOGGGGOOBBO.",
        "..OOOGLLLLGOOO..",
        "..OGGEGLLGEGGO..",
        "OmmGOGGGGGOGGmmO",
        "OdmGOGMMMMOGGmdO",
        ".OOOGOGMMGOGOOO.",
        "...OO.OGGO.OO...",
        "....OGGMMGGO....",
        "....OGG..GGO....",
        "...OOB....BOO...",
        "....OO....OO....",
        "................",
        "................",
        "................",
        "................",
    ], {
        "O": O, "E": E,
        "B": hx("#92400E") if is16 else hx("#7C4820"),
        "L": hx("#86EFAC") if is16 else hx("#4ADE80"),
        "G": hx("#16A34A") if is16 else hx("#22C55E"),
        "M": hx("#BEF264"),
        "m": hx("#4ADE80"),
        "d": hx("#14532D"),
    })

    # 9. mire (Realm 6 Deep Teal, Bioluminescent Lime & Slate Swamp Dragon)
    mire = from_grid([
        "....L.OOOO.L....",
        "...OLOTTTTOLO...",
        "..OOTTTLLTTTOO..",
        "..OTTLSTTSLTTO..",
        "OSSTOTTLLTOTTSOO".replace("TSOO", "TSSO"),
        "OdSTOTTLLTOTTsdO",
        ".OOOTOTTTTOTOOO.",
        "...OO.OTTO.OO...",
        "....OTTLSTTO....",
        "....OTT..TTO....",
        "...OOd....dOO...",
        "....OO....OO....",
        "................",
        "................",
        "................",
        "................",
    ], {
        "O": O,
        "T": hx("#0F766E") if is16 else hx("#115E59"),
        "S": hx("#64748B") if is16 else hx("#475569"),
        "s": hx("#334155"),
        "d": hx("#1E293B"),
        "L": hx("#A3E635") if is16 else hx("#BEF264"),
    })

    return {
        "elder_ada": ada,
        "bram": bram,
        "spark": spark,
        "pebble": pebble,
        "lord_null": lord_null,
        "emberwing": emberwing,
        "glacier": glacier,
        "bramble": bramble,
        "mire": mire,
    }


# ---------------------------------------------------------------------------
# Tiny 5x7 Pixel Font for Comparison Header
# ---------------------------------------------------------------------------
FONT_5X7: Dict[str, List[str]] = {
    "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "B": ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
    "C": [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
    "D": ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
    "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    "F": ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
    "G": [".####", "#....", "#....", "#..##", "#...#", "#...#", ".####"],
    "H": ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "I": [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
    "L": ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
    "M": ["#...#", "##.##", "#.#.#", "#...#", "#...#", "#...#", "#...#"],
    "N": ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
    "O": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "P": ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
    "R": ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
    "S": [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "U": ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "V": ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
    "W": ["#...#", "#...#", "#...#", "#...#", "#.#.#", "##.##", "#...#"],
    "X": ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
    "Y": ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
    "0": [".###.", "#..##", "#.#.#", "#.#.#", "##..#", "#...#", ".###."],
    "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
    "2": [".###.", "#...#", "....#", "..##.", ".#...", "#....", "#####"],
    "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
    "4": ["#...#", "#...#", "#...#", "#####", "....#", "....#", "....#"],
    "6": [".###.", "#....", "####.", "#...#", "#...#", "#...#", ".###."],
    "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
    "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
    ":": [".....", "..#..", "..#..", ".....", "..#..", "..#..", "....."],
    "(": ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."],
    ")": [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."],
    " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
}


def draw_text(c: Canvas, x: int, y: int, text: str, color: RGBA, scale: int = 1) -> None:
    cx = x
    for ch in text.upper():
        glyph = FONT_5X7.get(ch, FONT_5X7[" "])
        for gy, row in enumerate(glyph):
            for gx, bit in enumerate(row):
                if bit == "#":
                    c.rect(cx + gx * scale, y + gy * scale, scale, scale, color)
        cx += 6 * scale


def render_map_canvas(
    map_data: dict,
    tiles: Dict[str, Canvas],
    npcs: Dict[str, Canvas],
) -> Canvas:
    ts = next(iter(tiles.values())).w if tiles else TILE_SIZE
    w = map_data["width"] * ts
    h = map_data["height"] * ts
    c = Canvas(w, h)
    ground = map_data["layers"]["ground"]
    decor = map_data["layers"]["decor"]
    for y in range(map_data["height"]):
        for x in range(map_data["width"]):
            gt = ground[y][x]
            if gt in tiles:
                c.blit(tiles[gt], x * ts, y * ts)
            dt = decor[y][x]
            if dt and dt in tiles:
                c.blit(tiles[dt], x * ts, y * ts)
    for ent in map_data.get("entities", []):
        sk = ent.get("spriteKey")
        ex, ey = ent["x"] * ts, ent["y"] * ts
        if sk in npcs:
            c.blit(npcs[sk], ex, ey)
        elif sk in tiles and decor[ent["y"]][ent["x"]] != sk:
            c.blit(tiles[sk], ex, ey)
    # Draw subtle golden spawn highlight marker
    sp = map_data.get("spawn")
    if sp:
        s = ts // 16
        sx, sy = sp["x"] * ts, sp["y"] * ts
        c.rect(sx + 5 * s, sy + 4 * s, 6 * s, 8 * s, hx("#248F55"))
        c.rect(sx + 5 * s, sy + 2 * s, 6 * s, 4 * s, hx("#C98F5D"))
        c.rect(sx + 4 * s, sy + 1 * s, 8 * s, 2 * s, hx("#8E4F22"))
        c.rect(sx + 6 * s, sy + 4 * s, s, s, hx("#1E1B2E"))
        c.rect(sx + 9 * s, sy + 4 * s, s, s, hx("#1E1B2E"))
    return c


def upscale_to_snes32(src: Canvas, is_sprite: bool = False) -> Canvas:
    """Upgrades a 16x16 base tile/sprite into a true 32x32 SNES 16-Bit pixel-art tile
    with 4x pixel density, directional top-left sunlight bevels, colored outlines,
    micro-dithered texture detail, specular highlights, and soft sprite drop shadows.
    """
    out = Canvas(32, 32, TRANSPARENT)

    def clamp(v: int) -> int:
        return max(0, min(255, v))

    def shift_rgb(c: RGBA, dr: int, dg: int, db: int) -> RGBA:
        if c[3] == 0:
            return TRANSPARENT
        return (clamp(c[0] + dr), clamp(c[1] + dg), clamp(c[2] + db), c[3])

    def luma(c: RGBA) -> float:
        return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]

    # Soft SNES oval shadow underneath opaque sprite feet
    if is_sprite:
        for y in range(26, 31):
            for x in range(7, 25):
                dx = (x - 15.5) / 8.5
                dy = (y - 28.0) / 2.4
                if dx * dx + dy * dy <= 1.0:
                    out.set(x, y, (10, 14, 28, 95))

    # Detect seamless opaque tiles (ground/floor tiles whose outer border is fully opaque)
    # so we wrap neighbor lookups instead of beveling the 32x32 tile boundary into a grid.
    is_seamless = (
        not is_sprite
        and all(src.get(x, 0)[3] == 255 and src.get(x, 15)[3] == 255 for x in range(16))
        and all(src.get(0, y)[3] == 255 and src.get(15, y)[3] == 255 for y in range(16))
    )

    def sample(x: int, y: int) -> RGBA:
        if is_seamless:
            return src.get(x % 16, y % 16)
        return src.get(x, y)

    for sy in range(16):
        for sx in range(16):
            c = src.get(sx, sy)
            if c[3] == 0:
                continue

            up = sample(sx, sy - 1)
            dn = sample(sx, sy + 1)
            lt = sample(sx - 1, sy)
            rt = sample(sx + 1, sy)

            # Soften harsh pure-black NES outlines into rich SNES deep indigo/umber
            is_dark_outline = (c[0] < 38 and c[1] < 38 and c[2] < 48)
            if is_dark_outline:
                # Find brightest adjacent neighbor to tint the outline
                nbrs = [n for n in (up, dn, lt, rt) if n[3] > 0 and not (n[0] < 38 and n[1] < 38 and n[2] < 48)]
                if nbrs:
                    avg_r = sum(n[0] for n in nbrs) // len(nbrs)
                    avg_g = sum(n[1] for n in nbrs) // len(nbrs)
                    avg_b = sum(n[2] for n in nbrs) // len(nbrs)
                    c = (clamp(avg_r // 4 + 12), clamp(avg_g // 4 + 10), clamp(avg_b // 4 + 20), c[3])

            # 2x2 subpixel SNES shading: top-left gets warm sunlight, bottom-right gets cool shadow
            for oy in (0, 1):
                for ox in (0, 1):
                    px = sx * 2 + ox
                    py = sy * 2 + oy
                    col = c

                    # Bevel & edge lighting based on neighboring pixels
                    if not is_dark_outline:
                        if oy == 0 and (up[3] == 0 or luma(up) + 28 < luma(c)):
                            col = shift_rgb(col, 22, 20, 14)  # sunlit top rim
                        elif oy == 1 and (dn[3] == 0 or luma(dn) + 28 < luma(c)):
                            col = shift_rgb(col, -20, -18, -10)  # shaded bottom edge
                        if ox == 0 and (lt[3] == 0 or luma(lt) + 28 < luma(c)):
                            col = shift_rgb(col, 14, 14, 10)  # sunlit left rim
                        elif ox == 1 and (rt[3] == 0 or luma(rt) + 28 < luma(c)):
                            col = shift_rgb(col, -16, -14, -8)  # shaded right edge

                        # Extra specular glint on bright highlights (gems, eyes, water, ice, gold)
                        if luma(c) > 205 and ox == 0 and oy == 0:
                            col = shift_rgb(col, 24, 24, 20)

                    # Round off staircase outer corners on sprites for smoother 16-bit silhouettes
                    if is_sprite and is_dark_outline:
                        if ox == 0 and oy == 0 and up[3] == 0 and lt[3] == 0:
                            continue
                        if ox == 1 and oy == 0 and up[3] == 0 and rt[3] == 0:
                            continue
                        if ox == 0 and oy == 1 and dn[3] == 0 and lt[3] == 0:
                            continue
                        if ox == 1 and oy == 1 and dn[3] == 0 and rt[3] == 0:
                            continue

                    out.set(px, py, col)

    return out


def build_snes_tiles_32(base_16_tiles: Dict[str, Canvas]) -> Dict[str, Canvas]:
    """Builds genuine, native 32x32 SNES (A Link to the Past / Chrono Trigger) tiles
    with organic multi-tone foliage, rounded masonry, smooth water waves, timber bridges,
    and colored outlines — falling back to refined 2x SNES upscaling for specialty props.
    """
    tiles: Dict[str, Canvas] = {k: upscale_to_snes32(v, is_sprite=False) for k, v in base_16_tiles.items()}

    def fill_ellipse(c: Canvas, cx: float, cy: float, rx: float, ry: float, col: RGBA, blend: bool = False) -> None:
        x0, x1 = max(0, int(cx - rx - 1)), min(c.w - 1, int(cx + rx + 1))
        y0, y1 = max(0, int(cy - ry - 1)), min(c.h - 1, int(cy + ry + 1))
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                dx = (x - cx) / max(0.1, rx)
                dy = (y - cy) / max(0.1, ry)
                if dx * dx + dy * dy <= 1.0:
                    if blend:
                        c.blend(x, y, col)
                    else:
                        c.set(x, y, col)

    def draw_blade_tuft(c: Canvas, x: int, y: int, dk: RGBA, mid: RGBA, hi: RGBA) -> None:
        # 5px wide lush SNES grass tuft with sunlit tip & dark base shadow
        c.set(x, y + 1, dk); c.set(x + 1, y + 2, dk); c.set(x + 2, y + 2, dk); c.set(x + 3, y + 1, dk)
        c.set(x - 1, y, mid); c.set(x + 1, y + 1, mid); c.set(x + 2, y + 1, mid); c.set(x + 4, y, mid)
        c.set(x, y - 1, hi); c.set(x + 2, y, hi); c.set(x + 3, y - 1, hi)

    # 1. SNES Grass (32x32 seamless lush meadow — subtle grain, zero polka-dot repeat)
    g_base = hx("#43A64A")
    g_warm = hx("#4EB351")
    g_sun  = hx("#7ED968")
    g_mid  = hx("#379241")
    g_dk   = hx("#236B33")
    grass = Canvas(32, 32, g_base)
    for y in range(32):
        for x in range(32):
            n = (x * 13 + y * 29 + (x * y) * 3) % 23
            if n in (0, 7, 14):
                grass.set(x, y, g_warm)
            elif n in (3, 11):
                grass.set(x, y, g_mid)
    for tx, ty in ((4, 6), (18, 4), (26, 14), (11, 18), (5, 27), (22, 26)):
        draw_blade_tuft(grass, tx, ty, g_dk, g_mid, g_sun)
    tiles["grass"] = grass

    # 2. SNES Grass Flower (32x32 lush meadow with detailed multi-petal wildflowers)
    gf = grass.copy()
    def draw_flower(c: Canvas, fx: int, fy: int, pet: RGBA, hi: RGBA, ctr: RGBA, leaf: RGBA) -> None:
        c.set(fx - 1, fy + 2, leaf); c.set(fx, fy + 2, leaf); c.set(fx + 1, fy + 2, leaf)
        c.set(fx, fy + 3, g_dk)
        for ox, oy, col in (
            (0, -2, hi), (-1, -1, hi), (1, -1, pet),
            (-2, 0, pet), (2, 0, pet),
            (-1, 1, pet), (1, 1, pet), (0, 2, pet),
        ):
            c.set(fx + ox, fy + oy, col)
        c.set(fx, fy, ctr); c.set(fx, fy - 1, ctr)

    draw_flower(gf, 8, 8, hx("#E2E8F0"), hx("#FFFFFF"), hx("#FACC15"), g_dk)
    draw_flower(gf, 23, 19, hx("#F472B6"), hx("#FBCFE8"), hx("#FEF08A"), g_dk)
    draw_flower(gf, 11, 24, hx("#60A5FA"), hx("#DBEAFE"), hx("#FEF08A"), g_dk)
    tiles["grass_flower"] = gf

    # 3. SNES Flower Bed (rich wildflower & tiny mushroom garden)
    fb = gf.copy()
    draw_flower(fb, 22, 7, hx("#C084FC"), hx("#F3E8FF"), hx("#FDE047"), g_dk)
    draw_flower(fb, 5, 16, hx("#FB7185"), hx("#FFE4E6"), hx("#FACC15"), g_dk)
    # Tiny red-capped toadstool
    fb.rect(25, 25, 4, 2, hx("#EF4444"))
    fb.rect(26, 24, 2, 1, hx("#FCA5A5"))
    fb.set(26, 25, hx("#FFFFFF")); fb.set(28, 25, hx("#FFFFFF"))
    fb.rect(26, 27, 2, 2, hx("#F8FAFC"))
    tiles["flower_bed"] = fb

    # 4. SNES Dirt Path (seamless warm packed earth with fine grain & tiny pebbles)
    d_base = hx("#C89E6A")
    d_hi   = hx("#D6AF7C")
    d_lt   = hx("#E6C698")
    d_mid  = hx("#B88B57")
    d_dk   = hx("#94693D")
    dirt = Canvas(32, 32, d_base)
    for y in range(32):
        for x in range(32):
            n = (x * 17 + y * 31 + (x * y) * 5) % 29
            if n in (0, 8, 17):
                dirt.set(x, y, d_hi)
            elif n in (4, 13, 22):
                dirt.set(x, y, d_mid)
    # Subtle small pebbles (sunlit top, warm underside)
    for px, py in ((6, 7), (21, 11), (12, 22), (26, 25)):
        dirt.set(px, py, d_lt); dirt.set(px + 1, py, d_hi)
        dirt.set(px, py + 1, d_dk); dirt.set(px + 1, py + 1, d_mid)
    tiles["dirt_path"] = dirt

    # 5. SNES Sand (warm golden beach with gentle wind ripples & tiny shell)
    s_base = hx("#F2D28B")
    s_hi   = hx("#FBE4A8")
    s_mid  = hx("#DEB568")
    s_dk   = hx("#BA8E44")
    sand = Canvas(32, 32, s_base)
    for y in range(32):
        for x in range(32):
            wave = (y + (x // 6)) % 8
            if wave == 0:
                sand.set(x, y, s_hi)
            elif wave == 1:
                sand.set(x, y, s_mid)
    for px, py in ((7, 9), (22, 17), (12, 26)):
        sand.set(px, py, hx("#FFFBEB")); sand.set(px + 1, py, s_hi); sand.set(px + 1, py + 1, s_dk)
    tiles["sand"] = sand

    # 6. SNES Water (rich layered turquoise-to-cobalt water with curved wave crests)
    w_deep = hx("#1768B8")
    w_mid  = hx("#1E82D2")
    w_lt   = hx("#38A5EB")
    w_foam = hx("#9EE0FF")
    w_hi   = hx("#E0F7FF")
    water = Canvas(32, 32, w_mid)
    for y in range(32):
        band = (y // 4) % 2
        if band == 0:
            for x in range(32):
                water.set(x, y, w_deep if (x + y) % 8 < 3 else w_mid)
    # Smooth curved SNES wave crests
    for wx, wy in ((3, 5), (18, 12), (7, 21), (20, 27)):
        for i in range(9):
            curve = -1 if 2 <= i <= 6 else 0
            px = (wx + i) % 32
            py = (wy + curve) % 32
            water.set(px, py, w_foam if 2 <= i <= 6 else w_lt)
            if 3 <= i <= 5:
                water.set(px, (py - 1) % 32, w_hi)
            water.set(px, (py + 1) % 32, w_deep)
    tiles["water"] = water

    # 7. SNES Wooden Bridge (ALTTP-style grained timber planks + vertical posts & rails)
    br_dk  = hx("#4A2A14")
    br_md  = hx("#7B4B24")
    br_lt  = hx("#A86E3B")
    br_hi  = hx("#C9925A")
    br_out = hx("#2C180B")
    bridge = Canvas(32, 32, br_md)
    for y in range(0, 32, 4):
        bridge.rect(3, y, 26, 1, br_dk)
        bridge.rect(3, y + 1, 26, 1, br_hi)
        bridge.rect(3, y + 2, 26, 1, br_lt)
        bridge.rect(3, y + 3, 26, 1, br_md)
        # Subtle plank woodgrain & iron nails
        bridge.set(5, y + 2, br_out); bridge.set(26, y + 2, br_out)
        grain_x = 9 + ((y * 5) % 12)
        bridge.rect(grain_x, y + 2, 4, 1, br_dk)
    # Side timber rails with sunlit inner bevels and sturdy posts
    for rx in (0, 28):
        bridge.rect(rx, 0, 4, 32, br_out)
        bridge.rect(rx + 1, 0, 2, 32, br_md)
        bridge.rect(rx + 1, 0, 1, 32, br_hi)
        for py in (2, 18):
            bridge.rect(rx, py, 4, 5, br_out)
            bridge.rect(rx + 1, py + 1, 2, 3, br_lt)
            bridge.rect(rx + 1, py + 1, 2, 1, br_hi)
    # Cast shadow from left rail onto planks
    bridge.rect(4, 0, 2, 32, (20, 12, 6, 75), blend=True)
    tiles["bridge_wood"] = bridge

    # 8. SNES Broken Bridge (splintered timber over SNES water)
    bbrk = water.copy()
    for y in range(0, 8):
        for x in range(32):
            bbrk.set(x, y, bridge.get(x, y))
    for y in range(24, 32):
        for x in range(32):
            bbrk.set(x, y, bridge.get(x, y))
    # Jagged splinters + foam around broken edge
    for sx, sw, sh in ((2, 7, 4), (10, 4, 2), (22, 8, 3)):
        bbrk.rect(sx, 8, sw, sh, br_lt)
        bbrk.rect(sx, 8 + sh - 1, sw, 1, br_out)
        bbrk.rect(sx, 8 + sh, sw, 1, w_foam)
    for sx, sw, sh in ((3, 6, 3), (20, 9, 4)):
        bbrk.rect(sx, 24 - sh, sw, sh, br_md)
        bbrk.rect(sx, 24 - sh, sw, 1, br_hi)
    tiles["bridge_broken"] = bbrk

    # 9. SNES Stone Floor (beveled dungeon flagstones with moss in mortar)
    sf_m = hx("#758294")
    sf_h = hx("#9AA7B8")
    sf_l = hx("#B8C4D4")
    sf_d = hx("#4B5566")
    sf_g = hx("#2F3744")
    sfloor = Canvas(32, 32, sf_m)
    # 2x2 offset flagstones
    blocks = [(0, 0, 16, 16), (16, 0, 16, 16), (0, 16, 10, 16), (10, 16, 16, 16), (26, 16, 6, 16)]
    for bx, by, bw, bh in blocks:
        sfloor.rect(bx, by, bw, bh, sf_g)
        if bw > 2 and bh > 2:
            sfloor.rect(bx + 1, by + 1, bw - 2, bh - 2, sf_m)
            sfloor.rect(bx + 1, by + 1, bw - 2, 2, sf_h)
            sfloor.rect(bx + 1, by + 1, 2, bh - 2, sf_h)
            sfloor.set(bx + 1, by + 1, sf_l)
            sfloor.rect(bx + 1, by + bh - 2, bw - 2, 1, sf_d)
            sfloor.rect(bx + bw - 2, by + 1, 1, bh - 2, sf_d)
    # Tiny moss flecks in crevices
    for mx, my in ((15, 15), (16, 15), (15, 16), (9, 16), (10, 17), (25, 30), (26, 30)):
        sfloor.set(mx, my, hx("#4ADE80") if (mx + my) % 2 == 0 else hx("#16A34A"))
    tiles["stone_floor"] = sfloor

    # 10. SNES Stone Wall (carved mossy masonry cliff/wall with rounded stones & vines)
    sw_cap_hi = hx("#A8B5C4")
    sw_cap    = hx("#8291A3")
    sw_face   = hx("#586578")
    sw_hi     = hx("#738296")
    sw_dk     = hx("#36404F")
    sw_crev   = hx("#1F2633")
    swall = Canvas(32, 32, sw_crev)
    # Sunlit beveled top ledge
    swall.rect(0, 0, 32, 2, sw_cap_hi)
    swall.rect(0, 2, 32, 4, sw_cap)
    swall.rect(0, 6, 32, 2, sw_dk)
    # Layered rounded masonry courses
    courses = [
        (8, 8, [(0, 11), (11, 12), (23, 9)]),
        (16, 8, [(0, 7), (7, 13), (20, 12)]),
        (24, 8, [(0, 12), (12, 10), (22, 10)]),
    ]
    for cy, ch, segs in courses:
        for sx, sw in segs:
            swall.rect(sx + 1, cy + 1, sw - 2, ch - 2, sw_face)
            swall.rect(sx + 2, cy + 1, max(1, sw - 4), 2, sw_hi)
            swall.rect(sx + 1, cy + ch - 2, sw - 2, 1, sw_dk)
            swall.rect(sx + sw - 2, cy + 2, 1, ch - 3, sw_dk)
    # Lush hanging moss vines draping over the top ledge
    for vx, vlen in ((4, 9), (6, 6), (20, 8), (22, 11), (24, 5)):
        for dy in range(vlen):
            col = hx("#68C959") if dy < 2 else (hx("#2E8F40") if dy < vlen - 2 else hx("#1B5E2E"))
            swall.set(vx, 3 + dy, col)
            if dy < vlen - 2:
                swall.set(vx + 1, 3 + dy, hx("#2E8F40"))
    tiles["stone_wall"] = swall

    # 11. SNES Oak Tree (32x32 lush multi-cluster canopy + textured bark trunk & roots)
    tr_out = hx("#123524")
    tr_dk  = hx("#1B5E2E")
    tr_mid = hx("#2D8A3E")
    tr_lt  = hx("#4DB849")
    tr_hi  = hx("#8BE066")
    bk_out = hx("#2A180D")
    bk_dk  = hx("#59331B")
    bk_mid = hx("#7F4C28")
    bk_hi  = hx("#A86E3E")
    tree = Canvas(32, 32, TRANSPARENT)
    # Textured trunk with flaring roots
    tree.rect(12, 19, 8, 10, bk_out)
    tree.rect(13, 20, 6, 9, bk_mid)
    tree.rect(13, 20, 2, 9, bk_hi)
    tree.rect(17, 20, 2, 9, bk_dk)
    # Roots
    tree.rect(10, 27, 12, 3, bk_out)
    tree.rect(11, 28, 10, 2, bk_dk)
    tree.rect(12, 27, 4, 2, bk_hi)
    # Dark canopy outline silhouette (layered leaf puffs)
    puffs = [(16, 12, 12.5, 9.5), (9, 14, 7.2, 6.2), (23, 14, 7.2, 6.2), (16, 7, 8.5, 6.0)]
    for cx, cy, rx, ry in puffs:
        fill_ellipse(tree, cx, cy, rx, ry, tr_out)
    for cx, cy, rx, ry in puffs:
        fill_ellipse(tree, cx, cy, rx - 1.2, ry - 1.2, tr_dk)
    # Midtone leafy clusters
    for cx, cy, rx, ry in ((16, 11, 10.5, 7.2), (9.5, 13, 5.5, 4.5), (22.5, 13, 5.5, 4.5), (16, 6.8, 7.0, 4.6)):
        fill_ellipse(tree, cx, cy, rx, ry, tr_mid)
    # Sunlit upper-left foliage crowns
    for cx, cy, rx, ry in ((14, 6.5, 5.8, 3.6), (9.5, 11.2, 4.2, 2.8), (19.5, 9.5, 4.5, 3.0)):
        fill_ellipse(tree, cx, cy, rx, ry, tr_lt)
    for cx, cy, rx, ry in ((13.5, 5.5, 3.5, 2.0), (8.8, 10.4, 2.4, 1.5), (19.0, 8.4, 2.5, 1.4)):
        fill_ellipse(tree, cx, cy, rx, ry, tr_hi)
    # Under-canopy shadow on top of trunk
    tree.rect(13, 20, 6, 2, bk_out)
    tiles["tree"] = tree

    # 12. SNES Pine Tree (3-tier lush alpine evergreen)
    pine = Canvas(32, 32, TRANSPARENT)
    pine.rect(13, 25, 6, 6, bk_out)
    pine.rect(14, 25, 4, 5, bk_mid)
    pine.rect(14, 25, 2, 5, bk_hi)
    tiers = [(24, 13), (17, 10), (10, 7)]
    for base_y, half_w in tiers:
        for dy in range(10):
            y = base_y - dy
            w = max(1, int(half_w * (1.0 - dy / 10.5)))
            pine.rect(16 - w - 1, y, (w + 1) * 2, 1, tr_out)
            if w >= 1:
                pine.rect(16 - w, y, w * 2, 1, tr_dk if dy < 2 else tr_mid)
                pine.rect(16 - w, y, max(1, w), 1, tr_lt if dy >= 3 else tr_mid)
                if dy >= 5:
                    pine.rect(16 - max(1, w - 1), y, max(1, w // 2 + 1), 1, tr_hi)
    tiles["pine_tree"] = pine

    # 13. SNES Bush (lush rounded berry shrub with sunlit top & dark-green outline)
    bush = Canvas(32, 32, TRANSPARENT)
    for cx, cy, rx, ry in ((16, 17, 11.5, 7.5), (10, 18, 6.8, 5.5), (22, 18, 6.8, 5.5)):
        fill_ellipse(bush, cx, cy, rx, ry, tr_out)
    for cx, cy, rx, ry in ((16, 17, 10.3, 6.3), (10, 18, 5.6, 4.3), (22, 18, 5.6, 4.3)):
        fill_ellipse(bush, cx, cy, rx, ry, tr_dk)
    for cx, cy, rx, ry in ((15.5, 15.5, 9.0, 5.0), (10.5, 16.5, 4.6, 3.2), (21.0, 16.5, 4.6, 3.2)):
        fill_ellipse(bush, cx, cy, rx, ry, tr_mid)
    for cx, cy, rx, ry in ((14.5, 13.5, 6.0, 2.8), (10.5, 14.8, 3.2, 1.8)):
        fill_ellipse(bush, cx, cy, rx, ry, tr_lt)
    fill_ellipse(bush, 13.5, 12.6, 3.2, 1.3, tr_hi)
    # Gleaming berries
    for bx, by in ((11, 16), (20, 15), (15, 19)):
        bush.rect(bx, by, 2, 2, hx("#E11D48"))
        bush.set(bx, by, hx("#FDA4AF"))
    tiles["bush"] = bush

    # 14. SNES Lava (glowing swirling magma ribbons)
    lava = Canvas(32, 32, hx("#B91C1C"))
    for y in range(32):
        for x in range(32):
            v = ((x * 2 + y) % 16)
            w = ((x - y * 2) % 16)
            if v in (0, 1) or w == 0:
                lava.set(x, y, hx("#F97316"))
            if (x + y * 2) % 16 in (3, 4) and (x * 3 + y) % 8 < 3:
                lava.set(x, y, hx("#FACC15"))
            if (x * 4 + y * 4) % 16 == 0 and (x + y) % 8 == 0:
                lava.set(x, y, hx("#FEF08A"))
            if (x + y) % 8 == 0 and (x * 2 - y) % 8 == 0:
                lava.set(x, y, hx("#7F1D1D"))
    tiles["lava"] = lava

    # 15. SNES Coral (vibrant branching reef coral + turquoise fronds & pearl bubbles)
    cor = Canvas(32, 32, TRANSPARENT)
    c_out = hx("#3B1028")
    c_dk  = hx("#BE123C")
    c_md  = hx("#FB7185")
    c_hi  = hx("#FECDD3")
    t_out = hx("#0D3B3E")
    t_dk  = hx("#0F766E")
    t_md  = hx("#2DD4BF")
    t_hi  = hx("#99F6E4")
    # Reef base mound
    fill_ellipse(cor, 16, 23, 11.5, 5.5, c_out)
    fill_ellipse(cor, 16, 23, 10.2, 4.4, c_dk)
    fill_ellipse(cor, 15, 22, 8.8, 3.2, c_md)
    # Left rose coral branches
    for cx, cy, rx, ry in ((9, 13, 4.8, 7.2), (5.5, 16, 3.6, 5.0), (13.5, 15, 3.8, 5.5)):
        fill_ellipse(cor, cx, cy, rx, ry, c_out)
    for cx, cy, rx, ry in ((9, 13, 3.6, 6.0), (5.5, 16, 2.5, 3.8), (13.5, 15, 2.7, 4.4)):
        fill_ellipse(cor, cx, cy, rx, ry, c_md)
    for cx, cy, rx, ry in ((8.4, 10.5, 2.2, 3.2), (5.0, 14.2, 1.5, 2.0), (13.0, 13.0, 1.6, 2.4)):
        fill_ellipse(cor, cx, cy, rx, ry, c_hi)
    # Right turquoise anemone fronds
    for cx, cy, rx, ry in ((22.5, 14, 5.2, 6.8), (26.5, 17, 3.5, 4.8), (18.5, 17, 3.6, 4.5)):
        fill_ellipse(cor, cx, cy, rx, ry, t_out)
    for cx, cy, rx, ry in ((22.5, 14, 4.0, 5.6), (26.5, 17, 2.4, 3.6), (18.5, 17, 2.5, 3.4)):
        fill_ellipse(cor, cx, cy, rx, ry, t_dk)
    for cx, cy, rx, ry in ((22.0, 12.8, 3.2, 4.0), (26.0, 15.8, 1.8, 2.5), (18.2, 15.8, 1.8, 2.2)):
        fill_ellipse(cor, cx, cy, rx, ry, t_md)
    fill_ellipse(cor, 21.5, 10.8, 1.8, 1.8, t_hi)
    # Tiny gleaming bubbles
    for bx, by in ((11, 5), (21, 5), (16, 8)):
        cor.rect(bx, by, 2, 2, hx("#E0F2FE"))
        cor.set(bx, by, hx("#FFFFFF"))
    tiles["coral"] = cor

    # 16. SNES Ice Floor (seamless crystalline glacier floor with specular sheen)
    ice_f = Canvas(32, 32, hx("#BAE6FD"))
    for y in range(32):
        for x in range(32):
            d = (x + y) % 16
            if d in (0, 1):
                ice_f.set(x, y, hx("#E0F2FE"))
            elif d == 2:
                ice_f.set(x, y, hx("#F0F9FF"))
            elif d in (8, 9):
                ice_f.set(x, y, hx("#93C5FD"))
            elif (x - y) % 16 == 0 and (x & 3) == 0:
                ice_f.set(x, y, hx("#7DD3FC"))
    for sx, sy in ((6, 7), (22, 19), (14, 27)):
        ice_f.set(sx, sy, hx("#FFFFFF"))
        ice_f.set(sx + 1, sy, hx("#F0F9FF"))
        ice_f.set(sx, sy + 1, hx("#F0F9FF"))
    tiles["ice_floor"] = ice_f

    # 17. SNES Ice Wall (sculpted jagged crystalline glacier cliff)
    ice_w = Canvas(32, 32, TRANSPARENT)
    iw_o = hx("#0C2D48")
    iw_d = hx("#0369A1")
    iw_m = hx("#0EA5E9")
    iw_l = hx("#7DD3FC")
    iw_h = hx("#F0F9FF")
    peaks = [(9, 26, 8, 20), (22, 26, 8, 22), (16, 27, 10, 16)]
    for cx, base_y, half_w, height in peaks:
        for dy in range(height):
            y = base_y - dy
            w = max(1, int(half_w * (1.0 - dy / (height + 1.0))))
            ice_w.rect(cx - w - 1, y, (w + 1) * 2, 1, iw_o)
            ice_w.rect(cx - w, y, w * 2, 1, iw_m if dy > 4 else iw_d)
            ice_w.rect(cx - w, y, max(1, w), 1, iw_l if dy > 3 else iw_m)
            if dy > height // 2:
                ice_w.rect(cx - max(1, w - 1), y, max(1, w // 2 + 1), 1, iw_h)
    ice_w.rect(2, 26, 28, 3, iw_o)
    ice_w.rect(3, 26, 26, 2, iw_d)
    tiles["ice_wall"] = ice_w

    # 18. SNES Obsidian Floor (seamless beveled volcanic basalt flagstones + violet rune flecks)
    ob_f = Canvas(32, 32, hx("#1E1B2E"))
    ob_blocks = [(0, 0, 16, 16), (16, 0, 16, 16), (0, 16, 10, 16), (10, 16, 16, 16), (26, 16, 6, 16)]
    for bx, by, bw, bh in ob_blocks:
        ob_f.rect(bx, by, bw, bh, hx("#0F0D1A"))
        if bw > 2 and bh > 2:
            ob_f.rect(bx + 1, by + 1, bw - 2, bh - 2, hx("#25203B"))
            ob_f.rect(bx + 1, by + 1, bw - 2, 2, hx("#3B345C"))
            ob_f.rect(bx + 1, by + 1, 2, bh - 2, hx("#3B345C"))
            ob_f.rect(bx + 1, by + bh - 2, bw - 2, 1, hx("#141124"))
    for rx, ry in ((15, 15), (16, 15), (10, 16), (25, 30)):
        ob_f.set(rx, ry, hx("#A855F7"))
    tiles["obsidian_floor"] = ob_f

    # 19. SNES Obsidian Wall (imposing beveled volcanic fortress wall with glowing arcane sigil)
    ob_w = Canvas(32, 32, hx("#0F0A1C"))
    ob_w.rect(0, 0, 32, 2, hx("#6D28D9"))
    ob_w.rect(0, 2, 32, 4, hx("#3B1C6E"))
    ob_w.rect(0, 6, 32, 2, hx("#140B29"))
    for cy, ch, segs in ((8, 8, [(0, 11), (11, 10), (21, 11)]), (16, 8, [(0, 8), (8, 16), (24, 8)]), (24, 8, [(0, 12), (12, 10), (22, 10)])):
        for sx, sw in segs:
            ob_w.rect(sx + 1, cy + 1, sw - 2, ch - 2, hx("#241545"))
            ob_w.rect(sx + 2, cy + 1, max(1, sw - 4), 2, hx("#3D2573"))
            ob_w.rect(sx + 1, cy + ch - 2, sw - 2, 1, hx("#120926"))
    # Glowing carved magenta-violet rune crystal in center
    fill_ellipse(ob_w, 15.5, 16.5, 5.2, 4.5, hx("#0F0A1C"))
    fill_ellipse(ob_w, 15.5, 16.5, 4.0, 3.4, hx("#7C3AED"))
    fill_ellipse(ob_w, 15.0, 15.8, 2.4, 2.0, hx("#C084FC"))
    ob_w.rect(14, 15, 2, 2, hx("#F5D0FE"))
    tiles["obsidian_wall"] = ob_w

    # 20. SNES Brass Floor (seamless riveted brushed-bronze clockwork plates)
    br_f = Canvas(32, 32, hx("#78350F"))
    for py in (0, 16):
        for px in (0, 16):
            br_f.rect(px, py, 16, 16, hx("#451A03"))
            br_f.rect(px + 1, py + 1, 14, 14, hx("#9A4D12"))
            br_f.rect(px + 1, py + 1, 14, 2, hx("#D97706"))
            br_f.rect(px + 1, py + 1, 2, 14, hx("#C26717"))
            br_f.rect(px + 1, py + 14, 14, 1, hx("#612A09"))
            br_f.rect(px + 14, py + 1, 1, 14, hx("#612A09"))
            # Subtle brushed sheen diagonal
            for d in range(4, 11):
                br_f.set(px + d, py + 14 - d, hx("#B45A14"))
            # Gleaming corner brass rivets
            for rx, ry in ((px + 3, py + 3), (px + 12, py + 3), (px + 3, py + 12), (px + 12, py + 12)):
                br_f.set(rx, ry, hx("#FDE047"))
                br_f.set(rx + 1, ry + 1, hx("#5C2808"))
    tiles["brass_floor"] = br_f

    # 21. SNES Gear Prop (sculpted 8-tooth clockwork brass cogwheel with steel axle)
    gear = Canvas(32, 32, TRANSPARENT)
    g_o = hx("#3B1904")
    g_d = hx("#92400E")
    g_m = hx("#D97706")
    g_l = hx("#F59E0B")
    g_h = hx("#FEF08A")
    # 8 gear teeth around perimeter
    teeth = [
        (13, 2, 6, 5), (13, 25, 6, 5), (2, 13, 5, 6), (25, 13, 5, 6),
        (5, 5, 5, 5), (22, 5, 5, 5), (5, 22, 5, 5), (22, 22, 5, 5),
    ]
    for tx, ty, tw, th in teeth:
        gear.rect(tx, ty, tw, th, g_o)
        gear.rect(tx + 1, ty + 1, tw - 2, th - 2, g_m)
        gear.rect(tx + 1, ty + 1, tw - 2, 1, g_h)
    fill_ellipse(gear, 15.5, 15.5, 11.2, 11.2, g_o)
    fill_ellipse(gear, 15.5, 15.5, 9.8, 9.8, g_d)
    fill_ellipse(gear, 15.0, 15.0, 8.8, 8.8, g_m)
    fill_ellipse(gear, 14.2, 14.0, 7.2, 7.2, g_l)
    # Recessed inner cutout ring + steel hub
    fill_ellipse(gear, 15.5, 15.5, 5.8, 5.8, g_o)
    fill_ellipse(gear, 15.5, 15.5, 4.6, 4.6, TRANSPARENT)
    # 4 spokes
    gear.rect(14, 10, 4, 12, g_m); gear.rect(10, 14, 12, 4, g_m)
    fill_ellipse(gear, 15.5, 15.5, 3.6, 3.6, g_o)
    fill_ellipse(gear, 15.5, 15.5, 2.5, 2.5, hx("#94A3B8"))
    gear.set(14, 14, hx("#F8FAFC"))
    tiles["gear_prop"] = gear

    # 22. SNES Cloud Floor (seamless billowy sunlit skyway clouds)
    cld = Canvas(32, 32, hx("#E0F2FE"))
    for px, py, rx, ry, col in (
        (8, 22, 9.5, 6.5, hx("#BAE6FD")),
        (24, 24, 9.5, 6.0, hx("#BAE6FD")),
        (8, 12, 8.5, 6.5, hx("#F0F9FF")),
        (23, 14, 9.0, 6.5, hx("#F0F9FF")),
        (15, 7, 7.5, 5.0, hx("#FFFFFF")),
        (29, 8, 6.5, 4.5, hx("#FFFFFF")),
    ):
        for dy in range(-8, 9):
            for dx in range(-10, 11):
                if (dx / rx) ** 2 + (dy / ry) ** 2 <= 1.0:
                    cld.set((px + dx) % 32, (py + dy) % 32, col)
    tiles["cloud_floor"] = cld

    # 23. SNES Star Tile (seamless deep cosmic nebula with 4-point twinkling stars)
    st_t = Canvas(32, 32, hx("#0B1026"))
    for y in range(32):
        for x in range(32):
            if ((x + y) % 16) < 4 and ((x * 2 - y) % 16) < 6:
                st_t.set(x, y, hx("#15193B"))
            elif ((x - y) % 16) == 0 and (x & 3) == 0:
                st_t.set(x, y, hx("#1E1B4B"))
    for sx, sy, core, halo in (
        (6, 7, "#FEF9C3", "#FACC15"),
        (22, 11, "#E0F2FE", "#38BDF8"),
        (13, 24, "#F5D0FE", "#C084FC"),
        (26, 25, "#FFFFFF", "#94A3B8"),
    ):
        st_t.set(sx, sy, hx(core))
        for ox, oy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            st_t.set((sx + ox) % 32, (sy + oy) % 32, hx(halo))
    for sx, sy in ((3, 18), (16, 4), (29, 17), (9, 29)):
        st_t.set(sx, sy, hx("#CBD5E1"))
    tiles["star_tile"] = st_t

    # 24. SNES Crystal Pillar (faceted cyan-magenta prism spire on carved stone plinth)
    cry = Canvas(32, 32, TRANSPARENT)
    cr_o = hx("#1E1348")
    # Stepped stone plinth base
    cry.rect(5, 25, 22, 5, hx("#1E293B"))
    cry.rect(6, 26, 20, 3, hx("#64748B"))
    cry.rect(6, 26, 20, 1, hx("#CBD5E1"))
    # Faceted crystal spire
    for dy in range(22):
        y = 25 - dy
        if dy < 6:
            w = 5 + dy // 2
        elif dy < 15:
            w = 8 - (dy - 6) // 3
        else:
            w = max(1, 5 - (dy - 15))
        cry.rect(16 - w - 1, y, (w + 1) * 2, 1, cr_o)
        cry.rect(16 - w, y, w * 2, 1, hx("#0284C7"))
        cry.rect(16 - w, y, max(1, w), 1, hx("#38BDF8"))
        if dy >= 5:
            cry.rect(16 - max(1, w - 1), y, max(1, w // 2), 1, hx("#BAE6FD"))
        if 7 <= dy <= 14:
            cry.rect(15, y, max(2, w // 2), 1, hx("#E879F9"))
    cry.rect(15, 4, 2, 4, hx("#FFFFFF"))
    tiles["crystal_pillar"] = cry

    # 25. SNES Column (classical fluted marble pillar with ornate capital & plinth)
    col_t = Canvas(32, 32, TRANSPARENT)
    co_o = hx("#1E293B")
    co_d = hx("#64748B")
    co_m = hx("#CBD5E1")
    co_l = hx("#E2E8F0")
    co_h = hx("#FFFFFF")
    # Ornate capital
    col_t.rect(4, 2, 24, 6, co_o)
    col_t.rect(5, 3, 22, 4, co_m)
    col_t.rect(5, 3, 22, 2, co_h)
    col_t.rect(7, 8, 18, 2, co_d)
    # Fluted shaft
    col_t.rect(8, 9, 16, 16, co_o)
    col_t.rect(9, 9, 14, 16, co_l)
    col_t.rect(10, 9, 2, 16, co_h)
    col_t.rect(13, 9, 2, 16, co_m)
    col_t.rect(15, 9, 2, 16, co_h)
    col_t.rect(18, 9, 2, 16, co_d)
    col_t.rect(21, 9, 2, 16, co_d)
    # Stepped plinth base
    col_t.rect(6, 24, 20, 3, co_o); col_t.rect(7, 25, 18, 2, co_m); col_t.rect(7, 25, 18, 1, co_h)
    col_t.rect(4, 27, 24, 4, co_o); col_t.rect(5, 28, 22, 2, co_d); col_t.rect(5, 28, 12, 1, co_m)
    tiles["column"] = col_t

    # 26. SNES Campfire (river-stone ring, crossed oak logs, layered vibrant flame)
    cf = Canvas(32, 32, TRANSPARENT)
    # Stone ring
    for cx, cy in ((7, 22), (12, 25), (19, 25), (24, 22), (9, 18), (22, 18)):
        fill_ellipse(cf, cx, cy, 3.6, 2.8, hx("#1E293B"))
        fill_ellipse(cf, cx, cy, 2.5, 1.8, hx("#64748B"))
        cf.set(cx - 1, cy - 1, hx("#CBD5E1"))
    # Crossed oak logs
    cf.rect(9, 19, 14, 4, hx("#3B1E0B"))
    cf.rect(10, 20, 12, 2, hx("#8B5A2B"))
    cf.rect(11, 17, 10, 4, hx("#5C2D0C"))
    # Layered multi-tone flame
    fill_ellipse(cf, 15.5, 13.5, 6.5, 7.5, hx("#DC2626"))
    fill_ellipse(cf, 15.5, 14.2, 5.2, 6.0, hx("#F97316"))
    fill_ellipse(cf, 15.5, 15.0, 3.6, 4.4, hx("#FACC15"))
    fill_ellipse(cf, 15.5, 16.0, 2.0, 2.6, hx("#FEF9C3"))
    cf.rect(15, 4, 2, 3, hx("#F97316"))
    cf.set(12, 5, hx("#FACC15")); cf.set(20, 6, hx("#FDE047"))
    tiles["campfire"] = cf

    # 27. SNES Anvil (sculpted blacksmith steel anvil with tapered horn & specular rim)
    anv = Canvas(32, 32, TRANSPARENT)
    av_o = hx("#0F172A")
    av_d = hx("#334155")
    av_m = hx("#64748B")
    av_l = hx("#94A3B8")
    av_h = hx("#E2E8F0")
    # Tapered horn + flat top face
    anv.rect(3, 9, 26, 6, av_o)
    anv.rect(2, 10, 4, 3, av_o)
    anv.rect(4, 10, 24, 4, av_l)
    anv.rect(4, 10, 24, 2, av_h)
    anv.rect(6, 13, 22, 2, av_m)
    # Beveled waist
    anv.rect(10, 15, 12, 7, av_o)
    anv.rect(11, 15, 10, 7, av_m)
    anv.rect(11, 15, 3, 7, av_l)
    anv.rect(18, 15, 3, 7, av_d)
    # Sturdy flared base
    anv.rect(6, 22, 20, 6, av_o)
    anv.rect(7, 23, 18, 4, av_d)
    anv.rect(7, 23, 18, 2, av_m)
    anv.rect(8, 23, 8, 1, av_l)
    tiles["anvil"] = anv

    # 28. SNES Statue (carved stone guardian on pedestal with glowing cyan rune eyes & sigil)
    stv = Canvas(32, 32, TRANSPARENT)
    st_o = hx("#1E293B")
    st_d = hx("#475569")
    st_m = hx("#94A3B8")
    st_l = hx("#CBD5E1")
    st_h = hx("#F1F5F9")
    # Pedestal
    stv.rect(5, 24, 22, 6, st_o)
    stv.rect(6, 25, 20, 4, st_d)
    stv.rect(6, 25, 20, 2, st_l)
    stv.rect(7, 25, 10, 1, st_h)
    # Robed torso & shoulders
    fill_ellipse(stv, 15.5, 18.0, 7.6, 6.8, st_o)
    fill_ellipse(stv, 15.5, 18.0, 6.4, 5.6, st_m)
    fill_ellipse(stv, 14.5, 16.8, 4.8, 4.0, st_l)
    # Glowing cyan rune sigil on chest
    stv.rect(14, 16, 4, 4, hx("#0284C7"))
    stv.rect(15, 17, 2, 2, hx("#7DD3FC"))
    # Sculpted head & glowing eyes
    fill_ellipse(stv, 15.5, 8.5, 5.6, 5.2, st_o)
    fill_ellipse(stv, 15.5, 8.5, 4.5, 4.1, st_m)
    fill_ellipse(stv, 14.5, 7.2, 3.2, 2.4, st_h)
    stv.rect(12, 8, 2, 2, hx("#38BDF8")); stv.set(12, 8, hx("#E0F2FE"))
    stv.rect(17, 8, 2, 2, hx("#38BDF8")); stv.set(17, 8, hx("#E0F2FE"))
    tiles["statue"] = stv

    # 29 & 30. SNES Mossy Gate (Closed & Open)
    def build_snes_gate(closed: bool) -> Canvas:
        g = Canvas(32, 32, TRANSPARENT)
        go = hx("#1E293B")
        gd = hx("#475569")
        gm = hx("#94A3B8")
        gh = hx("#CBD5E1")
        # Outer stone pillars & lintel arch
        g.rect(0, 0, 32, 6, go); g.rect(1, 1, 30, 4, gm); g.rect(1, 1, 30, 2, gh)
        g.rect(0, 6, 7, 26, go); g.rect(1, 6, 5, 25, gm); g.rect(1, 6, 2, 25, gh); g.rect(5, 6, 1, 25, gd)
        g.rect(25, 6, 7, 26, go); g.rect(26, 6, 5, 25, gm); g.rect(26, 6, 2, 25, gh); g.rect(30, 6, 1, 25, gd)
        # Hanging lush moss vines on lintel
        for vx, vl in ((3, 6), (5, 9), (25, 8), (27, 5)):
            for dy in range(vl):
                g.set(vx, 1 + dy, hx("#4ADE80") if dy < 2 else hx("#16A34A"))
                g.set(vx + 1, 1 + dy, hx("#15803D"))
        if closed:
            # Heavy oak & iron gate bars + golden lock crest
            g.rect(7, 6, 18, 24, hx("#2C1608"))
            for bx in (8, 12, 16, 20):
                g.rect(bx, 6, 3, 24, hx("#7C4820"))
                g.rect(bx, 6, 1, 24, hx("#A86E3B"))
            for by in (10, 18, 26):
                g.rect(7, by, 18, 3, hx("#334155"))
                g.rect(7, by, 18, 1, hx("#94A3B8"))
            # Gleaming golden lock emblem
            g.rect(13, 13, 6, 6, hx("#451A03"))
            g.rect(14, 14, 4, 4, hx("#FACC15"))
            g.set(14, 14, hx("#FEF9C3"))
        return g

    tiles["mossy_gate_closed"] = build_snes_gate(True)
    tiles["mossy_gate_open"] = build_snes_gate(False)

    # 31 & 32. SNES Treasure Chest (Closed & Open — ALTTP style)
    def build_snes_chest(opened: bool) -> Canvas:
        ch = Canvas(32, 32, TRANSPARENT)
        co = hx("#2A1508")
        wd = hx("#6B3A16")
        wm = hx("#9A5824")
        wl = hx("#C67D3B")
        gd = hx("#B45309")
        gm = hx("#FACC15")
        gh = hx("#FEF9C3")
        # Chest body
        ch.rect(4, 14, 24, 13, co)
        ch.rect(5, 15, 22, 11, wd)
        ch.rect(5, 15, 22, 6, wm)
        # Gold trim bands & corner brackets
        ch.rect(5, 15, 2, 11, gm); ch.rect(25, 15, 2, 11, gm)
        ch.rect(5, 24, 22, 2, gd); ch.rect(5, 15, 22, 2, gm)
        if not opened:
            # Arched oak lid
            ch.rect(4, 7, 24, 9, co)
            ch.rect(5, 8, 22, 7, wm)
            ch.rect(6, 8, 20, 3, wl)
            ch.rect(5, 8, 2, 7, gm); ch.rect(25, 8, 2, 7, gm)
            ch.rect(5, 14, 22, 2, gm); ch.rect(6, 8, 20, 1, gh)
        else:
            # Hinged open lid + glowing sapphire & gold treasure inside
            ch.rect(4, 4, 24, 7, co)
            ch.rect(5, 5, 22, 5, wl)
            ch.rect(5, 5, 22, 1, gh)
            ch.rect(5, 10, 22, 6, hx("#0C4A6E"))
            ch.rect(6, 11, 20, 4, hx("#38BDF8"))
            ch.rect(8, 12, 16, 2, hx("#E0F2FE"))
            ch.rect(10, 11, 4, 3, gm); ch.rect(18, 11, 4, 3, gm)
        # Golden keyhole clasp
        ch.rect(13, 14, 6, 6, co)
        ch.rect(14, 15, 4, 4, gm)
        ch.set(14, 15, gh)
        ch.set(15, 17, co)
        return ch

    tiles["chest_closed"] = build_snes_chest(False)
    tiles["chest_open"] = build_snes_chest(True)

    # 33. SNES Vault Shrine (ornate marble & gold Dragon Logic Vault with holographic screen)
    vs = Canvas(32, 32, TRANSPARENT)
    # Stepped pedestal
    vs.rect(3, 24, 26, 6, hx("#1E293B"))
    vs.rect(4, 25, 24, 4, hx("#64748B"))
    vs.rect(4, 25, 24, 2, hx("#CBD5E1"))
    # Ornate arched marble frame
    fill_ellipse(vs, 15.5, 13.5, 11.5, 10.5, hx("#1E293B"))
    fill_ellipse(vs, 15.5, 13.5, 10.2, 9.2, hx("#94A3B8"))
    fill_ellipse(vs, 14.8, 12.2, 9.0, 7.8, hx("#E2E8F0"))
    # Gold inner arch trim
    fill_ellipse(vs, 15.5, 14.0, 8.2, 7.2, hx("#D97706"))
    fill_ellipse(vs, 15.2, 13.6, 7.4, 6.4, hx("#FACC15"))
    # Luminous cyan holographic vault core
    vs.rect(9, 9, 14, 12, hx("#0369A1"))
    vs.rect(10, 10, 12, 10, hx("#38BDF8"))
    vs.rect(11, 11, 10, 2, hx("#E0F2FE"))
    vs.rect(11, 14, 7, 2, hx("#BAE6FD"))
    vs.rect(11, 17, 9, 2, hx("#E0F2FE"))
    vs.rect(4, 22, 24, 3, hx("#475569"))
    tiles["vault_shrine"] = vs

    # 34. SNES Torch (carved brazier-torch with iron sconce & vibrant layered flame)
    tor = Canvas(32, 32, TRANSPARENT)
    # Wooden handle & base
    tor.rect(13, 14, 6, 15, hx("#2A1508"))
    tor.rect(14, 15, 4, 13, hx("#7C4820"))
    tor.rect(14, 15, 2, 13, hx("#A86E3B"))
    tor.rect(11, 27, 10, 3, hx("#2A1508"))
    tor.rect(12, 28, 8, 1, hx("#64748B"))
    # Iron sconce bowl
    tor.rect(10, 11, 12, 5, hx("#0F172A"))
    tor.rect(11, 12, 10, 3, hx("#475569"))
    tor.rect(11, 12, 10, 1, hx("#94A3B8"))
    # Layered flickering flame
    fill_ellipse(tor, 15.5, 7.5, 4.5, 5.2, hx("#DC2626"))
    fill_ellipse(tor, 15.5, 8.2, 3.4, 4.0, hx("#F97316"))
    fill_ellipse(tor, 15.5, 9.0, 2.2, 2.6, hx("#FACC15"))
    tor.rect(15, 8, 2, 3, hx("#FEF9C3"))
    tor.set(15, 2, hx("#F97316"))
    tiles["torch"] = tor

    # 35. SNES Portal (swirling dimensional vortex with violet-cyan energy rings & bright core)
    por = Canvas(32, 32, TRANSPARENT)
    fill_ellipse(por, 15.5, 15.5, 13.5, 13.5, hx("#1E1042"))
    fill_ellipse(por, 15.5, 15.5, 12.2, 12.2, hx("#6D28D9"))
    fill_ellipse(por, 15.5, 15.5, 10.2, 10.2, hx("#A855F7"))
    fill_ellipse(por, 15.5, 15.5, 8.4, 8.4, hx("#0EA5E9"))
    fill_ellipse(por, 15.5, 15.5, 6.2, 6.2, hx("#7DD3FC"))
    fill_ellipse(por, 15.5, 15.5, 4.0, 4.0, hx("#E0F2FE"))
    fill_ellipse(por, 15.5, 15.5, 2.0, 2.0, hx("#FFFFFF"))
    # Orbiting energy sparks
    for sx, sy in ((8, 8), (23, 9), (22, 22), (9, 23)):
        por.rect(sx, sy, 2, 2, hx("#F0F9FF"))
    tiles["portal"] = por

    return tiles


def build_snes_npcs_32() -> Dict[str, Canvas]:
    """Builds genuine, native 32x32 SNES (16-Bit) NPC & Dragon sprites with
    layered shading, expressive eyes with specular highlights, colored outlines,
    wings/horns/robes, and soft grounded shadows.
    """
    def fill_ellipse(c: Canvas, cx: float, cy: float, rx: float, ry: float, col: RGBA, blend: bool = False) -> None:
        x0, x1 = max(0, int(cx - rx - 1)), min(c.w - 1, int(cx + rx + 1))
        y0, y1 = max(0, int(cy - ry - 1)), min(c.h - 1, int(cy + ry + 1))
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                dx = (x - cx) / max(0.1, rx)
                dy = (y - cy) / max(0.1, ry)
                if dx * dx + dy * dy <= 1.0:
                    if blend:
                        c.blend(x, y, col)
                    else:
                        c.set(x, y, col)

    def add_shadow(c: Canvas, rx: float = 9.0, cy: float = 28.5) -> None:
        # Runtime renderers (world.js, cutscene.js, renderer3d.js) draw grounded shadows
        # separately so shadows stay anchored on the ground while sprites bob.
        return

    def build_dragon_32(
        out_c: RGBA,
        body_dk: RGBA,
        body_md: RGBA,
        body_lt: RGBA,
        belly_md: RGBA,
        belly_hi: RGBA,
        wing_dk: RGBA,
        wing_lt: RGBA,
        horn_c: RGBA,
        eye_c: RGBA,
        crest_c: Optional[RGBA] = None,
    ) -> Canvas:
        c = Canvas(32, 32, TRANSPARENT)
        add_shadow(c, 9.5, 28.5)

        # Swept SNES wings (left & right, angled upward with membrane shading)
        for side in (-1, 1):
            wx = 15.5 + side * 8.5
            fill_ellipse(c, wx, 14.5, 5.8, 4.6, out_c)
            fill_ellipse(c, wx, 14.5, 4.6, 3.5, wing_dk)
            fill_ellipse(c, wx - side * 0.6, 13.5, 3.6, 2.2, wing_lt)
            # Wing claw tip
            tx = int(15.5 + side * 12)
            c.rect(tx, 10, 2, 2, horn_c)

        # Tail curving out on right
        for tx, ty in ((22, 22), (24, 21), (26, 19), (27, 17)):
            c.rect(tx - 1, ty - 1, 3, 3, out_c)
            c.rect(tx, ty, 2, 2, body_md)
        c.rect(27, 16, 2, 2, horn_c)

        # Sturdy hind legs & claws
        for lx in (10, 19):
            c.rect(lx, 22, 4, 6, out_c)
            c.rect(lx + 1, 22, 2, 5, body_dk)
            c.rect(lx, 26, 4, 2, horn_c)

        # Rounded torso + ridged belly scales
        fill_ellipse(c, 15.5, 19.0, 6.8, 6.5, out_c)
        fill_ellipse(c, 15.5, 19.0, 5.6, 5.4, body_dk)
        fill_ellipse(c, 15.0, 18.2, 4.8, 4.6, body_md)
        fill_ellipse(c, 15.5, 19.5, 3.4, 4.0, belly_md)
        fill_ellipse(c, 15.0, 18.6, 2.4, 2.8, belly_hi)
        # Belly scale lines
        for by in (17, 19, 21):
            c.rect(13, by, 5, 1, body_dk)

        # Expressive SNES dragon head & snout
        fill_ellipse(c, 15.5, 10.5, 6.5, 5.5, out_c)
        fill_ellipse(c, 15.5, 10.5, 5.4, 4.4, body_md)
        fill_ellipse(c, 14.5, 9.2, 4.2, 2.8, body_lt)
        # Horns curving upward with crisp outer outline
        for hx_pos in (10, 20):
            c.rect(hx_pos - 1, 2, 4, 5, out_c)
            c.rect(hx_pos, 3, 2, 3, horn_c)
            c.set(hx_pos, 3, hx("#FFFFFF"))
        # Optional elemental crest between horns
        if crest_c:
            c.rect(14, 4, 4, 3, out_c)
            c.rect(15, 4, 2, 2, crest_c)
        # Expressive eyes with white catchlights
        for ex in (12, 18):
            c.rect(ex, 9, 2, 3, eye_c)
            c.set(ex, 9, hx("#FFFFFF"))
        # Cute snout nostrils
        c.set(14, 13, out_c); c.set(17, 13, out_c)
        return c

    npcs: Dict[str, Canvas] = {}

    # 1. Elder Ada (graceful SNES sage with silver hair bun, teal-and-gold robes, glowing oak staff)
    ada = Canvas(32, 32, TRANSPARENT)
    add_shadow(ada, 8.5, 28.5)
    o_ada = hx("#172536")
    # Robe body
    fill_ellipse(ada, 14.5, 21.5, 7.2, 7.5, o_ada)
    fill_ellipse(ada, 14.5, 21.5, 6.1, 6.4, hx("#0F766E"))
    fill_ellipse(ada, 13.8, 20.5, 4.6, 5.2, hx("#14B8A6"))
    # Gold embroidered stole down the center
    ada.rect(13, 15, 3, 12, hx("#D97706"))
    ada.rect(13, 15, 2, 12, hx("#FACC15"))
    ada.rect(12, 26, 5, 2, hx("#115E59"))
    # Silver hair halo & bun
    fill_ellipse(ada, 14.5, 5.2, 3.6, 2.6, o_ada)
    fill_ellipse(ada, 14.5, 5.2, 2.5, 1.7, hx("#E2E8F0"))
    fill_ellipse(ada, 14.5, 10.5, 6.5, 5.6, o_ada)
    fill_ellipse(ada, 14.5, 9.5, 5.5, 4.4, hx("#CBD5E1"))
    fill_ellipse(ada, 13.8, 8.2, 4.4, 2.8, hx("#F8FAFC"))
    # Warm face & kind eyes
    fill_ellipse(ada, 14.5, 11.6, 4.2, 3.6, hx("#E8B98E"))
    fill_ellipse(ada, 13.8, 10.8, 3.0, 2.2, hx("#F7D4B2"))
    ada.rect(12, 11, 2, 2, hx("#1E293B")); ada.set(12, 11, hx("#FFFFFF"))
    ada.rect(16, 11, 2, 2, hx("#1E293B")); ada.set(16, 11, hx("#FFFFFF"))
    ada.set(11, 13, hx("#F4A29E")); ada.set(18, 13, hx("#F4A29E"))
    # Glowing oak staff on right
    ada.rect(24, 11, 3, 17, hx("#3B1E0B"))
    ada.rect(25, 11, 1, 16, hx("#9A5B2A"))
    fill_ellipse(ada, 25.5, 9.5, 3.0, 3.0, o_ada)
    fill_ellipse(ada, 25.5, 9.5, 2.1, 2.1, hx("#FACC15"))
    ada.set(25, 8, hx("#FEF9C3"))
    npcs["elder_ada"] = ada

    # 2. Bram (sturdy SNES blacksmith with forge goggles, leather apron, steel buckle, beard)
    bram = Canvas(32, 32, TRANSPARENT)
    add_shadow(bram, 9.5, 28.5)
    o_br = hx("#23150C")
    # Broad shoulders & tunic
    fill_ellipse(bram, 15.5, 20.5, 8.8, 7.6, o_br)
    fill_ellipse(bram, 15.5, 20.5, 7.6, 6.4, hx("#92400E"))
    fill_ellipse(bram, 14.6, 19.2, 6.2, 4.6, hx("#C26724"))
    # Heavy leather forge apron + steel chest emblem
    bram.rect(11, 16, 9, 10, hx("#5C2D0C"))
    bram.rect(12, 17, 7, 8, hx("#78350F"))
    bram.rect(13, 19, 5, 4, hx("#64748B"))
    bram.rect(14, 19, 3, 2, hx("#CBD5E1"))
    # Sturdy boots
    bram.rect(10, 26, 4, 3, o_br); bram.rect(11, 26, 2, 2, hx("#451A03"))
    bram.rect(17, 26, 4, 3, o_br); bram.rect(18, 26, 2, 2, hx("#451A03"))
    # Head, cap & glowing cyan forge goggles
    fill_ellipse(bram, 15.5, 10.5, 6.6, 5.8, o_br)
    fill_ellipse(bram, 15.5, 8.8, 5.6, 3.6, hx("#7C4820"))
    # Cyan goggles
    bram.rect(10, 7, 11, 4, o_br)
    bram.rect(11, 8, 4, 2, hx("#38BDF8")); bram.set(11, 8, hx("#E0F2FE"))
    bram.rect(16, 8, 4, 2, hx("#38BDF8")); bram.set(16, 8, hx("#E0F2FE"))
    # Face & full auburn beard
    bram.rect(11, 11, 9, 4, hx("#E6B98A"))
    bram.rect(12, 11, 2, 2, hx("#1E293B")); bram.set(12, 11, hx("#FFFFFF"))
    bram.rect(17, 11, 2, 2, hx("#1E293B")); bram.set(17, 11, hx("#FFFFFF"))
    fill_ellipse(bram, 15.5, 14.8, 5.0, 2.8, hx("#78350F"))
    fill_ellipse(bram, 15.0, 14.2, 3.6, 1.6, hx("#B45309"))
    npcs["bram"] = bram

    # 3. Spark (Golden Lightning Dragon)
    npcs["spark"] = build_dragon_32(
        out_c=hx("#2B1908"),
        body_dk=hx("#D97706"),
        body_md=hx("#F59E0B"),
        body_lt=hx("#FDE047"),
        belly_md=hx("#FEF08A"),
        belly_hi=hx("#FEFCE8"),
        wing_dk=hx("#0284C7"),
        wing_lt=hx("#38BDF8"),
        horn_c=hx("#FEF08A"),
        eye_c=hx("#1E1B2E"),
        crest_c=hx("#38BDF8"),
    )

    # 4. Pebble (Mossy Earth Dragon)
    npcs["pebble"] = build_dragon_32(
        out_c=hx("#17202B"),
        body_dk=hx("#475569"),
        body_md=hx("#64748B"),
        body_lt=hx("#94A3B8"),
        belly_md=hx("#CBD5E1"),
        belly_hi=hx("#F1F5F9"),
        wing_dk=hx("#15803D"),
        wing_lt=hx("#4ADE80"),
        horn_c=hx("#CBD5E1"),
        eye_c=hx("#1E1B2E"),
        crest_c=hx("#4ADE80"),
    )

    # 5. Lord Null (Menacing SNES Glitch-Shadow Sorcerer)
    null = Canvas(32, 32, TRANSPARENT)
    add_shadow(null, 9.0, 28.5)
    o_nu = hx("#12061F")
    # Billowing dark violet cloak
    fill_ellipse(null, 15.5, 20.5, 9.0, 8.2, o_nu)
    fill_ellipse(null, 15.5, 20.5, 7.8, 7.0, hx("#3B0764"))
    fill_ellipse(null, 14.5, 19.2, 6.2, 5.2, hx("#581C87"))
    # Glowing magenta glitch-core emblem on chest
    fill_ellipse(null, 15.5, 20.5, 3.6, 3.4, hx("#BE185D"))
    fill_ellipse(null, 15.0, 19.8, 2.2, 2.0, hx("#F472B6"))
    null.rect(15, 19, 2, 2, hx("#FCE7F3"))
    # Deep hooded cowl + shadow void face
    fill_ellipse(null, 15.5, 10.5, 7.4, 6.4, o_nu)
    fill_ellipse(null, 15.5, 9.8, 6.2, 5.2, hx("#4C1D95"))
    fill_ellipse(null, 14.5, 8.2, 4.6, 2.8, hx("#7C3AED"))
    fill_ellipse(null, 15.5, 11.4, 4.4, 3.2, hx("#090412"))
    # Glowing crimson-pink eyes inside shadow hood
    null.rect(12, 10, 3, 2, hx("#F43F5E")); null.set(12, 10, hx("#FFE4E6"))
    null.rect(17, 10, 3, 2, hx("#F43F5E")); null.set(17, 10, hx("#FFE4E6"))
    npcs["lord_null"] = null

    # 6. Emberwing (Crimson & Molten-Gold Flame Dragon)
    npcs["emberwing"] = build_dragon_32(
        out_c=hx("#2A0A0A"),
        body_dk=hx("#991B1B"),
        body_md=hx("#DC2626"),
        body_lt=hx("#F87171"),
        belly_md=hx("#F59E0B"),
        belly_hi=hx("#FEF08A"),
        wing_dk=hx("#B45309"),
        wing_lt=hx("#FB923C"),
        horn_c=hx("#FDE68A"),
        eye_c=hx("#1E1B2E"),
        crest_c=hx("#FACC15"),
    )

    # 7. Glacier (Crystalline Frost Wyvern)
    npcs["glacier"] = build_dragon_32(
        out_c=hx("#0B2545"),
        body_dk=hx("#0284C7"),
        body_md=hx("#38BDF8"),
        body_lt=hx("#BAE6FD"),
        belly_md=hx("#E0F2FE"),
        belly_hi=hx("#FFFFFF"),
        wing_dk=hx("#0369A1"),
        wing_lt=hx("#7DD3FC"),
        horn_c=hx("#F8FAFC"),
        eye_c=hx("#0F172A"),
        crest_c=hx("#F0F9FF"),
    )

    # 8. Bramble (Emerald & Bark Forest Dragon)
    npcs["bramble"] = build_dragon_32(
        out_c=hx("#0F2A1A"),
        body_dk=hx("#15803D"),
        body_md=hx("#22C55E"),
        body_lt=hx("#86EFAC"),
        belly_md=hx("#BEF264"),
        belly_hi=hx("#ECFCCB"),
        wing_dk=hx("#166534"),
        wing_lt=hx("#4ADE80"),
        horn_c=hx("#B45309"),
        eye_c=hx("#1E1B2E"),
        crest_c=hx("#BEF264"),
    )

    # 9. Mire (Deep Teal & Bioluminescent Swamp Dragon)
    npcs["mire"] = build_dragon_32(
        out_c=hx("#091E20"),
        body_dk=hx("#115E59"),
        body_md=hx("#0F766E"),
        body_lt=hx("#2DD4BF"),
        belly_md=hx("#A3E635"),
        belly_hi=hx("#D9F99D"),
        wing_dk=hx("#334155"),
        wing_lt=hx("#64748B"),
        horn_c=hx("#A3E635"),
        eye_c=hx("#D9F99D"),
        crest_c=hx("#A3E635"),
    )

    return npcs


def main() -> None:
    tiles_by_era: Dict[str, Dict[str, Canvas]] = {}
    npcs_by_era: Dict[str, Dict[str, Canvas]] = {}

    for era in ("8bit", "16bit"):
        tiles = build_tiles(era)
        npcs = build_npcs(era)
        ts = 32 if era == "16bit" else TILE_SIZE
        if era == "16bit":
            tiles = build_snes_tiles_32(tiles)
            npcs = build_snes_npcs_32()

        tiles_by_era[era] = tiles
        npcs_by_era[era] = npcs

        rows = (len(TILE_IDS) + SHEET_COLS - 1) // SHEET_COLS
        sheet = Canvas(SHEET_COLS * ts, rows * ts)
        for idx, tid in enumerate(TILE_IDS):
            col, row = idx % SHEET_COLS, idx // SHEET_COLS
            sheet.blit(tiles[tid], col * ts, row * ts)
        sheet.save(TILESETS_DIR / era / "meadow_ruins.png")

        npc_sheet = Canvas(len(NPC_KEYS) * ts, ts)
        for idx, key in enumerate(NPC_KEYS):
            npc_sheet.blit(npcs[key], idx * ts, 0)
        npc_sheet.save(TILESETS_DIR / era / "npcs_and_dragons.png")

    # Build manifest.json with exact per-era coordinates (16x16 for 8bit, 32x32 for 16bit!)
    total_rows = (len(TILE_IDS) + SHEET_COLS - 1) // SHEET_COLS

    def build_coords(ts: int):
        tc = {}
        for idx, tid in enumerate(TILE_IDS):
            col, row = idx % SHEET_COLS, idx // SHEET_COLS
            tc[tid] = {"col": col, "row": row, "x": col * ts, "y": row * ts, "width": ts, "height": ts}
        nc = {}
        for idx, key in enumerate(NPC_KEYS):
            nc[key] = {"col": idx, "row": 0, "x": idx * ts, "y": 0, "width": ts, "height": ts}
        return tc, nc

    tc8, nc8 = build_coords(16)
    tc16, nc16 = build_coords(32)

    manifest = {
        "version": "1.2.0",
        "tilesetId": "meadow_ruins",
        "tileSize": TILE_SIZE,
        "tileIds": TILE_IDS,
        "npcKeys": NPC_KEYS,
        "eras": {
            "8bit": {
                "tilesetImage": "8bit/meadow_ruins.png",
                "tilesetSize": {"width": SHEET_COLS * 16, "height": total_rows * 16},
                "npcsImage": "8bit/npcs_and_dragons.png",
                "npcsSize": {"width": len(NPC_KEYS) * 16, "height": 16},
                "tiles": tc8,
                "npcs": nc8,
            },
            "16bit": {
                "tilesetImage": "16bit/meadow_ruins.png",
                "tilesetSize": {"width": SHEET_COLS * 32, "height": total_rows * 32},
                "npcsImage": "16bit/npcs_and_dragons.png",
                "npcsSize": {"width": len(NPC_KEYS) * 32, "height": 32},
                "tiles": tc16,
                "npcs": nc16,
            },
        },
    }
    (TILESETS_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    # If content/maps JSONs exist, also write file:// fallback bundle & render Realm 1 comparison PNG
    WORLD_DIR.mkdir(parents=True, exist_ok=True)
    m1_path = MAPS_DIR / "realm-01-meadow.json"
    m2_path = MAPS_DIR / "realm-02-ruins.json"
    bundle = {}
    if m1_path.exists():
        bundle["realm-01-meadow"] = json.loads(m1_path.read_text(encoding="utf-8"))
    if m2_path.exists():
        bundle["realm-02-ruins"] = json.loads(m2_path.read_text(encoding="utf-8"))
    if bundle:
        (WORLD_DIR / "maps_bundle.js").write_text(
            "window.PYRIA_MAPS_BUNDLE = " + json.dumps(bundle) + ";\n",
            encoding="utf-8",
        )

    if "realm-01-meadow" in bundle:
        m1 = bundle["realm-01-meadow"]
        r8_raw = render_map_canvas(m1, tiles_by_era["8bit"], npcs_by_era["8bit"])
        # Scale 8-bit 2x so 8-bit (16px tiles) and 16-bit (32px tiles) align 1:1 side-by-side
        r8 = Canvas(r8_raw.w * 2, r8_raw.h * 2)
        for yy in range(r8_raw.h):
            for xx in range(r8_raw.w):
                col = r8_raw.get(xx, yy)
                r8.set(xx * 2, yy * 2, col)
                r8.set(xx * 2 + 1, yy * 2, col)
                r8.set(xx * 2, yy * 2 + 1, col)
                r8.set(xx * 2 + 1, yy * 2 + 1, col)
        r16 = render_map_canvas(m1, tiles_by_era["16bit"], npcs_by_era["16bit"])
        pad = 20
        header_h = 56
        comp_w = pad + r8.w + pad + r16.w + pad
        comp_h = header_h + max(r8.h, r16.h) + pad
        comp = Canvas(comp_w, comp_h, hx("#0F172A"))
        comp.rect(0, 0, comp_w, header_h - 2, hx("#131C31"))
        comp.rect(0, header_h - 2, comp_w, 2, hx("#334155"))
        draw_text(comp, 20, 12, "PYRIA REALM 1: WHISPERING MEADOW", hx("#F8FAFC"), scale=2)
        draw_text(comp, 20, 36, "8-BIT NES (16PX TILES, LEFT) VS 16-BIT SNES (32PX TILES, RIGHT)", hx("#38BDF8"), scale=1)

        # Borders + maps
        comp.rect(pad - 2, header_h - 2, r8.w + 4, r8.h + 4, hx("#22C55E"))
        comp.blit(r8, pad, header_h)
        x16 = pad + r8.w + pad
        comp.rect(x16 - 2, header_h - 2, r16.w + 4, r16.h + 4, hx("#38BDF8"))
        comp.blit(r16, x16, header_h)
        comp.save(WORLD_DIR / "realm01_meadow_comparison.png")
        print(f"Rendered {WORLD_DIR / 'realm01_meadow_comparison.png'} ({comp_w}x{comp_h})")

    print(f"Generated 8bit & 16bit tilesets ({len(TILE_IDS)} tiles + {len(NPC_KEYS)} NPCs/dragons) + manifest.json in {TILESETS_DIR}")


if __name__ == "__main__":
    main()
