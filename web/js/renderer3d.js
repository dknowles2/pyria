// Zero-dependency 32-Bit (PS1/GBA Isometric 2.5D) & 64-Bit (Nintendo 64 Textured 3D) Canvas Renderers

import { pickN64Entity, renderN64WebGL } from './n64Renderer.js?v=20261127u';
export { pickN64Entity };

const TILE_PALETTE = {
  grass: { top: '#43a047', left: '#2e7d32', right: '#1b5e20' },
  grass_flower: { top: '#66bb6a', left: '#2e7d32', right: '#1b5e20' },
  dirt_path: { top: '#c79c6e', left: '#9c7248', right: '#785230' },
  water: { top: '#29b6f6', left: '#0288d1', right: '#01579b' },
  bridge_wood: { top: '#d4a373', left: '#a67647', right: '#7d532b' },
  bridge_broken: { top: '#8d5b4c', left: '#5d3a2f', right: '#3e251d' },
  stone_floor: { top: '#8d99ae', left: '#64748b', right: '#475569' },
  stone_wall: { top: '#64748b', left: '#475569', right: '#1e293b' },
  tree: { top: '#2d6a4f', left: '#1b4332', right: '#0f291e' },
  bush: { top: '#40916c', left: '#2d6a4f', right: '#1b4332' },
  campfire: { top: '#fb923c', left: '#ea580c', right: '#9a3412' },
  anvil: { top: '#94a3b8', left: '#64748b', right: '#334155' },
  statue: { top: '#cbd5e1', left: '#94a3b8', right: '#475569' },
  mossy_gate_closed: { top: '#dc2626', left: '#991b1b', right: '#7f1d1d' },
  mossy_gate_open: { top: '#65a30d', left: '#4d7c0f', right: '#365314' },
  chest_closed: { top: '#facc15', left: '#ca8a04', right: '#854d0e' },
  chest_open: { top: '#a8a29e', left: '#78716c', right: '#44403c' },
  vault_shrine: { top: '#f43f5e', left: '#be123c', right: '#881337' },
  torch: { top: '#fde047', left: '#f97316', right: '#c2410c' },
  portal: { top: '#38bdf8', left: '#6366f1', right: '#4338ca' },
  lava: { top: '#f97316', left: '#dc2626', right: '#991b1b' },
  ice_floor: { top: '#e0f2fe', left: '#7dd3fc', right: '#38bdf8' },
  ice_wall: { top: '#f0f9ff', left: '#38bdf8', right: '#0284c7' },
  sand: { top: '#fde68a', left: '#f59e0b', right: '#b45309' },
  coral: { top: '#fb7185', left: '#2dd4bf', right: '#0f766e' },
  obsidian_floor: { top: '#312e4a', left: '#1e1b2e', right: '#0f0d1a' },
  obsidian_wall: { top: '#6d28d9', left: '#3b0764', right: '#1e1b4b' },
  brass_floor: { top: '#d97706', left: '#92400e', right: '#78350f' },
  gear_prop: { top: '#fde047', left: '#d97706', right: '#78350f' },
  cloud_floor: { top: '#f0f9ff', left: '#bae6fd', right: '#7dd3fc' },
  star_tile: { top: '#1e1b4b', left: '#0f172a', right: '#020617' },
  crystal_pillar: { top: '#e879f9', left: '#38bdf8', right: '#6d28d9' },
  pine_tree: { top: '#22c55e', left: '#15803d', right: '#14532d' },
  column: { top: '#f8fafc', left: '#cbd5e1', right: '#64748b' },
  flower_bed: { top: '#66bb6a', left: '#2e7d32', right: '#1b5e20' },
};

function getTileElevation(map, x, y, groundTile) {
  const elevLayer = map?.layers?.elevation;
  if (elevLayer && elevLayer[y] && typeof elevLayer[y][x] === 'number') {
    return elevLayer[y][x];
  }
  if (groundTile === 'water') return 0;
  if (groundTile === 'stone_floor') return 1.3;
  return 1;
}

function getEffectiveTile(map, dynamicOverrides, x, y) {
  const ov = dynamicOverrides.get(`${x},${y}`);
  let groundTile = map.layers.ground[y][x];
  if (ov && ov.layer === 'ground') groundTile = ov.tile;
  let decorTile = map.layers.decor[y][x];
  if (ov && ov.layer === 'decor') decorTile = ov.tile;
  return { groundTile, decorTile };
}

function drawIsoBox(ctx, cx, cy, hw, hh, h, pal) {
  // Top diamond
  ctx.beginPath();
  ctx.moveTo(cx, cy - hh);
  ctx.lineTo(cx + hw, cy);
  ctx.lineTo(cx, cy + hh);
  ctx.lineTo(cx - hw, cy);
  ctx.closePath();
  ctx.fillStyle = pal.top;
  ctx.fill();
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.25)';
  ctx.lineWidth = 1;
  ctx.stroke();

  if (h > 0) {
    // Left extruded wall
    ctx.beginPath();
    ctx.moveTo(cx - hw, cy);
    ctx.lineTo(cx, cy + hh);
    ctx.lineTo(cx, cy + hh + h);
    ctx.lineTo(cx - hw, cy + h);
    ctx.closePath();
    ctx.fillStyle = pal.left;
    ctx.fill();

    // Right extruded wall
    ctx.beginPath();
    ctx.moveTo(cx + hw, cy);
    ctx.lineTo(cx, cy + hh);
    ctx.lineTo(cx, cy + hh + h);
    ctx.lineTo(cx + hw, cy + h);
    ctx.closePath();
    ctx.fillStyle = pal.right;
    ctx.fill();
  }
}

/**
 * 32-Bit (PS1 / GBA) Isometric 2.5D Diorama Renderer
 */
export function renderIsometric32Bit(engine, ctx, dynamicOverrides, completed, openedChests, rescued) {
  const { map, hero, pip, sprites, save, time, canvas } = engine;
  const W = canvas.width;
  const H = canvas.height;

  // PS1/GBA atmospheric sky backdrop
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#0f172a');
  sky.addColorStop(0.55, '#1e293b');
  sky.addColorStop(1, '#0b1020');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  const HW = 26;
  const HH = 13;
  const ELEV_PX = 14;

  const heroGround = map.layers.ground[Math.min(map.height - 1, Math.max(0, Math.floor(hero.y)))]?.[
    Math.min(map.width - 1, Math.max(0, Math.floor(hero.x)))
  ] || 'grass';
  const heroElev = getTileElevation(map, Math.floor(hero.x), Math.floor(hero.y), heroGround);

  const project = (wx, wy, wz = 1) => {
    const dx = wx - hero.x;
    const dy = wy - hero.y;
    const dz = wz - heroElev;
    return {
      x: W * 0.5 + (dx - dy) * HW,
      y: H * 0.54 + (dx + dy) * HH - dz * ELEV_PX,
    };
  };

  const radius = 15;
  const minX = Math.max(0, Math.floor(hero.x) - radius);
  const maxX = Math.min(map.width - 1, Math.floor(hero.x) + radius);
  const minY = Math.max(0, Math.floor(hero.y) - radius);
  const maxY = Math.min(map.height - 1, Math.floor(hero.y) + radius);

  // Collect tiles + entities for painter's-order depth sorting by (x + y)
  const items = [];

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const { groundTile, decorTile } = getEffectiveTile(map, dynamicOverrides, x, y);
      const elev = getTileElevation(map, x, y, groundTile);
      const p = project(x + 0.5, y + 0.5, elev);
      if (p.x < -60 || p.x > W + 60 || p.y < -80 || p.y > H + 80) continue;

      items.push({
        depth: x + y,
        draw: () => {
          const pal = TILE_PALETTE[groundTile] || TILE_PALETTE.stone_floor;
          const baseH = groundTile === 'water' ? 6 : 12 + elev * 8;
          const waveY = groundTile === 'water' ? Math.sin(time * 3 + x * 0.8 + y * 0.7) * 1.5 : 0;
          drawIsoBox(ctx, p.x, p.y + waveY, HW, HH, baseH, pal);

          // Subtle flower or shimmer accent
          if (groundTile === 'grass_flower') {
            ctx.fillStyle = '#fde047';
            ctx.fillRect(Math.round(p.x - 2), Math.round(p.y - 3), 4, 4);
          } else if (groundTile === 'water' && Math.sin(time * 3.5 + x + y) > 0.6) {
            ctx.fillStyle = 'rgba(224, 242, 254, 0.55)';
            ctx.fillRect(Math.round(p.x - 6), Math.round(p.y + waveY - 1), 12, 2);
          }

          // Extruded 2.5D decor structures
          if (
            decorTile === 'stone_wall' ||
            decorTile === 'mossy_gate_closed' ||
            decorTile === 'ice_wall' ||
            decorTile === 'obsidian_wall'
          ) {
            const dpal = TILE_PALETTE[decorTile] || TILE_PALETTE.stone_wall;
            drawIsoBox(ctx, p.x, p.y - 18, HW * 0.88, HH * 0.88, 22, dpal);
          } else if (decorTile === 'crystal_pillar' || decorTile === 'column') {
            const dpal = TILE_PALETTE[decorTile];
            drawIsoBox(ctx, p.x, p.y - 26, HW * 0.52, HH * 0.52, 28, dpal);
          } else if (decorTile === 'tree' || decorTile === 'pine_tree') {
            // Chunky trunk + layered isometric emerald crown
            ctx.fillStyle = '#6d4c41';
            ctx.fillRect(Math.round(p.x - 4), Math.round(p.y - 14), 8, 14);
            drawIsoBox(ctx, p.x, p.y - 26, HW * 0.72, HH * 0.72, 14, TILE_PALETTE[decorTile]);
          } else if (decorTile === 'portal') {
            const pulse = 0.7 + 0.3 * Math.sin(time * 5);
            ctx.strokeStyle = `rgba(56, 189, 248, ${pulse.toFixed(2)})`;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.ellipse(p.x, p.y - 16, 14, 20, 0, 0, Math.PI * 2);
            ctx.stroke();
          } else if (decorTile === 'vault_shrine') {
            drawIsoBox(ctx, p.x, p.y - 22, HW * 0.75, HH * 0.75, 24, TILE_PALETTE.vault_shrine);
          } else if (decorTile === 'torch') {
            ctx.fillStyle = '#78350f';
            ctx.fillRect(Math.round(p.x - 2), Math.round(p.y - 14), 4, 14);
            ctx.fillStyle = '#fde047';
            ctx.beginPath();
            ctx.arc(p.x, p.y - 17, 4 + Math.sin(time * 9 + x) * 1.2, 0, Math.PI * 2);
            ctx.fill();
          } else if (decorTile === 'chest_closed' || decorTile === 'chest_open') {
            drawIsoBox(ctx, p.x, p.y - 8, HW * 0.5, HH * 0.5, 10, TILE_PALETTE[decorTile]);
          } else if (
            decorTile === 'anvil' ||
            decorTile === 'campfire' ||
            decorTile === 'statue' ||
            decorTile === 'bush' ||
            decorTile === 'coral' ||
            decorTile === 'gear_prop'
          ) {
            drawIsoBox(ctx, p.x, p.y - 10, HW * 0.55, HH * 0.55, 12, TILE_PALETTE[decorTile]);
          }
        },
      });
    }
  }

  // Entities
  for (const ent of map.entities || []) {
    if (Math.abs(ent.x - hero.x) > radius || Math.abs(ent.y - hero.y) > radius) continue;
    const g = map.layers.ground[ent.y]?.[ent.x] || 'stone_floor';
    const elev = getTileElevation(map, ent.x, ent.y, g);
    const p = project(ent.x + 0.5, ent.y + 0.5, elev);
    const isSolved = ent.refId && completed.has(ent.refId);
    const isOpened = ent.type === 'chest' && openedChests.has(ent.id);

    items.push({
      depth: ent.x + ent.y + 0.35,
      draw: () => {
        if (ent.type === 'npc' || ent.type === 'vault') {
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, 16, 8, 0, 0, Math.PI * 2);
          ctx.fill();
          const sz = ent.type === 'vault' ? 54 : 44;
          sprites.drawNpc(ctx, ent.spriteKey, '16bit', p.x - sz / 2, p.y - sz + 6, sz, sz);
        }
        // Floating marker for active trials/portals/chests
        if (ent.type === 'trial' && !isSolved) {
          const bob = Math.sin(time * 6 + ent.x) * 3;
          ctx.fillStyle = '#facc15';
          ctx.beginPath();
          ctx.arc(p.x, p.y - 34 + bob, 9, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#0f172a';
          ctx.font = 'bold 12px monospace';
          ctx.textAlign = 'center';
          ctx.fillText('!', p.x, p.y - 30 + bob);
        } else if (ent.type === 'bonus_trial' && !isSolved) {
          const bob = Math.sin(time * 5 + ent.x) * 3;
          ctx.fillStyle = '#c084fc';
          ctx.beginPath();
          ctx.arc(p.x, p.y - 32 + bob, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 11px monospace';
          ctx.textAlign = 'center';
          ctx.fillText('★', p.x, p.y - 28 + bob);
        } else if (ent.type === 'chest' && !isOpened) {
          ctx.fillStyle = '#fde047';
          ctx.font = 'bold 11px monospace';
          ctx.textAlign = 'center';
          ctx.fillText('💎', p.x, p.y - 22);
        }
      },
    });
  }

  // Pip
  const pipElev = getTileElevation(map, Math.floor(pip.x), Math.floor(pip.y), 'grass');
  const pp = project(pip.x, pip.y, pipElev);
  items.push({
    depth: pip.x + pip.y + 0.25,
    draw: () => {
      const bob = Math.sin(time * 6) * 3;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(pp.x, pp.y, 12, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      sprites.drawPip(ctx, save.appearance, '16bit', pip.dir, pip.frame, pp.x - 20, pp.y - 38 + bob, 40, 40);
    },
  });

  // Hero
  const hp = project(hero.x, hero.y, heroElev);
  items.push({
    depth: hero.x + hero.y + 0.3,
    draw: () => {
      ctx.fillStyle = 'rgba(0,0,0,0.38)';
      ctx.beginPath();
      ctx.ellipse(hp.x, hp.y + 2, 16, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      sprites.drawHero(ctx, save.appearance, '16bit', hero.dir, hero.frame, hp.x - 28, hp.y - 52, 56, 56);
    },
  });

  items.sort((a, b) => a.depth - b.depth);
  for (const it of items) it.draw();

  // Subtle 32-Bit Era HUD stamp
  ctx.save();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
  ctx.fillRect(12, H - 34, 178, 22);
  ctx.fillStyle = '#38bdf8';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('32-BIT ISOMETRIC 2.5D', 20, H - 19);
  ctx.restore();
}

/**
 * 64-Bit (Nintendo 64) Chunky Gouraud-Shaded Perspective 3D Renderer
 */
export function renderN643D(engine, ctx, dynamicOverrides, completed, openedChests, rescued) {
  // Prefer hardware-accelerated WebGL N64 textured 3D renderer; fall back to Canvas 2D if unavailable
  if (renderN64WebGL(engine, ctx, dynamicOverrides, completed, openedChests)) {
    return;
  }
  const { map, hero, pip, sprites, save, time, canvas } = engine;
  const W = canvas.width;
  const H = canvas.height;

  // Classic Nintendo 64 vibrant cobalt sky + warm horizon fog
  const horizonY = H * 0.36;
  const sky = ctx.createLinearGradient(0, 0, 0, horizonY + 40);
  sky.addColorStop(0, '#1d4ed8');
  sky.addColorStop(0.65, '#38bdf8');
  sky.addColorStop(1, '#bae6fd');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Distant N64 low-poly mountain silhouette ring
  ctx.fillStyle = '#3b82f6';
  ctx.beginPath();
  ctx.moveTo(0, horizonY + 12);
  for (let i = 0; i <= 12; i++) {
    const mx = (W / 12) * i;
    const peak = (i % 2 === 0 ? 18 : 44) + Math.sin(i * 1.9) * 10;
    ctx.lineTo(mx, horizonY - peak);
  }
  ctx.lineTo(W, horizonY + 12);
  ctx.closePath();
  ctx.fill();

  // Ground horizon base (fog color)
  const fogGrad = ctx.createLinearGradient(0, horizonY, 0, H);
  fogGrad.addColorStop(0, '#93c5fd');
  fogGrad.addColorStop(0.22, '#2d6a4f');
  fogGrad.addColorStop(1, '#143628');
  ctx.fillStyle = fogGrad;
  ctx.fillRect(0, horizonY, W, H - horizonY);

  // 3rd-person N64 camera behind (south of) and above the Hero, pitched slightly down
  const heroGround = map.layers.ground[Math.min(map.height - 1, Math.max(0, Math.floor(hero.y)))]?.[
    Math.min(map.width - 1, Math.max(0, Math.floor(hero.x)))
  ] || 'grass';
  const heroElev = getTileElevation(map, Math.floor(hero.x), Math.floor(hero.y), heroGround) * 0.75;

  const camX = hero.x;
  const camY = hero.y + 7.2;
  const camZ = heroElev + 5.6;
  const pitch = 0.44; // radians downward
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const focal = H * 0.92;

  const project3D = (wx, wy, wz) => {
    const dx = wx - camX;
    const dzForward = camY - wy; // looking north (-Y)
    const dyUp = wz - camZ;
    // Rotate around X axis by pitch
    const rz = dzForward * cosP - dyUp * sinP;
    const ry = dzForward * sinP + dyUp * cosP;
    if (rz <= 0.6) return null;
    const scale = focal / rz;
    return {
      sx: W * 0.5 + dx * scale,
      sy: horizonY + H * 0.14 - ry * scale,
      scale,
      depth: rz,
    };
  };

  const polys = [];
  const minX = Math.max(0, Math.floor(hero.x) - 11);
  const maxX = Math.min(map.width - 1, Math.floor(hero.x) + 11);
  const minY = Math.max(0, Math.floor(hero.y) - 14);
  const maxY = Math.min(map.height - 1, Math.floor(hero.y) + 5);

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const { groundTile, decorTile } = getEffectiveTile(map, dynamicOverrides, x, y);
      const elev = getTileElevation(map, x, y, groundTile) * 0.75;
      const p00 = project3D(x, y, elev);
      const p10 = project3D(x + 1, y, elev);
      const p11 = project3D(x + 1, y + 1, elev);
      const p01 = project3D(x, y + 1, elev);
      if (!p00 || !p10 || !p11 || !p01) continue;
      const avgDepth = (p00.depth + p10.depth + p11.depth + p01.depth) * 0.25;
      const pal = TILE_PALETTE[groundTile] || TILE_PALETTE.grass;

      // Ground quad with Gouraud-like N64 directional gradient
      polys.push({
        depth: avgDepth + 0.2,
        draw: () => {
          const grad = ctx.createLinearGradient(p00.sx, p00.sy, p11.sx, p11.sy);
          grad.addColorStop(0, pal.top);
          grad.addColorStop(1, pal.left);
          ctx.beginPath();
          ctx.moveTo(p00.sx, p00.sy);
          ctx.lineTo(p10.sx, p10.sy);
          ctx.lineTo(p11.sx, p11.sy);
          ctx.lineTo(p01.sx, p01.sy);
          ctx.closePath();
          ctx.fillStyle = grad;
          ctx.fill();
          ctx.strokeStyle = 'rgba(15, 23, 42, 0.14)';
          ctx.lineWidth = 0.8;
          ctx.stroke();

          // N64 distance fog tint
          const fogAlpha = Math.max(0, Math.min(0.65, (avgDepth - 9) / 14));
          if (fogAlpha > 0.02) {
            ctx.fillStyle = `rgba(147, 197, 253, ${fogAlpha.toFixed(2)})`;
            ctx.fill();
          }
        },
      });

      // Low-poly 3D props
      if (decorTile) {
        const pc = project3D(x + 0.5, y + 0.5, elev);
        if (pc) {
          polys.push({
            depth: pc.depth - 0.05,
            draw: () => {
              const s = pc.scale;
              if (decorTile === 'tree' || decorTile === 'pine_tree') {
                // Chunky N64 brown trunk + 2-tier Gouraud emerald pyramid canopy
                ctx.fillStyle = '#78350f';
                ctx.fillRect(pc.sx - s * 0.14, pc.sy - s * 0.6, s * 0.28, s * 0.6);
                const g1 = ctx.createLinearGradient(pc.sx - s * 0.5, pc.sy - s * 1.6, pc.sx + s * 0.5, pc.sy - s * 0.4);
                g1.addColorStop(0, decorTile === 'pine_tree' ? '#34d399' : '#4ade80');
                g1.addColorStop(1, '#14532d');
                ctx.fillStyle = g1;
                ctx.beginPath();
                ctx.moveTo(pc.sx, pc.sy - s * 1.85);
                ctx.lineTo(pc.sx - s * 0.52, pc.sy - s * 0.45);
                ctx.lineTo(pc.sx + s * 0.52, pc.sy - s * 0.45);
                ctx.closePath();
                ctx.fill();
              } else if (decorTile === 'crystal_pillar') {
                // Glowing low-poly 3D diamond prism
                const cg = ctx.createLinearGradient(pc.sx - s * 0.3, pc.sy - s * 1.6, pc.sx + s * 0.3, pc.sy);
                cg.addColorStop(0, '#f0abfc');
                cg.addColorStop(0.5, '#38bdf8');
                cg.addColorStop(1, '#4c1d95');
                ctx.fillStyle = cg;
                ctx.beginPath();
                ctx.moveTo(pc.sx, pc.sy - s * 1.65);
                ctx.lineTo(pc.sx + s * 0.34, pc.sy - s * 0.6);
                ctx.lineTo(pc.sx, pc.sy);
                ctx.lineTo(pc.sx - s * 0.34, pc.sy - s * 0.6);
                ctx.closePath();
                ctx.fill();
              } else if (decorTile === 'column') {
                const cw = s * 0.46;
                const ch = s * 1.45;
                const cg = ctx.createLinearGradient(pc.sx - cw / 2, pc.sy - ch, pc.sx + cw / 2, pc.sy);
                cg.addColorStop(0, '#f8fafc');
                cg.addColorStop(1, '#64748b');
                ctx.fillStyle = cg;
                ctx.fillRect(pc.sx - cw / 2, pc.sy - ch, cw, ch);
                ctx.fillStyle = '#e2e8f0';
                ctx.fillRect(pc.sx - cw * 0.68, pc.sy - ch, cw * 1.36, s * 0.18);
                ctx.fillRect(pc.sx - cw * 0.68, pc.sy - s * 0.16, cw * 1.36, s * 0.16);
              } else if (
                decorTile === 'stone_wall' ||
                decorTile === 'mossy_gate_closed' ||
                decorTile === 'vault_shrine' ||
                decorTile === 'ice_wall' ||
                decorTile === 'obsidian_wall'
              ) {
                const dpal = TILE_PALETTE[decorTile] || TILE_PALETTE.stone_wall;
                const bh = decorTile === 'vault_shrine' ? s * 1.4 : s * 1.05;
                const bw = s * 0.92;
                const grad = ctx.createLinearGradient(pc.sx - bw / 2, pc.sy - bh, pc.sx + bw / 2, pc.sy);
                grad.addColorStop(0, dpal.top);
                grad.addColorStop(1, dpal.right);
                ctx.fillStyle = grad;
                ctx.fillRect(pc.sx - bw / 2, pc.sy - bh, bw, bh);
                ctx.strokeStyle = 'rgba(15, 23, 42, 0.4)';
                ctx.lineWidth = 1.2;
                ctx.strokeRect(pc.sx - bw / 2, pc.sy - bh, bw, bh);
              } else if (decorTile === 'coral' || decorTile === 'gear_prop' || decorTile === 'statue' || decorTile === 'bush') {
                const dpal = TILE_PALETTE[decorTile];
                const bw = s * 0.62;
                const bh = s * 0.68;
                ctx.fillStyle = dpal.top;
                ctx.fillRect(pc.sx - bw / 2, pc.sy - bh, bw, bh);
                ctx.strokeStyle = dpal.right;
                ctx.strokeRect(pc.sx - bw / 2, pc.sy - bh, bw, bh);
              } else if (decorTile === 'portal') {
                const pulse = 0.7 + 0.3 * Math.sin(time * 5);
                ctx.strokeStyle = `rgba(56, 189, 248, ${pulse.toFixed(2)})`;
                ctx.lineWidth = Math.max(2, s * 0.08);
                ctx.beginPath();
                ctx.ellipse(pc.sx, pc.sy - s * 0.75, s * 0.42, s * 0.68, 0, 0, Math.PI * 2);
                ctx.stroke();
              } else if (decorTile === 'chest_closed' || decorTile === 'chest_open') {
                const dpal = TILE_PALETTE[decorTile];
                ctx.fillStyle = dpal.top;
                ctx.fillRect(pc.sx - s * 0.32, pc.sy - s * 0.46, s * 0.64, s * 0.46);
                ctx.strokeStyle = '#713f12';
                ctx.strokeRect(pc.sx - s * 0.32, pc.sy - s * 0.46, s * 0.64, s * 0.46);
              } else if (decorTile === 'torch') {
                ctx.fillStyle = '#78350f';
                ctx.fillRect(pc.sx - s * 0.07, pc.sy - s * 0.75, s * 0.14, s * 0.75);
                ctx.fillStyle = '#fde047';
                ctx.beginPath();
                ctx.arc(pc.sx, pc.sy - s * 0.85, s * 0.18, 0, Math.PI * 2);
                ctx.fill();
              }
            },
          });
        }
      }
    }
  }

  // Entities in 3D space
  for (const ent of map.entities || []) {
    if (Math.abs(ent.x - hero.x) > 12 || Math.abs(ent.y - hero.y) > 15) continue;
    const g = map.layers.ground[ent.y]?.[ent.x] || 'grass';
    const elev = getTileElevation(map, ent.x, ent.y, g) * 0.75;
    const p = project3D(ent.x + 0.5, ent.y + 0.5, elev);
    if (!p) continue;
    const isSolved = ent.refId && completed.has(ent.refId);

    polys.push({
      depth: p.depth - 0.15,
      draw: () => {
        const s = p.scale;
        if (ent.type === 'npc' || ent.type === 'vault') {
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.beginPath();
          ctx.ellipse(p.sx, p.sy, s * 0.38, s * 0.16, 0, 0, Math.PI * 2);
          ctx.fill();
          const sz = ent.type === 'vault' ? s * 1.4 : s * 1.1;
          sprites.drawNpc(ctx, ent.spriteKey, '16bit', p.sx - sz / 2, p.sy - sz, sz, sz);
        }
        if (ent.type === 'trial' && !isSolved) {
          const bob = Math.sin(time * 6 + ent.x) * s * 0.12;
          ctx.fillStyle = '#facc15';
          ctx.beginPath();
          ctx.arc(p.sx, p.sy - s * 1.25 + bob, Math.max(6, s * 0.22), 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#0f172a';
          ctx.font = `bold ${Math.max(10, Math.round(s * 0.28))}px monospace`;
          ctx.textAlign = 'center';
          ctx.fillText('!', p.sx, p.sy - s * 1.16 + bob);
        } else if (ent.type === 'bonus_trial' && !isSolved) {
          const bob = Math.sin(time * 5 + ent.x) * s * 0.12;
          ctx.fillStyle = '#c084fc';
          ctx.beginPath();
          ctx.arc(p.sx, p.sy - s * 1.2 + bob, Math.max(6, s * 0.2), 0, Math.PI * 2);
          ctx.fill();
        }
      },
    });
  }

  // Pip in 3D
  const pipElev = getTileElevation(map, Math.floor(pip.x), Math.floor(pip.y), 'grass') * 0.75;
  const pp = project3D(pip.x, pip.y, pipElev);
  if (pp) {
    polys.push({
      depth: pp.depth - 0.18,
      draw: () => {
        const s = pp.scale;
        const bob = Math.sin(time * 6) * s * 0.08;
        ctx.fillStyle = 'rgba(0,0,0,0.32)';
        ctx.beginPath();
        ctx.ellipse(pp.sx, pp.sy, s * 0.28, s * 0.12, 0, 0, Math.PI * 2);
        ctx.fill();
        sprites.drawPip(ctx, save.appearance, '16bit', pip.dir, pip.frame, pp.sx - s * 0.45, pp.sy - s * 0.9 + bob, s * 0.9, s * 0.9);
      },
    });
  }

  // Hero in 3D
  const hp = project3D(hero.x, hero.y, heroElev);
  if (hp) {
    polys.push({
      depth: hp.depth - 0.2,
      draw: () => {
        const s = hp.scale;
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.beginPath();
        ctx.ellipse(hp.sx, hp.sy, s * 0.38, s * 0.16, 0, 0, Math.PI * 2);
        ctx.fill();
        sprites.drawHero(ctx, save.appearance, '16bit', hero.dir, hero.frame, hp.sx - s * 0.62, hp.sy - s * 1.25, s * 1.25, s * 1.25);
      },
    });
  }

  // Painter's algorithm: farthest first!
  polys.sort((a, b) => b.depth - a.depth);
  for (const poly of polys) poly.draw();

  // 64-Bit N64 Era HUD stamp
  ctx.save();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.74)';
  ctx.fillRect(12, H - 34, 198, 22);
  ctx.fillStyle = '#facc15';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('64-BIT N64 GOURAUD 3D', 20, H - 19);
  ctx.restore();
}
