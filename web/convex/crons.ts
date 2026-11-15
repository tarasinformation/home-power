import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Кожні 5 хвилин: якщо плата мовчить понад 5 хвилин, записати подію «зв'язок зник»
// (час події — останній сигнал плати, тож рідший розклад точності не шкодить).
// Сторінка показує «немає зв'язку» й без цього (рахує сама за часом останнього сигналу),
// але подія в журналі закриває відключення, під час якого зник і зв'язок.
crons.interval("check-stale", { minutes: 5 }, internal.power.checkStale);

// Кожні 20 хвилин: забрати офіційний графік відключень. Запис у базу лише коли він змінився.
crons.interval("sync-schedule", { minutes: 20 }, internal.schedule.sync);

// Раз на добу: прибрати стару історію, щоб база й читання не росли без меж.
crons.daily("prune-history", { hourUTC: 2, minuteUTC: 30 }, internal.power.prune);

export default crons;
