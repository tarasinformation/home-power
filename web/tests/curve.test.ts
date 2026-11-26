import assert from "node:assert/strict";
import { test } from "node:test";
import { smoothPath, type XY } from "../src/curve.ts";

/** Розбирає шлях на відрізки: початок, дві керівні точки, кінець. */
function segments(d: string): { a: XY; c1: XY; c2: XY; b: XY }[] {
  const nums = (s: string) => s.trim().split(/\s+/).map(Number);
  const parts = d.split(/(?=[MLC])/).map(s => ({ cmd: s[0], v: nums(s.slice(1)) }));
  let at: XY = { x: parts[0].v[0], y: parts[0].v[1] };
  const out = [];
  for (const part of parts.slice(1)) {
    assert.equal(part.cmd, "C");
    const [x1, y1, x2, y2, x, y] = part.v;
    out.push({ a: at, c1: { x: x1, y: y1 }, c2: { x: x2, y: y2 }, b: { x, y } });
    at = { x, y };
  }
  return out;
}

test("smoothPath: порожньо, одна точка, дві точки — пряма", () => {
  assert.equal(smoothPath([]), "");
  assert.equal(smoothPath([{ x: 1, y: 2 }]), "M1.0 2.0");
  assert.equal(smoothPath([{ x: 0, y: 0 }, { x: 10, y: 5 }]), "M0.0 0.0 L10.0 5.0");
});

test("smoothPath: крива проходить через кожну точку", () => {
  const pts = [{ x: 0, y: 50 }, { x: 10, y: 20 }, { x: 25, y: 22 }, { x: 40, y: 80 }, { x: 55, y: 80 }, { x: 60, y: 10 }];
  const segs = segments(smoothPath(pts));
  assert.equal(segs.length, pts.length - 1);
  segs.forEach((s, i) => {
    assert.deepEqual(s.a, pts[i]);
    assert.deepEqual(s.b, pts[i + 1]);
  });
});

test("smoothPath: між двома вимірами крива не виходить за їхні значення", () => {
  // Сходинки, різкий пік, плато й нерівні проміжки: найгірші випадки для «вистрибування».
  const sets: XY[][] = [
    [{ x: 0, y: 10 }, { x: 5, y: 10 }, { x: 6, y: 40 }, { x: 30, y: 40 }, { x: 31, y: 12 }, { x: 60, y: 11 }],
    [{ x: 0, y: 0 }, { x: 1, y: 100 }, { x: 50, y: 101 }, { x: 51, y: 0 }, { x: 52, y: 100 }],
    Array.from({ length: 40 }, (_, i) => ({ x: i * 7 + (i % 3), y: 60 + 40 * Math.sin(i * 1.3) + (i % 5) * 3 })),
  ];
  for (const pts of sets) {
    for (const s of segments(smoothPath(pts))) {
      const lo = Math.min(s.a.y, s.b.y) - 0.06; // 0,06 — округлення координат до 0,1
      const hi = Math.max(s.a.y, s.b.y) + 0.06;
      for (const c of [s.c1, s.c2]) {
        assert.ok(c.y >= lo && c.y <= hi, `керівна точка ${c.y} поза ${s.a.y}…${s.b.y}`);
        assert.ok(c.x >= s.a.x - 0.06 && c.x <= s.b.x + 0.06);
      }
    }
  }
});

test("smoothPath: точки, що не просуваються по x, пропускаються", () => {
  const d = smoothPath([{ x: 0, y: 0 }, { x: 0, y: 9 }, { x: 10, y: 5 }, { x: 10, y: 7 }, { x: 20, y: 0 }]);
  assert.equal(segments(d).length, 2);
});
