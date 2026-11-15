import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, query } from "./_generated/server";
import { parseYasno, type PlanDay } from "./lib/logic";

// Офіційний графік відключень: відкритий API Yasno. Регіон, оператор і черга — змінні середовища
// деплоймента: YASNO_REGION (Київ — 25), YASNO_DSO (ДТЕК Київські електромережі — 902),
// YASNO_GROUP (наприклад, 3.1). Як знайти свою чергу за адресою — у README.
// API недокументований і стоїть за захистом від ботів: будь-яка несподівана відповідь — тихий пропуск,
// у базі лишається останній добрий графік.
const REGION = process.env.YASNO_REGION ?? "25";
const DSO = process.env.YASNO_DSO ?? "902";
const URL = `https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/${REGION}/dsos/${DSO}/planned-outages`;
const GROUP = process.env.YASNO_GROUP ?? "";
/** Скільки останніх діб графіка віддавати сторінці: тиждень назад, сьогодні й завтра. */
const DAYS = 10;

const slot = v.object({ from: v.number(), to: v.number(), kind: v.union(v.literal("planned"), v.literal("possible")) });
const status = v.union(v.literal("applies"), v.literal("waiting"), v.literal("none"), v.literal("emergency"), v.literal("unknown"));
const day = v.object({ start: v.number(), status, slots: v.array(slot), updated: v.union(v.number(), v.null()) });

/** Опитування за розкладом (convex/crons.ts). Повертає короткий підсумок для журналу. */
export const sync = internalAction({
  args: {},
  handler: async (ctx): Promise<string> => {
    if (!GROUP) return "Yasno: черга не задана (YASNO_GROUP)";
    let body: unknown;
    try {
      const res = await fetch(URL, { headers: { Accept: "application/json" } });
      if (!res.ok) return `Yasno: HTTP ${res.status}`;
      if (!(res.headers.get("content-type") ?? "").includes("json")) return "Yasno: відповідь не JSON";
      body = await res.json();
    } catch (e) {
      return `Yasno: ${e instanceof Error ? e.message : "помилка запиту"}`;
    }
    const days = parseYasno(body, GROUP);
    if (!days) return `Yasno: у відповіді немає черги ${GROUP}`;
    const changed: number = await ctx.runMutation(internal.schedule.save, { days });
    return `Yasno: черга ${GROUP}, діб ${days.length}, оновлено ${changed}`;
  },
});

/** Зберігає графік; пише в базу лише ті доби, де щось змінилося. Повертає кількість змінених діб. */
export const save = internalMutation({
  args: { days: v.array(day) },
  handler: async (ctx, { days }): Promise<number> => {
    let changed = 0;
    for (const d of days) {
      const old = await ctx.db
        .query("plan")
        .withIndex("by_start", q => q.eq("start", d.start))
        .first();
      if (!old) {
        await ctx.db.insert("plan", d);
        changed++;
        continue;
      }
      // «Графіка ще немає» або невідомий стан не затирає вже відомий графік цієї доби.
      if (d.status !== "applies" && d.status !== "emergency" && old.status === "applies") continue;
      const same = old.status === d.status && JSON.stringify(old.slots) === JSON.stringify(d.slots);
      if (same) continue;
      await ctx.db.replace(old._id, d);
      changed++;
    }
    return changed;
  },
});

/** Графік за останні доби у порядку зростання часу. Лише для користувача, що увійшов. */
/** Черга, за якою стежимо, для підпису на сторінці. Лише для користувача, що увійшов. */
export const group = query({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    if ((await getAuthUserId(ctx)) === null) throw new Error("Потрібен вхід");
    return GROUP || null;
  },
});

export const plan = query({
  args: {},
  handler: async (ctx): Promise<PlanDay[]> => {
    if ((await getAuthUserId(ctx)) === null) throw new Error("Потрібен вхід");
    const rows = await ctx.db.query("plan").withIndex("by_start").order("desc").take(DAYS);
    return rows.reverse().map(r => ({ start: r.start, status: r.status, slots: r.slots, updated: r.updated }));
  },
});
