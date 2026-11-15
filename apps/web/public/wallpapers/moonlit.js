const clouds = new Map();
const cloudArt = (w) => {
  if (!clouds.has(w)) {
    const cx = w / 2,
      inside = (x, y) =>
        Math.min(ell(x, y, cx, 3, w / 2, 1.6), ell(x, y, cx + w * 0.1, 1.4, w * 0.28, 1.2)) <= 1;
    clouds.set(
      w,
      shape(w + 1, 6, (x, y) =>
        inside(x, y) ? String(1 + Math.min(3, Math.floor((4 * x) / (w + 1)))) : ".",
      ),
    );
  }
  return clouds.get(w);
};

const METEOR = sketch(8, 4, [
  [0, 0, "11"],
  [1, 2, "22"],
  [2, 4, "33"],
  [3, 6, "4H"],
]);
const METEORS = [METEOR, flip(METEOR)];
const meteorPal = (ch) => ({
  H: { bg: "#fff6d0", fg: "#3a3524", a: 1 },
  4: { ch, fg: "#fff6d0", a: 0.85 },
  3: { ch, fg: "#fff6d0", a: 0.6 },
  2: { ch, fg: "#dbe2f5", a: 0.4 },
  1: { ch, fg: "#dbe2f5", a: 0.2 },
});
const METEOR_PALS = [meteorPal("\\"), meteorPal("/")];
const SKYFALL = 12,
  FALL = 1.5;
const meteor = (cols, rows, t) => {
  const k = Math.floor(t / SKYFALL),
    p = (t - k * SKYFALL) / FALL;
  if (p >= 1) return [];
  const left = hash(k, 3) < 0.5,
    run = 26 * p;
  const hx = cols * (0.25 + 0.5 * hash(k, 1)) + (left ? -run : run),
    hy = rows * (0.05 + 0.25 * hash(k, 2)) + run * 0.5;
  return [
    {
      art: METEORS[+left],
      pal: METEOR_PALS[+left],
      key: 40,
      a: Math.sin(Math.PI * p),
      x: left ? hx : hx - 7,
      y: hy - 3,
    },
  ];
};

const CLOUDS = [
  [0.08, 0.14, 26, 0.6],
  [0.55, 0.36, 22, 0.45],
  [0.3, 0.6, 24, 0.5],
  [0.85, 0.8, 18, 0.7],
];
const NIGHT = tint("#7088d8", "#18214a", [0.35, 0.5, 0.65, 0.82]);

SCENES.moonlit = {
  cell: (x, y, cols, rows, t) => {
    const mx = Math.round(cols * 0.74),
      my = Math.round(rows * 0.22),
      R = 6.5;
    const d1 = Math.hypot(x - mx, y - my),
      d2 = Math.hypot(x - mx - 3.4, y - my + 1.8);
    if (d1 <= R && d2 > R * 0.85) return { bg: "#d9c98f", fg: "#3a3524", a: 0.9 };
    if (d1 <= R + 1.6 && d2 > R * 0.85 + 0.6 && hash(x, y, 5) < 0.45)
      return { fg: "#d9c98f", a: 0.25 + 0.15 * Math.sin(t * 2 + x) };
    return twinkle(x, y, t, "#dbe2f5", 0.014);
  },
  sprites: (cols, rows, t) => [
    ...meteor(cols, rows, t),
    ...CLOUDS.map(([fx, fy, w, v], i) => ({
      art: cloudArt(w),
      pal: NIGHT,
      halo: "#8ea2e6",
      x: drift(cols, fx, t, v, w) - w / 2,
      y: fy * rows - 3,
      key: i,
    })),
  ],
};
