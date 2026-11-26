// Чиста логіка клімату вдома: покази датчика температури й вологості, які надсилає
// плата-читач хаба (окрема плата, маршрут POST /home). Без Convex і без годинника:
// час завжди приходить аргументом, тож усе тут перевіряється `node --test` (tests/home.test.ts).
// Модуль використовують і бекенд (convex/home.ts), і сторінка (src/Climate.tsx).
// Свідомо без імпортів: його підключають і Convex, і Vite, і тести.

/** Плата-читач шле повний знімок кожні 5 хв. Після стількох мілісекунд тиші — «мовчить». */
export const HOME_STALE_MS = 12 * 60 * 1000;
/** Найбільший розмір тіла звіту, байтів. */
export const HOME_MAX_BODY = 4096;
export const CLIMATE_WINDOW_MS = 24 * 3600 * 1000;
/** Довша пауза між сусідніми записами лишається на графіку порожньою: даних не було. */
export const CLIMATE_GAP_MS = 40 * 60 * 1000;

/** Запис в історію не частіше, ніж раз на стільки, якщо зміна дрібна. */
const SAMPLE_MIN_MS = 4.5 * 60 * 1000;
/** І не рідше, ніж раз на стільки, навіть без змін: інакше рівна температура виглядала б як пропуск. */
const SAMPLE_MAX_MS = 15 * 60 * 1000;
/** Зміна, яку записуємо одразу. */
const JUMP_TEMP = 0.5;
const JUMP_HUM = 3;
const MIN_SPAN_MS = 3 * 3600 * 1000;

/** Очищений звіт плати-читача. З пристроїв хаба поки беремо лише клімат. */
export type HomeReport = {
  /** `full` — повний знімок, `delta` — лише змінене. */
  kind: "full" | "delta";
  /** Випадкове число, яке плата обирає при старті, і номер звіту після старту: захист від повторів. */
  boot: number;
  seq: number;
  uptime: number | null;
  fw: string | null;
  rssi: number | null;
  /** Чи має плата живу підписку на хаб. */
  hub: boolean;
  /** Температура, °C з кроком 0,1, і вологість, цілі відсотки. null — у звіті немає. */
  temp: number | null;
  hum: number | null;
  /** Діагностика: причина останнього перезапуску плати (код esp_reset_reason) і найменша вільна пам'ять, байтів. */
  rst?: number | null;
  heap?: number | null;
};

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Розбирає тіло звіту (контракт v1). Повертає текст помилки або очищений звіт.
 * Значення пристроїв сирі, як у Matter: температура й вологість у сотих.
 * Записи інших типів (вікна, замок, батареї) поки пропускаються.
 */
export function parseHome(body: unknown): HomeReport | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Очікується об'єкт JSON";
  const b = body as Record<string, unknown>;
  if (b.v !== 1) return 'Підтримується лише "v": 1';
  if (b.kind !== "full" && b.kind !== "delta") return 'Поле "kind" має бути "full" або "delta"';
  const count = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= Number.MAX_SAFE_INTEGER ? x : null);
  const boot = count(b.boot);
  const seq = count(b.seq);
  if (boot === null || seq === null) return 'Поля "boot" і "seq" мають бути невід\'ємними цілими числами';
  if (typeof b.hub !== "boolean") return 'Поле "hub" має бути true або false';
  if (!Array.isArray(b.d) || b.d.length > 64) return 'Поле "d" має бути списком до 64 записів';

  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x) : null);
  let temp: number | null = null;
  let hum: number | null = null;
  for (const raw of b.d) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    // Якщо датчиків кілька, береться перший у списку.
    if (e.k === "temp" && temp === null && typeof e.temp === "number" && e.temp >= -4000 && e.temp <= 8000) {
      temp = round1(e.temp / 100);
    }
    if (e.k === "hum" && hum === null && typeof e.hum === "number" && e.hum >= 0 && e.hum <= 10000) {
      hum = Math.round(e.hum / 100);
    }
  }
  return {
    kind: b.kind,
    boot,
    seq,
    uptime: num(b.uptime),
    fw: typeof b.fw === "string" ? b.fw.slice(0, 32) : null,
    rssi: num(b.rssi),
    hub: b.hub,
    temp,
    hum,
    rst: count(b.rst) !== null && count(b.rst)! <= 32 ? count(b.rst) : null,
    heap: count(b.heap),
  };
}

/** Те, що сторінці треба знати про плату-читач і останні покази. */
export type HomePublic = {
  /** Час останнього звіту плати. */
  lastSeen: number;
  hub: boolean;
  /** Останні відомі покази і час, коли плата їх передала. */
  temp: number | null;
  hum: number | null;
  climateSeen: number | null;
  /** Версія прошивки плати. */
  fw: string | null;
  /** Коли плата востаннє запустилась (за її лічильником часу роботи) і з якої причини. */
  bootAt?: number | null;
  rst?: number | null;
};

/** Стан плати-читача (один документ у таблиці `homeHub`). */
export type HomeState = HomePublic & {
  boot: number;
  seq: number;
  rssi: number | null;
  uptime: number | null;
  /** Найменша вільна пам'ять плати від її запуску, байтів. */
  heapMin?: number | null;
};

/** Причини перезапуску, які означають збій, а не ввімкнення чи оновлення: паніка, сторожові таймери, просідання живлення. */
export function crashed(rst: number | null | undefined): boolean {
  return rst === 4 || rst === 5 || rst === 6 || rst === 7 || rst === 9;
}

/** Запис історії клімату. */
export type ClimateSample = { t: number; temp: number; hum: number | null };

/**
 * Звіт плати-читача. Повертає новий стан, запис для історії (або null) і прапорець `full`:
 * сервер просить повний знімок, якщо отримав `delta`, а попередніх звітів цього запуску не бачив.
 * `skip` — повтор уже прийнятого звіту, нічого не змінюємо.
 */
export function applyHome(
  state: HomeState | null,
  report: HomeReport,
  last: ClimateSample | null,
  now: number,
): { next: HomeState; sample: ClimateSample | null; full: boolean; skip: boolean } {
  if (state && report.boot === state.boot && report.seq <= state.seq) {
    return { next: state, sample: null, full: false, skip: true };
  }
  const full = report.kind === "delta" && (!state || report.boot !== state.boot || report.seq !== state.seq + 1);
  // Без підписки на хаб плата нових показів не має: лишаємо останні відомі з їхнім часом.
  const heard = report.hub && (report.temp !== null || report.hum !== null);
  const temp = heard && report.temp !== null ? report.temp : (state?.temp ?? null);
  const hum = heard && report.hum !== null ? report.hum : (state?.hum ?? null);
  const next: HomeState = {
    lastSeen: now,
    hub: report.hub,
    boot: report.boot,
    seq: report.seq,
    rssi: report.rssi,
    uptime: report.uptime,
    fw: report.fw,
    temp,
    hum,
    climateSeen: heard ? now : (state?.climateSeen ?? null),
    // Новий запуск плати видно зі зміни `boot`; його час рахуємо назад від лічильника роботи.
    bootAt: state && state.boot === report.boot && state.bootAt != null ? state.bootAt : now - (report.uptime ?? 0) * 1000,
    rst: report.rst ?? null,
    heapMin: report.heap ?? null,
  };
  let sample: ClimateSample | null = null;
  if (heard && temp !== null) {
    const age = last ? now - last.t : Infinity;
    const dTemp = last ? Math.abs(temp - last.temp) : Infinity;
    const dHum = last && last.hum !== null && hum !== null ? Math.abs(hum - last.hum) : last?.hum === hum ? 0 : Infinity;
    const jump = dTemp >= JUMP_TEMP || dHum >= JUMP_HUM;
    const changed = dTemp > 0 || dHum > 0;
    if (jump || (changed && age >= SAMPLE_MIN_MS) || age >= SAMPLE_MAX_MS) sample = { t: now, temp, hum };
  }
  return { next, sample, full, skip: false };
}

/** Чому покази несвіжі: плата мовчить, плата не чує хаб або датчик давно не оновлювався. */
export type ClimateIssue = "silent" | "nohub" | "old";

export type ClimateView = {
  temp: number;
  hum: number | null;
  /** Коли плата востаннє передала покази. */
  seen: number;
  lastSeen: number;
  issue: ClimateIssue | null;
};

/** Картка температури або null, якщо показів ще не було. */
export function climateView(home: HomePublic | null, now: number): ClimateView | null {
  if (!home || home.temp === null || home.climateSeen === null) return null;
  const issue: ClimateIssue | null =
    now - home.lastSeen > HOME_STALE_MS ? "silent" : !home.hub ? "nohub" : now - home.climateSeen > HOME_STALE_MS ? "old" : null;
  return { temp: home.temp, hum: home.hum, seen: home.climateSeen, lastSeen: home.lastSeen, issue };
}

export type ClimatePoint = { t: number; v: number };
export type ClimateLine = {
  from: number;
  to: number;
  /** Суцільні відрізки лінії. Між відрізками даних не було. */
  runs: ClimatePoint[][];
  min: number;
  max: number;
};

/**
 * Лінія температури за останню добу (або з першого запису, але не менше трьох годин).
 * `samples` — у порядку зростання часу. Свіжі покази дотягують лінію до «зараз».
 */
export function climateLine(samples: ClimateSample[], view: ClimateView | null, now: number): ClimateLine | null {
  const windowStart = now - CLIMATE_WINDOW_MS;
  let before: ClimateSample | null = null;
  const inside: ClimatePoint[] = [];
  for (const s of samples) {
    if (s.t <= windowStart) before = s;
    else if (s.t <= now) inside.push({ t: s.t, v: s.temp });
  }
  const fresh = view !== null && view.issue === null;
  if (!inside.length && !fresh) return null;
  const first = inside[0]?.t ?? now;
  // Історія довша за добу — показуємо рівно добу; коротша — від першого запису.
  const span = before ? CLIMATE_WINDOW_MS : Math.min(CLIMATE_WINDOW_MS, Math.max(MIN_SPAN_MS, now - first));
  const from = now - span;
  const pts = inside.filter(p => p.t >= from);
  // Запис перед вікном дає значення на лівому краї, якщо до першої точки у вікні немає розриву.
  if (before && pts.length && pts[0].t - before.t <= CLIMATE_GAP_MS && pts[0].t > from) {
    const k = (from - before.t) / (pts[0].t - before.t);
    pts.unshift({ t: from, v: round1(before.temp + (pts[0].v - before.temp) * k) });
  }
  if (fresh && (!pts.length || now > pts[pts.length - 1].t)) pts.push({ t: now, v: view.temp });
  const runs: ClimatePoint[][] = [];
  for (const p of pts) {
    const run = runs[runs.length - 1];
    if (run && p.t - run[run.length - 1].t <= CLIMATE_GAP_MS) run.push(p);
    else runs.push([p]);
  }
  if (!runs.length) return null;
  const values = pts.map(p => p.v);
  return { from, to: now, runs, min: Math.min(...values), max: Math.max(...values) };
}

/**
 * Значення в момент `t`: лінійно між сусідніми точками відрізка. У розриві — null.
 * `exact` — без округлення до десятих (для положення точки на згладженій лінії).
 */
export function valueAt(runs: ClimatePoint[][], t: number, exact = false): number | null {
  for (const run of runs) {
    if (t < run[0].t || t > run[run.length - 1].t) continue;
    for (let i = 1; i < run.length; i++) {
      if (t <= run[i].t) {
        const a = run[i - 1];
        const b = run[i];
        const k = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
        const v = a.v + (b.v - a.v) * k;
        return exact ? v : round1(v);
      }
    }
    return run[0].v;
  }
  return null;
}

/** Температура вдома в момент `t` за лінією. У розриві — null. */
export function climateAt(line: ClimateLine, t: number): number | null {
  return valueAt(line.runs, t);
}

/**
 * Вертикальна шкала: цілі градуси з запасом навколо даних, щонайменше 4° заввишки,
 * три позначки (низ, середина, верх).
 * `tight` — щільна шкала для графіка з двома осями, де кожна лінія має власну: без запасу
 * (межі — найближчі цілі градуси), найменша висота 2°, а зайвий градус для парної висоти додається
 * з того боку, де до даних ближче. Так і невеликі коливання температури вдома добре видно.
 */
export function tempScale(min: number, max: number, tight = false): { lo: number; hi: number; ticks: number[] } {
  const pad = tight ? 0 : 0.5;
  const least = tight ? 2 : 4;
  let lo = Math.floor(min - pad);
  let hi = Math.ceil(max + pad);
  while (hi - lo < least) {
    hi++;
    if (hi - lo < least) lo--;
  }
  if ((hi - lo) % 2) {
    if (tight && min - lo < hi - max) lo--;
    else hi++;
  }
  return { lo, hi, ticks: [lo, (lo + hi) / 2, hi] };
}

// ---------- усереднення лінії для показу ----------

/** Крок рівної сітки, на яку перекладається лінія перед усередненням. */
export const SMOOTH_STEP_MS = 5 * 60 * 1000;
/** Ширина усереднення (сигма гаусового вікна). */
export const SMOOTH_SIGMA_MS = 25 * 60 * 1000;

/**
 * Усереднена лінія для малювання: кожен відрізок перекладається на рівну сітку й згладжується
 * гаусовим вікном. Вікно симетричне і звужується до країв відрізка, тому лінія не запізнюється,
 * а її початок і кінець (зокрема «зараз») лишаються точними. Значення не виходять за межі вихідних.
 * Точні покази лишаються у вихідних відрізках: їх показує підказка.
 */
export function smoothRuns(runs: ClimatePoint[][], step = SMOOTH_STEP_MS, sigma = SMOOTH_SIGMA_MS): ClimatePoint[][] {
  return runs.map(run => {
    const t0 = run[0].t;
    const t1 = run[run.length - 1].t;
    if (run.length < 3 || t1 <= t0) return run;
    const n = Math.max(1, Math.ceil((t1 - t0) / step));
    const dt = (t1 - t0) / n;
    const raw: number[] = [];
    let j = 1;
    for (let k = 0; k <= n; k++) {
      const t = k === n ? t1 : t0 + k * dt;
      while (j < run.length - 1 && run[j].t < t) j++;
      const a = run[j - 1];
      const b = run[j];
      raw.push(a.v + (b.v - a.v) * (b.t === a.t ? 1 : (t - a.t) / (b.t - a.t)));
    }
    const reach = Math.max(1, Math.round((3 * sigma) / dt));
    return raw.map((value, k) => {
      const t = k === n ? t1 : t0 + k * dt;
      const w = Math.min(reach, k, n - k);
      if (w === 0) return { t, v: value };
      const s = w / 3;
      let sum = 0;
      let weight = 0;
      for (let i = -w; i <= w; i++) {
        const g = Math.exp(-(i * i) / (2 * s * s));
        sum += g * raw[k + i];
        weight += g;
      }
      return { t, v: sum / weight };
    });
  });
}

// ---------- шкала графіка температури ----------

/** Смуга шкали: свій відрізок градусів зі своїми позначками. `who` — чия лінія в ній лежить. */
export type TempBand = { lo: number; hi: number; ticks: number[]; who: "home" | "out" | "both" };
/** Шкала графіка: одна смуга або дві з розривом між ними, знизу вгору (холодніша перша). */
export type TempAxis = { bands: TempBand[] };
/** Розрив роблять, лише якщо між шкалами дому й вулиці пропущено щонайменше стільки градусів. */
export const AXIS_BREAK_MIN = 4;

/**
 * Шкала для графіка «вдома + надворі». Вона одна й зростає знизу вгору, тому холодніша лінія завжди
 * нижче, а перетнутися лінії можуть лише там, де температури збіглися. Коли вдома й надворі різняться
 * сильно, порожню середину шкали вирізано: лишаються дві смуги (кожна підібрана під свою лінію)
 * з розривом між ними. Коли діапазони близькі або перекриваються — одна спільна смуга.
 * Без погоди — звичайна шкала для однієї лінії.
 */
export function tempAxis(home: { min: number; max: number }, out: { min: number; max: number } | null): TempAxis {
  if (!out) return { bands: [{ ...tempScale(home.min, home.max), who: "home" }] };
  const h: TempBand = { ...tempScale(home.min, home.max, true), who: "home" };
  const o: TempBand = { ...tempScale(out.min, out.max, true), who: "out" };
  const [cold, warm] = o.lo <= h.lo ? [o, h] : [h, o];
  if (warm.lo - cold.hi >= AXIS_BREAK_MIN) return { bands: [cold, warm] };
  return { bands: [{ ...tempScale(Math.min(home.min, out.min), Math.max(home.max, out.max), true), who: "both" }] };
}

/**
 * Висота значення над низом графіка в пікселях. `bandH` — висота однієї смуги, `gapH` — розриву.
 * Функція строго зростає: значення в розриві лягають у розрив, нижчі за шкалу — нижче за неї.
 */
export function axisY(axis: TempAxis, v: number, bandH: number, gapH: number): number {
  const { bands } = axis;
  let base = 0;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (v <= b.hi || i === bands.length - 1) {
      if (i > 0 && v < b.lo) {
        const prev = bands[i - 1];
        return base - gapH + ((v - prev.hi) / (b.lo - prev.hi)) * gapH;
      }
      return base + ((v - b.lo) / (b.hi - b.lo)) * bandH;
    }
    base += bandH + gapH;
  }
  return base;
}

/** «23,8»: температура з однією цифрою після коми. */
export function deg(v: number): string {
  // Справжній знак мінус замість дефіса: «−0,2», а не «-0,2».
  return v.toLocaleString("uk-UA", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).replace("-", "−");
}

// ---------- погода надворі ----------
// Джерело — відкритий API Open-Meteo (без ключа), його опитує бекенд за розкладом (convex/weather.ts).

/** Довша пауза між записами температури надворі лишається на графіку порожньою. */
export const OUTDOOR_GAP_MS = 100 * 60 * 1000;
/** Поточна погода старша за це вважається застарілою. */
export const WEATHER_STALE_MS = 90 * 60 * 1000;

/** Запис історії температури надворі, °C. */
export type OutdoorSample = { t: number; temp: number };

/** Поточна погода. `t` — час, на який її порахувало джерело. */
export type WeatherNow = {
  t: number;
  temp: number;
  /** «Відчувається як», °C. */
  feels: number | null;
  /** Відносна вологість, %. */
  hum: number | null;
  /** Вітер, м/с. */
  wind: number | null;
  /** Опади за останній проміжок, мм. */
  precip: number | null;
  /** Код погоди WMO. */
  code: number | null;
};

/**
 * Розбирає відповідь Open-Meteo (current + hourly, час у секундах Unix).
 * Повертає null, якщо відповідь не схожа на очікувану; погодинні значення без температури пропускає.
 */
export function parseOpenMeteo(body: unknown): { now: WeatherNow; hourly: OutdoorSample[] } | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const cur = b.current as Record<string, unknown> | undefined;
  if (typeof cur !== "object" || cur === null) return null;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const time = num(cur.time);
  const temp = num(cur.temperature_2m);
  if (time === null || temp === null || temp < -90 || temp > 70) return null;
  const now: WeatherNow = {
    t: time * 1000,
    temp: round1(temp),
    feels: num(cur.apparent_temperature) === null ? null : round1(num(cur.apparent_temperature)!),
    hum: num(cur.relative_humidity_2m) === null ? null : Math.round(num(cur.relative_humidity_2m)!),
    wind: num(cur.wind_speed_10m) === null ? null : round1(num(cur.wind_speed_10m)!),
    precip: num(cur.precipitation) === null ? null : round1(num(cur.precipitation)!),
    code: num(cur.weather_code) === null ? null : Math.round(num(cur.weather_code)!),
  };
  const hourly: OutdoorSample[] = [];
  const h = b.hourly as Record<string, unknown> | undefined;
  if (typeof h === "object" && h !== null && Array.isArray(h.time) && Array.isArray(h.temperature_2m)) {
    for (let i = 0; i < h.time.length && i < h.temperature_2m.length; i++) {
      const t = num(h.time[i]);
      const v = num(h.temperature_2m[i]);
      if (t !== null && v !== null) hourly.push({ t: t * 1000, temp: round1(v) });
    }
  }
  return { now, hourly };
}

const WEATHER_TEXT: Record<number, string> = {
  0: "ясно",
  1: "переважно ясно",
  2: "мінлива хмарність",
  3: "хмарно",
  45: "туман",
  48: "туман з памороззю",
  51: "слабка мряка",
  53: "мряка",
  55: "сильна мряка",
  56: "крижана мряка",
  57: "крижана мряка",
  61: "невеликий дощ",
  63: "дощ",
  65: "сильний дощ",
  66: "крижаний дощ",
  67: "крижаний дощ",
  71: "невеликий сніг",
  73: "сніг",
  75: "сильний сніг",
  77: "снігова крупа",
  80: "короткочасний дощ",
  81: "злива",
  82: "сильна злива",
  85: "снігопад",
  86: "сильний снігопад",
  95: "гроза",
  96: "гроза з градом",
  99: "гроза з градом",
};

/** Погода словами за кодом WMO або null, якщо код невідомий. */
export function weatherText(code: number | null): string | null {
  return code === null ? null : (WEATHER_TEXT[code] ?? null);
}

/** Чи поточна погода свіжа. */
export function weatherFresh(w: WeatherNow | null, now: number): boolean {
  return w !== null && now - w.t <= WEATHER_STALE_MS;
}

/**
 * Лінія температури надворі для вікна [from, to] (те саме вікно, що в лінії «вдома»).
 * `samples` — у порядку зростання часу. Свіжа поточна погода дотягує лінію до `to`.
 */
export function outdoorLine(
  samples: OutdoorSample[],
  weather: WeatherNow | null,
  from: number,
  to: number,
): { runs: ClimatePoint[][]; min: number; max: number } | null {
  let before: OutdoorSample | null = null;
  const pts: ClimatePoint[] = [];
  for (const s of samples) {
    if (s.t < from) before = s;
    else if (s.t <= to) pts.push({ t: s.t, v: s.temp });
  }
  if (before && pts.length && pts[0].t - before.t <= OUTDOOR_GAP_MS && pts[0].t > from) {
    const k = (from - before.t) / (pts[0].t - before.t);
    pts.unshift({ t: from, v: round1(before.temp + (pts[0].v - before.temp) * k) });
  }
  if (weather && weatherFresh(weather, to) && (!pts.length || to > pts[pts.length - 1].t)) pts.push({ t: to, v: weather.temp });
  const runs: ClimatePoint[][] = [];
  for (const p of pts) {
    const run = runs[runs.length - 1];
    if (run && p.t - run[run.length - 1].t <= OUTDOOR_GAP_MS) run.push(p);
    else runs.push([p]);
  }
  if (!runs.length) return null;
  const values = pts.map(p => p.v);
  return { runs, min: Math.min(...values), max: Math.max(...values) };
}
