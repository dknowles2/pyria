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

                        # Subtle SNES micro-dither texture (gives rich 32x32 fabric/stone/foliage grain)
                        h = (px * 17 + py * 31) % 11
                        if h == 0:
                            col = shift_rgb(col, 14, 14, 10)
                        elif h == 5:
                            col = shift_rgb(col, -12, -10, -6)

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


def main() -> None:
    tiles_by_era: Dict[str, Dict[str, Canvas]] = {}
    npcs_by_era: Dict[str, Dict[str, Canvas]] = {}

    for era in ("8bit", "16bit"):
        tiles = build_tiles(era)
        npcs = build_npcs(era)
        ts = 32 if era == "16bit" else TILE_SIZE
        if era == "16bit":
            tiles = {k: upscale_to_snes32(v, is_sprite=False) for k, v in tiles.items()}
            npcs = {k: upscale_to_snes32(v, is_sprite=True) for k, v in npcs.items()}

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
