import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import { parseReport } from "./lib/logic";
import { HOME_MAX_BODY, parseHome } from "./lib/home";

const http = httpRouter();

// Кінцеві точки входу (/api/auth/*).
auth.addHttpRoutes(http);

/**
 * Сигнал від плати ESP32.
 *
 *   curl -X POST https://<назва>.convex.site/report \
 *     -H "Authorization: Bearer $DEVICE_TOKEN" -H "Content-Type: application/json" \
 *     -d '{"power":true,"rssi":-55,"uptime":120,"fw":"0.2"}'
 *
 * Для «світла немає» плата додає "ago": скільки секунд тому зник перший ping.
 *
 * DEVICE_TOKEN — змінна середовища деплоймента Convex. У коді й у репозиторії її немає.
 */
http.route({
  path: "/report",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.DEVICE_TOKEN;
    if (!expected) return text("DEVICE_TOKEN не налаштовано", 503);
    if (!(await sameSecret(bearer(request), expected))) return text("Unauthorized", 401);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return text("Некоректний JSON", 400);
    }
    const report = parseReport(body);
    if (typeof report === "string") return text(report, 400);

    const state = await ctx.runMutation(internal.power.report, report);
    return Response.json({ ok: true, state }, { headers: { "Cache-Control": "no-store" } });
  }),
});

/**
 * Звіт плати-читача хаба: покази датчиків розумного дому (поки зберігається лише клімат).
 *
 *   curl -X POST https://<назва>.convex.site/home \
 *     -H "Authorization: Bearer $HOME_TOKEN" -H "Content-Type: application/json" \
 *     -d '{"v":1,"kind":"full","boot":1,"seq":1,"hub":true,"d":[{"k":"temp","temp":2380},{"k":"hum","hum":4500}]}'
 *
 * Значення сирі, як у Matter: температура й вологість у сотих. HOME_TOKEN — окрема змінна
 * середовища, не ключ монітора світла: поки її не задано, маршрут відповідає 503.
 * У відповіді `full: true` означає «надішли повний знімок»; більше нічого плата від сервера не приймає.
 */
http.route({
  path: "/home",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.HOME_TOKEN;
    if (!expected) return text("HOME_TOKEN не налаштовано", 503);
    if (!(await sameSecret(bearer(request), expected))) return text("Unauthorized", 401);

    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > HOME_MAX_BODY) return text("Завеликий звіт", 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return text("Некоректний JSON", 400);
    }
    const report = parseHome(body);
    if (typeof report === "string") return text(report, 400);

    const { full } = await ctx.runMutation(internal.home.report, report);
    return Response.json({ ok: true, full }, { headers: { "Cache-Control": "no-store" } });
  }),
});

/** Ключ із заголовка `Authorization: Bearer …` або порожній рядок. */
function bearer(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Порівняння секретів, стійке до атак за часом: порівнюються хеші SHA-256 однакової
 * довжини, і цикл завжди проходить усі байти, де б не трапилася розбіжність.
 */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

export default http;
