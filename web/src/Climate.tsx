import { useCallback, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { clock, dayStart, hourTicks, time, type Segment } from "../convex/lib/logic";
import {
  CLIMATE_WINDOW_MS,
  climateLine,
  climateView,
  deg,
  outdoorLine,
  tempScale,
  valueAt,
  weatherFresh,
  weatherText,
  type ClimateLine,
  type ClimatePoint,
  type ClimateSample,
  type ClimateView,
  type HomePublic,
  type OutdoorSample,
  type WeatherNow,
} from "../convex/lib/home";

const H = 3600_000;
const PAD = { l: 36, r: 14, t: 14, b: 28 };
/** Правий відступ, коли праворуч стоїть друга шкала (надворі). */
const PAD_R_AXIS = 38;
const PH = 120;

/** Погода надворі для картки: поточні значення, історія температури й назва місця. */
export type Outdoor = { weather: WeatherNow | null; samples: OutdoorSample[]; place: string | null };

function staleNote(c: ClimateView): string | null {
  if (c.issue === "silent") return `плата-читач мовчить з ${time(c.lastSeen)}`;
  if (c.issue === "nohub") return `плата не чує хаб, покази від ${time(c.seen)}`;
  if (c.issue === "old") return `датчик не оновлювався з ${time(c.seen)}`;
  return null;
}

/** Позначка шкали: цілі градуси зі справжнім мінусом. */
function tick(v: number): string {
  return `${String(v).replace("-", "−")}°`;
}

/** «21,9…22,4°» або «22,0°», якщо значення не змінювалось. */
function range(min: number, max: number): string {
  return min === max ? `${deg(min)}°` : `${deg(min)}…${deg(max)}°`;
}

/**
 * Температура вдома: поточні покази, вологість і лінія за останню добу з відключеннями позаду.
 * Якщо бекенд збирає погоду, на тому самому графіку — температура надворі з власною шкалою праворуч
 * (вдома й надворі різняться на десятки градусів, на спільній шкалі обидві лінії були б майже прямі)
 * та поточна погода.
 * Нічого не малює, поки плата-читач хаба не передала жодного показу.
 */
export function Climate({
  home,
  samples,
  outages,
  now,
  outdoor,
}: {
  home: HomePublic | null;
  samples: ClimateSample[];
  outages: Segment[];
  now: number;
  outdoor: Outdoor;
}) {
  const [w, setW] = useState(0);
  const [at, setAt] = useState<number | null>(null);
  const ro = useRef<ResizeObserver | null>(null);
  const measure = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    setW(el.clientWidth);
    ro.current = new ResizeObserver(() => setW(el.clientWidth));
    ro.current.observe(el);
  }, []);

  const c = climateView(home, now);
  if (!c) return null;
  const stale = staleNote(c);
  const line = climateLine(samples, c, now);
  const points = line ? line.runs.reduce((n, r) => n + r.length, 0) : 0;
  const weather = outdoor.weather;

  return (
    <section className={`card climate${stale ? " stale" : ""}`} style={{ "--d": 4 } as CSSProperties} aria-label="Температура вдома">
      <div className="station-row">
        <div>
          <p className="eyebrow">Температура вдома</p>
          <p className="station-value">
            <span className="num" key={c.temp}>
              {deg(c.temp)}
            </span>
            <span className="pct">°C</span>
          </p>
        </div>
        {c.hum !== null && (
          <div className="climate-hum">
            <p className="eyebrow">Вологість</p>
            <p className="climate-hum-value">
              {c.hum}
              <span>%</span>
            </p>
          </div>
        )}
      </div>
      {stale && <p className="station-sub">{stale}</p>}
      {weather && <OutdoorNow weather={weather} place={outdoor.place} now={now} />}
      {line && points >= 2 ? (
        <Plot line={line} outdoor={outdoor} outages={outages} now={now} w={w} at={at} setAt={setAt} measure={measure} temp={c.temp} />
      ) : (
        <p className="hint climate-empty">Для графіка даних поки мало.</p>
      )}
      {weather && (
        <p className="climate-credit">
          Погода: <a href="https://open-meteo.com/">Open-Meteo</a>
        </p>
      )}
    </section>
  );
}

/** Рядок про погоду надворі: температура, стан словами й подробиці. */
function OutdoorNow({ weather, place, now }: { weather: WeatherNow; place: string | null; now: number }) {
  const fresh = weatherFresh(weather, now);
  const text = weatherText(weather.code);
  const details = [
    weather.feels !== null && `відчувається як ${deg(weather.feels)}°`,
    weather.wind !== null && `вітер ${deg(weather.wind)} м/с`,
    weather.hum !== null && `вологість ${weather.hum}%`,
    weather.precip !== null && weather.precip > 0 && `опади ${deg(weather.precip)} мм`,
  ].filter(Boolean);
  return (
    <div className={`climate-out${fresh ? "" : " stale"}`}>
      <p className="eyebrow">Надворі{place ? ` · ${place}` : ""}</p>
      <p className="climate-out-main">
        <b>{deg(weather.temp)}°</b>
        {text && <span>{text}</span>}
      </p>
      <p className="climate-out-details">{fresh ? details.join(" · ") : `дані від ${time(weather.t)}`}</p>
    </div>
  );
}

function path(run: ClimatePoint[], x: (t: number) => number, y: (v: number) => number): string {
  return run.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
}

function Plot({
  line,
  outdoor,
  outages,
  now,
  w,
  at,
  setAt,
  measure,
  temp,
}: {
  line: ClimateLine;
  outdoor: Outdoor;
  outages: Segment[];
  now: number;
  w: number;
  at: number | null;
  setAt: (t: number | null) => void;
  measure: (el: HTMLDivElement | null) => void;
  temp: number;
}) {
  const { from } = line;
  const span = line.to - from;
  const out = outdoorLine(outdoor.samples, outdoor.weather, from, line.to);
  // Дві шкали градусів на одному графіку: ліворуч — вдома, праворуч — надворі. Кожна підібрана під свою
  // лінію, тому висота ліній і місця, де вони перетинаються, нічого не означають: порівнювати можна
  // лише форму й час змін. Обидві шкали мають по три позначки на тих самих висотах, тож сітка одна.
  const scale = tempScale(line.min, line.max, out !== null);
  const outScale = out ? tempScale(out.min, out.max, true) : null;
  const padR = out ? PAD_R_AXIS : PAD.r;
  const iw = Math.max(1, w - PAD.l - padR);
  const x = (t: number) => PAD.l + ((t - from) / span) * iw;
  const y = (v: number) => PAD.t + PH - ((v - scale.lo) / (scale.hi - scale.lo)) * PH;
  const yOut = (v: number) => (outScale ? PAD.t + PH - ((v - outScale.lo) / (outScale.hi - outScale.lo)) * PH : 0);
  const step = span <= 6 * H ? 1 : span <= 12 * H ? 3 : 6;
  const ticks = hourTicks(from, now, step);
  const bands = outages
    .filter(s => s.kind === "off" && s.to > from && s.from < now)
    .map(s => ({ a: Math.max(s.from, from), b: Math.min(s.to, now) }));
  const first = line.runs[0][0].t;
  const period = span >= CLIMATE_WINDOW_MS - 60_000 ? "за 24 години" : `з ${dayStart(first) === dayStart(now) ? clock(first) : time(first)}`;
  const lastRun = line.runs[line.runs.length - 1];
  const last = lastRun[lastRun.length - 1];
  const outLastRun = out ? out.runs[out.runs.length - 1] : null;
  const outLast = outLastRun ? outLastRun[outLastRun.length - 1] : null;
  const value = at === null ? null : valueAt(line.runs, at);
  const outValue = at === null || !out ? null : valueAt(out.runs, at);

  function move(e: PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const part = (e.clientX - r.left - PAD.l) / iw;
    setAt(from + Math.max(0, Math.min(1, part)) * span);
  }

  const tip = [
    at === null ? "" : clock(at),
    value !== null ? (out ? `вдома ${deg(value)}°` : `${deg(value)}°`) : null,
    outValue !== null ? `надворі ${deg(outValue)}°` : null,
    value === null && outValue === null ? "немає даних" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const tipW = Math.min(iw, 24 + tip.length * 7.4);
  const tipX = at === null ? 0 : Math.max(PAD.l, Math.min(PAD.l + iw - tipW, x(at) - tipW / 2));
  const label =
    `Температура ${period}: вдома зараз ${deg(temp)}°, від ${deg(line.min)}° до ${deg(line.max)}°` +
    (out ? `; надворі від ${deg(out.min)}° до ${deg(out.max)}°; у кожної лінії своя шкала` : "");

  return (
    <>
      <p className="climate-range">
        <span>{period}</span>
        {!out && (
          <span>
            від {deg(line.min)}° до {deg(line.max)}°
          </span>
        )}
      </p>
      <div
        className="soc-plot"
        ref={measure}
        onPointerDown={move}
        onPointerMove={move}
        onPointerLeave={() => setAt(null)}
        onPointerCancel={() => setAt(null)}
      >
        {w > 0 && (
          <svg width={w} height={PAD.t + PH + PAD.b} role="img" aria-label={label}>
            <defs>
              <linearGradient id="temp-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" style={{ stopColor: "var(--accent)", stopOpacity: 0.28 }} />
                <stop offset="1" style={{ stopColor: "var(--accent)", stopOpacity: 0 }} />
              </linearGradient>
            </defs>
            {bands.map(b => (
              <rect key={b.a} className="soc-band" x={x(b.a)} y={PAD.t} width={Math.max(2, x(b.b) - x(b.a))} height={PH} rx={3} />
            ))}
            {scale.ticks.map(g => (
              <g key={g}>
                <line className="soc-grid" x1={PAD.l} x2={PAD.l + iw} y1={y(g)} y2={y(g)} />
                <text className="soc-axis" x={PAD.l - 8} y={y(g) + 4} textAnchor="end">
                  {tick(g)}
                </text>
              </g>
            ))}
            {outScale && (
              <>
                {/* Кольорові рейки вздовж осей: яка шкала чия. Підписи лишаються звичайним кольором тексту. */}
                <line className="axis-rail axis-rail-home" x1={PAD.l - 3} x2={PAD.l - 3} y1={PAD.t} y2={PAD.t + PH} />
                <line className="axis-rail axis-rail-out" x1={PAD.l + iw + 3} x2={PAD.l + iw + 3} y1={PAD.t} y2={PAD.t + PH} />
                {outScale.ticks.map(g => (
                  <text key={g} className="soc-axis" x={PAD.l + iw + 9} y={yOut(g) + 4} textAnchor="start">
                    {tick(g)}
                  </text>
                ))}
              </>
            )}
            {ticks.map(t => (
              <text key={t} className="soc-axis" x={x(t)} y={PAD.t + PH + 20} textAnchor="middle">
                {clock(t)}
              </text>
            ))}
            {/* Заливка лише під лінією «вдома» і лише коли вона на графіку одна: з двома лініями вона б зливалася. */}
            {!out &&
              line.runs
                .filter(run => run.length >= 2)
                .map(run => {
                  const floor = y(scale.lo);
                  const d = path(run, x, y);
                  return (
                    <path
                      key={run[0].t}
                      className="soc-area"
                      d={`${d} L${x(run[run.length - 1].t).toFixed(1)} ${floor} L${x(run[0].t).toFixed(1)} ${floor} Z`}
                      fill="url(#temp-fill)"
                    />
                  );
                })}
            {out?.runs.map(run =>
              run.length < 2 ? (
                <circle key={run[0].t} className="out-lone" cx={x(run[0].t)} cy={yOut(run[0].v)} r={2.5} />
              ) : (
                <path key={run[0].t} className="soc-line out-line" d={path(run, x, yOut)} pathLength={1} />
              ),
            )}
            {line.runs.map(run =>
              run.length < 2 ? (
                <circle key={run[0].t} className="climate-lone" cx={x(run[0].t)} cy={y(run[0].v)} r={2.5} />
              ) : (
                <path key={run[0].t} className="soc-line" d={path(run, x, y)} pathLength={1} />
              ),
            )}
            {outLast && <circle className="soc-dot out-dot" cx={x(outLast.t)} cy={yOut(outLast.v)} r={4} />}
            <circle className="soc-dot" cx={x(last.t)} cy={y(last.v)} r={5} />
            {at !== null && (
              <g className="soc-tip">
                <line x1={x(at)} x2={x(at)} y1={PAD.t} y2={PAD.t + PH} />
                {outValue !== null && <circle className="out-tip" cx={x(at)} cy={yOut(outValue)} r={4} />}
                {value !== null && <circle cx={x(at)} cy={y(value)} r={5} />}
                <rect x={tipX} y={2} width={tipW} height={26} rx={13} />
                <text x={tipX + tipW / 2} y={19} textAnchor="middle">
                  {tip}
                </text>
              </g>
            )}
          </svg>
        )}
      </div>
      {(out || bands.length > 0) && (
        <ul className="climate-legend">
          {out && (
            <>
              <li>
                <i className="sw sw-home" aria-hidden="true" /> вдома <b>{range(line.min, line.max)}</b>
                <span className="climate-axis-note">шкала ліворуч</span>
              </li>
              <li>
                <i className="sw sw-out" aria-hidden="true" /> надворі <b>{range(out.min, out.max)}</b>
                <span className="climate-axis-note">шкала праворуч</span>
              </li>
            </>
          )}
          {bands.length > 0 && (
            <li>
              <i className="lg lg-band" aria-hidden="true" /> світла не було
            </li>
          )}
        </ul>
      )}
    </>
  );
}
