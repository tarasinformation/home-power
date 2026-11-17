// Перевірка логіки станів без Convex: npm test
// Підставна «база» в пам'яті повторює те, що роблять мутації в convex/power.ts:
// сигнал плати -> applyReport, розклад -> checkStale, сторінка -> view.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyReport,
  checkStale,
  clock,
  dayLabel,
  days,
  dayStart,
  dur,
  emailAllowed,
  hourCells,
  planPill,
  socInterp,
  socTrend,
  forecastFor,
  hours,
  parseYasno,
  planFor,
  planNote,
  planTotal,
  hourTicks,
  socAt,
  socLine,
  intervals,
  note,
  parseReport,
  stationNote,
  statusOf,
  TITLES,
  view,
  type DeviceState,
  type PowerEvent,
} from "../convex/lib/logic.ts";

function world() {
  let state: DeviceState | null = null;
  const events: PowerEvent[] = [];
  let clock = Date.UTC(2026, 10, 14, 18, 0, 0);
  let writes = 0;
  return {
    get clock() {
      return clock;
    },
    get writes() {
      return writes;
    },
    events,
    tick: (s: number) => (clock += s * 1000),
    send(power: boolean) {
      const report = parseReport({ power, rssi: -55.4, uptime: 100, fw: "0.1" });
      assert.ok(typeof report !== "string");
      const r = applyReport(state, report, clock);
      if (r.write) {
        state = r.next;
        writes++;
      }
      events.push(...r.events);
    },
    cron() {
      const e = checkStale(state, clock);
      if (e && state) {
        state = { ...state, lost: true };
        events.push(e);
      }
      return e;
    },
    view: () => view(state, events, clock),
    state: () => state,
  };
}

test("тіло запиту: обов'язкове лише power, зайве обрізається", () => {
  assert.equal(typeof parseReport(null), "string");
  assert.equal(typeof parseReport([]), "string");
  assert.equal(typeof parseReport({}), "string");
  assert.equal(typeof parseReport({ power: "true" }), "string");
  assert.equal(typeof parseReport({ power: 1 }), "string");
  assert.deepEqual(parseReport({ power: false }), { power: false, rssi: null, uptime: null, fw: null, ago: null });
  assert.deepEqual(parseReport({ power: true, rssi: -61.6, uptime: "x", fw: "v".repeat(100) }), {
    power: true,
    rssi: -62,
    uptime: null,
    fw: "v".repeat(32),
    ago: null,
  });
  assert.deepEqual(parseReport({ power: true, rssi: Infinity, uptime: NaN, fw: 5 }), {
    power: true,
    rssi: null,
    uptime: null,
    fw: null,
    ago: null,
  });
  // ago має зміст лише для «світла немає»; від'ємне й нечислове відкидається.
  assert.equal((parseReport({ power: false, ago: 41.6 }) as { ago: number }).ago, 42);
  assert.equal((parseReport({ power: true, ago: 40 }) as { ago: null }).ago, null);
  assert.equal((parseReport({ power: false, ago: -5 }) as { ago: null }).ago, null);
  assert.equal((parseReport({ power: false, ago: "40" }) as { ago: null }).ago, null);
});

test("початок відключення записується часом першого невдалого ping", () => {
  const report = (power: boolean, ago: number | null) => ({ power, rssi: null, uptime: null, fw: null, ago });
  const t0 = Date.UTC(2026, 10, 14, 18, 0, 0);
  const on = applyReport(null, report(true, null), t0).next;

  // Плата повідомила через 50 с після останнього сигналу, що світло зникло 40 с тому.
  let r = applyReport(on, report(false, 40), t0 + 50_000);
  assert.deepEqual(r.events, [{ t: t0 + 10_000, s: "off" }]);
  assert.equal(r.next.since, t0 + 10_000);
  assert.equal(r.next.lastSeen, t0 + 50_000);
  // Повернення світла — без поправки; тривалість тепер справжня.
  const back = applyReport(r.next, report(true, null), t0 + 170_000);
  assert.deepEqual(back.events, [{ t: t0 + 170_000, s: "on" }]);
  assert.equal(view(back.next, [...r.events, ...back.events], t0 + 170_000).total, 160_000);

  // Не раніше за останній сигнал зі світлом.
  r = applyReport(on, report(false, 120), t0 + 50_000);
  assert.equal(r.events[0].t, t0);
  // Не більше ніж на 5 хвилин назад.
  r = applyReport(null, report(false, 3600), t0);
  assert.equal(r.events[0].t, t0 - 5 * 60_000);
  // Стан не змінився: поправка нічого не переписує.
  const off = applyReport(on, report(false, 40), t0 + 50_000).next;
  r = applyReport(off, report(false, 60), t0 + 70_000);
  assert.deepEqual(r.events, []);
  assert.equal(r.next.since, t0 + 10_000);
  // Після втрати зв'язку: «зв'язок зник» часом останнього сигналу, відключення не раніше за нього.
  r = applyReport(on, report(false, 40), t0 + 20 * 60_000);
  assert.deepEqual(r.events, [
    { t: t0, s: "lost" },
    { t: t0 + 20 * 60_000 - 40_000, s: "off" },
  ]);
});

test("до першого сигналу стан невідомий", () => {
  const w = world();
  assert.equal(w.view().status, "unknown");
  assert.equal(w.cron(), null);
  assert.equal(note(w.view()), "Плата ще не надіслала жодного сигналу");
});

test("часті сигнали без зміни стану: записів у базу мало, подія одна", () => {
  const w = world();
  w.send(true);
  const w0 = w.writes;
  for (let i = 0; i < 30; i++) {
    w.tick(20);
    w.send(true);
    assert.equal(w.cron(), null);
  }
  assert.ok(w.writes - w0 <= 10, `забагато записів: ${w.writes - w0}`);
  assert.deepEqual(w.events.map(e => e.s), ["on"]);
  const v = w.view();
  assert.equal(v.status, "on");
  assert.equal(v.outages.length, 0);
  // Рідкі записи не роблять стан застарілим: останній сигнал не старший за хвилину.
  assert.ok(w.clock - v.lastSeen! <= 60_000);
});

test("відключення на 45 хвилин: точна тривалість і початок стану", () => {
  const w = world();
  w.send(true);
  w.tick(30);
  w.send(false);
  const offAt = w.clock;
  let v = w.view();
  assert.equal(v.status, "off");
  assert.equal(v.since, offAt);
  assert.equal(v.outages[0].end, null);
  for (let i = 0; i < 90; i++) {
    w.tick(30);
    w.send(false);
    assert.equal(w.cron(), null);
  }
  // Триває: тривалість рахується до «зараз».
  assert.equal(w.view().total, 45 * 60 * 1000);
  w.send(true);
  v = w.view();
  assert.equal(v.status, "on");
  assert.equal(v.since, w.clock);
  assert.equal(v.outages.length, 1);
  assert.equal(v.outages[0].end! - v.outages[0].start, 45 * 60 * 1000);
  assert.equal(v.outages[0].endedBy, "on");
  assert.equal(v.total, 45 * 60 * 1000);
});

test("плата замовкла: розклад сам записує «зв'язок зник» з часом останнього сигналу", () => {
  const w = world();
  w.send(true);
  const last = w.clock;
  w.tick(4 * 60);
  assert.equal(w.cron(), null); // ще в межах 5 хвилин
  assert.equal(w.view().status, "on");
  w.tick(2 * 60);
  // Сторінка бачить «немає зв'язку» ще до спрацювання розкладу.
  assert.equal(w.view().status, "lost");
  assert.deepEqual(w.cron(), { t: last, s: "lost" });
  assert.equal(w.cron(), null); // вдруге подія не дублюється
  w.tick(14 * 60);
  const v = w.view();
  assert.equal(v.status, "lost");
  assert.equal(v.since, last);
  assert.match(note(v), /^останній сигнал .* 20 хв тому\. Зник інтернет або резервне живлення$/);
  w.send(true);
  assert.equal(w.view().status, "on");
  assert.equal(w.view().since, w.clock);
  assert.deepEqual(w.events.map(e => e.s), ["on", "lost", "on"]);
});

test("плата повернулася раніше за розклад: подія «зв'язок зник» дописується заднім числом", () => {
  const w = world();
  w.send(true);
  const last = w.clock;
  w.tick(20 * 60);
  w.send(true); // розклад не спрацював
  assert.deepEqual(w.events, [
    { t: w.clock - 20 * 60 * 1000, s: "on" },
    { t: last, s: "lost" },
    { t: w.clock, s: "on" },
  ]);
  assert.equal(w.cron(), null);
});

test("зв'язок зник під час відключення: кінець відключення позначено як «зв'язок зник»", () => {
  const w = world();
  w.send(true);
  w.tick(60);
  w.send(false);
  const offAt = w.clock;
  w.tick(60);
  w.send(false);
  const last = w.clock;
  w.tick(10 * 60);
  // Розклад ще не спрацював, а сторінка вже закриває відключення часом останнього сигналу.
  let v = w.view();
  assert.equal(v.status, "lost");
  assert.deepEqual(v.outages[0], { start: offAt, end: last, endedBy: "lost" });
  w.cron();
  assert.deepEqual(w.view().outages[0], { start: offAt, end: last, endedBy: "lost" });
  w.tick(20 * 60);
  w.send(true);
  v = w.view();
  assert.equal(v.status, "on");
  assert.equal(v.outages.length, 1);
  assert.equal(v.outages[0].endedBy, "lost");
  assert.equal(v.total, 60 * 1000);
  assert.deepEqual(w.events.map(e => e.s), ["on", "off", "lost", "on"]);
});

test("після зникнення зв'язку світла й далі немає: починається нове відключення", () => {
  const w = world();
  w.send(false);
  w.tick(10 * 60);
  w.cron();
  w.send(false);
  assert.deepEqual(w.events.map(e => e.s), ["off", "lost", "off"]);
  const v = w.view();
  assert.equal(v.status, "off");
  assert.equal(v.outages.length, 2);
  assert.equal(v.outages[0].end, null);
});

test("історія: лише відключення за останні 7 днів, найновіші зверху", () => {
  const w = world();
  w.send(true);
  w.send(false);
  w.tick(3600);
  w.send(true); // старе відключення, 1 год
  w.tick(8 * 24 * 3600);
  w.send(true); // після довгої тиші: lost + on
  // Сигнали йдуть щохвилини, інакше тиша понад 5 хвилин сама стала б «зв'язок зник».
  const hold = (power: boolean, minutes: number) => {
    for (let i = 0; i < minutes; i++) {
      w.tick(60);
      w.send(power);
    }
  };
  hold(true, 1);
  hold(false, 10);
  hold(true, 1);
  hold(false, 2);
  hold(true, 1); // друге відключення тривало 2 хв: від першого «немає» до першого «є»
  const v = w.view();
  assert.equal(v.outages.length, 2);
  assert.ok(v.outages[0].start > v.outages[1].start);
  assert.equal(v.total, (600 + 120) * 1000);
  assert.equal(v.outages[1].end! - v.outages[1].start, 600 * 1000);
});

test("statusOf і тексти", () => {
  assert.equal(statusOf(null, 0), "unknown");
  assert.deepEqual(Object.keys(TITLES).sort(), ["lost", "off", "on", "unknown"]);
  assert.equal(dur(20_000), "менше хвилини");
  assert.equal(dur(45 * 60_000), "45 хв");
  assert.equal(dur(60 * 60_000), "1 год");
  assert.equal(dur((26 * 60 + 5) * 60_000), "1 д 2 год 5 хв");
  const w = world();
  w.send(true);
  w.tick(125 * 60);
  w.send(true);
  // 18:00 UTC 14 листопада = 20:00 за Києвом (зимовий час).
  assert.match(note({ ...w.view(), status: "on", since: Date.UTC(2026, 10, 14, 18, 0, 0) }), /^з 14\.11, 20:00, уже 2 год 5 хв$/);
});

test("реєстрація: лише пошта з переліку; порожній перелік закриває реєстрацію", () => {
  assert.equal(emailAllowed("me@example.com", undefined), false);
  assert.equal(emailAllowed("me@example.com", ""), false);
  assert.equal(emailAllowed("me@example.com", " , "), false);
  assert.equal(emailAllowed("", ""), false);
  assert.equal(emailAllowed("Me@Example.com ", "other@example.com, me@example.com"), true);
  assert.equal(emailAllowed("evil@example.com", "me@example.com"), false);
  assert.equal(emailAllowed("me@example.com.evil.io", "me@example.com"), false);
});

test("графік: доба за київським часом, зокрема в дні переведення годинника", () => {
  const kyiv = (t: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Kyiv", dateStyle: "short", timeStyle: "medium" }).format(t);
  // Звичайний день: 14.11.2026 18:00 UTC = 20:00 за Києвом; доба почалася о 22:00 UTC напередодні.
  const t = Date.UTC(2026, 10, 14, 18, 0, 0);
  assert.equal(dayStart(t), Date.UTC(2026, 10, 13, 22, 0, 0));
  assert.equal(dayStart(dayStart(t)), dayStart(t));
  assert.equal(dayStart(dayStart(t) - 1), Date.UTC(2026, 10, 12, 22, 0, 0));
  // 25.10.2026 годинник переводять назад (доба 25 годин), 29.03.2026 — вперед (23 години).
  for (const [y, m, d, hours] of [[2026, 9, 25, 25], [2026, 2, 29, 23]] as const) {
    const noon = Date.UTC(y, m, d, 10, 0, 0);
    const start = dayStart(noon);
    assert.match(kyiv(start), / 00:00:00$/);
    const next = dayStart(start + 26 * 3600_000);
    assert.match(kyiv(next), / 00:00:00$/);
    assert.equal((next - start) / 3600_000, hours);
    assert.equal(dayStart(next - 1), start);
  }
});

test("графік: стани розкладаються по днях, відключення через північ ділиться на два дні", () => {
  const w = world();
  const H = 3600_000;
  const hold = (power: boolean, minutes: number) => {
    for (let i = 0; i < minutes; i++) {
      w.tick(60);
      w.send(power);
    }
  };
  // Старт 14.11 о 20:00 за Києвом. Світло є до 23:00, немає до 01:30, далі є до 03:00.
  w.send(true);
  const t0 = w.clock;
  hold(true, 179);
  hold(false, 150);
  hold(true, 90);
  const rows = days(w.state(), w.events, w.clock, 3);
  assert.equal(rows.length, 3);
  const [today, yesterday, before] = rows;
  assert.equal(today.start, dayStart(w.clock));
  assert.equal(today.end - today.start, 24 * H);
  assert.equal(yesterday.end, today.start);
  assert.equal(before.end, yesterday.start);
  // Сьогодні (15.11): 00:00-01:30 немає, далі є до «зараз»; майбутнього в сегментах немає.
  assert.deepEqual(today.segments.map(s => s.kind), ["off", "on"]);
  assert.equal(today.segments[0].from, today.start);
  assert.equal(today.off, 90 * 60_000);
  assert.equal(today.segments.at(-1)!.to, w.clock);
  // Світло й темрява разом покривають усю минулу частину доби, коли зв'язок був.
  assert.equal(today.on + today.off, w.clock - today.start);
  // Учора (14.11): до 20:00 даних немає, 20:00-23:00 є, 23:00-24:00 немає.
  assert.deepEqual(yesterday.segments.map(s => s.kind), ["on", "off"]);
  assert.equal(yesterday.segments[0].from, t0);
  assert.equal(yesterday.segments[1].to, yesterday.end);
  assert.equal(yesterday.off, 60 * 60_000);
  assert.equal(yesterday.on, 180 * 60_000);
  // Позавчора даних немає зовсім.
  assert.deepEqual(before.segments, []);
  assert.equal(before.off, 0);
  assert.equal(before.on, 0);
  // Сума по днях дорівнює сумі в таблиці відключень.
  assert.equal(today.off + yesterday.off, w.view().total);
  assert.equal(dayLabel(today.start, w.clock), "сьогодні");
  assert.equal(dayLabel(yesterday.start, w.clock), "вчора");
  assert.match(dayLabel(before.start, w.clock), /13\.11/);
  assert.equal(clock(yesterday.segments[1].from), "23:00");
  assert.equal(clock(yesterday.end, yesterday.end), "24:00");
});

test("графік: плата замовкла — стрічка показує «немає зв'язку» ще до спрацювання розкладу", () => {
  const w = world();
  w.send(true);
  const last = w.clock;
  w.tick(30 * 60);
  let segs = intervals(w.state(), w.events, w.clock);
  assert.deepEqual(segs, [{ from: last, to: w.clock, kind: "lost" }]);
  w.cron();
  segs = intervals(w.state(), w.events, w.clock);
  assert.deepEqual(segs, [{ from: last, to: w.clock, kind: "lost" }]);
  w.send(true);
  w.tick(60);
  w.send(true);
  assert.deepEqual(intervals(w.state(), w.events, w.clock).map(s => s.kind), ["lost", "on"]);
  assert.deepEqual(intervals(null, [], w.clock), []);
});

test("заряд станції EcoFlow: розбір, збереження, текст", () => {
  // Без поля soc звіт лишається таким, як був.
  assert.equal("soc" in (parseReport({ power: true }) as object), false);
  assert.deepEqual(parseReport({ power: true, soc: 98.6, socAge: 12 }), {
    power: true, rssi: null, uptime: null, fw: null, ago: null, soc: 99, socAge: 12,
  });
  assert.equal("soc" in (parseReport({ power: true, soc: 101 }) as object), false);
  assert.equal("soc" in (parseReport({ power: true, soc: "99" }) as object), false);

  const t0 = 1_800_000_000_000;
  const base = { power: true, rssi: null, uptime: null, fw: null, ago: null };
  const a = applyReport(null, { ...base, soc: 99, socAge: 10 }, t0);
  assert.equal(a.next.soc, 99);
  assert.equal(a.next.socSeen, t0 - 10_000);

  // Зміна заряду записується одразу, навіть якщо з останнього запису не минула хвилина.
  const b = applyReport(a.next, { ...base, soc: 98, socAge: 0 }, t0 + 20_000);
  assert.equal(b.write, true);
  assert.equal(b.next.soc, 98);
  const same = applyReport(b.next, { ...base, soc: 98, socAge: 0 }, t0 + 40_000);
  assert.equal(same.write, false);

  // Плата перестала чути станцію: лишається останнє значення з його часом.
  const c = applyReport(b.next, base, t0 + 60_000);
  assert.equal(c.next.soc, 98);
  assert.equal(c.next.socSeen, t0 + 20_000);

  assert.equal(stationNote(view(null, [], t0)), null);
  assert.equal(stationNote(view(applyReport(null, base, t0).next, [], t0)), null);
  assert.equal(stationNote(view(b.next, [], t0 + 30_000)), "Зарядна станція: 98%");
  assert.match(stationNote(view(c.next, [], t0 + 10 * 60_000))!, /98% \(дані від .*не чути\)/);
});

test("історія заряду: запис лише при зміні, лінія за 24 години тримає значення до наступної зміни", () => {
  const H = 3600_000;
  const t0 = Date.UTC(2026, 10, 14, 18, 0, 0);
  const rep = (soc: number | null) => ({ power: true, rssi: null, uptime: null, fw: null, ago: null, soc, socAge: 0 });
  let state: DeviceState | null = null;
  const samples: { t: number; v: number }[] = [];
  const send = (t: number, soc: number | null) => {
    const r = applyReport(state, rep(soc), t);
    state = r.next;
    if (r.sample) samples.push(r.sample);
    return r.sample;
  };
  assert.deepEqual(send(t0, 100), { t: t0, v: 100 }); // перше почуте значення
  assert.equal(send(t0 + 60_000, 100), null); // не змінилося
  assert.equal(send(t0 + 120_000, null), null); // станцію не чути: запису немає, значення лишається
  assert.equal(state!.soc, 100);
  assert.deepEqual(send(t0 + 2 * H, 99), { t: t0 + 2 * H, v: 99 });
  assert.deepEqual(send(t0 + 3 * H, 60), { t: t0 + 3 * H, v: 60 });
  assert.equal(samples.length, 3);

  // Через 30 годин після старту: вікно 24 год починається о t0 + 6 год, там заряд уже 60.
  let now = t0 + 30 * H;
  send(now - 60_000, 60);
  let line = socLine(samples, view(state, [], now));
  assert.equal(line.to - line.from, 24 * H);
  assert.deepEqual(line.points, [
    { t: now - 24 * H, v: 60 },
    { t: now, v: 60 },
  ]);
  assert.equal(socAt(line, now - 12 * H), 60);
  assert.equal(socAt(line, now - 25 * H), null);

  // Через 4 години після старту видно всі три сходинки, лінія доходить до «зараз».
  now = t0 + 4 * H;
  state = { ...state!, lastSeen: now - 10_000, socSeen: now - 10_000 };
  line = socLine(samples, view(state, [], now));
  assert.deepEqual(line.points, [
    { t: t0, v: 100 },
    { t: t0 + 2 * H, v: 99 },
    { t: t0 + 3 * H, v: 60 },
    { t: now, v: 60 },
  ]);
  assert.equal(socAt(line, t0 + H), 100);
  assert.equal(socAt(line, t0 + 2.5 * H), 99);
  assert.equal(socAt(line, now), 60);
  assert.equal(socAt(line, t0 - 1), null);

  // Станцію перестали чути годину тому: лінія обривається на останньому почутому моменті.
  state = { ...state!, lastSeen: now - 10_000, socSeen: now - H };
  line = socLine(samples.filter(s => s.t <= now - H), view(state, [], now));
  assert.equal(line.points.at(-1)!.t, now - H);
  assert.equal(socAt(line, now - 30 * 60_000), null);

  // Без історії лінії немає.
  assert.deepEqual(socLine([], view(state, [], now)).points, []);
});

test("позначки осі часу: кожні 6 годин за київським часом", () => {
  const H = 3600_000;
  const to = Date.UTC(2026, 10, 14, 18, 30, 0); // 20:30 за Києвом
  const ticks = hourTicks(to - 24 * H, to);
  assert.deepEqual(ticks.map(t => clock(t)), ["00:00", "06:00", "12:00", "18:00"]);
  assert.ok(ticks.every(t => t >= to - 24 * H && t <= to));
});

test("офіційний графік: розбір відповіді Yasno, прогноз і підказка «графік проти факту»", () => {
  const H = 3600_000;
  // Вигадані дані у форматі відповіді Yasno (скорочено до однієї черги).
  const body = {
    "1.1": {
      today: {
        slots: [
          { start: 0, end: 390, type: "NotPlanned" },
          { start: 390, end: 630, type: "Definite" },
          { start: 630, end: 930, type: "NotPlanned" },
          { start: 930, end: 1020, type: "Definite" },
          { start: 1020, end: 1110, type: "Definite" },
          { start: 1110, end: 1170, type: "SomethingNew" },
          { start: 1170, end: 1440, type: "NotPlanned" },
        ],
        date: "2026-01-10T00:00:00+02:00",
        status: "ScheduleApplies",
      },
      tomorrow: { slots: [], date: "2026-01-11T00:00:00+02:00", status: "WaitingForSchedule" },
      updatedOn: "2026-01-09T18:00:00+00:00",
    },
  };
  const plan = parseYasno(body, "1.1")!;
  const d0 = Date.UTC(2026, 0, 9, 22, 0, 0); // північ 10.01 за Києвом
  assert.equal(plan.length, 2);
  assert.equal(plan[0].start, d0);
  assert.equal(plan[0].start, dayStart(d0 + H));
  assert.equal(plan[0].status, "applies");
  assert.equal(plan[0].updated, Date.UTC(2026, 0, 9, 18, 0, 0));
  // Сусідні проміжки одного типу склеєні; невідомий тип стає «можливим».
  assert.deepEqual(plan[0].slots, [
    { from: d0 + 6.5 * H, to: d0 + 10.5 * H, kind: "planned" },
    { from: d0 + 15.5 * H, to: d0 + 18.5 * H, kind: "planned" },
    { from: d0 + 18.5 * H, to: d0 + 19.5 * H, kind: "possible" },
  ]);
  assert.deepEqual(plan[1], { start: d0 + 24 * H, status: "waiting", slots: [], updated: plan[0].updated });
  assert.equal(planTotal(plan, d0), 8 * H);
  assert.equal(hours(7 * H), "7 год");
  assert.equal(hours(3.5 * H), "3,5 год");
  assert.deepEqual(planFor(plan, d0 + 24 * H), []); // графіка на завтра ще немає

  // Зіпсовані й чужі відповіді не ламають розбір.
  assert.equal(parseYasno(null, "1.1"), null);
  assert.equal(parseYasno("<html>", "1.1"), null);
  assert.equal(parseYasno(body, "2.1"), null);
  assert.equal(parseYasno({ "1.1": { today: { date: "не дата", slots: [] } } }, "1.1"), null);
  assert.equal(parseYasno({ "1.1": { today: { date: "2026-01-10T00:00:00+02:00", status: "Нове", slots: [{ start: 5, end: 3 }] } } }, "1.1")![0].status, "unknown");

  // Прогноз о 09:00: решта ранкового відключення й вечірнє.
  const nine = d0 + 9 * H;
  assert.deepEqual(forecastFor(plan, d0, nine).map(s => [s.from, s.to]), [
    [nine, d0 + 10.5 * H],
    [d0 + 15.5 * H, d0 + 18.5 * H],
    [d0 + 18.5 * H, d0 + 19.5 * H],
  ]);

  // Підказка: чотири поєднання графіка й факту.
  const state = (power: boolean, t: number): DeviceState => ({ power, since: t - H / 2, lastSeen: t - 5000, lost: false, rssi: null, uptime: null, fw: null });
  const say = (power: boolean, t: number) => planNote(plan, view(state(power, t), [], t));
  assert.equal(say(true, d0 + 13 * H), "За графіком наступне відключення о 15:30, до 18:30.");
  assert.equal(say(false, d0 + 9 * H), "Відключення за графіком: світло мають дати о 10:30.");
  assert.equal(say(true, d0 + 9 * H), "За графіком зараз відключення до 10:30, але світло є.");
  assert.equal(
    say(false, d0 + 13 * H),
    "Відключення поза графіком: за графіком світло зараз мало б бути. За графіком наступне відключення о 15:30, до 18:30.",
  );
  assert.equal(say(true, d0 + 22 * H), "За графіком відключень більше не заплановано.");
  // Відключення до півночі пишеться як «до 24:00»; через північ склеюється з завтрашнім.
  const late: typeof plan = [
    { start: d0, status: "applies", slots: [{ from: d0 + 21 * H, to: d0 + 24 * H, kind: "planned" }], updated: null },
    { start: d0 + 24 * H, status: "applies", slots: [{ from: d0 + 24 * H, to: d0 + 26 * H, kind: "planned" }], updated: null },
  ];
  assert.equal(planNote(late, view(state(true, d0 + 13 * H), [], d0 + 13 * H)), "За графіком наступне відключення о 21:00, до 02:00.");
  assert.equal(planNote([late[0]], view(state(true, d0 + 13 * H), [], d0 + 13 * H)), "За графіком наступне відключення о 21:00, до 24:00.");
  assert.equal(planNote(late, view(state(false, d0 + 23 * H), [], d0 + 23 * H)), "Відключення за графіком: світло мають дати завтра о 02:00.");
  // Немає графіка на сьогодні або плата ще нічого не надсилала.
  assert.equal(planNote([], view(state(true, d0 + H), [], d0 + H)), null);
  assert.equal(planNote([{ start: d0, status: "waiting", slots: [], updated: null }], view(state(true, d0 + H), [], d0 + H)), "Офіційного графіка на сьогодні ще немає.");
});

test("день по годинах: минуле — факт, майбутнє — графік, розбіжності рахуються", () => {
  const H = 3600_000;
  const d0 = Date.UTC(2026, 0, 9, 22, 0, 0); // північ 10.01 за Києвом
  const now = d0 + 13.25 * H;
  const row = {
    start: d0,
    end: d0 + 24 * H,
    on: 0,
    off: 0,
    segments: [
      { from: d0 + 5 * H, to: d0 + 7 * H, kind: "on" as const },
      { from: d0 + 7 * H, to: d0 + 8.5 * H, kind: "off" as const },
      { from: d0 + 8.5 * H, to: now, kind: "on" as const },
    ],
  };
  const plan = [
    {
      start: d0,
      status: "applies" as const,
      updated: null,
      slots: [
        { from: d0 + 6.5 * H, to: d0 + 10.5 * H, kind: "planned" as const },
        { from: d0 + 15.5 * H, to: d0 + 18.5 * H, kind: "planned" as const },
        { from: d0 + 18.5 * H, to: d0 + 19.5 * H, kind: "possible" as const },
      ],
    },
  ];
  const cells = hourCells(row, plan, now);
  assert.equal(cells.length, 24);
  const kinds = (i: number) => cells[i].parts.map(p => `${(p.from - d0) / H}-${(p.to - d0) / H} ${p.kind}`);
  assert.deepEqual(kinds(4), ["4-5 none"]); // ще не стежили
  assert.deepEqual(kinds(6), ["6-7 on"]);
  assert.equal(cells[6].mismatch, 0.5 * H); // за графіком з 06:30 мало не бути, а світло було
  assert.deepEqual(kinds(7), ["7-8 off"]);
  assert.equal(cells[7].mismatch, 0);
  assert.deepEqual(kinds(8), ["8-8.5 off", "8.5-9 on"]);
  assert.equal(cells[8].mismatch, 0.5 * H);
  assert.equal(cells[13].current, true);
  assert.deepEqual(kinds(13), ["13-13.25 on", "13.25-14 on"]); // факт і прогноз не склеюються
  assert.equal(cells[14].future, true);
  assert.deepEqual(kinds(15), ["15-15.5 on", "15.5-16 off"]);
  assert.deepEqual(kinds(19), ["19-19.5 maybe", "19.5-20 on"]);
  assert.deepEqual(kinds(22), ["22-23 on"]);
  assert.deepEqual(cells[15].planned.map(p => (p.from - d0) / H), [15.5]);
  // Світла не було поза графіком — теж розбіжність.
  const extra = hourCells({ ...row, segments: [{ from: d0 + 12 * H, to: d0 + 13 * H, kind: "off" as const }] }, plan, now);
  assert.equal(extra[12].mismatch, H);
  // Завтра графіка ще немає: усе «немає даних».
  const tomorrow = hourCells({ start: d0 + 24 * H, end: d0 + 48 * H, on: 0, off: 0, segments: [] }, [{ start: d0 + 24 * H, status: "waiting", slots: [], updated: null }], now);
  assert.ok(tomorrow.every(c => c.parts.length === 1 && c.parts[0].kind === "none" && !c.scheduled));
});

test("плашка графіка і попередження про розбіжність", () => {
  const H = 3600_000;
  const d0 = Date.UTC(2026, 0, 9, 22, 0, 0);
  const plan = [
    { start: d0, status: "applies" as const, updated: null, slots: [{ from: d0 + 6.5 * H, to: d0 + 10.5 * H, kind: "planned" as const }, { from: d0 + 21 * H, to: d0 + 24 * H, kind: "planned" as const }] },
    { start: d0 + 24 * H, status: "applies" as const, updated: null, slots: [{ from: d0 + 24 * H, to: d0 + 26 * H, kind: "planned" as const }] },
  ];
  const at = (power: boolean, h: number) => {
    const t = d0 + h * H;
    const st: DeviceState = { power, since: t - 600_000, lastSeen: t - 5000, lost: false, rssi: null, uptime: null, fw: null };
    return planPill(plan, view(st, [], t));
  };
  assert.deepEqual(at(true, 13), { kind: "on", text: "є світло до 21:00", warn: null });
  assert.deepEqual(at(false, 9), { kind: "off", text: "немає світла до 10:30", warn: null });
  assert.equal(at(false, 13)!.warn, "Відключення поза графіком.");
  assert.equal(at(true, 9)!.warn, "За графіком зараз відключення, але світло є.");
  assert.equal(at(false, 23)!.text, "немає світла до завтра 02:00");
  assert.equal(at(true, 5)!.text, "є світло до 06:30");
  // Можливе відключення: не «поза графіком» і не «без відключень».
  const maybePlan = [{ start: d0, status: "applies" as const, updated: null, slots: [{ from: d0 + 13 * H, to: d0 + 15 * H, kind: "possible" as const }] }];
  const t = d0 + 13.5 * H;
  const off: DeviceState = { power: false, since: t - 600_000, lastSeen: t - 5000, lost: false, rssi: null, uptime: null, fw: null };
  assert.deepEqual(planPill(maybePlan, view(off, [], t)), { kind: "none", text: "можливе відключення до 15:00", warn: null });
  assert.equal(planNote(maybePlan, view(off, [], t)), "Можливе відключення за графіком, до 15:00.");
});

test("заряд: інтерполяція і тренд із оцінкою часу", () => {
  const H = 3600_000;
  const line = { from: 0, to: 30, points: [{ t: 0, v: 100 }, { t: 10, v: 90 }, { t: 30, v: 90 }] };
  assert.equal(socInterp(line, 5), 95);
  assert.equal(socInterp(line, 20), 90);
  assert.equal(socInterp(line, 31), null);

  const now = Date.UTC(2026, 10, 15, 10, 0, 0);
  const st = (soc: number, power = false): DeviceState => ({ power, since: now - H, lastSeen: now - 5000, lost: false, rssi: null, uptime: null, fw: null, soc, socSeen: now - 5000 });
  const down = [{ t: now - 50 * 60_000, v: 90 }, { t: now - 30 * 60_000, v: 85 }, { t: now - 60_000, v: 80 }];
  const t1 = socTrend(down, view(st(80), [], now));
  assert.equal(t1.dir, "down");
  assert.ok(Math.abs(t1.eta! / 60_000 - 392) < 0.01); // 10% за 49 хв → 80% вистачить на 392 хв
  const t2 = socTrend([{ t: now - 40 * 60_000, v: 50 }, { t: now - 60_000, v: 70 }], view(st(70, true), [], now));
  assert.equal(t2.dir, "up");
  assert.ok(Math.abs(t2.eta! / 60_000 - 58.5) < 0.01);
  // Заряд давно не змінювався або станцію не чути — без тренду.
  assert.equal(socTrend([{ t: now - 50 * 60_000, v: 90 }, { t: now - 30 * 60_000, v: 80 }], view(st(80), [], now)).dir, "flat");
  assert.equal(socTrend(down, view({ ...st(80), socSeen: now - H }, [], now)).dir, "flat");
  // Заряджалася, а 5 хв тому світло зникло: заряд до відключення не рахується.
  const mixed = [{ t: now - 50 * 60_000, v: 60 }, { t: now - 35 * 60_000, v: 65 }, { t: now - 22 * 60_000, v: 70 }, { t: now - 60_000, v: 69 }];
  assert.equal(socTrend(mixed, view({ ...st(69), since: now - 5 * 60_000 }, [], now)).dir, "flat");
});
