import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { applyHome, type ClimateSample, type HomePublic, type HomeState } from "./lib/home";
import { requireUser } from "./power";

/** Скільки останніх записів клімату віддавати сторінці: доба з кроком 5 хв і запас. */
const MAX_CLIMATE = 320;

const nullable = <T extends ReturnType<typeof v.number> | ReturnType<typeof v.string>>(x: T) => v.union(x, v.null());

/** Звіт плати-читача хаба. Викликається лише з HTTP-дії /home після перевірки ключа. */
export const report = internalMutation({
  args: {
    kind: v.union(v.literal("full"), v.literal("delta")),
    boot: v.number(),
    seq: v.number(),
    uptime: nullable(v.number()),
    fw: nullable(v.string()),
    rssi: nullable(v.number()),
    hub: v.boolean(),
    temp: nullable(v.number()),
    hum: nullable(v.number()),
    rst: v.optional(nullable(v.number())),
    heap: v.optional(nullable(v.number())),
  },
  handler: async (ctx, args): Promise<{ full: boolean }> => {
    const doc = await ctx.db.query("homeHub").first();
    const state: HomeState | null = doc ? strip(doc) : null;
    const lastRow = await ctx.db.query("homeClimate").withIndex("by_t").order("desc").first();
    const last: ClimateSample | null = lastRow ? { t: lastRow.t, temp: lastRow.temp, hum: lastRow.hum } : null;
    const { next, sample, full, skip } = applyHome(state, args, last, Date.now());
    if (skip) return { full };
    if (doc) await ctx.db.replace(doc._id, next);
    else await ctx.db.insert("homeHub", next);
    if (sample) await ctx.db.insert("homeClimate", sample);
    return { full };
  },
});

/** Останні покази й стан плати-читача. Лише для користувача, що увійшов. */
export const state = query({
  args: {},
  handler: async (ctx): Promise<HomePublic | null> => {
    await requireUser(ctx);
    const doc = await ctx.db.query("homeHub").first();
    if (!doc) return null;
    const { lastSeen, hub, temp, hum, climateSeen, fw, bootAt, rst } = doc;
    return { lastSeen, hub, temp, hum, climateSeen, fw, bootAt: bootAt ?? null, rst: rst ?? null };
  },
});

/** Останні записи клімату в порядку зростання часу. Лише для користувача, що увійшов. */
export const climate = query({
  args: {},
  handler: async (ctx): Promise<ClimateSample[]> => {
    await requireUser(ctx);
    const rows = await ctx.db.query("homeClimate").withIndex("by_t").order("desc").take(MAX_CLIMATE);
    return rows.reverse().map(r => ({ t: r.t, temp: r.temp, hum: r.hum }));
  },
});

function strip(doc: HomeState & { _id: unknown; _creationTime: number }): HomeState {
  const { lastSeen, hub, boot, seq, rssi, uptime, fw, temp, hum, climateSeen, bootAt, rst, heapMin } = doc;
  return { lastSeen, hub, boot, seq, rssi, uptime, fw, temp, hum, climateSeen, bootAt: bootAt ?? null, rst: rst ?? null, heapMin: heapMin ?? null };
}
