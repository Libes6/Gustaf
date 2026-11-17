// Scene kit and renderer adapted from Claude Desktop Themes by 0toshigami (MIT, wallpapers/LICENSE).
// Scenes written for that mod run here unchanged: each one adds SCENES['<id>'] = { cell, sprites, size? }.
(() => {
  const root = document.documentElement;
  const canvas = document.getElementById("wallpaper");
  const ctx = canvas.getContext("2d");
  const calm = matchMedia("(prefers-reduced-motion: reduce)");

  const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const hex = (c) =>
    "#" +
    c
      .map((v) =>
        Math.round(v * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");
  const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
  const hsl = ([r, g, b]) => {
    const hi = Math.max(r, g, b),
      lo = Math.min(r, g, b),
      l = (hi + lo) / 2,
      d = hi - lo;
    const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    const h = !d
      ? 0
      : hi === r
        ? ((g - b) / d + 6) % 6
        : hi === g
          ? (b - r) / d + 2
          : (r - g) / d + 4;
    return `${Math.round(h * 60)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%`;
  };

  let CELL = 22;
  const GLYPHS = "St%;:X",
    LOOSE = ".:',o";
  const hash = (a, b, c = 0) => {
    let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(c, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const glyph = (set, x, y, t) =>
    set[Math.floor(hash(x, y, Math.floor(t * 1.2 + hash(y, x) * 7)) * set.length)];
  const ell = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
  const drift = (cols, f, t, v, w) => {
    const span = cols + w * 2;
    return ((f * span + t * v) % span) - w;
  };
  const near = (x, y, fg, a = 0.3, odds = 0.5) => (hash(x, y, 3) < odds ? { fg, a } : undefined);
  const twinkle = (x, y, t, fg, odds) => {
    const s = hash(x, y, 9);
    if (s < odds)
      return {
        ch: s < odds / 3 ? "+" : ".",
        fg,
        a: 0.2 + 0.5 * (0.5 + 0.5 * Math.sin(t * (1 + s * 200) + s * 1000)),
      };
  };
  const rising = (x, y, t, v, odds) => hash(x, Math.floor(y + t * v), 11) < odds;
  const sketch = (w, h, parts) => {
    const g = Array.from({ length: h }, () => Array(w).fill("."));
    for (const [r, c, s] of parts)
      [...s].forEach((ch, i) => {
        if (ch !== " " && g[r]?.[c + i]) g[r][c + i] = ch;
      });
    return g.map((r) => r.join(""));
  };
  const shape = (w, h, at) =>
    Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => at(x, y)).join(""));
  const flip = (art) => art.map((r) => [...r].reverse().join(""));
  const frame = (frames, t, rate, phase = 0) =>
    frames[Math.floor(t * rate + phase) % frames.length];
  const shade = (c, k) => hex(mix(rgb(c), k > 0 ? [1, 1, 1] : [0, 0, 0], Math.abs(k)));
  const tint = (bg, fg, alphas) =>
    Object.fromEntries(alphas.map((a, i) => [String(i + 1), { bg, fg, a }]));
  const halos = new WeakMap();
  const haloOf = (art) => {
    if (!halos.has(art)) {
      const on = (x, y) => (art[y]?.[x] ?? ".") !== ".",
        out = [];
      for (let y = -1; y <= art.length; y++)
        for (let x = -1; x <= art[0].length; x++)
          if (
            !on(x, y) &&
            [-1, 0, 1].some((i) => [-1, 0, 1].some((j) => on(x + i, y + j))) &&
            hash(x + 50, y + 50, 5) < 0.45
          )
            out.push([x, y]);
      halos.set(art, out);
    }
    return halos.get(art);
  };

  let scene,
    time = 0,
    last,
    raf;
  let working = false,
    paused = false;

  const put = (px, py, c, sx, sy) => {
    ctx.globalAlpha = Math.max(0, Math.min(1, c.a));
    if (ctx.globalAlpha < 0.01) return;
    if (c.bg) {
      ctx.fillStyle = c.bg;
      ctx.beginPath();
      ctx.roundRect(px + 2, py + 2, CELL - 4, CELL - 4, 3);
      ctx.fill();
    }
    ctx.fillStyle = c.fg;
    ctx.fillText(
      c.ch ?? glyph(c.bg ? GLYPHS : LOOSE, sx, sy, time),
      px + CELL / 2,
      py + CELL / 2 + 1,
    );
  };

  const draw = () => {
    const t = time,
      W = innerWidth,
      H = innerHeight,
      cols = Math.ceil(W / CELL),
      rows = Math.ceil(H / CELL);
    ctx.clearRect(0, 0, W, H);
    if (!scene) return;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(160, 180, 255, .05)";
    ctx.beginPath();
    for (let x = 0; x <= cols; x++) {
      ctx.moveTo(x * CELL + 0.5, 0);
      ctx.lineTo(x * CELL + 0.5, H);
    }
    for (let y = 0; y <= rows; y++) {
      ctx.moveTo(0, y * CELL + 0.5);
      ctx.lineTo(W, y * CELL + 0.5);
    }
    ctx.stroke();
    if (scene.cell)
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          const c = scene.cell(x, y, cols, rows, t);
          if (c) put(x * CELL, y * CELL, c, x, y);
        }
    for (const s of scene.sprites?.(cols, rows, t) ?? []) {
      const ox = s.x * CELL,
        oy = s.y * CELL;
      const m = s.a ?? 1,
        k = s.key * 997;
      const bw = s.art ? s.art[0].length : s.w,
        bh = s.art ? s.art.length : s.h;
      if (ox > W + CELL * 4 || oy > H + CELL * 4 || ox + (bw + 4) * CELL < 0) continue;
      if (oy + (bh + 4) * CELL < 0) continue;
      if (s.glow) {
        const g = s.glow,
          cx = ox + (bw / 2) * CELL,
          cy = oy + (bh / 2) * CELL,
          r = g.r * CELL;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0, g.color);
        grad.addColorStop(1, `${g.color}00`);
        ctx.globalAlpha = Math.min(1, g.a);
        ctx.globalCompositeOperation = "screen";
        ctx.fillStyle = grad;
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
        ctx.globalCompositeOperation = "source-over";
      }
      const cells = [];
      if (s.art)
        s.art.forEach((row, gy) => {
          for (let gx = 0; gx < row.length; gx++)
            if (s.pal[row[gx]]) cells.push([gx, gy, s.pal[row[gx]], gx + k, gy]);
        });
      else
        for (let gy = 0; gy < s.h; gy++)
          for (let gx = 0; gx < s.w; gx++) {
            const f = s.field(gx, gy);
            if (f) cells.push([gx, gy, f.c, (f.sx ?? gx) + k, f.sy ?? gy]);
          }
      if (s.shadow)
        for (const [gx, gy, c] of cells)
          if (c.bg)
            put(
              ox + (gx + 0.8) * CELL,
              oy + (gy + 0.8) * CELL,
              { bg: s.shadow, fg: s.shadow, ch: "", a: 0.4 * m },
              0,
              0,
            );
      if (s.halo && s.art)
        for (const [gx, gy] of haloOf(s.art))
          put(ox + gx * CELL, oy + gy * CELL, { fg: s.halo, a: 0.3 * m }, gx + k, gy);
      for (const [gx, gy, c, sx, sy] of cells)
        put(ox + gx * CELL, oy + gy * CELL, m === 1 ? c : { ...c, a: c.a * m }, sx, sy);
    }
  };

  const fail = (error) => {
    scene = undefined;
    cancelAnimationFrame(raf);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    parent.postMessage({ type: "wallpaper:error", message: String(error?.message ?? error) }, "*");
  };

  const safeDraw = () => {
    try {
      draw();
    } catch (error) {
      fail(error);
    }
  };

  const size = () => {
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `bold ${Math.round((CELL * 13) / 22)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    safeDraw();
  };

  const tick = (now) => {
    raf = requestAnimationFrame(tick);
    if (now - last < 33) return;
    time += (last ? Math.min(now - last, 250) / 1000 : 0) * (working ? 3 : 1);
    last = now;
    safeDraw();
  };

  const run = () => {
    cancelAnimationFrame(raf);
    last = 0;
    if (scene && !paused && !calm.matches) raf = requestAnimationFrame(tick);
  };

  const load = ({ id, source, sky }) => {
    const SCENES = Object.create(null);
    const kit = {
      root,
      SIDE: 0,
      GLYPHS,
      LOOSE,
      rgb,
      hex,
      mix,
      hsl,
      hash,
      glyph,
      ell,
      drift,
      near,
      twinkle,
      rising,
      sketch,
      shape,
      flip,
      frame,
      shade,
      tint,
      haloOf,
      SCENES,
    };
    scene = undefined;
    time = 0;
    document.body.style.background = typeof sky === "string" ? sky : "transparent";
    try {
      new Function(...Object.keys(kit), source)(...Object.values(kit));
      scene = Object.hasOwn(SCENES, id) ? SCENES[id] : Object.values(SCENES)[0];
      if (!scene) throw new Error("The file registered no scene");
    } catch (error) {
      fail(error);
      return;
    }
    CELL =
      typeof scene.size === "number" && Number.isFinite(scene.size)
        ? Math.max(8, Math.min(48, scene.size))
        : 22;
    size();
    run();
  };

  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const message = event.data;
    if (message?.type === "wallpaper:scene") load(message);
    if (message?.type === "wallpaper:state") {
      working = message.working === true;
      if (working) root.dataset.themeState = "thinking";
      else delete root.dataset.themeState;
      if (paused !== (message.paused === true)) {
        paused = message.paused === true;
        run();
      }
    }
  });
  addEventListener("resize", size);
  calm.addEventListener("change", run);
  parent.postMessage({ type: "wallpaper:ready" }, "*");
})();
