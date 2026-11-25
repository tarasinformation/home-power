import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, query } from "./_generated/server";
import { parseOpenMeteo, type OutdoorSample, type WeatherNow } from "./lib/home";
import { requireUser } from "./power";

// Погода надворі: відкритий API Open-Meteo (без ключа, дані за ліцензією CC BY 4.0).
// Місце — змінні середовища деплоймента: WEATHER_LAT і WEATHER_LON (за замовчуванням центр Києва),
// WEATHER_PLACE — підпис на сторінці. WEATHER_LAT=off вимикає опитування.
const LAT = process.env.WEATHER_LAT ?? "50.45";
const LON = process.env.WEATHER_LON ?? "30.52";
const PLACE = process.env.WEATHER_PLACE ?? "Київ";
const URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(LAT)}&longitude=${encodeURIComponent(LON)}` +
  "&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m" +
  "&hourly=temperature_2m&past_days=1&forecast_days=1&wind_speed_unit=ms&timeformat=unixtime&timezone=GMT";

/** Скільки останніх записів віддавати сторінці: доба з кроком 15 хв і запас. */
const MAX_SAMPLES = 130;
/** Новий запис історії не частіше, ніж раз на стільки. */
const SAMPLE_EVERY_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;

const nullable = v.union(v.number(), v.null());
const nowShape = v.object({ t: v.number(), temp: v.number(), feels: nullable, hum: nullable, wind: nullable, precip: nullable, code: nullable });

/** Опитування за розкладом (convex/crons.ts). Повертає короткий підсумок для журналу. */
export const sync = internalAction({
  args: {},
  handler: async (ctx): Promise<string> => {
    if (LAT === "off") return "Погода: вимкнено (WEATHER_LAT=off)";
    let body: unknown;
    try {
      const res = await fetch(URL, { headers: { Accept: "application/json" } });
      if (!res.ok) return `Погода: HTTP ${res.status}`;
      body = await res.json();
    } catch (e) {
      return `Погода: ${e instanceof Error ? e.message : "помилка запиту"}`;
    }
    const parsed = parseOpenMeteo(body);
    if (!parsed) return "Погода: відповідь не розібрано";
    const added: number = await ctx.runMutation(internal.weather.save, parsed);
    return `Погода: ${parsed.now.temp} °C, записів додано ${added}`;
  },
});

/**
 * Зберігає поточну погоду й дописує історію температури. Якщо історії ще немає,
 * заповнює останню добу погодинними значеннями з тієї ж відповіді.
 */
export const save = internalMutation({
  args: { now: nowShape, hourly: v.array(v.object({ t: v.number(), temp: v.number() })) },
  handler: async (ctx, { now, hourly }): Promise<number> => {
    const doc = await ctx.db.query("weatherNow").first();
    if (doc) await ctx.db.replace(doc._id, now);
    else await ctx.db.insert("weatherNow", now);

    let added = 0;
    let last = await ctx.db.query("weatherSamples").withIndex("by_t").order("desc").first();
    if (!last) {
      for (const h of hourly) {
        if (h.t > now.t - DAY_MS - 3600_000 && h.t < now.t) {
          await ctx.db.insert("weatherSamples", h);
          added++;
        }
      }
      last = await ctx.db.query("weatherSamples").withIndex("by_t").order("desc").first();
    }
    if (!last || now.t - last.t >= SAMPLE_EVERY_MS) {
      await ctx.db.insert("weatherSamples", { t: now.t, temp: now.temp });
      added++;
    }
    return added;
  },
});

/** Поточна погода й назва місця. Лише для користувача, що увійшов. */
export const now = query({
  args: {},
  handler: async (ctx): Promise<{ weather: WeatherNow; place: string } | null> => {
    await requireUser(ctx);
    const doc = await ctx.db.query("weatherNow").first();
    if (!doc) return null;
    const { t, temp, feels, hum, wind, precip, code } = doc;
    return { weather: { t, temp, feels, hum, wind, precip, code }, place: PLACE };
  },
});

/** Останні записи температури надворі у порядку зростання часу. Лише для користувача, що увійшов. */
export const samples = query({
  args: {},
  handler: async (ctx): Promise<OutdoorSample[]> => {
    await requireUser(ctx);
    const rows = await ctx.db.query("weatherSamples").withIndex("by_t").order("desc").take(MAX_SAMPLES);
    return rows.reverse().map(r => ({ t: r.t, temp: r.temp }));
  },
});
