// Сторінка статусу на вигаданих даних: без входу й без бекенда, лише для розробки.
// Відкривається під `npm run dev` за адресою /dev/preview.html; у зібраний сайт не потрапляє.
// Варіанти: ?case=silent (плата-читач мовчить), ?case=nohub (не чує хаб), ?case=few (мало даних),
// ?case=none (плати-читача ще немає), ?case=noweather (без погоди надворі).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StatusView } from "../src/Status";
import { days, intervals, view, type DeviceState, type PowerEvent, type SocSample } from "../convex/lib/logic";
import type { ClimateSample, HomePublic, OutdoorSample, WeatherNow } from "../convex/lib/home";
import "../src/index.css";

const H = 3600_000;
const MIN = 60_000;
const now = Date.now();
const kind = new URLSearchParams(location.search).get("case");

const outage = { from: now - 9 * H, to: now - 5.5 * H };
const events: PowerEvent[] = [
  { t: now - 30 * H, s: "on" },
  { t: outage.from, s: "off" },
  { t: outage.to, s: "on" },
];
const state: DeviceState = { power: true, since: outage.to, lastSeen: now - 20_000, lost: false, rssi: -62, uptime: 90_000, fw: "0.6.1", soc: 84, socSeen: now - 20_000 };
const soc: SocSample[] = [
  { t: now - 26 * H, v: 100 },
  { t: outage.from + 40 * MIN, v: 97 },
  { t: outage.from + 100 * MIN, v: 93 },
  { t: outage.from + 160 * MIN, v: 89 },
  { t: outage.to, v: 86 },
  { t: outage.to + 3 * H, v: 84 },
];

/** Вигадана температура: добова хвиля, охолодження без світла, повільне прогрівання після. */
function tempAt(t: number): number {
  const wave = 0.8 * Math.sin(((t / H) % 24) * (Math.PI / 12));
  const cold = t < outage.from ? 0 : t < outage.to ? ((t - outage.from) / (outage.to - outage.from)) * 2.6 : Math.max(0, 2.6 - ((t - outage.to) / (3 * H)) * 2.6);
  return Math.round((22.6 + wave - cold) * 10) / 10;
}
const climate: ClimateSample[] = [];
if (kind !== "none") {
  const start = kind === "few" ? now - 20 * MIN : now - 26 * H;
  for (let t = start; t <= now - 2 * MIN; t += 10 * MIN) {
    if (t > now - 16 * H && t < now - 14 * H) continue; // дві години без даних
    climate.push({ t, temp: tempAt(t), hum: 44 + Math.round(3 * Math.sin(t / (5 * H))) });
  }
  if (kind === "few") climate.length = 1;
}
const lastSample = climate[climate.length - 1];
const seen = kind === "silent" ? now - 3 * H : now - MIN;
const home: HomePublic | null = lastSample
  ? { lastSeen: seen, hub: kind !== "nohub", temp: tempAt(seen), hum: 45, climateSeen: kind === "nohub" ? now - 50 * MIN : seen, fw: "0.2.0", bootAt: now - 30 * H, rst: 1 }
  : null;
const shown = kind === "silent" ? climate.filter(s => s.t <= seen) : kind === "nohub" ? climate.filter(s => s.t <= now - 50 * MIN) : climate;

/** Вигадана температура надворі: мороз уночі, близько нуля вдень. */
function outAt(t: number): number {
  return Math.round((-1.5 + 3.2 * Math.sin((((t / H) % 24) - 9) * (Math.PI / 12))) * 10) / 10;
}
const outdoorSamples: OutdoorSample[] = [];
for (let t = now - 26 * H; t <= now - 5 * MIN; t += 15 * MIN) outdoorSamples.push({ t, temp: outAt(t) });
const weather: WeatherNow | null =
  kind === "noweather" ? null : { t: now - 4 * MIN, temp: outAt(now), feels: outAt(now) - 3.9, hum: 80, wind: 2.6, precip: 0.3, code: 71 };

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StatusView
      v={view(state, events, now)}
      rows={days(state, events, now)}
      samples={soc}
      outages={intervals(state, events, now)}
      plan={[]}
      group={null}
      who="перегляд на вигаданих даних"
      home={home}
      climate={shown}
      outdoor={{ weather, samples: weather ? outdoorSamples : [], place: weather ? "Київ" : null }}
      onSignOut={() => {}}
    />
  </StrictMode>,
);
