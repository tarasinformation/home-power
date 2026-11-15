import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import { parseReport } from "./lib/logic";

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
    const header = request.headers.get("Authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!(await sameSecret(given, expected))) return text("Unauthorized", 401);

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
