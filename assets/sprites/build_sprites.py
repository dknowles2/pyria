#!/usr/bin/env python3
"""
Pyria Modular Hero & Pip Sprite Generator
Pure Python 3 (stdlib only: zlib, struct, json, pathlib) — zero external dependencies.

Generates:
  - 8-bit (16x16 per frame, 4 directions x 2 walk frames = 32x64 sheets)
  - 16-bit (32x32 per frame, 4 directions x 4 walk frames = 128x128 sheets)
  - Pip companion sprites (16x16 per frame in both eras) + ember scarf overlay
  - manifest.json matching /Users/dknowles/src/pyria/content/catalog.json 100%
  - hero_showcase.png (4 customized hero builds in 8-bit & 16-bit side-by-side with Pip)
"""

from __future__ import annotations

import json
import struct
import zlib
from pathlib import Path
from typing import Dict, List, Optional, Tuple

RGBA = Tuple[int, int, int, int]
TRANSPARENT: RGBA = (0, 0, 0, 0)

BASE_DIR = Path(__file__).resolve().parent
DIRECTIONS = ["down", "up", "left", "right"]


# ---------------------------------------------------------------------------
# Pure-Python PNG Encoder (RGBA8)
# ---------------------------------------------------------------------------
def write_png(path: Path, width: int, height: int, pixels: List[RGBA]) -> None:
    """Write an RGBA8 PNG file using only stdlib zlib & struct."""
    assert len(pixels) == width * height, f"Expected {width*height} pixels, got {len(pixels)}"
    path.parent.mkdir(parents=True, exist_ok=True)

    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        row_start = y * width
        for x in range(width):
            r, g, b, a = pixels[row_start + x]
            raw.extend((r, g, b, a))

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), level=9)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    path.write_bytes(png)


class Canvas:
    """Simple RGBA pixel buffer with alpha compositing and nearest-neighbor scaling."""

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

    def flip_x(self) -> "Canvas":
        out = Canvas(self.w, self.h)
        for y in range(self.h):
            for x in range(self.w):
                out.px[y * self.w + (self.w - 1 - x)] = self.px[y * self.w + x]
        return out

    def shift(self, dx: int, dy: int) -> "Canvas":
        out = Canvas(self.w, self.h)
        for y in range(self.h):
            for x in range(self.w):
                c = self.px[y * self.w + x]
                if c[3] > 0:
                    out.set(x + dx, y + dy, c)
        return out

    def save(self, path: Path) -> None:
        write_png(path, self.w, self.h, self.px)


def hex_rgba(h: str, a: int = 255) -> RGBA:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def from_grid(rows: List[str], palette: Dict[str, RGBA]) -> Canvas:
    h = len(rows)
    w = len(rows[0])
    c = Canvas(w, h)
    for y, row in enumerate(rows):
        assert len(row) == w, f"Row {y} length {len(row)} != {w}"
        for x, ch in enumerate(row):
            if ch != "." and ch != " ":
                c.set(x, y, palette[ch])
    return c


def assemble_sheet(frames_by_dir: Dict[str, List[Canvas]]) -> Canvas:
    """Assemble 4 direction rows (down, up, left, right) x N frames into a single sheet."""
    sample = frames_by_dir["down"][0]
    fw, fh = sample.w, sample.h
    n_frames = len(frames_by_dir["down"])
    sheet = Canvas(fw * n_frames, fh * len(DIRECTIONS))
    for r, d in enumerate(DIRECTIONS):
        frames = frames_by_dir[d]
        assert len(frames) == n_frames
        for col, frame in enumerate(frames):
            sheet.blit(frame, col * fw, r * fh)
    return sheet


# ---------------------------------------------------------------------------
# Color Palettes (Cohesive with hero_and_pip.png & modular_hero_sheet.png)
# ---------------------------------------------------------------------------
OUTLINE = hex_rgba("#1C1926")
EYE_DARK = hex_rgba("#1E1B2E")
EYE_WHITE = hex_rgba("#F8FAFC")

SKIN_PALETTES: Dict[str, Dict[str, RGBA]] = {
    "ivory": {
        "L": hex_rgba("#FFF2E2"),
        "M": hex_rgba("#F6D6B8"),
        "D": hex_rgba("#D6A887"),
        "C": hex_rgba("#F2A8A0"),
    },
    "peach": {
        "L": hex_rgba("#FFE5CC"),
        "M": hex_rgba("#F1BE98"),
        "D": hex_rgba("#CE8F6B"),
        "C": hex_rgba("#E88F84"),
    },
    "olive": {
        "L": hex_rgba("#EBD2A8"),
        "M": hex_rgba("#CFA978"),
        "D": hex_rgba("#A37B4E"),
        "C": hex_rgba("#C88A6B"),
    },
    "warm_tan": {
        "L": hex_rgba("#E6B98A"),
        "M": hex_rgba("#C98F5D"),
        "D": hex_rgba("#9B653B"),
        "C": hex_rgba("#C4785B"),
    },
    "bronze": {
        "L": hex_rgba("#C98E62"),
        "M": hex_rgba("#A5673F"),
        "D": hex_rgba("#7A4525"),
        "C": hex_rgba("#9E5B45"),
    },
    "deep_brown": {
        "L": hex_rgba("#9C6442"),
        "M": hex_rgba("#75442A"),
        "D": hex_rgba("#4E2B19"),
        "C": hex_rgba("#7A3E32"),
    },
}

TUNIC_PALETTES: Dict[str, Dict[str, RGBA]] = {
    "emerald": {
        "L": hex_rgba("#4ADE80"),
        "M": hex_rgba("#248F55"),
        "D": hex_rgba("#145C36"),
        "T": hex_rgba("#A7F3D0"),
    },
    "crimson": {
        "L": hex_rgba("#F87171"),
        "M": hex_rgba("#C42E2E"),
        "D": hex_rgba("#7F1D1D"),
        "T": hex_rgba("#FDE68A"),
    },
    "navy": {
        "L": hex_rgba("#60A5FA"),
        "M": hex_rgba("#244B8A"),
        "D": hex_rgba("#172C59"),
        "T": hex_rgba("#CBD5E1"),
    },
    "amber": {
        "L": hex_rgba("#FCD34D"),
        "M": hex_rgba("#D97706"),
        "D": hex_rgba("#92400E"),
        "T": hex_rgba("#FEF3C7"),
    },
    "violet": {
        "L": hex_rgba("#C084FC"),
        "M": hex_rgba("#7C3AED"),
        "D": hex_rgba("#4C1D95"),
        "T": hex_rgba("#E9D5FF"),
    },
    "slate": {
        "L": hex_rgba("#94A3B8"),
        "M": hex_rgba("#475569"),
        "D": hex_rgba("#293548"),
        "T": hex_rgba("#E2E8F0"),
    },
}

HAIR_PAL = {
    "O": OUTLINE,
    "L": hex_rgba("#C67D3B"),
    "M": hex_rgba("#8E4F22"),
    "D": hex_rgba("#5C3014"),
    "H": hex_rgba("#E2A45B"),
}

LEATHER_PAL = {
    "O": OUTLINE,
    "L": hex_rgba("#A66A3E"),
    "M": hex_rgba("#7A4826"),
    "D": hex_rgba("#4D2B15"),
    "G": hex_rgba("#FACC15"),
    "g": hex_rgba("#CA8A04"),
}


# ---------------------------------------------------------------------------
# 8-BIT ERA (16x16 frames, 4 dirs x 2 walk frames = 32x64 sheets)
# ---------------------------------------------------------------------------
def build_8bit_shadow() -> Canvas:
    pal = {"s": (20, 18, 34, 110)}
    frame = from_grid([
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        ".....ssssss.....",
        "....ssssssss....",
        ".....ssssss.....",
    ], pal)
    return assemble_sheet({d: [frame, frame] for d in DIRECTIONS})


def build_8bit_skin(tone: str) -> Canvas:
    sp = SKIN_PALETTES[tone]
    pal = {"O": OUTLINE, "M": sp["M"], "L": sp["L"], "D": sp["D"], "E": EYE_DARK}

    down_0 = from_grid([
        "................",
        "................",
        ".....OOOOOO.....",
        "....OLLMMMDO....",
        "....OLMMMMDO....",
        "....OMEMMEDO....",
        "....OMMMMMDO....",
        ".....ODDDDO.....",
        "......OOOO......",
        "...O........O...",
        "...MO......OM...",
        "...O........O...",
        "................",
        "................",
        "................",
        "................",
    ], pal)
    down_1 = down_0.copy()
    # Slight arm shift on walk frame 1
    down_1.set(3, 10, TRANSPARENT)
    down_1.set(3, 11, sp["M"])
    down_1.set(12, 10, TRANSPARENT)
    down_1.set(12, 9, sp["M"])

    up_0 = from_grid([
        "................",
        "................",
        ".....OOOOOO.....",
        "....OMMMMMDO....",
        "....OMMMMMDO....",
        "....OMMMMMDO....",
        "....ODDDDDDO....",
        ".....OOOOOO.....",
        "................",
        "...O........O...",
        "...DO......OD...",
        "...O........O...",
        "................",
        "................",
        "................",
        "................",
    ], pal)
    up_1 = up_0.copy()
    up_1.set(3, 10, TRANSPARENT)
    up_1.set(3, 9, sp["D"])
    up_1.set(12, 10, TRANSPARENT)
    up_1.set(12, 11, sp["D"])

    right_0 = from_grid([
        "................",
        "................",
        ".....OOOOOO.....",
        "....ODMMMLO.....",
        "....ODMMMMLO....",
        "....ODMMEMLO....",
        "....ODMMMMLO....",
        ".....ODDDDO.....",
        "................",
        "................",
        ".......OM.......",
        ".......OO.......",
        "................",
        "................",
        "................",
        "................",
    ], pal)
    right_1 = right_0.copy()
    right_1.set(8, 10, TRANSPARENT)
    right_1.set(9, 10, sp["M"])

    left_0 = right_0.flip_x()
    left_1 = right_1.flip_x()
    return assemble_sheet({
        "down": [down_0, down_1],
        "up": [up_0, up_1],
        "left": [left_0, left_1],
        "right": [right_0, right_1],
    })


def build_8bit_tunic(color: str) -> Canvas:
    tp = TUNIC_PALETTES[color]
    pal = {
        "O": OUTLINE, "L": tp["L"], "M": tp["M"], "D": tp["D"], "T": tp["T"],
        "B": LEATHER_PAL["D"], "G": LEATHER_PAL["G"],
    }
    down_0 = from_grid([
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        ".....OOOOOO.....",
        "....OLMTTMD0....".replace("0", "O"),
        "...OLMMMMMMDO...",
        "....OBBGBBBO....",
        "....OMMMMMDO....",
        ".....OOOOOO.....",
        "................",
        "................",
        "................",
    ], pal)
    down_1 = down_0.shift(0, 0)

    up_0 = from_grid([
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        ".....OOOOOO.....",
        "....OMMMMMDO....",
        "...OMMMMMMMDO...",
        "....OBBBBBBO....",
        "....OMMMMMDO....",
        ".....OOOOOO.....",
        "................",
        "................",
        "................",
    ], pal)
    up_1 = up_0.copy()

    right_0 = from_grid([
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        ".....OOOOO......",
        "....ODMMMLO.....",
        "....ODMMMLO.....",
        "....OBBBGBO.....",
        "....ODMMMLO.....",
        ".....OOOOO......",
        "................",
        "................",
        "................",
    ], pal)
    right_1 = right_0.copy()

    return assemble_sheet({
        "down": [down_0, down_1],
        "up": [up_0, up_1],
        "left": [right_0.flip_x(), right_1.flip_x()],
        "right": [right_0, right_1],
    })


def build_8bit_boots(swift: bool = False) -> Canvas:
    pal = {
        "O": OUTLINE,
        "L": LEATHER_PAL["L"],
        "M": LEATHER_PAL["M"],
        "D": LEATHER_PAL["D"],
        "W": hex_rgba("#E0F2FE"),
        "C": hex_rgba("#38BDF8"),
    }
    if not swift:
        down_0 = from_grid([
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            ".....OO..OO.....",
            "....OLMO.OLMO...",
            "....OOOO.OOOO...",
            "................",
        ], pal)
        down_1 = from_grid([
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            ".....OO...OO....",
            "....OLMO..OLMO..",
            "....OOOO...OO...",
            "................",
        ], pal)
        right_0 = from_grid([
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            ".....OOOO.......",
            "....ODMLMO......",
            "....OOOOOO......",
            "................",
        ], pal)
        right_1 = from_grid([
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "....OO...OO.....",
            "...ODMO.OMLO....",
            "...OOOO.OOOO....",
            "................",
        ], pal)
    else:
        down_0 = from_grid([
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "...W.OO..OO.W...",
            "...COLMO.OLMOC..",
            "....OOOO.OOOO...",
            "................",
        ], pal)
        down_1 = from_grid([
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "...W.OO...OO.W..",
            "...COLMO..OLMOC.",
            "....OOOO...OO...",
            "................",
        ], pal)
        right_0 = from_grid([
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "...W.OOOO.......",
            "...CODMLMO......",
            "....OOOOOO......",
            "................",
        ], pal)
        right_1 = from_grid([
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "..W.OO...OO.....",
            "..CODMO.OMLO....",
            "...OOOO.OOOO....",
            "................",
        ], pal)

    return assemble_sheet({
        "down": [down_0, down_1],
        "up": [down_0, down_1],
        "left": [right_0.flip_x(), right_1.flip_x()],
        "right": [right_0, right_1],
    })


def build_8bit_hair(style: str, tucked: bool = False) -> Canvas:
    pal = HAIR_PAL
    if tucked:
        # Minimal sideburn/nape fringe visible under full-coverage helms
        down = from_grid([
            "................",
            "................",
            "................",
            "................",
            "....D......D....",
            "....D......D....",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        up = from_grid([
            "................",
            "................",
            "................",
            "................",
            "................",
            "....OMMMMMDO....",
            ".....ODDDDO.....",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        right = from_grid([
            "................",
            "................",
            "................",
            "................",
            "....DM..........",
            "....DD..........",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        return assemble_sheet({
            "down": [down, down],
            "up": [up, up],
            "left": [right.flip_x(), right.flip_x()],
            "right": [right, right],
        })

    if style == "spiky":
        down = from_grid([
            "....O..OO..O....",
            "...OLOOLLOOMO...",
            "...OLLMMMMLDO...",
            "...OMMDDDDMDO...",
            "...OD......DO...",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        up = from_grid([
            "....O..OO..O....",
            "...OLOOLLOOMO...",
            "...OLLMMMMMDO...",
            "...OMMMMMMMDO...",
            "...OMMMMMMMDO...",
            "...ODDDDDDDDO...",
            "....OOOOOOOO....",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        right = from_grid([
            "....O..OO.......",
            "...OLOOLLOO.....",
            "...OLLMMMMLO....",
            "...OMMDDDDMO....",
            "...OMD..........",
            "...OD...........",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
    elif style == "windswept":
        down = from_grid([
            ".....OOOOOO.....",
            "...OOLLLLMMOO...",
            "..OLLMMMMMMMDO..",
            "...OMMDD..MMDO..",
            "...OD......DDO..",
            ".............O..",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        up = from_grid([
            ".....OOOOOO.....",
            "...OOLLLLMMOO...",
            "..OLLMMMMMMMDO..",
            "..OMMMMMMMMMDO..",
            "...OMMMMMMMMDO..",
            "....ODDDDDDDO...",
            ".....OOOOOOO....",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        right = from_grid([
            "....OOOOOOO.....",
            "..OOLLLLMMMO....",
            ".OLLMMMMMMMLO...",
            "..OMMDDDDM.O....",
            "..OMD...........",
            "...O............",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
    elif style == "curly":
        down = from_grid([
            "....OOOOOOOO....",
            "...OLLMLLMLLO...",
            "..OLLMMLMMLMDO..",
            "..OMMD....DMDO..",
            "..OMD......DMO..",
            "...O........O...",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        up = from_grid([
            "....OOOOOOOO....",
            "...OLLMLLMLLO...",
            "..OLLMMLMMLMDO..",
            "..OMMMMMMMMMDO..",
            "..OMMDMMMMDMDO..",
            "...ODDDDDDDDO...",
            "....OOOOOOOO....",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        right = from_grid([
            "....OOOOOOO.....",
            "...OLLMLLMLO....",
            "..OLLMMLMMMLO...",
            "..OMMD.DDM.O....",
            "..OMD...........",
            "...O............",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
    elif style == "braided":
        down = from_grid([
            ".....OOOOOO.....",
            "....OLLLLMMO....",
            "...OLLMMMMMDO...",
            "...OMD....DMO...",
            "...OMD....DMO...",
            "...OLD....DLO...",
            "...OMD....DMO...",
            "....O......O....",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        up = from_grid([
            ".....OOOOOO.....",
            "....OLLLLMMO....",
            "...OLLMMMMMDO...",
            "...OMMMMMMMDO...",
            "...ODDDDDDDDO...",
            "......OLMO......",
            "......OMDO......",
            "......OLMO......",
            ".......OO.......",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        right = from_grid([
            ".....OOOOOO.....",
            "....OLLLLMMO....",
            "...OLLMMMMMLO...",
            "...OMMD...MO....",
            "...OMD..........",
            "...OLD..........",
            "...OMD..........",
            "....O...........",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
    elif style == "ponytail":
        down = from_grid([
            ".....OOOOOO.....",
            "....OLLLLMMO....",
            "...OLLMMMMMDO...",
            "...OMD....DMO...",
            "....O......O....",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        up = from_grid([
            ".....OOOOOO.....",
            "....OLLLLMMO....",
            "...OLLMMMMMDO...",
            "...OMMMMMMMDO...",
            "....ODDDDDDO....",
            "......OLLO......",
            ".....OMMMDO.....",
            ".....ODDDDO.....",
            "......OOOO......",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        right = from_grid([
            ".....OOOOOO.....",
            "....OLLLLMMO....",
            "..OOLLMMMMMLO...",
            ".OLLMMMD..MO....",
            ".OMMDD..........",
            "..OO............",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
    else:  # cropped
        down = from_grid([
            "................",
            ".....OOOOOO.....",
            "....OLLLLMMO....",
            "....OMDDDDMO....",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        up = from_grid([
            "................",
            ".....OOOOOO.....",
            "....OLLLLMMO....",
            "....OMMMMMDO....",
            "....ODDDDDDO....",
            ".....OOOOOO.....",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        right = from_grid([
            "................",
            ".....OOOOOO.....",
            "....OLLLLMLO....",
            "....OMDD..MO....",
            "....OD..........",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)

    return assemble_sheet({
        "down": [down, down],
        "up": [up, up],
        "left": [right.flip_x(), right.flip_x()],
        "right": [right, right],
    })


def build_8bit_hat(hat_key: str) -> Canvas:
    if hat_key == "hat_explorer":
        pal = {
            "O": OUTLINE,
            "L": hex_rgba("#B57A46"),
            "M": hex_rgba("#875329"),
            "D": hex_rgba("#593316"),
            "C": hex_rgba("#38BDF8"),
            "G": hex_rgba("#FACC15"),
        }
        down = from_grid([
            ".....OOOOOO.C...",
            "....OLLLLMMOC...",
            "..OOOMMMMMMOO...",
            ".OLLLDDDDDDMMO..",
            "..OOOOOOOOOOO...",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        up = down.copy()
        right = from_grid([
            "....C.OOOOOO....",
            "....COLLLLMMO...",
            "..OOOMMMMMMOO...",
            ".ODDDMMMMMMLLO..",
            "..OOOOOOOOOOO...",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
    elif hat_key == "hat_dragon_helm":
        pal = {
            "O": OUTLINE,
            "R": hex_rgba("#DC2626"),
            "r": hex_rgba("#991B1B"),
            "H": hex_rgba("#FEF3C7"),
            "h": hex_rgba("#D97706"),
            "G": hex_rgba("#FACC15"),
        }
        down = from_grid([
            "..O..........O..",
            ".OHO.OOOOOO.OHO.",
            "..OhORRGGRROhO..",
            "...ORRRRRRRrO...",
            "...ORrO..OrRO...",
            "...OrO....OrO...",
            "....O......O....",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        up = from_grid([
            "..O..........O..",
            ".OHO.OOOOOO.OHO.",
            "..OhORRGGRROhO..",
            "...ORRRRRRRrO...",
            "...ORrrrrrrrO...",
            "...OrrrrrrrrO...",
            "....OOOOOOOO....",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        right = from_grid([
            "...O............",
            "..OHOOOOOOO.....",
            "...OhORRGGRRO...",
            "....ORRRRRRRO...",
            "....ORrO..OO....",
            "....OrO.........",
            ".....O..........",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
    else:  # hat_wizard_cap
        pal = {
            "O": OUTLINE,
            "L": hex_rgba("#60A5FA"),
            "M": hex_rgba("#2563EB"),
            "D": hex_rgba("#1E3A8A"),
            "G": hex_rgba("#FACC15"),
        }
        down = from_grid([
            "......OOOG......",
            ".....OLMMMO.....",
            "..OOOLMGMMMOO...",
            ".OLLMMMMMMMMDO..",
            "..OOOOOOOOOOO...",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)
        up = down.copy()
        right = from_grid([
            ".....GOOO.......",
            "....OMMMLO......",
            "..OOMMMGMLOOO...",
            ".ODMMMMMMMMLLO..",
            "..OOOOOOOOOOO...",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
            "................",
        ], pal)

    return assemble_sheet({
        "down": [down, down],
        "up": [up, up],
        "left": [right.flip_x(), right.flip_x()],
        "right": [right, right],
    })


def build_8bit_cloak_tide() -> Tuple[Canvas, Canvas]:
    pal = {
        "O": OUTLINE,
        "L": hex_rgba("#2DD4BF"),
        "M": hex_rgba("#0D9488"),
        "D": hex_rgba("#115E59"),
        "G": hex_rgba("#FACC15"),
    }
    back_down_0 = from_grid([
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "...O........O...",
        "..OMO......OMO..",
        "..OMO......OMO..",
        "..OLM......DMO..",
        "..OLMOOOOOODMO..",
        "...OOOOOOOOOO...",
        "................",
        "................",
    ], pal)
    back_down_1 = back_down_0.copy()
    back_down_1.set(2, 12, TRANSPARENT)
    back_down_1.set(13, 12, hex_rgba("#2DD4BF"))

    back_up_0 = from_grid([
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        ".....OOOOOO.....",
        "....OLMMMMDO....",
        "...OLMMMMMMDO...",
        "...OLMLMMMDDO...",
        "..OOLMLMMMDDOO..",
        "..OLMLMMMMDDMO..",
        "...OOOOOOOOOO...",
        "................",
        "................",
    ], pal)
    back_up_1 = back_up_0.copy()
    back_up_1.set(2, 12, TRANSPARENT)
    back_up_1.set(13, 12, hex_rgba("#0D9488"))

    back_right_0 = from_grid([
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "....OOO.........",
        "...OLMO.........",
        "..OLMMO.........",
        "..OMMDO.........",
        ".OLMMDO.........",
        ".ODDDDO.........",
        "..OOOO..........",
        "................",
        "................",
    ], pal)
    back_right_1 = back_right_0.shift(-1, 0)

    front_down = from_grid([
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        ".....OOGGOO.....",
        "....OMOOOOOO....",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ], pal)
    front_empty = Canvas(16, 16)
    front_right = from_grid([
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        ".....OOG........",
        ".....OMO........",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ], pal)

    back_sheet = assemble_sheet({
        "down": [back_down_0, back_down_1],
        "up": [back_up_0, back_up_1],
        "left": [back_right_0.flip_x(), back_right_1.flip_x()],
        "right": [back_right_0, back_right_1],
    })
    front_sheet = assemble_sheet({
        "down": [front_down, front_down],
        "up": [front_empty, front_empty],
        "left": [front_right.flip_x(), front_right.flip_x()],
        "right": [front_right, front_right],
    })
    return back_sheet, front_sheet


def build_8bit_shield(kind: str) -> Canvas:
    if kind == "shield_oak":
        pal = {
            "O": OUTLINE,
            "R": hex_rgba("#94A3B8"),
            "L": hex_rgba("#B57A46"),
            "M": hex_rgba("#875329"),
            "C": hex_rgba("#38BDF8"),
        }
    else:  # shield_coral
        pal = {
            "O": OUTLINE,
            "R": hex_rgba("#F472B6"),
            "L": hex_rgba("#2DD4BF"),
            "M": hex_rgba("#0D9488"),
            "C": hex_rgba("#FEF08A"),
        }
    down_0 = from_grid([
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "...........OOOO.",
        "..........ORLMO.",
        "..........ORCMO.",
        "..........ORMMO.",
        "...........OOO..",
        "................",
        "................",
        "................",
    ], pal)
    down_1 = down_0.shift(0, -1)
    up_0 = down_0.flip_x()
    up_1 = down_1.flip_x()
    right_0 = from_grid([
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        ".........OOOO...",
        "........ORLMO...",
        "........ORCMO...",
        "........ORMMO...",
        ".........OOO....",
        "................",
        "................",
        "................",
    ], pal)
    right_1 = right_0.shift(1, 0)
    return assemble_sheet({
        "down": [down_0, down_1],
        "up": [up_0, up_1],
        "left": [right_0.flip_x(), right_1.flip_x()],
        "right": [right_0, right_1],
    })


def build_8bit_aura(kind: str) -> Canvas:
    if kind == "aura_charisma_1":
        pal = {"A": hex_rgba("#38BDF8"), "B": hex_rgba("#FACC15")}
    else:  # aura_courage_1
        pal = {"A": hex_rgba("#FB923C"), "B": hex_rgba("#FEF08A")}
    f0 = from_grid([
        "..A.............",
        "..............B.",
        "................",
        "................",
        "................",
        ".B..............",
        "................",
        "................",
        "...............A",
        "................",
        "................",
        "..B.............",
        "................",
        "..............A.",
        "................",
        "................",
    ], pal)
    f1 = from_grid([
        ".............A..",
        ".B..............",
        "................",
        "................",
        "..............B.",
        "................",
        "................",
        ".A..............",
        "................",
        "................",
        ".............B..",
        "................",
        "..A.............",
        "................",
        "................",
        "................",
    ], pal)
    return assemble_sheet({d: [f0, f1] for d in DIRECTIONS})


def build_pip_sprites(frames: int) -> Tuple[Canvas, Canvas]:
    """Pip 16x16 companion sprites (2 frames for 8-bit, 4 frames for 16-bit) + ember scarf."""
    pal = {
        "O": OUTLINE,
        "L": hex_rgba("#5EEAD4"),
        "M": hex_rgba("#14B8A6"),
        "D": hex_rgba("#0F766E"),
        "W": hex_rgba("#FB923C"),
        "w": hex_rgba("#EA580C"),
        "B": hex_rgba("#FDE68A"),
        "E": EYE_DARK,
        "G": hex_rgba("#38BDF8"),
    }
    down_0 = from_grid([
        "......G.........",
        "....O....O......",
        "....OLOOOLO.....",
        "...OLLMMMLDO....",
        "..OOMEMMEMDOO...",
        ".OWWOBBBBOOWWO..",
        ".OwwOMMMMOwwO...",
        "..OOOMBBMOOO..G.",
        ".....OMMO.......",
        "....OD..DO......",
        "....OO..OO......",
        ".........G......",
        "................",
        "................",
        "................",
        "................",
    ], pal)
    down_1 = from_grid([
        ".........G......",
        "....O....O......",
        ".OO.OLOOOLO.OO..",
        "OWWOLLMMMLDOWWO.",
        ".OwwMEMMEMDwwO..",
        "..OOOBBBBOOOO...",
        ".....OMMO.....G.",
        ".....MBBM.......",
        ".....OMMO.......",
        "....OD..DO......",
        "....OO..OO......",
        "..G.............",
        "................",
        "................",
        "................",
        "................",
    ], pal)

    up_0 = from_grid([
        "......G.........",
        "....O....O......",
        "....OLOOOLO.....",
        "...OLLMMMLDO....",
        "..OOMMMMMMDOO...",
        ".OWWOMMMMOOWWO..",
        ".OwwODDDDOwwO...",
        "..OOOMMMMOOO..G.",
        ".....ODDO.......",
        "......OO........",
        "................",
        ".........G......",
        "................",
        "................",
        "................",
        "................",
    ], pal)
    up_1 = from_grid([
        ".........G......",
        "....O....O......",
        ".OO.OLOOOLO.OO..",
        "OWWOLLMMMLDOWWO.",
        ".OwwMMMMMMDwwO..",
        "..OOOMMMMOOOO...",
        ".....ODDO.....G.",
        ".....OMMO.......",
        ".....ODDO.......",
        "......OO........",
        "................",
        "..G.............",
        "................",
        "................",
        "................",
        "................",
    ], pal)

    right_0 = from_grid([
        ".....G..........",
        "......O..O......",
        ".....OLOOLO.....",
        "....OLLMMMLO....",
        "..OOOMMMEMLO....",
        ".OWWOMMBBBBO....",
        ".OwwODMMBBO..G..",
        "..OO.OMMMO......",
        "...OOODDO.......",
        "..O..O..O.......",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ], pal)
    right_1 = from_grid([
        ".........G......",
        "......O..O......",
        ".OO..OLOOLO.....",
        "OWWO.LLMMMLO....",
        ".OwwOMMMEMLO....",
        "..OOOMMBBBBO....",
        ".....DMMBBO..G..",
        "....OOMMMO......",
        "..OO.ODDO.......",
        ".....O..O.......",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ], pal)

    scarf_pal = {
        "O": OUTLINE,
        "R": hex_rgba("#EF4444"),
        "r": hex_rgba("#B91C1C"),
        "G": hex_rgba("#FACC15"),
    }
    s_down_0 = from_grid([
        "................",
        "................",
        "................",
        "................",
        "................",
        "....OOOOOO......",
        "....ORRRGOrO....",
        ".........OrO....",
        "..........O.....",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ], scarf_pal)
    s_down_1 = s_down_0.shift(0, -1)
    s_up_0 = s_down_0.copy()
    s_up_1 = s_down_1.copy()
    s_right_0 = from_grid([
        "................",
        "................",
        "................",
        "................",
        "................",
        "...OOOOOOO......",
        "..OrRRGrrO......",
        "..OO............",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ], scarf_pal)
    s_right_1 = s_right_0.shift(-1, -1)

    if frames == 2:
        pip_sheet = assemble_sheet({
            "down": [down_0, down_1],
            "up": [up_0, up_1],
            "left": [right_0.flip_x(), right_1.flip_x()],
            "right": [right_0, right_1],
        })
        scarf_sheet = assemble_sheet({
            "down": [s_down_0, s_down_1],
            "up": [s_up_0, s_up_1],
            "left": [s_right_0.flip_x(), s_right_1.flip_x()],
            "right": [s_right_0, s_right_1],
        })
    else:
        # 4-frame smooth hover bob for 16-bit era
        pip_sheet = assemble_sheet({
            "down": [down_0, down_1, down_0.shift(0, -1), down_1.shift(0, 1)],
            "up": [up_0, up_1, up_0.shift(0, -1), up_1.shift(0, 1)],
            "left": [right_0.flip_x(), right_1.flip_x(), right_0.flip_x().shift(0, -1), right_1.flip_x().shift(0, 1)],
            "right": [right_0, right_1, right_0.shift(0, -1), right_1.shift(0, 1)],
        })
        scarf_sheet = assemble_sheet({
            "down": [s_down_0, s_down_1, s_down_0.shift(0, -1), s_down_1.shift(0, 1)],
            "up": [s_up_0, s_up_1, s_up_0.shift(0, -1), s_up_1.shift(0, 1)],
            "left": [s_right_0.flip_x(), s_right_1.flip_x(), s_right_0.flip_x().shift(0, -1), s_right_1.flip_x().shift(0, 1)],
            "right": [s_right_0, s_right_1, s_right_0.shift(0, -1), s_right_1.shift(0, 1)],
        })
    return pip_sheet, scarf_sheet


# ---------------------------------------------------------------------------
# 16-BIT ERA (32x32 frames, 4 dirs x 4 walk frames = 128x128 sheets)
# Rich 3-step shading ramps, specular highlights, colored depth, smooth 4-frame walk
# ---------------------------------------------------------------------------
def build_16bit_shadow() -> Canvas:
    c = Canvas(32, 32)
    outer = (18, 16, 32, 70)
    inner = (14, 12, 26, 130)
    c.rect(10, 27, 12, 3, outer)
    c.rect(9, 28, 14, 1, outer)
    c.rect(11, 28, 10, 2, inner)
    return assemble_sheet({d: [c, c, c, c] for d in DIRECTIONS})


def build_16bit_skin(tone: str) -> Canvas:
    sp = SKIN_PALETTES[tone]
    O = OUTLINE
    L, M, D, C = sp["L"], sp["M"], sp["D"], sp["C"]
    E, W = EYE_DARK, EYE_WHITE

    def make_down(arm_l_dy: int, arm_r_dy: int, bob: int) -> Canvas:
        c = Canvas(32, 32)
        # Head (x=10..21, y=6..15)
        c.rect(11, 6 + bob, 10, 1, O)
        c.rect(10, 7 + bob, 12, 8, O)
        c.rect(11, 15 + bob, 10, 1, O)
        c.rect(11, 7 + bob, 10, 8, M)
        c.rect(11, 7 + bob, 9, 2, L)
        c.rect(11, 14 + bob, 10, 1, D)
        c.rect(20, 8 + bob, 1, 6, D)
        # Ears
        c.set(9, 10 + bob, O); c.set(9, 11 + bob, O); c.set(10, 10 + bob, M); c.set(10, 11 + bob, D)
        c.set(22, 10 + bob, O); c.set(22, 11 + bob, O); c.set(21, 10 + bob, M); c.set(21, 11 + bob, D)
        # Eyes (2x2 with white glint)
        c.set(12, 11 + bob, E); c.set(13, 11 + bob, W)
        c.set(12, 12 + bob, E); c.set(13, 12 + bob, E)
        c.set(18, 11 + bob, W); c.set(19, 11 + bob, E)
        c.set(18, 12 + bob, E); c.set(19, 12 + bob, E)
        # Rosy cheeks
        c.set(11, 13 + bob, C); c.set(20, 13 + bob, C)
        # Neck
        c.rect(14, 15 + bob, 4, 2, D)
        # Hands (left & right)
        for hx, dy in ((8, arm_l_dy), (21, arm_r_dy)):
            c.rect(hx, 20 + bob + dy, 3, 3, O)
            c.set(hx + 1, 21 + bob + dy, L)
            c.set(hx + 1, 22 + bob + dy, D)
        return c

    def make_up(arm_l_dy: int, arm_r_dy: int, bob: int) -> Canvas:
        c = Canvas(32, 32)
        c.rect(11, 6 + bob, 10, 1, O)
        c.rect(10, 7 + bob, 12, 8, O)
        c.rect(11, 15 + bob, 10, 1, O)
        c.rect(11, 7 + bob, 10, 8, M)
        c.rect(11, 13 + bob, 10, 2, D)
        c.rect(14, 15 + bob, 4, 2, D)
        for hx, dy in ((8, arm_l_dy), (21, arm_r_dy)):
            c.rect(hx, 20 + bob + dy, 3, 3, O)
            c.set(hx + 1, 21 + bob + dy, M)
        return c

    def make_right(hand_dx: int, bob: int) -> Canvas:
        c = Canvas(32, 32)
        c.rect(11, 6 + bob, 9, 1, O)
        c.rect(10, 7 + bob, 11, 8, O)
        c.rect(11, 15 + bob, 9, 1, O)
        c.rect(11, 7 + bob, 9, 8, M)
        c.rect(13, 7 + bob, 7, 2, L)
        c.rect(11, 7 + bob, 2, 8, D)
        c.rect(11, 14 + bob, 9, 1, D)
        # Side eye
        c.set(17, 11 + bob, W); c.set(18, 11 + bob, E)
        c.set(17, 12 + bob, E); c.set(18, 12 + bob, E)
        c.set(18, 13 + bob, C)
        # Neck
        c.rect(14, 15 + bob, 3, 2, D)
        # Swinging hand
        hx = 15 + hand_dx
        c.rect(hx, 20 + bob, 3, 3, O)
        c.set(hx + 1, 21 + bob, L)
        return c

    down = [make_down(0, 0, 0), make_down(-1, 1, -1), make_down(0, 0, 0), make_down(1, -1, -1)]
    up = [make_up(0, 0, 0), make_up(1, -1, -1), make_up(0, 0, 0), make_up(-1, 1, -1)]
    right = [make_right(0, 0), make_right(2, -1), make_right(0, 0), make_right(-2, -1)]
    left = [f.flip_x() for f in right]
    return assemble_sheet({"down": down, "up": up, "left": left, "right": right})


def build_16bit_tunic(color: str) -> Canvas:
    tp = TUNIC_PALETTES[color]
    O = OUTLINE
    L, M, D, T = tp["L"], tp["M"], tp["D"], tp["T"]
    BL, BM, BD, G = LEATHER_PAL["L"], LEATHER_PAL["M"], LEATHER_PAL["D"], LEATHER_PAL["G"]

    def make_down(bob: int) -> Canvas:
        c = Canvas(32, 32)
        # Torso outline & fill
        c.rect(10, 16 + bob, 12, 9, O)
        c.rect(9, 17 + bob, 14, 5, O)
        c.rect(11, 17 + bob, 10, 7, M)
        # 3-step shading
        c.rect(11, 17 + bob, 8, 2, L)
        c.rect(19, 17 + bob, 2, 7, D)
        c.rect(11, 23 + bob, 10, 1, D)
        # Collar trim
        c.rect(13, 16 + bob, 6, 1, T)
        c.rect(14, 17 + bob, 4, 1, T)
        c.set(15, 18 + bob, D); c.set(16, 18 + bob, D)
        # Sleeves
        c.rect(9, 17 + bob, 2, 4, M); c.set(9, 17 + bob, L)
        c.rect(21, 17 + bob, 2, 4, D); c.set(21, 17 + bob, M)
        # Leather belt + gold buckle
        c.rect(10, 21 + bob, 12, 2, BD)
        c.rect(11, 21 + bob, 10, 1, BM)
        c.rect(15, 21 + bob, 2, 2, G)
        # Tunic hem trim
        c.rect(11, 24 + bob, 10, 1, O)
        return c

    def make_up(bob: int) -> Canvas:
        c = Canvas(32, 32)
        c.rect(10, 16 + bob, 12, 9, O)
        c.rect(9, 17 + bob, 14, 5, O)
        c.rect(11, 17 + bob, 10, 7, M)
        c.rect(11, 17 + bob, 10, 2, L)
        c.rect(11, 23 + bob, 10, 1, D)
        c.rect(9, 17 + bob, 2, 4, M)
        c.rect(21, 17 + bob, 2, 4, D)
        c.rect(10, 21 + bob, 12, 2, BD)
        c.rect(11, 21 + bob, 10, 1, BM)
        c.rect(11, 24 + bob, 10, 1, O)
        return c

    def make_right(bob: int) -> Canvas:
        c = Canvas(32, 32)
        c.rect(11, 16 + bob, 9, 9, O)
        c.rect(12, 17 + bob, 7, 7, M)
        c.rect(14, 17 + bob, 5, 2, L)
        c.rect(12, 17 + bob, 2, 7, D)
        c.rect(12, 23 + bob, 7, 1, D)
        c.rect(14, 16 + bob, 4, 1, T)
        c.rect(11, 21 + bob, 9, 2, BD)
        c.rect(12, 21 + bob, 7, 1, BM)
        c.rect(17, 21 + bob, 2, 2, G)
        return c

    bobs = [0, -1, 0, -1]
    down = [make_down(b) for b in bobs]
    up = [make_up(b) for b in bobs]
    right = [make_right(b) for b in bobs]
    left = [f.flip_x() for f in right]
    return assemble_sheet({"down": down, "up": up, "left": left, "right": right})


def build_16bit_boots(swift: bool = False) -> Canvas:
    O = OUTLINE
    L, M, D = LEATHER_PAL["L"], LEATHER_PAL["M"], LEATHER_PAL["D"]
    P = hex_rgba("#3B4252")  # trousers
    W = hex_rgba("#F0F9FF")
    C = hex_rgba("#38BDF8")

    def make_down(ldy: int, rdy: int) -> Canvas:
        c = Canvas(32, 32)
        # Left leg + boot
        c.rect(11, 24 + ldy, 4, 4, O)
        c.rect(12, 24 + ldy, 2, 1, P)
        c.rect(12, 25 + ldy, 2, 2, M)
        c.set(12, 25 + ldy, L)
        c.set(13, 26 + ldy, D)
        # Right leg + boot
        c.rect(17, 24 + rdy, 4, 4, O)
        c.rect(18, 24 + rdy, 2, 1, P)
        c.rect(18, 25 + rdy, 2, 2, M)
        c.set(18, 25 + rdy, L)
        c.set(19, 26 + rdy, D)
        if swift:
            c.set(10, 25 + ldy, W); c.set(9, 24 + ldy, W); c.set(10, 26 + ldy, C)
            c.set(21, 25 + rdy, W); c.set(22, 24 + rdy, W); c.set(21, 26 + rdy, C)
        return c

    def make_right(step: int) -> Canvas:
        c = Canvas(32, 32)
        if step == 0:
            c.rect(13, 24, 6, 4, O)
            c.rect(14, 24, 3, 1, P)
            c.rect(14, 25, 4, 2, M)
            c.set(15, 25, L); c.set(16, 25, L)
            if swift:
                c.set(12, 25, W); c.set(11, 24, W); c.set(12, 26, C)
        elif step == 1:
            # Stride apart
            c.rect(10, 24, 5, 4, O); c.rect(11, 25, 3, 2, D)
            c.rect(17, 24, 5, 4, O); c.rect(18, 25, 3, 2, M); c.set(19, 25, L)
            if swift:
                c.set(9, 25, W); c.set(8, 24, W); c.set(9, 26, C)
                c.set(16, 25, W); c.set(16, 26, C)
        else:
            c.rect(11, 24, 5, 4, O); c.rect(12, 25, 3, 2, M); c.set(13, 25, L)
            c.rect(16, 24, 5, 4, O); c.rect(17, 25, 3, 2, D)
            if swift:
                c.set(10, 25, W); c.set(9, 24, W); c.set(10, 26, C)
        return c

    down = [make_down(0, 0), make_down(-1, 1), make_down(0, 0), make_down(1, -1)]
    up = [make_down(0, 0), make_down(1, -1), make_down(0, 0), make_down(-1, 1)]
    right = [make_right(0), make_right(1), make_right(0), make_right(2)]
    left = [f.flip_x() for f in right]
    return assemble_sheet({"down": down, "up": up, "left": left, "right": right})


def build_16bit_hair(style: str, tucked: bool = False) -> Canvas:
    O, H, L, M, D = HAIR_PAL["O"], HAIR_PAL["H"], HAIR_PAL["L"], HAIR_PAL["M"], HAIR_PAL["D"]
    bobs = [0, -1, 0, -1]

    def make_down(bob: int) -> Canvas:
        c = Canvas(32, 32)
        if tucked:
            c.rect(10, 10 + bob, 1, 3, D)
            c.rect(21, 10 + bob, 1, 3, D)
            return c
        # Base crown common to all styles
        c.rect(10, 4 + bob, 12, 5, O)
        c.rect(11, 5 + bob, 10, 4, M)
        c.rect(12, 5 + bob, 8, 2, L)
        c.rect(13, 5 + bob, 5, 1, H)
        c.rect(11, 8 + bob, 10, 1, D)
        # Side framing
        c.rect(9, 7 + bob, 2, 4, O); c.rect(10, 7 + bob, 1, 3, M)
        c.rect(21, 7 + bob, 2, 4, O); c.rect(21, 7 + bob, 1, 3, D)
        if style == "spiky":
            for sx, sy in ((11, 3), (14, 2), (17, 2), (20, 3)):
                c.rect(sx, sy + bob, 2, 2, O)
                c.set(sx, sy + 1 + bob, H if sx < 17 else L)
            # Bangs spikes
            c.set(12, 9 + bob, M); c.set(15, 9 + bob, L); c.set(18, 9 + bob, M)
        elif style == "windswept":
            c.rect(8, 5 + bob, 4, 3, O); c.rect(9, 6 + bob, 3, 2, L)
            c.rect(21, 6 + bob, 3, 4, O); c.rect(21, 7 + bob, 2, 2, M)
            c.rect(12, 8 + bob, 6, 2, M); c.rect(13, 8 + bob, 4, 1, H)
        elif style == "curly":
            for cx, cy in ((9, 5), (12, 3), (16, 3), (20, 5), (8, 8), (22, 8)):
                c.rect(cx, cy + bob, 3, 3, O)
                c.set(cx + 1, cy + 1 + bob, L if cy < 6 else M)
        elif style == "braided":
            # Twin side braids hanging to shoulders
            for bx in (9, 21):
                c.rect(bx, 10 + bob, 2, 8, O)
                for y in range(10, 17, 2):
                    c.set(bx, y + bob, L)
                    c.set(bx + 1, y + 1 + bob, D)
        elif style == "ponytail":
            c.rect(13, 3 + bob, 6, 2, O); c.rect(14, 4 + bob, 4, 1, H)
        elif style == "cropped":
            c = Canvas(32, 32)
            c.rect(10, 5 + bob, 12, 4, O)
            c.rect(11, 6 + bob, 10, 2, M)
            c.rect(12, 6 + bob, 6, 1, L)
        return c

    def make_up(bob: int) -> Canvas:
        c = Canvas(32, 32)
        if tucked:
            c.rect(11, 13 + bob, 10, 2, D)
            c.rect(11, 15 + bob, 10, 1, O)
            return c
        c.rect(10, 4 + bob, 12, 11, O)
        c.rect(11, 5 + bob, 10, 9, M)
        c.rect(12, 5 + bob, 8, 3, L)
        c.rect(13, 5 + bob, 5, 1, H)
        c.rect(11, 12 + bob, 10, 2, D)
        if style == "spiky":
            for sx, sy in ((11, 3), (14, 2), (17, 2), (20, 3)):
                c.rect(sx, sy + bob, 2, 2, O); c.set(sx, sy + 1 + bob, L)
        elif style == "windswept":
            c.rect(8, 5 + bob, 3, 4, O); c.rect(9, 6 + bob, 2, 2, L)
            c.rect(21, 6 + bob, 3, 5, O); c.rect(21, 7 + bob, 2, 3, D)
        elif style == "curly":
            for cx, cy in ((9, 5), (12, 3), (16, 3), (20, 5), (9, 10), (20, 10)):
                c.rect(cx, cy + bob, 3, 3, O); c.set(cx + 1, cy + 1 + bob, M)
        elif style == "braided":
            c.rect(14, 13 + bob, 4, 7, O)
            for y in range(14, 19, 2):
                c.rect(15, y + bob, 2, 1, L)
                c.rect(15, y + 1 + bob, 2, 1, D)
        elif style == "ponytail":
            c.rect(13, 12 + bob, 6, 7, O)
            c.rect(14, 13 + bob, 4, 5, M)
            c.rect(15, 13 + bob, 2, 2, H)
            c.rect(14, 11 + bob, 4, 2, hex_rgba("#EF4444"))  # hair tie
        elif style == "cropped":
            c = Canvas(32, 32)
            c.rect(10, 5 + bob, 12, 8, O)
            c.rect(11, 6 + bob, 10, 6, M)
            c.rect(12, 6 + bob, 7, 2, L)
            c.rect(11, 11 + bob, 10, 1, D)
        return c

    def make_right(bob: int) -> Canvas:
        c = Canvas(32, 32)
        if tucked:
            c.rect(10, 10 + bob, 2, 3, D)
            return c
        c.rect(10, 4 + bob, 11, 5, O)
        c.rect(11, 5 + bob, 9, 4, M)
        c.rect(12, 5 + bob, 7, 2, L)
        c.rect(13, 5 + bob, 4, 1, H)
        c.rect(9, 7 + bob, 4, 7, O)
        c.rect(10, 8 + bob, 3, 5, M)
        c.rect(10, 11 + bob, 2, 2, D)
        if style == "spiky":
            for sx, sy in ((10, 3), (13, 2), (17, 2)):
                c.rect(sx, sy + bob, 2, 2, O); c.set(sx, sy + 1 + bob, H)
        elif style == "windswept":
            c.rect(7, 6 + bob, 4, 4, O); c.rect(8, 7 + bob, 3, 2, L)
        elif style == "curly":
            for cx, cy in ((8, 6), (11, 3), (15, 3), (8, 10)):
                c.rect(cx, cy + bob, 3, 3, O); c.set(cx + 1, cy + 1 + bob, L)
        elif style == "braided":
            c.rect(9, 12 + bob, 3, 7, O)
            for y in range(13, 18, 2):
                c.set(10, y + bob, L); c.set(10, y + 1 + bob, D)
        elif style == "ponytail":
            c.rect(6, 8 + bob, 5, 5, O)
            c.rect(7, 9 + bob, 3, 3, M)
            c.set(8, 9 + bob, H)
            c.set(10, 9 + bob, hex_rgba("#EF4444"))
        elif style == "cropped":
            c = Canvas(32, 32)
            c.rect(10, 5 + bob, 11, 4, O)
            c.rect(11, 6 + bob, 9, 2, M)
            c.rect(12, 6 + bob, 6, 1, L)
            c.rect(10, 8 + bob, 3, 4, O); c.rect(11, 8 + bob, 2, 3, D)
        return c

    down = [make_down(b) for b in bobs]
    up = [make_up(b) for b in bobs]
    right = [make_right(b) for b in bobs]
    left = [f.flip_x() for f in right]
    return assemble_sheet({"down": down, "up": up, "left": left, "right": right})


def build_16bit_hat(hat_key: str) -> Canvas:
    O = OUTLINE
    bobs = [0, -1, 0, -1]

    def make_frame(direction: str, bob: int) -> Canvas:
        c = Canvas(32, 32)
        if hat_key == "hat_explorer":
            L, M, D = hex_rgba("#C2834B"), hex_rgba("#8A5428"), hex_rgba("#593316")
            B = hex_rgba("#38BDF8")  # cyan pixel feather
            G = hex_rgba("#FACC15")
            # Brim
            c.rect(6, 7 + bob, 20, 3, O)
            c.rect(7, 8 + bob, 18, 1, M)
            c.rect(8, 8 + bob, 12, 1, L)
            # Crown
            c.rect(10, 3 + bob, 12, 5, O)
            c.rect(11, 4 + bob, 10, 4, M)
            c.rect(12, 4 + bob, 7, 2, L)
            c.rect(11, 7 + bob, 10, 1, D)  # hatband
            # Glowing feather
            fx = 21 if direction != "right" else 9
            c.rect(fx, 2 + bob, 2, 5, O)
            c.set(fx, 3 + bob, B); c.set(fx + 1, 2 + bob, B); c.set(fx, 5 + bob, G)
        elif hat_key == "hat_dragon_helm":
            R, r, d = hex_rgba("#EF4444"), hex_rgba("#B91C1C"), hex_rgba("#7F1D1D")
            H, h = hex_rgba("#FEF3C7"), hex_rgba("#D97706")
            G = hex_rgba("#FACC15")
            if direction == "right":
                c.rect(9, 4 + bob, 13, 6, O)
                c.rect(10, 5 + bob, 11, 4, R)
                c.rect(11, 5 + bob, 8, 2, hex_rgba("#F87171"))
                c.rect(10, 8 + bob, 11, 1, d)
                # Cheek guard
                c.rect(10, 9 + bob, 4, 4, O); c.rect(11, 9 + bob, 2, 3, r)
                # Curved horn
                c.rect(7, 2 + bob, 4, 4, O); c.set(8, 3 + bob, H); c.set(9, 4 + bob, h)
                c.set(19, 6 + bob, G); c.set(20, 6 + bob, G)
            else:
                c.rect(9, 4 + bob, 14, 6, O)
                c.rect(10, 5 + bob, 12, 4, R)
                c.rect(11, 5 + bob, 10, 2, hex_rgba("#F87171"))
                c.rect(10, 8 + bob, 12, 1, d)
                # Gold crest
                c.rect(15, 3 + bob, 2, 5, G)
                # Twin curved horns
                for hx in (6, 23):
                    c.rect(hx, 2 + bob, 3, 4, O)
                    c.set(hx + 1, 3 + bob, H)
                    c.set(hx + 1, 4 + bob, h)
                if direction == "down":
                    # Cheek guards framing face
                    c.rect(9, 9 + bob, 3, 4, O); c.rect(10, 9 + bob, 1, 3, r)
                    c.rect(20, 9 + bob, 3, 4, O); c.rect(21, 9 + bob, 1, 3, r)
                else:
                    # Full back plate
                    c.rect(10, 9 + bob, 12, 5, O); c.rect(11, 9 + bob, 10, 4, r); c.rect(11, 12 + bob, 10, 1, d)
        else:  # hat_wizard_cap
            L, M, D = hex_rgba("#60A5FA"), hex_rgba("#2563EB"), hex_rgba("#1E3A8A")
            G = hex_rgba("#FACC15")
            # Brim
            c.rect(6, 7 + bob, 20, 3, O)
            c.rect(7, 8 + bob, 18, 1, M)
            c.rect(8, 8 + bob, 11, 1, L)
            # Pointed cone
            c.rect(10, 5 + bob, 12, 3, O); c.rect(11, 6 + bob, 10, 2, M)
            c.rect(12, 3 + bob, 8, 3, O); c.rect(13, 4 + bob, 6, 2, M); c.rect(13, 4 + bob, 3, 1, L)
            tip_x = 15 if direction != "right" else 11
            c.rect(tip_x, 1 + bob, 5, 3, O); c.rect(tip_x + 1, 2 + bob, 3, 1, L)
            # Silver/gold stars
            c.set(13, 6 + bob, G); c.set(18, 5 + bob, G); c.set(15, 3 + bob, G)
        return c

    down = [make_frame("down", b) for b in bobs]
    up = [make_frame("up", b) for b in bobs]
    right = [make_frame("right", b) for b in bobs]
    left = [f.flip_x() for f in right]
    return assemble_sheet({"down": down, "up": up, "left": left, "right": right})


def build_16bit_cloak_tide() -> Tuple[Canvas, Canvas]:
    O = OUTLINE
    L, M, D = hex_rgba("#2DD4BF"), hex_rgba("#0D9488"), hex_rgba("#115E59")
    G = hex_rgba("#FACC15")
    bobs = [0, -1, 0, -1]

    def back_down(i: int, bob: int) -> Canvas:
        c = Canvas(32, 32)
        sway = 1 if i == 1 else (-1 if i == 3 else 0)
        c.rect(6 + sway, 17 + bob, 20, 10, O)
        c.rect(7 + sway, 18 + bob, 18, 8, M)
        c.rect(7 + sway, 18 + bob, 4, 8, L)
        c.rect(21 + sway, 18 + bob, 4, 8, D)
        c.rect(7 + sway, 25 + bob, 18, 1, D)
        return c

    def back_up(i: int, bob: int) -> Canvas:
        c = Canvas(32, 32)
        sway = 1 if i == 1 else (-1 if i == 3 else 0)
        c.rect(9, 16 + bob, 14, 3, O)
        c.rect(8 + sway, 18 + bob, 16, 9, O)
        c.rect(9 + sway, 17 + bob, 14, 9, M)
        # Vertical ripple folds
        c.rect(10 + sway, 17 + bob, 2, 8, L)
        c.rect(15 + sway, 18 + bob, 2, 8, L)
        c.rect(13 + sway, 18 + bob, 1, 8, D)
        c.rect(19 + sway, 18 + bob, 3, 8, D)
        c.rect(9 + sway, 25 + bob, 14, 1, D)
        return c

    def back_right(i: int, bob: int) -> Canvas:
        c = Canvas(32, 32)
        sway = -1 if i in (1, 3) else 0
        c.rect(8 + sway, 17 + bob, 7, 10, O)
        c.rect(9 + sway, 18 + bob, 5, 8, M)
        c.rect(9 + sway, 18 + bob, 2, 8, L)
        c.rect(12 + sway, 19 + bob, 2, 7, D)
        return c

    def front_down(bob: int) -> Canvas:
        c = Canvas(32, 32)
        c.rect(10, 16 + bob, 12, 2, O)
        c.rect(11, 16 + bob, 10, 1, M)
        c.rect(15, 16 + bob, 2, 2, G)
        return c

    def front_right(bob: int) -> Canvas:
        c = Canvas(32, 32)
        c.rect(12, 16 + bob, 6, 2, O)
        c.rect(13, 16 + bob, 4, 1, M)
        c.set(16, 16 + bob, G); c.set(17, 17 + bob, G)
        return c

    empty = Canvas(32, 32)
    b_down = [back_down(i, bobs[i]) for i in range(4)]
    b_up = [back_up(i, bobs[i]) for i in range(4)]
    b_right = [back_right(i, bobs[i]) for i in range(4)]
    b_left = [f.flip_x() for f in b_right]

    f_down = [front_down(b) for b in bobs]
    f_right = [front_right(b) for b in bobs]
    f_left = [f.flip_x() for f in f_right]

    return (
        assemble_sheet({"down": b_down, "up": b_up, "left": b_left, "right": b_right}),
        assemble_sheet({"down": f_down, "up": [empty]*4, "left": f_left, "right": f_right}),
    )


def build_16bit_shield(kind: str) -> Canvas:
    O = OUTLINE
    if kind == "shield_oak":
        R, L, M, D, C = hex_rgba("#94A3B8"), hex_rgba("#C2834B"), hex_rgba("#8A5428"), hex_rgba("#593316"), hex_rgba("#38BDF8")
    else:  # shield_coral
        R, L, M, D, C = hex_rgba("#F472B6"), hex_rgba("#5EEAD4"), hex_rgba("#0D9488"), hex_rgba("#115E59"), hex_rgba("#FEF08A")

    def draw_shield(c: Canvas, sx: int, sy: int) -> None:
        c.rect(sx, sy, 7, 8, O)
        c.rect(sx + 1, sy + 8, 5, 1, O)
        c.rect(sx + 2, sy + 9, 3, 1, O)
        c.rect(sx + 1, sy + 1, 5, 7, R)
        c.rect(sx + 2, sy + 2, 3, 5, M)
        c.rect(sx + 2, sy + 2, 1, 5, L)
        c.rect(sx + 4, sy + 3, 1, 4, D)
        c.set(sx + 3, sy + 3, C); c.set(sx + 3, sy + 5, C)
        c.rect(sx + 2, sy + 8, 3, 1, R)

    bobs = [0, -1, 0, -1]
    down = []
    for i, b in enumerate(bobs):
        c = Canvas(32, 32)
        draw_shield(c, 21, 16 + b + (1 if i == 1 else 0))
        down.append(c)
    up = [f.flip_x() for f in down]
    right = []
    for i, b in enumerate(bobs):
        c = Canvas(32, 32)
        draw_shield(c, 18 + (1 if i == 1 else (-1 if i == 3 else 0)), 16 + b)
        right.append(c)
    left = [f.flip_x() for f in right]
    return assemble_sheet({"down": down, "up": up, "left": left, "right": right})


def build_16bit_aura(kind: str) -> Canvas:
    if kind == "aura_charisma_1":
        A, B, C = hex_rgba("#38BDF8"), hex_rgba("#FACC15"), hex_rgba("#E0F2FE")
    else:  # aura_courage_1
        A, B, C = hex_rgba("#F97316"), hex_rgba("#FACC15"), hex_rgba("#FEF08A")

    coords_per_frame = [
        [(6, 6, A), (25, 8, B), (5, 18, B), (26, 21, A), (8, 25, C), (23, 4, C)],
        [(5, 5, B), (26, 7, C), (6, 16, A), (25, 19, B), (7, 23, A), (24, 3, B)],
        [(7, 4, C), (24, 9, A), (4, 20, C), (27, 17, A), (9, 26, B), (22, 5, A)],
        [(6, 7, A), (25, 6, B), (5, 15, B), (26, 22, C), (6, 24, A), (23, 2, C)],
    ]
    frames = []
    for pts in coords_per_frame:
        c = Canvas(32, 32)
        for x, y, col in pts:
            c.set(x, y, col)
            # Subtle 4-way cross glint on primary sparkles
            glow = (col[0], col[1], col[2], 140)
            c.blend(x - 1, y, glow); c.blend(x + 1, y, glow)
            c.blend(x, y - 1, glow); c.blend(x, y + 1, glow)
        frames.append(c)
    return assemble_sheet({d: frames for d in DIRECTIONS})


# ---------------------------------------------------------------------------
# Tiny 5x7 Pixel Bitmap Font (for hero_showcase.png labels)
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
    "J": ["..###", "...#.", "...#.", "...#.", "#..#.", "#..#.", ".##.."],
    "K": ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
    "L": ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
    "M": ["#...#", "##.##", "#.#.#", "#...#", "#...#", "#...#", "#...#"],
    "N": ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
    "O": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "P": ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
    "Q": [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
    "R": ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
    "S": [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "U": ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "V": ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
    "W": ["#...#", "#...#", "#...#", "#...#", "#.#.#", "##.##", "#...#"],
    "X": ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
    "Y": ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
    "Z": ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
    "0": [".###.", "#..##", "#.#.#", "#.#.#", "##..#", "#...#", ".###."],
    "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
    "2": [".###.", "#...#", "....#", "..##.", ".#...", "#....", "#####"],
    "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
    "4": ["#...#", "#...#", "#...#", "#####", "....#", "....#", "....#"],
    "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
    "6": [".###.", "#....", "####.", "#...#", "#...#", "#...#", ".###."],
    "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
    "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
    "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
    "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
    ":": [".....", "..#..", "..#..", ".....", "..#..", "..#..", "....."],
    "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
    "(": ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."],
    ")": [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."],
    "/": ["....#", "...#.", "...#.", "..#..", ".#...", ".#...", "#...."],
    ".": [".....", ".....", ".....", ".....", ".....", "..##.", "..##."],
    "&": [".##..", "#..#.", ".##..", "#.#.#", "#..#.", "#..#.", ".##.#"],
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


def extract_frame(sheet: Canvas, fw: int, fh: int, dir_idx: int, frame_idx: int) -> Canvas:
    out = Canvas(fw, fh)
    ox, oy = frame_idx * fw, dir_idx * fh
    for y in range(fh):
        for x in range(fw):
            out.set(x, y, sheet.get(ox + x, oy + y))
    return out


# ---------------------------------------------------------------------------
# Main Build + Manifest + Visual Showcase
# ---------------------------------------------------------------------------
def main() -> None:
    era_8_dir = BASE_DIR / "8bit"
    era_16_dir = BASE_DIR / "16bit"
    era_8_dir.mkdir(parents=True, exist_ok=True)
    era_16_dir.mkdir(parents=True, exist_ok=True)

    # Keep generated sheets in memory to also composite hero_showcase.png
    sheets: Dict[str, Dict[str, Canvas]] = {"8bit": {}, "16bit": {}}

    def save_sheet(era: str, name: str, canvas: Canvas) -> str:
        rel = f"{era}/{name}.png"
        canvas.save(BASE_DIR / rel)
        sheets[era][name] = canvas
        return rel

    # 1. Shadow
    save_sheet("8bit", "shadow", build_8bit_shadow())
    save_sheet("16bit", "shadow", build_16bit_shadow())

    # 2. Skin tones
    for tone in SKIN_PALETTES:
        save_sheet("8bit", f"skin_{tone}", build_8bit_skin(tone))
        save_sheet("16bit", f"skin_{tone}", build_16bit_skin(tone))

    # 3. Hair styles (+ tucked variants for full-coverage hats like hat_dragon_helm)
    hair_styles = ["spiky", "windswept", "curly", "braided", "ponytail", "cropped"]
    for style in hair_styles:
        save_sheet("8bit", f"hair_{style}", build_8bit_hair(style, tucked=False))
        save_sheet("8bit", f"hair_{style}_tucked", build_8bit_hair(style, tucked=True))
        save_sheet("16bit", f"hair_{style}", build_16bit_hair(style, tucked=False))
        save_sheet("16bit", f"hair_{style}_tucked", build_16bit_hair(style, tucked=True))

    # 4. Tunics (torso)
    for color in TUNIC_PALETTES:
        save_sheet("8bit", f"tunic_{color}", build_8bit_tunic(color))
        save_sheet("16bit", f"tunic_{color}", build_16bit_tunic(color))

    # 5. Footwear
    save_sheet("8bit", "boots_default", build_8bit_boots(swift=False))
    save_sheet("8bit", "boots_swift", build_8bit_boots(swift=True))
    save_sheet("16bit", "boots_default", build_16bit_boots(swift=False))
    save_sheet("16bit", "boots_swift", build_16bit_boots(swift=True))

    # 6. Headgear
    for hat_key in ("hat_explorer", "hat_dragon_helm", "hat_wizard_cap"):
        save_sheet("8bit", hat_key, build_8bit_hat(hat_key))
        save_sheet("16bit", hat_key, build_16bit_hat(hat_key))

    # 7. Back / Cloak (back + front sheets for direction-aware Z-swap)
    c8_back, c8_front = build_8bit_cloak_tide()
    save_sheet("8bit", "cloak_tide_back", c8_back)
    save_sheet("8bit", "cloak_tide_front", c8_front)
    c16_back, c16_front = build_16bit_cloak_tide()
    save_sheet("16bit", "cloak_tide_back", c16_back)
    save_sheet("16bit", "cloak_tide_front", c16_front)

    # 8. Offhand shields
    for shield_key in ("shield_oak", "shield_coral"):
        save_sheet("8bit", shield_key, build_8bit_shield(shield_key))
        save_sheet("16bit", shield_key, build_16bit_shield(shield_key))

    # 9. Stat auras
    for aura_key in ("aura_charisma_1", "aura_courage_1"):
        save_sheet("8bit", aura_key, build_8bit_aura(aura_key))
        save_sheet("16bit", aura_key, build_16bit_aura(aura_key))

    # 10. Pip companion + ember scarf
    pip8, scarf8 = build_pip_sprites(frames=2)
    save_sheet("8bit", "pip_base", pip8)
    save_sheet("8bit", "pip_scarf_ember", scarf8)
    pip16, scarf16 = build_pip_sprites(frames=4)
    save_sheet("16bit", "pip_base", pip16)
    save_sheet("16bit", "pip_scarf_ember", scarf16)

    # -----------------------------------------------------------------------
    # Build manifest.json (100% keyed to content/catalog.json)
    # -----------------------------------------------------------------------
    manifest = {
        "version": "1.0.0",
        "catalogContract": "../../content/catalog.json",
        "directions": DIRECTIONS,
        "sheetLayout": {
            "rows": "directions (0=down, 1=up, 2=left, 3=right)",
            "columns": "animation frames (0..frameCount-1)"
        },
        "eras": {
            "era-01-8bit": {
                "key": "8bit",
                "name": "8-Bit Era (NES)",
                "heroFrameSize": {"width": 16, "height": 16},
                "heroFramesPerDirection": 2,
                "heroSheetSize": {"width": 32, "height": 64},
                "pipFrameSize": {"width": 16, "height": 16},
                "pipFramesPerDirection": 2,
                "pipSheetSize": {"width": 32, "height": 64},
                "recommendedFps": 5
            },
            "era-02-16bit": {
                "key": "16bit",
                "name": "16-Bit Era (SNES)",
                "heroFrameSize": {"width": 32, "height": 32},
                "heroFramesPerDirection": 4,
                "heroSheetSize": {"width": 128, "height": 128},
                "pipFrameSize": {"width": 16, "height": 16},
                "pipFramesPerDirection": 4,
                "pipSheetSize": {"width": 64, "height": 64},
                "recommendedFps": 8
            }
        },
        "layerOrder": {
            "default": [
                "shadow",
                "back_behind",
                "skin",
                "footwear",
                "torso",
                "hair",
                "headgear",
                "back_front",
                "offhand",
                "aura"
            ],
            "up": [
                "shadow",
                "offhand",
                "skin",
                "footwear",
                "torso",
                "hair",
                "headgear",
                "back_behind",
                "back_front",
                "aura"
            ]
        },
        "fullCoverageHeadgear": ["hat_dragon_helm"],
        "layers": {
            "shadow": {
                "default": {"8bit": "8bit/shadow.png", "16bit": "16bit/shadow.png"}
            },
            "skin": {
                tone: {"8bit": f"8bit/skin_{tone}.png", "16bit": f"16bit/skin_{tone}.png"}
                for tone in SKIN_PALETTES
            },
            "hair": {
                style: {
                    "8bit": f"8bit/hair_{style}.png",
                    "16bit": f"16bit/hair_{style}.png",
                    "8bit_tucked": f"8bit/hair_{style}_tucked.png",
                    "16bit_tucked": f"16bit/hair_{style}_tucked.png"
                }
                for style in hair_styles
            },
            "torso": {
                f"tunic_{color}": {
                    "value": color,
                    "8bit": f"8bit/tunic_{color}.png",
                    "16bit": f"16bit/tunic_{color}.png"
                }
                for color in TUNIC_PALETTES
            },
            "footwear": {
                "boots_default": {"8bit": "8bit/boots_default.png", "16bit": "16bit/boots_default.png"},
                "boots_swift": {"8bit": "8bit/boots_swift.png", "16bit": "16bit/boots_swift.png"}
            },
            "headgear": {
                "hat_explorer": {
                    "tucksHair": False,
                    "8bit": "8bit/hat_explorer.png",
                    "16bit": "16bit/hat_explorer.png"
                },
                "hat_dragon_helm": {
                    "tucksHair": True,
                    "8bit": "8bit/hat_dragon_helm.png",
                    "16bit": "16bit/hat_dragon_helm.png"
                },
                "hat_wizard_cap": {
                    "tucksHair": False,
                    "8bit": "8bit/hat_wizard_cap.png",
                    "16bit": "16bit/hat_wizard_cap.png"
                }
            },
            "back": {
                "cloak_tide": {
                    "8bit_back": "8bit/cloak_tide_back.png",
                    "8bit_front": "8bit/cloak_tide_front.png",
                    "16bit_back": "16bit/cloak_tide_back.png",
                    "16bit_front": "16bit/cloak_tide_front.png"
                }
            },
            "offhand": {
                "shield_oak": {"8bit": "8bit/shield_oak.png", "16bit": "16bit/shield_oak.png"},
                "shield_coral": {"8bit": "8bit/shield_coral.png", "16bit": "16bit/shield_coral.png"}
            },
            "aura": {
                "aura_charisma_1": {"8bit": "8bit/aura_charisma_1.png", "16bit": "16bit/aura_charisma_1.png"},
                "aura_courage_1": {"8bit": "8bit/aura_courage_1.png", "16bit": "16bit/aura_courage_1.png"}
            },
            "companion": {
                "pip_base": {"8bit": "8bit/pip_base.png", "16bit": "16bit/pip_base.png"}
            },
            "companion_neck": {
                "pip_scarf_ember": {"8bit": "8bit/pip_scarf_ember.png", "16bit": "16bit/pip_scarf_ember.png"}
            }
        }
    }
    (BASE_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    # -----------------------------------------------------------------------
    # Render hero_showcase.png (4 customized builds, 8-bit & 16-bit + Pip)
    # -----------------------------------------------------------------------
    def composite_hero(era: str, cfg: dict, direction: str = "down", frame: int = 0) -> Canvas:
        fw = 16 if era == "8bit" else 32
        dir_idx = DIRECTIONS.index(direction)
        out = Canvas(fw, fw)
        tucked = cfg.get("headgear") == "hat_dragon_helm"
        order = manifest["layerOrder"]["up" if direction == "up" else "default"]

        for slot in order:
            sheet_name: Optional[str] = None
            if slot == "shadow":
                sheet_name = "shadow"
            elif slot == "back_behind" and cfg.get("back"):
                sheet_name = f"{cfg['back']}_back"
            elif slot == "back_front" and cfg.get("back"):
                sheet_name = f"{cfg['back']}_front"
            elif slot == "skin":
                sheet_name = f"skin_{cfg['skin']}"
            elif slot == "footwear":
                sheet_name = cfg.get("footwear", "boots_default")
            elif slot == "torso":
                sheet_name = f"tunic_{cfg['tunic']}"
            elif slot == "hair":
                sheet_name = f"hair_{cfg['hair']}_tucked" if tucked else f"hair_{cfg['hair']}"
            elif slot == "headgear" and cfg.get("headgear"):
                sheet_name = cfg["headgear"]
            elif slot == "offhand" and cfg.get("offhand"):
                sheet_name = cfg["offhand"]
            elif slot == "aura" and cfg.get("aura"):
                sheet_name = cfg["aura"]

            if sheet_name:
                f = extract_frame(sheets[era][sheet_name], fw, fw, dir_idx, frame)
                out.blit(f)
        return out

    def composite_pip(era: str, scarf: bool, direction: str = "down", frame: int = 0) -> Canvas:
        dir_idx = DIRECTIONS.index(direction)
        out = extract_frame(sheets[era]["pip_base"], 16, 16, dir_idx, frame)
        if scarf:
            out.blit(extract_frame(sheets[era]["pip_scarf_ember"], 16, 16, dir_idx, frame))
        return out

    builds = [
        {
            "title": "STARTER EXPLORER",
            "sub": "EMERALD + EXPLORER HAT + OAK",
            "cfg": {
                "skin": "warm_tan", "hair": "spiky", "tunic": "emerald",
                "headgear": "hat_explorer", "footwear": "boots_default",
                "back": None, "offhand": "shield_oak", "aura": "aura_charisma_1",
            },
            "pip_scarf": False,
        },
        {
            "title": "EMBERWING KNIGHT",
            "sub": "CRIMSON + DRAGON HELM + SWIFT",
            "cfg": {
                "skin": "bronze", "hair": "cropped", "tunic": "crimson",
                "headgear": "hat_dragon_helm", "footwear": "boots_swift",
                "back": None, "offhand": "shield_oak", "aura": "aura_courage_1",
            },
            "pip_scarf": True,
        },
        {
            "title": "STAR-LOOP WIZARD",
            "sub": "VIOLET + WIZARD CAP + CHARISMA",
            "cfg": {
                "skin": "ivory", "hair": "braided", "tunic": "violet",
                "headgear": "hat_wizard_cap", "footwear": "boots_swift",
                "back": None, "offhand": None, "aura": "aura_charisma_1",
            },
            "pip_scarf": False,
        },
        {
            "title": "TIDE-WEAVER HERO",
            "sub": "NAVY + TIDE CLOAK + CORAL",
            "cfg": {
                "skin": "deep_brown", "hair": "curly", "tunic": "navy",
                "headgear": None, "footwear": "boots_swift",
                "back": "cloak_tide", "offhand": "shield_coral", "aura": "aura_courage_1",
            },
            "pip_scarf": True,
        },
    ]

    W, H = 960, 560
    bg = hex_rgba("#0F172A")
    card_bg = hex_rgba("#1E293B")
    card_border = hex_rgba("#334155")
    panel_8 = hex_rgba("#16231C")
    panel_16 = hex_rgba("#17253B")
    title_col = hex_rgba("#F8FAFC")
    accent_gold = hex_rgba("#FACC15")
    accent_cyan = hex_rgba("#38BDF8")
    muted = hex_rgba("#94A3B8")

    sc = Canvas(W, H, bg)
    # Header bar
    sc.rect(0, 0, W, 62, hex_rgba("#131C31"))
    sc.rect(0, 61, W, 2, hex_rgba("#334155"))
    draw_text(sc, 28, 16, "PYRIA MODULAR HERO SPRITES: 8-BIT VS 16-BIT", title_col, scale=2)
    draw_text(sc, 28, 40, "DETERMINISTIC PIXEL LAYERS MATCHING CONTENT/CATALOG.JSON + PIP COMPANION", accent_cyan, scale=1)

    card_w, card_h = 446, 224
    positions = [(24, 80), (490, 80), (24, 320), (490, 320)]

    for (cx, cy), b in zip(positions, builds):
        # Card frame
        sc.rect(cx, cy, card_w, card_h, card_border)
        sc.rect(cx + 2, cy + 2, card_w - 4, card_h - 4, card_bg)
        draw_text(sc, cx + 16, cy + 14, b["title"], accent_gold, scale=2)
        draw_text(sc, cx + 16, cy + 34, b["sub"], muted, scale=1)

        # Left sub-panel: 8-Bit (16x16 @ 6x = 96x96) + Pip (16x16 @ 4x = 64x64)
        p8x, p8y = cx + 16, cy + 52
        sc.rect(p8x, p8y, 200, 156, panel_8)
        sc.rect(p8x, p8y, 200, 2, hex_rgba("#22C55E"))
        draw_text(sc, p8x + 10, p8y + 10, "8-BIT (16X16)", hex_rgba("#4ADE80"), scale=1)
        h8 = composite_hero("8bit", b["cfg"], "down", 0)
        p8 = composite_pip("8bit", b["pip_scarf"], "down", 0)
        sc.blit_scaled(h8, p8x + 16, p8y + 38, scale=6)
        sc.blit_scaled(p8, p8x + 120, p8y + 58, scale=4)

        # Right sub-panel: 16-Bit (32x32 @ 4x = 128x128) + Pip (16x16 @ 4x = 64x64)
        p16x, p16y = cx + 230, cy + 52
        sc.rect(p16x, p16y, 200, 156, panel_16)
        sc.rect(p16x, p16y, 200, 2, accent_cyan)
        draw_text(sc, p16x + 10, p16y + 10, "16-BIT (32X32)", accent_cyan, scale=1)
        h16 = composite_hero("16bit", b["cfg"], "down", 0)
        p16 = composite_pip("16bit", b["pip_scarf"], "down", 0)
        sc.blit_scaled(h16, p16x + 6, p16y + 24, scale=4)
        sc.blit_scaled(p16, p16x + 130, p16y + 56, scale=4)

    sc.save(BASE_DIR / "hero_showcase.png")
    total_pngs = len(list(era_8_dir.glob("*.png"))) + len(list(era_16_dir.glob("*.png")))
    print(f"Generated {total_pngs} modular sprite sheets + manifest.json + hero_showcase.png in {BASE_DIR}")


if __name__ == "__main__":
    main()
