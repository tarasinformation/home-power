import { useCallback, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { clock, dayStart, hourTicks, time, type Segment } from "../convex/lib/logic";
import { smoothPath } from "./curve";
import {
  CLIMATE_WINDOW_MS,
  climateLine,
  climateView,
  deg,
  axisY,
  outdoorLine,
  smoothRuns,
  tempAxis,
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
const PH = 120;
/** Шкала з розривом: висота кожної з двох смуг і самого розриву. */
const BAND_H = 92;
const GAP_H = 24;

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
 * Якщо бекенд збирає погоду, на тому самому графіку — температура надворі та поточна погода.
 * Шкала одна, тому холодніша лінія завжди нижче; коли вдома й надворі різняться сильно, порожню
 * середину шкали вирізано (розрив), щоб коливання обох ліній було видно.
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

/** Плавна лінія через покази: проходить через кожну точку й не виходить за сусідні значення. */
function path(run: ClimatePoint[], x: (t: number) => number, y: (v: number) => number): string {
  return smoothPath(run.map(p => ({ x: x(p.t), y: y(p.v) })));
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
  // Одна шкала на обидві лінії, за потреби з розривом посередині (tempAxis): холодніша лінія завжди нижче.
  const axis = tempAxis(line, out);
  const broken = axis.bands.length > 1;
  const bandH = broken ? BAND_H : PH;
  const ph = broken ? BAND_H * 2 + GAP_H : PH;
  const iw = Math.max(1, w - PAD.l - PAD.r);
  const x = (t: number) => PAD.l + ((t - from) / span) * iw;
  const y = (v: number) => PAD.t + ph - axisY(axis, v, bandH, GAP_H);
  // Малюємо усереднені лінії; точні покази лишаються для підказки.
  const homeRuns = smoothRuns(line.runs);
  const outRuns = out ? smoothRuns(out.runs) : null;
  const step = span <= 6 * H ? 1 : span <= 12 * H ? 3 : 6;
  const ticks = hourTicks(from, now, step);
  const bands = outages
    .filter(s => s.kind === "off" && s.to > from && s.from < now)
    .map(s => ({ a: Math.max(s.from, from), b: Math.min(s.to, now) }));
  const first = line.runs[0][0].t;
  const period = span >= CLIMATE_WINDOW_MS - 60_000 ? "за 24 години" : `з ${dayStart(first) === dayStart(now) ? clock(first) : time(first)}`;
  const lastRun = homeRuns[homeRuns.length - 1];
  const last = lastRun[lastRun.length - 1];
  const outLastRun = outRuns ? outRuns[outRuns.length - 1] : null;
  const outLast = outLastRun ? outLastRun[outLastRun.length - 1] : null;
  // У підказці — точні покази; точки підказки стоять на намальованих (усереднених) лініях.
  const value = at === null ? null : valueAt(line.runs, at);
  const outValue = at === null || !out ? null : valueAt(out.runs, at);
  const drawn = at === null ? null : valueAt(homeRuns, at, true);
  const outDrawn = at === null || !outRuns ? null : valueAt(outRuns, at, true);

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
  const gap = broken ? `розрив шкали між ${tick(axis.bands[0].hi)} і ${tick(axis.bands[1].lo)}` : null;
  const label =
    `Температура ${period}: вдома зараз ${deg(temp)}°, від ${deg(line.min)}° до ${deg(line.max)}°` +
    (out ? `; надворі від ${deg(out.min)}° до ${deg(out.max)}°; холодніша лінія нижче` : "") +
    (gap ? `; ${gap}` : "");
  const gapMid = PAD.t + BAND_H + GAP_H / 2;

  return (
    <>
      <p className="climate-range">
        <span>{period}</span>
        {!out && (
          <span>
            від {deg(line.min)}° до {deg(line.max)}°
          </span>
        )}
        {gap && <span>{gap}</span>}
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
          <svg width={w} height={PAD.t + ph + PAD.b} role="img" aria-label={label}>
            <defs>
              <linearGradient id="temp-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" style={{ stopColor: "var(--accent)", stopOpacity: 0.28 }} />
                <stop offset="1" style={{ stopColor: "var(--accent)", stopOpacity: 0 }} />
              </linearGradient>
            </defs>
            {bands.map(b => (
              <rect key={b.a} className="soc-band" x={x(b.a)} y={PAD.t} width={Math.max(2, x(b.b) - x(b.a))} height={ph} rx={3} />
            ))}
            {axis.bands.map(band => (
              <g key={band.who}>
                {band.ticks.map(g => (
                  <g key={g}>
                    <line className="soc-grid" x1={PAD.l} x2={PAD.l + iw} y1={y(g)} y2={y(g)} />
                    <text className="soc-axis" x={PAD.l - 8} y={y(g) + 4} textAnchor="end">
                      {tick(g)}
                    </text>
                  </g>
                ))}
                {/* Кольорова рейка вздовж смуги: чия це частина шкали. Підписи лишаються кольором тексту. */}
                {broken && (
                  <line
                    className={`axis-rail axis-rail-${band.who}`}
                    x1={PAD.l - 3}
                    x2={PAD.l - 3}
                    y1={y(band.hi)}
                    y2={y(band.lo)}
                  />
                )}
              </g>
            ))}
            {broken && (
              <g className="axis-break" aria-hidden="true">
                {/* Знак розриву шкали: дві косі риски на осі між смугами. */}
                <line x1={PAD.l - 8} x2={PAD.l + 2} y1={gapMid + 1} y2={gapMid - 5} />
                <line x1={PAD.l - 8} x2={PAD.l + 2} y1={gapMid + 6} y2={gapMid} />
              </g>
            )}
            {ticks.map(t => (
              <text key={t} className="soc-axis" x={x(t)} y={PAD.t + ph + 20} textAnchor="middle">
                {clock(t)}
              </text>
            ))}
            {/* Заливка лише під лінією «вдома» і лише коли вона на графіку одна: з двома лініями вона б зливалася. */}
            {!out &&
              homeRuns
                .filter(run => run.length >= 2)
                .map(run => {
                  const floor = y(axis.bands[0].lo);
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
            {outRuns?.map(run =>
              run.length < 2 ? (
                <circle key={run[0].t} className="out-lone" cx={x(run[0].t)} cy={y(run[0].v)} r={2.5} />
              ) : (
                <path key={run[0].t} className="soc-line out-line" d={path(run, x, y)} pathLength={1} />
              ),
            )}
            {homeRuns.map(run =>
              run.length < 2 ? (
                <circle key={run[0].t} className="climate-lone" cx={x(run[0].t)} cy={y(run[0].v)} r={2.5} />
              ) : (
                <path key={run[0].t} className="soc-line" d={path(run, x, y)} pathLength={1} />
              ),
            )}
            {outLast && <circle className="soc-dot out-dot" cx={x(outLast.t)} cy={y(outLast.v)} r={4} />}
            <circle className="soc-dot" cx={x(last.t)} cy={y(last.v)} r={5} />
            {at !== null && (
              <g className="soc-tip">
                <line x1={x(at)} x2={x(at)} y1={PAD.t} y2={PAD.t + ph} />
                {outDrawn !== null && <circle className="out-tip" cx={x(at)} cy={y(outDrawn)} r={4} />}
                {drawn !== null && <circle cx={x(at)} cy={y(drawn)} r={5} />}
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
              </li>
              <li>
                <i className="sw sw-out" aria-hidden="true" /> надворі <b>{range(out.min, out.max)}</b>
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
