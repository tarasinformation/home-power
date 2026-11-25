// Перевірка логіки клімату без Convex: npm test
// Підставна «база» в пам'яті повторює мутацію convex/home.ts: звіт плати-читача -> applyHome.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyHome,
  climateAt,
  climateLine,
  climateView,
  crashed,
  deg,
  outdoorLine,
  parseHome,
  parseOpenMeteo,
  tempScale,
  valueAt,
  weatherFresh,
  weatherText,
  type ClimateSample,
  type HomeReport,
  type HomeState,
} from "../convex/lib/home.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);

function world() {
  let state: HomeState | null = null;
  const samples: ClimateSample[] = [];
  let seq = 0;
  return {
    get state() {
      return state;
    },
    samples,
    /** Звіт плати: температура в °C, вологість у %. */
    send(now: number, temp: number | null, hum: number | null = 45, extra: Partial<HomeReport> = {}) {
      const report: HomeReport = { kind: "full", boot: 7, seq: ++seq, uptime: 1, fw: "0.1", rssi: -60, hub: true, temp, hum, ...extra };
      const res = applyHome(state, report, samples[samples.length - 1] ?? null, now);
      if (!res.skip) state = res.next;
      if (res.sample) samples.push(res.sample);
      return res;
    },
  };
}

const body = (d: unknown[], extra: Record<string, unknown> = {}) => ({ v: 1, kind: "full", boot: 2871340021, seq: 17, hub: true, d, ...extra });

test("parseHome: бере температуру й вологість із сирих значень Matter", () => {
  const r = parseHome(
    body(
      [
        { ep: 8, uid: "a", k: "contact", closed: false, bat: 200, age: 3 },
        { ep: 5, k: "temp", p: 4, temp: 2549 },
        { ep: 6, k: "hum", p: 4, hum: 4205 },
      ],
      { uptime: 5400, fw: "0.1", rssi: -58 },
    ),
  );
  assert.deepEqual(r, { kind: "full", boot: 2871340021, seq: 17, uptime: 5400, fw: "0.1", rssi: -58, hub: true, temp: 25.5, hum: 42, rst: null, heap: null });
  const diag = parseHome(body([], { rst: 6, heap: 158304 }));
  assert.ok(typeof diag !== "string");
  assert.equal(diag.rst, 6);
  assert.equal(diag.heap, 158304);
});

test("parseHome: без записів клімату значення порожні, від'ємна температура проходить", () => {
  const empty = parseHome(body([]));
  assert.ok(typeof empty !== "string");
  assert.equal(empty.temp, null);
  assert.equal(empty.hum, null);
  const cold = parseHome(body([{ k: "temp", temp: -1234 }]));
  assert.ok(typeof cold !== "string");
  assert.equal(cold.temp, -12.3);
});

test("parseHome: значення поза межами й чужі типи відкидаються", () => {
  const r = parseHome(body([{ k: "temp", temp: 99999 }, { k: "temp", temp: "23" }, { k: "hum", hum: -5 }, null, 7]));
  assert.ok(typeof r !== "string");
  assert.equal(r.temp, null);
  assert.equal(r.hum, null);
});

test("parseHome: якщо датчиків кілька, береться перший", () => {
  const r = parseHome(body([{ k: "temp", temp: 2100 }, { k: "temp", temp: 2900 }]));
  assert.ok(typeof r !== "string");
  assert.equal(r.temp, 21);
});

test("parseHome: некоректні звіти дають текст помилки", () => {
  for (const bad of [
    null,
    [],
    "x",
    { ...body([]), v: 2 },
    { ...body([]), kind: "other" },
    { ...body([]), boot: -1 },
    { ...body([]), seq: 1.5 },
    { ...body([]), hub: "yes" },
    { ...body([]), d: {} },
    { ...body(Array(65).fill({})) },
  ]) {
    assert.equal(typeof parseHome(bad), "string");
  }
});

test("applyHome: перший звіт створює стан і перший запис історії", () => {
  const w = world();
  const res = w.send(T0, 23.8, 45);
  assert.equal(res.full, false);
  assert.equal(w.state?.temp, 23.8);
  assert.equal(w.state?.hum, 45);
  assert.equal(w.state?.climateSeen, T0);
  assert.deepEqual(w.samples, [{ t: T0, temp: 23.8, hum: 45 }]);
});

test("applyHome: дрібна зміна чекає 4,5 хв, стрибок записується одразу", () => {
  const w = world();
  w.send(T0, 23.8);
  w.send(T0 + 1 * MIN, 23.9);
  assert.equal(w.samples.length, 1, "0,1° за хвилину ще не пишемо");
  w.send(T0 + 2 * MIN, 24.3);
  assert.equal(w.samples.length, 2, "0,5° пишемо одразу");
  w.send(T0 + 3 * MIN, 24.3, 48);
  assert.equal(w.samples.length, 3, "3% вологості пишемо одразу");
  w.send(T0 + 8 * MIN, 24.4, 48);
  assert.equal(w.samples.length, 4, "дрібна зміна після паузи");
  assert.equal(w.state?.temp, 24.4);
});

test("applyHome: без змін запис з'являється раз на 15 хв", () => {
  const w = world();
  for (let m = 0; m <= 60; m += 5) w.send(T0 + m * MIN, 22);
  assert.deepEqual(
    w.samples.map(s => (s.t - T0) / MIN),
    [0, 15, 30, 45, 60],
  );
});

test("applyHome: повтор звіту ігнорується", () => {
  const w = world();
  w.send(T0, 22);
  const before = w.state;
  const res = applyHome(w.state, { kind: "full", boot: 7, seq: 1, uptime: 1, fw: "0.1", rssi: -60, hub: true, temp: 30, hum: 10 }, w.samples[0], T0 + MIN);
  assert.equal(res.skip, true);
  assert.equal(res.sample, null);
  assert.equal(res.next, before);
});

test("applyHome: delta без попереднього звіту чи з пропуском просить повний знімок", () => {
  const delta = (seq: number, boot = 7): HomeReport => ({ kind: "delta", boot, seq, uptime: 1, fw: "0.1", rssi: -60, hub: true, temp: 22, hum: null });
  assert.equal(applyHome(null, delta(1), null, T0).full, true, "стану ще немає");
  const w = world();
  w.send(T0, 22);
  assert.equal(applyHome(w.state, delta(2), w.samples[0], T0 + MIN).full, false, "наступний за номером");
  assert.equal(applyHome(w.state, delta(4), w.samples[0], T0 + MIN).full, true, "пропущено звіти");
  assert.equal(applyHome(w.state, delta(1, 8), w.samples[0], T0 + MIN).full, true, "плата перезапустилася");
});

test("applyHome: delta лише з температурою лишає вологість, і навпаки", () => {
  const w = world();
  w.send(T0, 22, 45);
  w.send(T0 + 10 * MIN, 22.6, null, { kind: "delta" });
  assert.equal(w.state?.hum, 45);
  assert.deepEqual(w.samples[1], { t: T0 + 10 * MIN, temp: 22.6, hum: 45 });
  w.send(T0 + 20 * MIN, null, 50, { kind: "delta" });
  assert.equal(w.state?.temp, 22.6);
  assert.deepEqual(w.samples[2], { t: T0 + 20 * MIN, temp: 22.6, hum: 50 });
});

test("applyHome: плата не чує хаб — покази й історія не оновлюються", () => {
  const w = world();
  w.send(T0, 22);
  w.send(T0 + 20 * MIN, 30, 10, { hub: false });
  assert.equal(w.state?.hub, false);
  assert.equal(w.state?.temp, 22);
  assert.equal(w.state?.climateSeen, T0);
  assert.equal(w.state?.lastSeen, T0 + 20 * MIN);
  assert.equal(w.samples.length, 1);
});

test("climateView: свіжі покази, мовчання плати, втрата хаба, застарілий датчик", () => {
  assert.equal(climateView(null, T0), null);
  const w = world();
  w.send(T0, null, null);
  assert.equal(climateView(w.state, T0), null, "показів ще не було");
  w.send(T0 + MIN, 23.8, 45);
  assert.deepEqual(climateView(w.state, T0 + 2 * MIN), { temp: 23.8, hum: 45, seen: T0 + MIN, lastSeen: T0 + MIN, issue: null });
  assert.equal(climateView(w.state, T0 + 20 * MIN)?.issue, "silent");
  w.send(T0 + 30 * MIN, null, null, { hub: false });
  assert.equal(climateView(w.state, T0 + 31 * MIN)?.issue, "nohub");
  w.send(T0 + 35 * MIN, null, null);
  const old = climateView(w.state, T0 + 36 * MIN);
  assert.equal(old?.issue, "old", "хаб чути, але датчик показів не дає");
  assert.equal(old?.temp, 23.8);
});

test("climateLine: суцільна лінія дотягується до «зараз», розрив ділить її на відрізки", () => {
  const w = world();
  for (let m = 0; m <= 60; m += 15) w.send(T0 + m * MIN, 22 + m / 60);
  // дві години тиші, потім ще пів години даних
  for (let m = 180; m <= 210; m += 15) w.send(T0 + m * MIN, 20);
  const now = T0 + 215 * MIN;
  const line = climateLine(w.samples, climateView(w.state, now), now);
  assert.ok(line);
  assert.equal(line.runs.length, 2);
  assert.equal(line.runs[0].length, 5);
  assert.deepEqual(line.runs[1][line.runs[1].length - 1], { t: now, v: 20 });
  assert.equal(line.min, 20);
  assert.equal(line.max, 23);
  assert.equal(line.from, T0, "вікно починається з першого запису");
  assert.equal(climateAt(line, T0 + 30 * MIN), 22.5);
  assert.equal(climateAt(line, T0 + 7.5 * MIN), 22.1, "лінійно між точками");
  assert.equal(climateAt(line, T0 + 120 * MIN), null, "у розриві даних немає");
  assert.equal(climateAt(line, now), 20);
});

test("climateLine: мало даних — вікно щонайменше три години; несвіжі покази лінію не дотягують", () => {
  const w = world();
  w.send(T0, 22);
  w.send(T0 + 15 * MIN, 22);
  const now = T0 + 60 * MIN;
  const line = climateLine(w.samples, climateView(w.state, now), now);
  assert.ok(line);
  assert.equal(line.to - line.from, 3 * 60 * MIN);
  assert.equal(line.runs.length, 1);
  assert.equal(line.runs[0][line.runs[0].length - 1].t, T0 + 15 * MIN, "плата мовчить: лінія закінчується на останньому записі");
});

test("climateLine: вікно — остання доба, лівий край береться з запису перед вікном", () => {
  const samples: ClimateSample[] = [];
  for (let m = -30 * 60; m <= 0; m += 10) samples.push({ t: T0 + m * MIN, temp: 20 + (m % 20 === 0 ? 0 : 1), hum: 40 });
  const now = T0 + 5 * MIN;
  const line = climateLine(samples, null, now);
  assert.ok(line);
  assert.equal(line.to - line.from, 24 * 60 * MIN);
  assert.equal(line.runs.length, 1);
  assert.equal(line.runs[0][0].t, line.from);
  assert.equal(line.runs[0][0].v, 20.5, "посередині між записами 20° і 21°");
  assert.equal(climateLine([], null, now), null);
});

test("tempScale: цілі градуси, щонайменше 4° і три позначки", () => {
  assert.deepEqual(tempScale(23.4, 24.1), { lo: 22, hi: 26, ticks: [22, 24, 26] });
  assert.deepEqual(tempScale(22, 22), { lo: 20, hi: 24, ticks: [20, 22, 24] });
  assert.deepEqual(tempScale(16.2, 24.8), { lo: 15, hi: 27, ticks: [15, 21, 27] });
  const cold = tempScale(-3.2, 1.4);
  assert.ok(cold.lo <= -4 && cold.hi >= 2 && (cold.hi - cold.lo) % 2 === 0);
});

test("deg: одна цифра після коми", () => {
  assert.equal(deg(23.8), "23,8");
  assert.equal(deg(24), "24,0");
  assert.equal(deg(-0.2), "−0,2");
});

// ---------- погода надворі ----------

const meteo = (current: Record<string, unknown>, hourly?: Record<string, unknown>) => ({ latitude: 50, longitude: 30, current, ...(hourly ? { hourly } : {}) });

test("parseOpenMeteo: поточна погода й погодинна температура, час із секунд у мілісекунди", () => {
  const r = parseOpenMeteo(
    meteo(
      { time: T0 / 1000, interval: 900, temperature_2m: -0.24, relative_humidity_2m: 80.4, apparent_temperature: -4.06, precipitation: 0, weather_code: 2, wind_speed_10m: 2.61 },
      { time: [T0 / 1000 - 7200, T0 / 1000 - 3600, T0 / 1000], temperature_2m: [0.4, null, -0.26] },
    ),
  );
  assert.ok(r);
  assert.deepEqual(r.now, { t: T0, temp: -0.2, feels: -4.1, hum: 80, wind: 2.6, precip: 0, code: 2 });
  assert.deepEqual(r.hourly, [
    { t: T0 - 120 * MIN, temp: 0.4 },
    { t: T0, temp: -0.3 },
  ]);
});

test("parseOpenMeteo: без температури чи з несподіваною відповіддю — null; решта полів необов'язкова", () => {
  for (const bad of [null, "x", {}, meteo({ time: 1 }), meteo({ temperature_2m: 3 }), meteo({ time: 1, temperature_2m: 999 })]) {
    assert.equal(parseOpenMeteo(bad), null);
  }
  const bare = parseOpenMeteo(meteo({ time: T0 / 1000, temperature_2m: 3 }));
  assert.ok(bare);
  assert.deepEqual(bare.now, { t: T0, temp: 3, feels: null, hum: null, wind: null, precip: null, code: null });
  assert.deepEqual(bare.hourly, []);
});

test("weatherText і weatherFresh", () => {
  assert.equal(weatherText(0), "ясно");
  assert.equal(weatherText(73), "сніг");
  assert.equal(weatherText(1234), null);
  assert.equal(weatherText(null), null);
  const w = { t: T0, temp: 1, feels: null, hum: null, wind: null, precip: null, code: null };
  assert.equal(weatherFresh(w, T0 + 60 * MIN), true);
  assert.equal(weatherFresh(w, T0 + 120 * MIN), false);
  assert.equal(weatherFresh(null, T0), false);
});

test("outdoorLine: вікно як у лінії «вдома», розрив ділить лінію, свіжа погода дотягує до краю", () => {
  const samples = [];
  for (let m = -90; m <= 60; m += 15) samples.push({ t: T0 + m * MIN, temp: m / 30 });
  // три години без даних, потім ще година
  for (let m = 240; m <= 300; m += 15) samples.push({ t: T0 + m * MIN, temp: -2 });
  const to = T0 + 310 * MIN;
  const fresh = { t: T0 + 300 * MIN, temp: -2.4, feels: null, hum: null, wind: null, precip: null, code: null };
  const line = outdoorLine(samples, fresh, T0, to);
  assert.ok(line);
  assert.equal(line.runs.length, 2);
  assert.deepEqual(line.runs[0][0], { t: T0, v: 0 }, "записи до початку вікна відкинуто");
  assert.deepEqual(line.runs[1][line.runs[1].length - 1], { t: to, v: -2.4 });
  assert.equal(line.min, -2.4);
  assert.equal(line.max, 2);
  assert.equal(valueAt(line.runs, T0 + 30 * MIN), 1);
  assert.equal(valueAt(line.runs, T0 + 150 * MIN), null, "у розриві даних немає");

  const stale = outdoorLine(samples, { ...fresh, t: T0 }, T0, to);
  assert.ok(stale);
  assert.equal(stale.runs[1][stale.runs[1].length - 1].t, T0 + 300 * MIN, "застаріла погода лінію не дотягує");
  assert.equal(outdoorLine([], null, T0, to), null);
});

test("outdoorLine: лівий край береться з запису перед вікном", () => {
  const line = outdoorLine(
    [
      { t: T0 - 30 * MIN, temp: 2 },
      { t: T0 + 30 * MIN, temp: 4 },
    ],
    null,
    T0,
    T0 + 60 * MIN,
  );
  assert.ok(line);
  assert.deepEqual(line.runs[0][0], { t: T0, v: 3 });
});

test("діагностика плати: час запуску рахується від лічильника роботи й не змінюється до наступного запуску", () => {
  const w = world();
  w.send(T0, 22, 45, { uptime: 120, rst: 1, heap: 170000 });
  assert.equal(w.state?.bootAt, T0 - 120_000);
  assert.equal(w.state?.rst, 1);
  assert.equal(w.state?.heapMin, 170000);
  w.send(T0 + 5 * MIN, 22, 45, { uptime: 420, rst: 1, heap: 165000 });
  assert.equal(w.state?.bootAt, T0 - 120_000, "той самий запуск");
  assert.equal(w.state?.heapMin, 165000);
  w.send(T0 + 10 * MIN, 22, 45, { boot: 8, seq: 1, uptime: 30, rst: 6 });
  assert.equal(w.state?.bootAt, T0 + 10 * MIN - 30_000, "плата перезапустилась");
  assert.equal(crashed(w.state?.rst), true, "сторожовий таймер — це збій");
  assert.equal(crashed(1), false);
  assert.equal(crashed(3), false);
  assert.equal(crashed(null), false);
});
