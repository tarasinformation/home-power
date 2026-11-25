import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export default defineSchema({
  // Користувачі, сесії й облікові записи входу (@convex-dev/auth).
  ...authTables,

  /** Поточний стан плати. У таблиці рівно один документ. Поля описано в lib/logic.ts. */
  device: defineTable({
    power: v.boolean(),
    since: v.number(),
    lastSeen: v.number(),
    lost: v.boolean(),
    rssi: v.union(v.number(), v.null()),
    uptime: v.union(v.number(), v.null()),
    fw: v.union(v.string(), v.null()),
    // Заряд станції EcoFlow (%) і час, коли плата її чула. Необов'язкові: старі документи їх не мають.
    soc: v.optional(v.union(v.number(), v.null())),
    socSeen: v.optional(v.union(v.number(), v.null())),
  }),

  /** Журнал змін стану: запис з'являється лише тоді, коли стан змінився. */
  events: defineTable({
    t: v.number(),
    s: v.union(v.literal("on"), v.literal("off"), v.literal("lost")),
  }).index("by_t", ["t"]),

  /** Офіційний графік відключень по днях (Yasno). Один документ на київську добу; `start` — її початок. */
  plan: defineTable({
    start: v.number(),
    status: v.union(v.literal("applies"), v.literal("waiting"), v.literal("none"), v.literal("emergency"), v.literal("unknown")),
    slots: v.array(v.object({ from: v.number(), to: v.number(), kind: v.union(v.literal("planned"), v.literal("possible")) })),
    updated: v.union(v.number(), v.null()),
  }).index("by_start", ["start"]),

  /** Історія заряду станції EcoFlow: запис з'являється, коли заряд змінився. */
  socSamples: defineTable({
    t: v.number(),
    v: v.number(),
  }).index("by_t", ["t"]),

  /** Стан плати-читача хаба й останні покази клімату. У таблиці рівно один документ. Поля описано в lib/home.ts. */
  homeHub: defineTable({
    lastSeen: v.number(),
    hub: v.boolean(),
    boot: v.number(),
    seq: v.number(),
    rssi: v.union(v.number(), v.null()),
    uptime: v.union(v.number(), v.null()),
    fw: v.union(v.string(), v.null()),
    temp: v.union(v.number(), v.null()),
    hum: v.union(v.number(), v.null()),
    climateSeen: v.union(v.number(), v.null()),
  }),

  /** Історія температури (°C) й вологості (%) вдома: запис при зміні, але не рідше ніж раз на 15 хв. */
  homeClimate: defineTable({
    t: v.number(),
    temp: v.number(),
    hum: v.union(v.number(), v.null()),
  }).index("by_t", ["t"]),

  /** Поточна погода надворі (Open-Meteo). У таблиці рівно один документ. Поля описано в lib/home.ts. */
  weatherNow: defineTable({
    t: v.number(),
    temp: v.number(),
    feels: v.union(v.number(), v.null()),
    hum: v.union(v.number(), v.null()),
    wind: v.union(v.number(), v.null()),
    precip: v.union(v.number(), v.null()),
    code: v.union(v.number(), v.null()),
  }),

  /** Історія температури надворі, °C: запис раз на 15 хв. */
  weatherSamples: defineTable({
    t: v.number(),
    temp: v.number(),
  }).index("by_t", ["t"]),
});
