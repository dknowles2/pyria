# Pyria — Concept Art & Sprite Architecture Guide

Visual direction, concept art catalog, and modular sprite specifications for **Pyria**, a browser-based Python-learning RPG that evolves across game eras (**8-Bit NES → 16-Bit SNES → 3D**) as the player rescues dragons with real Python code.

---

## Concept Art Assets

| File | Resolution | Subject | Purpose |
| --- | --- | --- | --- |
| `hero_and_pip.png` | `896×1200` | **The Code-Tamer Hero & Pip** | Establishes protagonist personality (adventurous 10-year-old explorer with emerald tunic and glowing Python rune spellbook) and **Pip**, the tiny teal/orange glitch-hatchling dragon sidekick with cyan pixel-sparkle accents. |
| `emberwing_dragon.png` | `1200×896` | **Emberwing** (Realm 3 Flame Dragon Guardian) | Establishes the dragon visual language: friendly, majestic *How to Train Your Dragon*–inspired silhouette, warm glowing ember wing veins, flame-tipped tail, expressive eyes, and strong readability at both illustration and sprite scales. |
| `era_comparison_8bit_16bit.png` | `1376×768` | **8-Bit vs. 16-Bit Split-Screen Visual Target** | Side-by-side benchmark of the same fantasy meadow, river bridge, hero + Pip, and cavern entrance: crisp 8-bit NES *Zelda*-style top-down pixel art (left) vs. lush 16-bit SNES *A Link to the Past* / *Chrono Trigger*-style top-down pixel art (right). |
| `modular_hero_sheet.png` | `1376×768` | **Modular Hero Customization Sheet** | Top-down pixel-art hero base sprites (front, side, back) alongside swappable gear pieces driven by Python calls (`wear_hat()`, `set_tunic_color()`, `equip_boots()`, etc.): explorer hat, dragon helm, wizard cap, emerald/crimson/navy tunics, tide cloak, winged swift boots, oak shield, and rune spellbook. |

---

## Era Sprite Dimensions & Grid Specs

### 8-Bit Era (NES / *Legend of Zelda* Style)
- **Tile size**: `16x16 px` (rendered at integer scale `3x` = `48x48 px` or `4x` = `64x64 px` with `image-rendering: pixelated`).
- **Hero sprite canvas**: `16x16 px` (single tile footprint; `16x24 px` optional headroom buffer only if tall hats like the wizard cap need a 4–6 px crown overhang).
- **Pip sidekick sprite**: `12x12 px` inside a `16x16 px` frame (floats/hops 1 tile behind hero).
- **Dragon Guardian sprites**: `32x32 px` (2×2 tiles) for standard Realm Guardians; `48x32 px` for winged boss/rescue poses.
- **Color budget**: 3 colors + transparency per sprite sub-palette (NES-authentic readability, high-contrast 1 px dark outline or silhouette separation).
- **Animation cadence**: 2-frame walk cycle per cardinal direction (`down`, `up`, `left`, `right`; `left` mirrored to `right` where asymmetric gear allows), 4–6 FPS.

### 16-Bit Era (SNES / *A Link to the Past* & *Chrono Trigger* Style)
- **Tile size**: `16x16 px` world grid with `32x32 px` composite environmental props (trees, cavern arches, waterfalls).
- **Hero sprite canvas**: `32x32 px` (character body occupies ~`20x26 px` centered on bottom-middle anchor `(16, 28)` so hats, cloaks, shields, and spellbooks fit without clipping).
- **Pip sidekick sprite**: `16x16 px` (4-frame wing-flap hover cycle + pixel-sparkle particle emitter).
- **Dragon Guardian sprites**: `64x64 px` (4×4 tiles) with multi-frame idle breathing, wing-flare, and rescue celebration animations.
- **Color budget**: 15 colors + transparency per sprite sheet (rich 3-step shading ramps, colored outlines, specular highlights).
- **Animation cadence**: 4-frame walk cycle per direction (`idle`, `step_left`, `idle`, `step_right`), 8–10 FPS, plus dedicated `cast_code` (spellbook raise) and `celebrate` poses.

---

## Modular Hero Layer Ordering

Pyria's character creation (`preview_skin()`, `preview_hair()`, `preview_tunic()`) and Bram's Workshop unlocks (`wear_hat()`, `set_tunic_color()`, `equip_boots()`, etc.) composite directly onto the hero sprite using deterministic Z-ordered layers.

All layers share the **exact same canvas dimensions and anchor point** (`16x16` in 8-Bit, `32x32` in 16-Bit) so any combination aligns with zero per-item offset math.

| Z-Index | Layer Key | Python API Examples | Notes |
| --- | --- | --- | --- |
| `0` | `shadow` | *(always on)* | Soft oval ground shadow (16-bit) or dithered 1 px shadow (8-bit). |
| `1` | `cloak_back` | `equip_cloak("tide")` | Rendered behind body when facing `down`/`left`/`right`; swapped to front (`Z=7`) when facing `up`. |
| `2` | `body_skin` | `preview_skin(...)` | Base head, hands, and silhouette with neutral skin tone ramp. |
| `3` | `boots` | `equip_boots("swift")` | Foot gear layered over lower legs; `swift` boots add subtle cyan/gold wing pixels. |
| `4` | `tunic` | `preview_tunic(...)`, `set_tunic_color("emerald" \| "crimson" \| "navy")` | Torso + belt + collar; supports palette swap or per-color sheet. |
| `5` | `hair` | `preview_hair(...)` | Base hair sprite. Automatically switches to `hair_tucked` variant when a full-coverage `hat` (e.g., `dragon_helm`) is equipped. |
| `6` | `hat` | `wear_hat("explorer" \| "dragon_helm" \| "wizard_cap")` | Headgear anchored to top of head; `dragon_helm` covers crown while keeping eyes visible. |
| `7` | `cloak_front` | `equip_cloak("tide")` | Collar clasp when facing `down`, or full cape drape when facing `up`. |
| `8` | `held_offhand` | `equip_shield("oak")` | Oak shield (or Python rune spellbook during `cast_code` animation), drawn on the hero's off-hand side per facing direction. |
| `9` | `fx_overlay` | *(runtime VFX)* | Transient glow, level-up sparkles, or Python execution rune aura. |

### Direction-Aware Layer Swaps
- **Facing `up` (north)**: `cloak_back` promotes above `tunic` and `hair` (`Z=7`) so the cape drapes cleanly over the hero's back; `held_offhand` moves behind the torso (`Z=1`) or to the side silhouette.
- **Facing `left` / `right`**: Mirror horizontally from a single authored `right` sheet, except for asymmetric gear (`oak_shield`, spellbook) if strict handedness is desired in 16-bit.

---

## Color Palette Guidelines

- **Hero & Code-Tamer Magic**: Warm explorer leather (`#7A4E2D`), emerald tunic (`#2E8B57`), crimson tunic (`#C0392B`), navy tunic (`#244B8A`), and glowing Python-rune cyan/gold accents (`#38BDF8` / `#FACC15`).
- **Pip (Glitch-Hatchling)**: Bright teal/azure scales (`#2DD4BF` / `#0EA5E9`) with magenta/gold glitch-pixel sparkles (`#F472B6`, `#FDE047`) so Pip pops against green meadows and dark caverns alike.
- **Emberwing (Realm 3)**: Deep volcanic crimson (`#991B1B`), warm molten orange (`#F97316`), amber underbelly (`#FCD34D`), and ember-gold glow (`#FEF08A`).
