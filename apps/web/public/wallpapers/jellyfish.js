const jelly = (ph) =>
  sketch(13, 22, [
    ...(ph
      ? [
          [0, 4, "BBBBB"],
          [1, 2, "BBBBBBBBB"],
          [2, 1, "BBpBBBBBpBB"],
          [3, 0, "RRRRRRRRRRRRR"],
        ]
      : [
          [0, 3, "BBBBBBB"],
          [1, 1, "BBBBBBBBBBB"],
          [2, 1, "BBpBBBBBpBB"],
          [3, 1, "RRRRRRRRRRR"],
        ]),
    [4, 3, "kkkkkkk"],
    ...[1, 3, 5, 7, 9, 11].flatMap((c, k) =>
      Array.from({ length: 16 }, (_, i) => {
        const r = hash(k, i, 7);
        return r < 0.18 ? [] : [[5 + i, c, r < 0.42 ? "o" : "l"]];
      }).flat(),
    ),
  ]);
const JELLIES = [jelly(0), jelly(1)];
const jellyPal = (c) => ({
  B: { bg: c, fg: shade(c, -0.6), a: 0.72 },
  p: { bg: shade(c, 0.55), fg: c, a: 0.85 },
  R: { bg: shade(c, 0.15), fg: shade(c, -0.6), a: 0.78 },
  k: { bg: shade(c, -0.15), fg: shade(c, -0.65), a: 0.6 },
  l: { bg: c, fg: shade(c, -0.6), a: 0.62 },
  o: { ch: "o", fg: shade(c, 0.3), a: 0.5 },
});

const JELLY = [
  [0.25, "#9a7fe0", 0.6, 0.7],
  [0.82, "#ef8f63", 0.9, 0.95],
  [0.06, "#ec92c6", 0.75, 0.9],
  [0.55, "#7fb4ef", 1.1, 0.6],
].map(([x, c, v, a]) => [x, jellyPal(c), v, a]);

SCENES.jellyfish = {
  cell: (x, y, cols, rows, t) => {
    const cx = -cols * 0.15,
      cy = -rows * 0.35,
      R = rows * 0.75 + cols * 0.1,
      d = Math.hypot(x - cx, y - cy);
    if (Math.abs(d - R) < 0.55 && (((Math.atan2(y - cy, x - cx) * R - t * 3) % 3) + 3) % 3 < 1)
      return { ch: "o", fg: "#dbe8ff", a: 0.55 };
    if (Math.abs(d - R - 1.6) < 0.55 && hash(x, y, 71) < 0.4)
      return { ch: "~", fg: "#9cc8ff", a: 0.35 };
    if (rising(x, y, t, 0.6, 0.01)) return { ch: ".", fg: "#9cc8ff", a: 0.35 };
  },
  sprites: (cols, rows, t) =>
    JELLY.map(([fx, pal, v, a], i) => {
      const span = rows + 34;
      return {
        art: frame(JELLIES, t, 1.1, i * 0.5),
        pal,
        a,
        key: i,
        x: fx * cols + Math.sin(t * 0.35 + i) * 2.5 - 6.5,
        y: rows + 4 - ((t * v + (i * span) / 4) % span),
      };
    }),
};
