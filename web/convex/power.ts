import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, query, type QueryCtx } from "./_generated/server";
import { applyReport, checkStale as staleEvent, type DeviceState, type PowerEvent, type SocSample } from "./lib/logic";

/** Скільки останніх подій віддавати сторінці. Події з'являються лише при зміні стану. */
const MAX_EVENTS = 300;
/** Скільки останніх записів заряду віддавати сторінці: з запасом на добу з повним розрядом і зарядом. */
const MAX_SOC_SAMPLES = 500;

const nullable = <T extends ReturnType<typeof v.number> | ReturnType<typeof v.string>>(x: T) => v.union(x, v.null());

/** Сигнал від плати. Викликається лише з HTTP-дії /report після перевірки ключа. */
export const report = internalMutation({
  args: {
    power: v.boolean(),
    rssi: nullable(v.number()),
    uptime: nullable(v.number()),
    fw: nullable(v.string()),
    ago: nullable(v.number()),
    soc: v.optional(nullable(v.number())),
    socAge: v.optional(nullable(v.number())),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.query("device").first();
    const state: DeviceState | null = doc ? strip(doc) : null;
    const { next, events, write, sample } = applyReport(state, args, Date.now());
    if (write) {
      if (doc) await ctx.db.replace(doc._id, next);
      else await ctx.db.insert("device", next);
    }
    for (const e of events) await ctx.db.insert("events", e);
    if (sample) await ctx.db.insert("socSamples", sample);
    else if (write && next.soc != null && !(await ctx.db.query("socSamples").first())) {
      // Перший запис історії: заряд уже відомий, але ще жодного разу не змінювався.
      await ctx.db.insert("socSamples", { t: next.socSeen ?? next.lastSeen, v: next.soc });
    }
    return next.power ? "on" : "off";
  },
});

/** Скільки зберігати історію: заряд станції — 30 днів, події світла — рік. */
const KEEP_SOC_MS = 30 * 24 * 3600 * 1000;
const KEEP_EVENTS_MS = 365 * 24 * 3600 * 1000;

/** Щоденне прибирання старої історії (convex/crons.ts). За раз не більше 500 записів із таблиці. */
export const prune = internalMutation({
  args: {},
  handler: async ctx => {
    const now = Date.now();
    const oldPlan = await ctx.db
      .query("plan")
      .withIndex("by_start", q => q.lt("start", now - KEEP_SOC_MS))
      .take(100);
    for (const row of oldPlan) await ctx.db.delete(row._id);
    // Клімат вдома й температура надворі зберігаються стільки ж, скільки заряд станції.
    for (const [table, keep] of [["socSamples", KEEP_SOC_MS], ["homeClimate", KEEP_SOC_MS], ["weatherSamples", KEEP_SOC_MS], ["events", KEEP_EVENTS_MS]] as const) {
      const old = await ctx.db
        .query(table)
        .withIndex("by_t", q => q.lt("t", now - keep))
        .take(500);
      for (const row of old) await ctx.db.delete(row._id);
    }
  },
});

/** Перевірка за розкладом (convex/crons.ts). */
export const checkStale = internalMutation({
  args: {},
  handler: async ctx => {
    const doc = await ctx.db.query("device").first();
    if (!doc) return;
    const event = staleEvent(strip(doc), Date.now());
    if (!event) return;
    await ctx.db.patch(doc._id, { lost: true });
    await ctx.db.insert("events", event);
  },
});

export async function requireUser(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Потрібен вхід");
}

/** Поточний стан плати. Лише для користувача, що увійшов. */
export const state = query({
  args: {},
  handler: async (ctx): Promise<DeviceState | null> => {
    await requireUser(ctx);
    const doc = await ctx.db.query("device").first();
    return doc ? strip(doc) : null;
  },
});

/** Останні події у порядку зростання часу. Лише для користувача, що увійшов. */
export const events = query({
  args: {},
  handler: async (ctx): Promise<PowerEvent[]> => {
    await requireUser(ctx);
    const rows = await ctx.db.query("events").withIndex("by_t").order("desc").take(MAX_EVENTS);
    return rows.reverse().map(r => ({ t: r.t, s: r.s }));
  },
});

/** Останні записи заряду станції у порядку зростання часу. Лише для користувача, що увійшов. */
export const soc = query({
  args: {},
  handler: async (ctx): Promise<SocSample[]> => {
    await requireUser(ctx);
    const rows = await ctx.db.query("socSamples").withIndex("by_t").order("desc").take(MAX_SOC_SAMPLES);
    return rows.reverse().map(r => ({ t: r.t, v: r.v }));
  },
});

/** Пошта користувача, що увійшов (для службового рядка внизу сторінки). */
export const me = query({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    return (await ctx.db.get(userId))?.email ?? null;
  },
});

function strip(doc: DeviceState & { _id: unknown; _creationTime: number }): DeviceState {
  const { power, since, lastSeen, lost, rssi, uptime, fw, soc, socSeen } = doc;
  return { power, since, lastSeen, lost, rssi, uptime, fw, ...(soc != null ? { soc, socSeen: socSeen ?? null } : {}) };
}
