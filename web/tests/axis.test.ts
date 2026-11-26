import assert from "node:assert/strict";
import { test } from "node:test";
import { axisY, smoothRuns, tempAxis, valueAt, type ClimatePoint } from "../convex/lib/home.ts";

const MIN = 60_000;
const BAND = 92;
const GAP = 24;

test("tempAxis: без погоди — звичайна шкала однієї лінії", () => {
  assert.deepEqual(tempAxis({ min: 23.4, max: 24.1 }, null), { bands: [{ lo: 22, hi: 26, ticks: [22, 24, 26], who: "home" }] });
});

test("tempAxis: взимку дві смуги з розривом, холодніша (надворі) знизу", () => {
  const axis = tempAxis({ min: 20.1, max: 23.4 }, { min: -4.7, max: 1.7 });
  assert.deepEqual(axis.bands, [
    { lo: -6, hi: 2, ticks: [-6, -2, 2], who: "out" },
    { lo: 20, hi: 24, ticks: [20, 22, 24], who: "home" },
  ]);
});

test("tempAxis: у спеку смуги міняються місцями — вулиця вгорі", () => {
  const axis = tempAxis({ min: 22.6, max: 24.2 }, { min: 29.8, max: 36.2 });
  assert.deepEqual(axis.bands.map(b => b.who), ["home", "out"]);
  assert.ok(axis.bands[1].lo - axis.bands[0].hi >= 4);
});

test("tempAxis: близькі або перекриті діапазони — одна спільна смуга без розриву", () => {
  // перекриваються
  assert.deepEqual(tempAxis({ min: 23.8, max: 25.4 }, { min: 18, max: 30 }).bands, [{ lo: 18, hi: 30, ticks: [18, 24, 30], who: "both" }]);
  // між шкалами лише 3°: розрив не вартий місця
  const near = tempAxis({ min: 21.2, max: 22.8 }, { min: 14.1, max: 17.9 });
  assert.equal(near.bands.length, 1);
  assert.equal(near.bands[0].who, "both");
  assert.ok(near.bands[0].lo <= 14.1 && near.bands[0].hi >= 22.8);
});

test("axisY: шкала строго зростає, тож холодніше завжди нижче, а однакове — на одній висоті", () => {
  const axes = [
    tempAxis({ min: 20.1, max: 23.4 }, { min: -4.7, max: 1.7 }),
    tempAxis({ min: 22.6, max: 24.2 }, { min: 29.8, max: 36.2 }),
    tempAxis({ min: 23.8, max: 25.4 }, { min: 18, max: 30 }),
    tempAxis({ min: 21, max: 22 }, null),
  ];
  for (const axis of axes) {
    let prev = -Infinity;
    for (let v = -15; v <= 45; v += 0.1) {
      const y = axisY(axis, v, BAND, GAP);
      assert.ok(y > prev, `шкала не зростає біля ${v.toFixed(1)}°`);
      prev = y;
    }
    assert.equal(axisY(axis, 21.3, BAND, GAP), axisY(axis, 21.3, BAND, GAP));
  }
});

test("axisY: смуги займають свою висоту, розрив — між ними", () => {
  const axis = tempAxis({ min: 20.1, max: 23.4 }, { min: -4.7, max: 1.7 });
  assert.equal(axisY(axis, -6, BAND, GAP), 0);
  assert.equal(axisY(axis, 2, BAND, GAP), BAND);
  assert.equal(axisY(axis, 20, BAND, GAP), BAND + GAP);
  assert.equal(axisY(axis, 24, BAND, GAP), 2 * BAND + GAP);
  // значення посеред розриву лягає посеред розриву
  assert.equal(axisY(axis, 11, BAND, GAP), BAND + GAP / 2);
});

/** Сходинки по 0,1°, як їх записує сервер. */
function stairs(n: number): ClimatePoint[] {
  return Array.from({ length: n }, (_, i) => ({ t: i * 10 * MIN, v: Math.round((22 + Math.sin(i / 9) + (i % 4 === 0 ? 0.1 : 0)) * 10) / 10 }));
}

test("smoothRuns: краї точні, значення в межах вихідних, сталу лінію не змінює", () => {
  const run = stairs(100);
  const [smooth] = smoothRuns([run]);
  assert.equal(smooth[0].t, run[0].t);
  assert.equal(smooth[0].v, run[0].v);
  assert.equal(smooth[smooth.length - 1].t, run[run.length - 1].t);
  assert.equal(smooth[smooth.length - 1].v, run[run.length - 1].v);
  const lo = Math.min(...run.map(p => p.v));
  const hi = Math.max(...run.map(p => p.v));
  for (const p of smooth) assert.ok(p.v >= lo - 1e-9 && p.v <= hi + 1e-9);
  for (let i = 1; i < smooth.length; i++) assert.ok(smooth[i].t > smooth[i - 1].t);
  const [flat] = smoothRuns([Array.from({ length: 30 }, (_, i) => ({ t: i * 7 * MIN, v: 21.5 }))]);
  for (const p of flat) assert.ok(Math.abs(p.v - 21.5) < 1e-9);
});

test("smoothRuns: лінія стає плавнішою, але лишається близько до показів", () => {
  const run = stairs(120);
  const [smooth] = smoothRuns([run]);
  const rough = (pts: ClimatePoint[], at: (t: number) => number) => {
    let sum = 0;
    for (let t = 30 * MIN; t < 1150 * MIN; t += 5 * MIN) sum += Math.abs(at(t + 5 * MIN) - 2 * at(t) + at(t - 5 * MIN));
    return sum;
  };
  const raw = (t: number) => valueAt([run], t, true)!;
  const avg = (t: number) => valueAt([smooth], t, true)!;
  assert.ok(rough(smooth, avg) < rough(run, raw) / 3, "усереднена лінія має бути помітно рівнішою");
  for (let t = 0; t <= 1190 * MIN; t += 10 * MIN) assert.ok(Math.abs(avg(t) - raw(t)) < 0.25, `відхилення в ${t / MIN} хв`);
});

test("smoothRuns: розриви лишаються, короткі відрізки не чіпає", () => {
  const a = stairs(20);
  const lone = [{ t: 9_000 * MIN, v: 19 }];
  const pair = [{ t: 9_500 * MIN, v: 19 }, { t: 9_510 * MIN, v: 19.4 }];
  const out = smoothRuns([a, lone, pair]);
  assert.equal(out.length, 3);
  assert.equal(out[1], lone);
  assert.equal(out[2], pair);
  assert.equal(valueAt(out, 5_000 * MIN), null);
});

test("valueAt: exact повертає значення без округлення", () => {
  const run = [{ t: 0, v: 20 }, { t: 30, v: 21 }];
  assert.equal(valueAt([run], 10), 20.3);
  assert.ok(Math.abs(valueAt([run], 10, true)! - 20.3333333) < 1e-6);
});
