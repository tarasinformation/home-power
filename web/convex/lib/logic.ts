// Чиста логіка станів монітора світла. Без Convex і без годинника: час завжди приходить
// аргументом, тому все тут перевіряється звичайним `node --test` (див. tests/logic.test.ts).
// Цей самий модуль використовують і бекенд (convex/power.ts), і сторінка (src/Status.tsx).

/** Після стількох мілісекунд без сигналу від плати — «немає зв'язку». */
export const STALE_MS = 5 * 60 * 1000;
/** Як часто оновлювати «останній сигнал» у базі, коли стан не змінився. */
export const WRITE_EVERY_MS = 50 * 1000;
export const HISTORY_DAYS = 7;

export type EventKind = "on" | "off" | "lost";
export type Status = EventKind | "unknown";

/** Поточний стан плати (один документ у таблиці `device`). */
export type DeviceState = {
  power: boolean;
  /** Відколи триває стан `power`. */
  since: number;
  /** Час останнього сигналу від плати. */
  lastSeen: number;
  /** Чи вже записано подію «зв'язок зник» для цієї паузи. */
  lost: boolean;
  rssi: number | null;
  uptime: number | null;
  fw: string | null;
  /** Заряд зарядної станції EcoFlow, %. Плата чує його з Bluetooth-оголошення станції. */
  soc?: number | null;
  /** Коли плата востаннє чула станцію. */
  socSeen?: number | null;
};

export type PowerEvent = { t: number; s: EventKind };

export type Report = {
  power: boolean;
  rssi: number | null;
  uptime: number | null;
  fw: string | null;
  /**
   * Скільки секунд тому світло зникло насправді (час першого невдалого ping).
   * Плата оголошує відключення лише після двох невдалих циклів, тож без цього поля
   * початок відключення записувався б із запізненням до хвилини.
   */
  ago: number | null;
  /** Заряд станції EcoFlow, % (0–100). Поля немає, якщо плата станцію не чує. */
  soc?: number | null;
  /** Скільки секунд тому плата чула станцію. */
  socAge?: number | null;
};

/**
 * Розбирає тіло запиту плати. Повертає текст помилки або очищений звіт.
 * Обов'язкове лише поле `power`; решта необов'язкова й обрізається до розумних меж.
 */
export function parseReport(body: unknown): Report | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Очікується об'єкт JSON";
  const b = body as Record<string, unknown>;
  if (typeof b.power !== "boolean") return 'Поле "power" має бути true або false';
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x) : null);
  const soc = num(b.soc);
  const socAge = num(b.socAge);
  const station = soc !== null && soc >= 0 && soc <= 100 ? { soc, socAge: socAge !== null && socAge > 0 ? socAge : 0 } : {};
  return {
    power: b.power,
    rssi: num(b.rssi),
    uptime: num(b.uptime),
    fw: typeof b.fw === "string" ? b.fw.slice(0, 32) : null,
    ago: b.power === false && typeof b.ago === "number" && b.ago > 0 ? num(b.ago) : null,
    ...station,
  };
}

/** Стан на момент `now`. Плата, що мовчить довше за STALE_MS, вважається втраченою. */
export function statusOf(state: DeviceState | null, now: number): Status {
  if (!state) return "unknown";
  if (state.lost || now - state.lastSeen > STALE_MS) return "lost";
  return state.power ? "on" : "off";
}

/**
 * Сигнал від плати. Повертає новий стан, події, які треба дописати, і чи варто
 * записувати стан у базу (без зміни стану пишемо не частіше, ніж раз на WRITE_EVERY_MS).
 */
export function applyReport(
  state: DeviceState | null,
  report: Report,
  now: number,
): { next: DeviceState; events: PowerEvent[]; write: boolean; sample: SocSample | null } {
  const prev = statusOf(state, now);
  const cur: EventKind = report.power ? "on" : "off";
  const events: PowerEvent[] = [];

  // Плата мовчала, а розклад ще не встиг це зафіксувати: дописуємо подію заднім числом.
  if (state && prev === "lost" && !state.lost) events.push({ t: state.lastSeen, s: "lost" });
  const changed = prev !== cur;
  // Початок відключення — заднім числом, якщо плата повідомила, коли зник перший ping.
  // Не раніше за останній сигнал зі світлом і не більше ніж на STALE_MS назад.
  const at =
    cur === "off" && report.ago !== null
      ? Math.max(now - Math.min(report.ago * 1000, STALE_MS), state?.lastSeen ?? 0)
      : now;
  if (changed) events.push({ t: at, s: cur });

  const next: DeviceState = {
    power: report.power,
    since: changed || !state ? at : state.since,
    lastSeen: now,
    lost: false,
    rssi: report.rssi,
    uptime: report.uptime,
    fw: report.fw,
  };
  // Заряд станції: якщо плата її зараз не чує, лишаємо останнє відоме значення з його часом.
  const heard = report.soc !== undefined && report.soc !== null;
  const soc = heard ? report.soc! : (state?.soc ?? null);
  const socSeen = heard ? now - (report.socAge ?? 0) * 1000 : (state?.socSeen ?? null);
  if (soc !== null) {
    next.soc = soc;
    next.socSeen = socSeen;
  }
  const write = changed || !state || now - state.lastSeen >= WRITE_EVERY_MS || soc !== (state.soc ?? null);
  // Історія заряду: запис лише тоді, коли почуте значення змінилося.
  const sample = heard && soc !== (state?.soc ?? null) ? { t: socSeen ?? now, v: soc! } : null;
  return { next, events, write, sample };
}

/**
 * Перевірка за розкладом. Якщо плата мовчить понад STALE_MS і це ще не зафіксовано,
 * повертає подію «зв'язок зник» з часом останнього сигналу. Інакше null.
 */
export function checkStale(state: DeviceState | null, now: number): PowerEvent | null {
  if (!state || state.lost || now - state.lastSeen <= STALE_MS) return null;
  return { t: state.lastSeen, s: "lost" };
}

export type Outage = { start: number; end: number | null; endedBy: EventKind | null };

export type View = {
  status: Status;
  since: number | null;
  lastSeen: number | null;
  rssi: number | null;
  fw: string | null;
  outages: Outage[];
  /** Сумарна тривалість відключень у вікні історії, мс. */
  total: number;
  now: number;
  /** Заряд станції EcoFlow і час, коли плата її чула. Немає, поки плата жодного разу її не почула. */
  soc?: number | null;
  socSeen?: number | null;
};

/**
 * Те, що показує сторінка. `events` — у порядку зростання часу.
 * Відключення — це інтервал від події "off" до наступної події будь-якого типу.
 */
export function view(state: DeviceState | null, events: PowerEvent[], now: number): View {
  if (!state) {
    return { status: "unknown", since: null, lastSeen: null, rssi: null, fw: null, outages: [], total: 0, now };
  }
  const status = statusOf(state, now);
  const since = status === "lost" ? state.lastSeen : state.since;

  const from = now - HISTORY_DAYS * 24 * 3600 * 1000;
  const outages: Outage[] = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].s !== "off") continue;
    const following = events[i + 1];
    // Без наступної події відключення або триває, або обірвалося разом зі зв'язком
    // (подію "lost" розклад ще не дописав).
    const end = following ? following.t : status === "off" ? null : state.lastSeen;
    const endedBy = following ? following.s : status === "lost" ? "lost" : null;
    if ((end ?? now) < from) continue;
    outages.push({ start: events[i].t, end, endedBy });
  }
  outages.reverse();
  const total = outages.reduce((sum, o) => sum + ((o.end ?? now) - o.start), 0);
  const station = state.soc != null ? { soc: state.soc, socSeen: state.socSeen ?? null } : {};
  return { status, since, lastSeen: state.lastSeen, rssi: state.rssi, fw: state.fw, outages, total, now, ...station };
}

/** Чи заряд станції свіжий: плата на зв'язку й чула станцію не пізніше ніж STALE_MS тому. */
export function stationFresh(v: View): boolean {
  const seen = v.socSeen ?? null;
  // Свіжість рахуємо від останнього сигналу плати: якщо мовчить плата, застарів і заряд.
  return v.soc != null && seen !== null && v.status !== "lost" && v.now - seen <= STALE_MS;
}

/** Рядок про зарядну станцію або null, якщо плата її ще не чула. */
export function stationNote(v: View): string | null {
  if (v.soc == null) return null;
  const seen = v.socSeen ?? null;
  const fresh = stationFresh(v);
  if (fresh) return `Зарядна станція: ${v.soc}%`;
  return `Зарядна станція: ${v.soc}% (дані від ${seen === null ? "невідомо коли" : time(seen)}, зараз станцію не чути)`;
}

// ---------- історія заряду станції ----------

/** Запис історії заряду: з моменту `t` заряд дорівнює `v` відсотків. */
export type SocSample = { t: number; v: number };
export const SOC_WINDOW_MS = 24 * 3600 * 1000;

export type SocLine = {
  from: number;
  to: number;
  /** Точки східчастої лінії: значення тримається до наступної точки. Остання точка — кінець лінії. */
  points: SocSample[];
};

/**
 * Лінія заряду за останні SOC_WINDOW_MS. `samples` — у порядку зростання часу.
 * Лінія закінчується там, де закінчуються дані: «зараз», якщо станцію чути, інакше час, коли її чули востаннє.
 */
export function socLine(samples: SocSample[], v: View): SocLine {
  const to = v.now;
  const from = to - SOC_WINDOW_MS;
  const end = stationFresh(v) ? to : Math.min(to, v.socSeen ?? 0);
  const points: SocSample[] = [];
  let before: SocSample | null = null;
  for (const s of samples) {
    if (s.t <= from) before = s;
    else if (s.t <= end) points.push(s);
  }
  if (before && end > from) points.unshift({ t: from, v: before.v });
  if (points.length && end > points[points.length - 1].t) points.push({ t: end, v: points[points.length - 1].v });
  return { from, to, points };
}

/** Заряд у момент `t` за лінією або null, якщо на цей час даних немає. */
export function socAt(line: SocLine, t: number): number | null {
  const p = line.points;
  if (!p.length || t < p[0].t || t > p[p.length - 1].t) return null;
  let value = p[0].v;
  for (const s of p) {
    if (s.t > t) break;
    value = s.v;
  }
  return value;
}

/** Позначки осі часу: кожні `stepHours` годин за київським часом у межах [from, to]. */
export function hourTicks(from: number, to: number, stepHours = 6): number[] {
  const ticks: number[] = [];
  for (let day = dayStart(from); day <= to; day = dayStart(day + 26 * HOUR)) {
    for (let h = 0; h < 24; h += stepHours) {
      const t = day + h * HOUR;
      if (t >= from && t <= to) ticks.push(t);
    }
  }
  return ticks;
}

// ---------- графік по днях ----------

export type SegKind = EventKind;
/** Проміжок часу з одним станом. */
export type Segment = { from: number; to: number; kind: SegKind };
/** Один календарний день за київським часом. Майбутня частина дня сегментів не має. */
/** `on` і `off`: скільки часу за цю добу світло було й не було (без проміжків «немає зв'язку» та без даних). */
export type DayRow = { start: number; end: number; segments: Segment[]; on: number; off: number };

const HOUR = 3600 * 1000;
const clockFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Kyiv",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function sinceMidnight(t: number): number {
  const p = Object.fromEntries(clockFmt.formatToParts(t).map(x => [x.type, Number(x.value)]));
  return ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 + (((t % 1000) + 1000) % 1000);
}

/** Положення моменту в добі за годинником на стіні (0…1): у дні переведення годинника шкала лишається 0–24. */
export function wallFrac(t: number, start: number, end: number): number {
  if (t <= start) return 0;
  if (t >= end) return 1;
  return sinceMidnight(t) / (24 * HOUR);
}

/** Початок київської доби, до якої належить момент `t`. Враховує переведення годинника. */
export function dayStart(t: number): number {
  let start = t - sinceMidnight(t);
  const rest = sinceMidnight(start); // не нуль лише в день переведення годинника
  if (rest !== 0) start += rest > 12 * HOUR ? 24 * HOUR - rest : -rest;
  return start;
}

/** Суцільна стрічка станів від першої події до «зараз». Час до першої події — без даних. */
export function intervals(state: DeviceState | null, events: PowerEvent[], now: number): Segment[] {
  if (!state) return [];
  const status = statusOf(state, now);
  const out: Segment[] = [];
  const push = (from: number, to: number, kind: SegKind) => {
    if (to > from) out.push({ from, to, kind });
  };
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const following = events[i + 1];
    if (following) push(e.t, following.t, e.s);
    else if (status === "lost" && e.s !== "lost") {
      // Плата замовкла, а подію «зв'язок зник» розклад ще не дописав.
      push(e.t, state.lastSeen, e.s);
      push(Math.max(e.t, state.lastSeen), now, "lost");
    } else push(e.t, now, e.s);
  }
  return out;
}

/** Останні `count` діб, сьогоднішня перша. */
export function days(state: DeviceState | null, events: PowerEvent[], now: number, count = HISTORY_DAYS): DayRow[] {
  const all = intervals(state, events, now);
  const rows: DayRow[] = [];
  let start = dayStart(now);
  for (let d = 0; d < count; d++) {
    const end = dayStart(start + 26 * HOUR);
    const segments = all
      .filter(s => s.to > start && s.from < end)
      .map(s => ({ from: Math.max(s.from, start), to: Math.min(s.to, end), kind: s.kind }));
    const total = (kind: SegKind) => segments.reduce((sum, s) => sum + (s.kind === kind ? s.to - s.from : 0), 0);
    rows.push({ start, end, segments, on: total("on"), off: total("off") });
    start = dayStart(start - 2 * HOUR);
  }
  return rows;
}

const dayFmt = new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", weekday: "short", day: "2-digit", month: "2-digit" });
const clockShort = new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" });

export function dayLabel(start: number, now: number): string {
  const today = dayStart(now);
  if (start === today) return "сьогодні";
  if (start === dayStart(today - 2 * HOUR)) return "вчора";
  if (start === dayStart(today + 26 * HOUR)) return "завтра";
  return dayFmt.format(start);
}

/** Година й хвилини; кінець доби пишемо як 24:00, а не 00:00 наступного дня. */
export function clock(t: number, dayEnd?: number): string {
  return t === dayEnd ? "24:00" : clockShort.format(t);
}

export const SEG_TITLES: Record<SegKind, string> = {
  on: "світло було",
  off: "світла не було",
  lost: "не було зв'язку з домом",
};

// ---------- офіційний графік відключень ----------

/** Чи застосовується графік цього дня. `waiting` — графіка ще не оприлюднено. */
export type PlanStatus = "applies" | "waiting" | "none" | "emergency" | "unknown";
/** Відключення за офіційним графіком. `possible` — можливе, а не гарантоване. */
export type PlanSlot = { from: number; to: number; kind: "planned" | "possible" };
/** Офіційний графік на одну київську добу; `start` — початок доби. */
export type PlanDay = { start: number; status: PlanStatus; slots: PlanSlot[]; updated: number | null };

const PLAN_STATUS: Record<string, PlanStatus> = {
  ScheduleApplies: "applies",
  NoOutages: "applies", // графік діє, відключень у ньому немає
  WaitingForSchedule: "waiting",
  EmergencyShutdowns: "emergency",
};

/**
 * Розбирає відповідь Yasno (`planned-outages`) для однієї черги, наприклад "3.1".
 * Повертає графік на сьогодні й завтра або null, якщо відповідь не схожа на очікувану.
 * Невідомі назви типів і станів не ламають розбір: тип стає «можливим відключенням», стан — «невідомим».
 */
export function parseYasno(body: unknown, group: string): PlanDay[] | null {
  if (typeof body !== "object" || body === null) return null;
  const entry = (body as Record<string, unknown>)[group];
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  const updated = typeof e.updatedOn === "string" && Number.isFinite(Date.parse(e.updatedOn)) ? Date.parse(e.updatedOn) : null;
  const out: PlanDay[] = [];
  for (const key of ["today", "tomorrow"]) {
    const d = e[key];
    if (typeof d !== "object" || d === null) continue;
    const day = d as Record<string, unknown>;
    const start = typeof day.date === "string" ? Date.parse(day.date) : NaN;
    if (!Number.isFinite(start)) continue;
    const slots: PlanSlot[] = [];
    for (const raw of Array.isArray(day.slots) ? day.slots : []) {
      const s = raw as Record<string, unknown>;
      if (typeof s?.start !== "number" || typeof s?.end !== "number" || !(s.end > s.start)) continue;
      if (s.start < 0 || s.end > 1440 || s.type === "NotPlanned") continue;
      const kind = s.type === "Definite" ? "planned" : "possible";
      const from = start + s.start * 60_000;
      const to = start + s.end * 60_000;
      const last = slots[slots.length - 1];
      if (last && last.kind === kind && last.to === from) last.to = to;
      else slots.push({ from, to, kind });
    }
    out.push({ start, status: PLAN_STATUS[String(day.status)] ?? "unknown", slots, updated });
  }
  return out.length ? out : null;
}

/** Проміжки графіка для доби, що починається в `start`. Порожньо, якщо графіка немає. */
export function planFor(plan: PlanDay[], start: number): PlanSlot[] {
  const day = plan.find(p => p.start === start);
  return day && day.status === "applies" ? day.slots : [];
}

/** Прогноз: те, що за графіком ще попереду (після `now`). */
export function forecastFor(plan: PlanDay[], start: number, now: number): PlanSlot[] {
  return planFor(plan, start)
    .filter(s => s.to > now)
    .map(s => ({ ...s, from: Math.max(s.from, now) }));
}

/** Сумарна тривалість відключень за графіком для доби, мс. */
export function planTotal(plan: PlanDay[], start: number): number {
  return planFor(plan, start).reduce((sum, s) => sum + (s.to - s.from), 0);
}

/** Проміжок графіка (будь-якого типу), що діє в момент `now`, або null. */
function slotNow(plan: PlanDay[], now: number): PlanSlot | null {
  for (const p of plan) {
    if (p.status !== "applies") continue;
    for (const s of p.slots) if (s.from <= now && now < s.to) return s;
  }
  return null;
}

/** Гарантовані відключення за графіком підряд, склеєні через північ. */
function plannedRuns(plan: PlanDay[]): { from: number; to: number }[] {
  const slots = plan
    .filter(p => p.status === "applies")
    .flatMap(p => p.slots.filter(s => s.kind === "planned"))
    .sort((a, b) => a.from - b.from);
  const runs: { from: number; to: number }[] = [];
  for (const s of slots) {
    const last = runs[runs.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else runs.push({ from: s.from, to: s.to });
  }
  return runs;
}

/** Час кінця проміжку: північ пишемо як 24:00, а не 00:00. */
function until(t: number): string {
  return t === dayStart(t) ? "24:00" : clock(t);
}

/** Тривалість за графіком у годинах: «7 год», «3,5 год». */
export function hours(ms: number): string {
  return `${(Math.round(ms / 360_000) / 10).toLocaleString("uk-UA")} год`;
}

/** «о 18:00», «завтра о 08:00»; північ пишемо як 24:00 того ж дня. */
function at(t: number, now: number): string {
  const today = dayStart(now);
  const day = dayStart(t);
  if (day === today) return `о ${clock(t)}`;
  if (t === day && dayStart(t - 1) === today) return "о 24:00";
  return `${dayLabel(day, now)} о ${clock(t)}`;
}

/** Один рядок під статусом: що каже офіційний графік і чи збігається він із тим, що є насправді. */
export function planNote(plan: PlanDay[], v: View): string | null {
  const today = plan.find(p => p.start === dayStart(v.now));
  if (!today) return null;
  if (today.status === "waiting") return "Офіційного графіка на сьогодні ще немає.";
  if (today.status === "emergency") return "Діють екстрені відключення: офіційний графік не застосовується.";
  if (today.status === "unknown") return null;
  const runs = plannedRuns(plan);
  const cur = runs.find(r => r.from <= v.now && v.now < r.to);
  const next = runs.find(r => r.from > v.now);
  const nextText = next
    ? `За графіком наступне відключення ${at(next.from, v.now)}, до ${until(next.to)}.`
    : "За графіком відключень більше не заплановано.";
  if (v.status === "off") {
    const slot = slotNow(plan, v.now);
    if (cur) return `Відключення за графіком: світло мають дати ${at(cur.to, v.now)}.`;
    if (slot) return `Можливе відключення за графіком, до ${until(slot.to)}.`;
    return `Відключення поза графіком: за графіком світло зараз мало б бути. ${nextText}`;
  }
  if (v.status === "on") {
    return cur ? `За графіком зараз відключення до ${until(cur.to)}, але світло є.` : nextText;
  }
  return cur ? `За графіком зараз відключення, світло мають дати ${at(cur.to, v.now)}.` : nextText;
}

// ---------- день по годинах ----------

export type CellKind = "on" | "off" | "lost" | "maybe" | "none";
export type CellPart = { from: number; to: number; kind: CellKind };
/**
 * Одна година дня. Минуле (до `now`) — як було насправді, майбутнє — за офіційним графіком.
 * `mismatch` — скільки мілісекунд минулого не збіглося з графіком.
 */
export type HourCell = {
  from: number;
  to: number;
  parts: CellPart[];
  planned: PlanSlot[];
  scheduled: boolean;
  mismatch: number;
  current: boolean;
  future: boolean;
};

function overlap(a: number, b: number, list: { from: number; to: number }[]): number {
  return list.reduce((sum, p) => sum + Math.max(0, Math.min(b, p.to) - Math.max(a, p.from)), 0);
}

export function hourCells(row: DayRow, plan: PlanDay[], now: number): HourCell[] {
  const day = plan.find(p => p.start === row.start);
  const scheduled = day?.status === "applies";
  const slots = scheduled ? day!.slots : [];
  const cells: HourCell[] = [];
  for (let from = row.start; from < row.end; from += HOUR) {
    const to = Math.min(from + HOUR, row.end);
    const parts: CellPart[] = [];
    const push = (a: number, b: number, kind: CellKind) => {
      if (b <= a) return;
      const last = parts[parts.length - 1];
      // Факт і прогноз не склеюємо: межа «зараз» лишається видимою в даних.
      if (last && last.kind === kind && last.to === a && a !== now) last.to = b;
      else parts.push({ from: a, to: b, kind });
    };
    // Минуле: що було насправді.
    const pastEnd = Math.min(to, now);
    let t = from;
    for (const s of row.segments) {
      if (s.to <= from || s.from >= pastEnd) continue;
      const a = Math.max(s.from, from);
      const b = Math.min(s.to, pastEnd);
      push(t, a, "none");
      push(a, b, s.kind);
      t = b;
    }
    push(t, pastEnd, "none");
    // Розбіжність із графіком рахуємо лише для минулого.
    let mismatch = 0;
    if (scheduled) {
      for (const p of parts) {
        if (p.kind === "off") mismatch += p.to - p.from - overlap(p.from, p.to, slots);
        if (p.kind === "on") mismatch += overlap(p.from, p.to, slots.filter(x => x.kind === "planned"));
      }
    }
    // Майбутнє: прогноз за графіком.
    const futureStart = Math.max(from, now);
    if (futureStart < to) {
      let u = futureStart;
      for (const p of slots) {
        if (p.to <= futureStart || p.from >= to) continue;
        const a = Math.max(p.from, futureStart);
        const b = Math.min(p.to, to);
        push(u, a, "on");
        push(a, b, p.kind === "planned" ? "off" : "maybe");
        u = b;
      }
      push(u, to, scheduled ? "on" : "none");
    }
    const planned = slots
      .filter(p => p.to > from && p.from < to)
      .map(p => ({ ...p, from: Math.max(p.from, from), to: Math.min(p.to, to) }));
    cells.push({ from, to, parts, planned, scheduled, mismatch, current: from <= now && now < to, future: from >= now });
  }
  return cells;
}

/** Коротко про час: «18:00», «24:00», «завтра 08:00». */
function atShort(t: number, now: number): string {
  const today = dayStart(now);
  const day = dayStart(t);
  if (day === today) return clock(t);
  if (t === day && dayStart(t - 1) === today) return "24:00";
  return `${dayLabel(day, now)} ${clock(t)}`;
}

/** Плашка під статусом: що каже графік зараз, і попередження, якщо факт із ним розходиться. */
export function planPill(plan: PlanDay[], v: View): { kind: "on" | "off" | "none"; text: string; warn: string | null } | null {
  const today = plan.find(p => p.start === dayStart(v.now));
  if (!today || today.status === "unknown") return null;
  if (today.status === "waiting") return { kind: "none", text: "графіка ще немає", warn: null };
  if (today.status === "emergency") {
    return { kind: "off", text: "екстрені відключення", warn: "Діють екстрені відключення: графік не застосовується." };
  }
  const runs = plannedRuns(plan);
  const cur = runs.find(r => r.from <= v.now && v.now < r.to);
  const next = runs.find(r => r.from > v.now);
  const slot = slotNow(plan, v.now);
  const maybe = !cur && slot?.kind === "possible" ? slot : null;
  const text = cur
    ? `немає світла до ${atShort(cur.to, v.now)}`
    : maybe
      ? `можливе відключення до ${atShort(maybe.to, v.now)}`
      : next
        ? `є світло до ${atShort(next.from, v.now)}`
        : "без відключень";
  let warn: string | null = null;
  if (v.status === "off" && !cur && !slot) warn = "Відключення поза графіком.";
  if (v.status === "on" && cur) warn = "За графіком зараз відключення, але світло є.";
  return { kind: cur ? "off" : maybe ? "none" : "on", text, warn };
}

/** Заряд у момент `t`: лінійно між точками лінії. */
export function socInterp(line: SocLine, t: number): number | null {
  const p = line.points;
  if (!p.length || t < p[0].t || t > p[p.length - 1].t) return null;
  for (let i = 1; i < p.length; i++) {
    if (t <= p[i].t) {
      const a = p[i - 1];
      const b = p[i];
      const k = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      return Math.round(a.v + (b.v - a.v) * k);
    }
  }
  return p[p.length - 1].v;
}

export type SocTrend = { dir: "up" | "down" | "flat"; eta: number | null };

/** Куди рухається заряд за останню годину і скільки лишилося до розряду чи до повного заряду. */
export function socTrend(samples: SocSample[], v: View): SocTrend {
  const flat: SocTrend = { dir: "flat", eta: null };
  if (v.soc == null || !stationFresh(v)) return flat;
  // Лише записи після останньої зміни стану світла: інакше заряд до відключення видасть себе за заряджання під час нього.
  const since = Math.max(v.now - HOUR, v.since ?? 0);
  const recent = samples.filter(s => s.t >= since);
  const last = samples[samples.length - 1];
  if (!last || last.t < since || v.now - last.t > 20 * 60_000 || recent.length < 2) return flat;
  const first = recent[0];
  const dv = last.v - first.v;
  const dt = last.t - first.t;
  if (Math.abs(dv) < 2 || dt < 5 * 60_000) return flat;
  const rate = dv / dt;
  if (rate < 0) return { dir: "down", eta: v.soc / -rate };
  return { dir: "up", eta: v.soc >= 100 ? null : (100 - v.soc) / rate };
}

// ---------- тексти ----------

const fmtTime = new Intl.DateTimeFormat("uk-UA", {
  timeZone: "Europe/Kyiv",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export const time = (t: number) => fmtTime.format(t);

export function dur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "менше хвилини";
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const min = m % 60;
  return [d && `${d} д`, h && `${h} год`, min && `${min} хв`].filter(Boolean).join(" ");
}

export const TITLES: Record<Status, string> = {
  on: "Світло є",
  off: "Світла немає",
  lost: "Немає зв'язку з домом",
  unknown: "Ще немає даних",
};

export function note(v: View): string {
  if (v.status === "unknown" || v.since === null) return "Плата ще не надіслала жодного сигналу";
  if (v.status === "lost") {
    return `останній сигнал ${time(v.since)}, ${dur(v.now - v.since)} тому. Зник інтернет або резервне живлення`;
  }
  return `з ${time(v.since)}, уже ${dur(v.now - v.since)}`;
}

/** Пошта дозволена для реєстрації? `allowed` — перелік через кому з ALLOWED_EMAILS. */
export function emailAllowed(email: string, allowed: string | undefined): boolean {
  const list = (allowed ?? "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}
