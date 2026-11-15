import { useCallback, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { ArrowDown, ArrowUp, Bolt } from "./Icons";
import {
  clock,
  dayStart,
  dur,
  hourTicks,
  socInterp,
  socLine,
  socTrend,
  stationFresh,
  time,
  type Segment,
  type SocSample,
  type View,
} from "../convex/lib/logic";

const LOW = 20; // з цього заряду й нижче — «мало»
const H = 3600_000;

/** Картка станції: великий відсоток, батарея, куди рухається заряд і на скільки вистачить. */
export function Battery({ v, samples }: { v: View; samples: SocSample[] }) {
  if (v.soc == null) return null;
  const fresh = stationFresh(v);
  const low = v.soc <= LOW;
  const trend = socTrend(samples, v);
  const sub = !fresh
    ? `станцію не чути з ${v.socSeen == null ? "—" : time(v.socSeen)}`
    : trend.dir === "down"
      ? trend.eta ? `вистачить на ≈ ${dur(trend.eta)}` : null
      : trend.dir === "up"
        ? trend.eta ? `повна через ≈ ${dur(trend.eta)}` : null
        : null;
  const level = Math.max(0, Math.min(100, v.soc));
  return (
    <section
      className={`card station${low ? " low" : ""}${fresh ? "" : " stale"}${fresh && trend.dir === "up" ? " charging" : ""}`}
      style={{ "--d": 1 } as CSSProperties}
      aria-label="Зарядна станція"
    >
      <div className="station-row">
        <div>
          <p className="eyebrow">Зарядна станція</p>
          <p className="station-value">
            <span className="num" key={v.soc}>
              {v.soc}
            </span>
            <span className="pct">%</span>
            {fresh && trend.dir === "up" && <ArrowUp size={22} className="trend up" />}
            {fresh && trend.dir === "down" && <ArrowDown size={22} className="trend down" />}
          </p>
        </div>
        <div className="battery" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v.soc} aria-label="Заряд станції">
          <span className="battery-fill" style={{ width: `${level}%` }} />
          {fresh && trend.dir === "up" && <Bolt size={20} className="battery-bolt" />}
        </div>
      </div>
      {(sub || (low && fresh)) && (
        <p className="station-sub">
          {low && fresh && <b>Мало заряду{sub ? " · " : ""}</b>}
          {sub}
        </p>
      )}
    </section>
  );
}

const PAD = { l: 36, r: 14, t: 14, b: 28 };
const PH = 140;

/** Заряд за останню добу (або з першого запису): плавна лінія, під нею заливка, позаду — відключення. */
export function SocChart({ samples, outages, v }: { samples: SocSample[]; outages: Segment[]; v: View }) {
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
  if (v.soc == null) return null;

  const line = socLine(samples, v);
  const pts = line.points;
  const first = pts[0]?.t ?? v.now;
  const span = Math.min(24 * H, Math.max(3 * H, v.now - first));
  const from = v.now - span;
  const iw = Math.max(1, w - PAD.l - PAD.r);
  const x = (t: number) => PAD.l + ((t - from) / span) * iw;
  const y = (val: number) => PAD.t + PH - (val / 100) * PH;
  const step = span <= 6 * H ? 1 : span <= 12 * H ? 3 : 6;
  const ticks = hourTicks(from, v.now, step);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const area = last ? `${d} L${x(last.t).toFixed(1)} ${y(0)} L${x(pts[0].t).toFixed(1)} ${y(0)} Z` : "";
  const bands = outages
    .filter(s => s.kind === "off" && s.to > from && s.from < v.now)
    .map(s => ({ a: Math.max(s.from, from), b: Math.min(s.to, v.now) }));
  const value = at === null ? null : socInterp(line, at);
  const sub = pts.length < 2 ? null : span >= 24 * H - 60_000 ? "за 24 години" : `з ${dayStart(first) === dayStart(v.now) ? clock(first) : time(first)}`;

  function move(e: PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const part = (e.clientX - r.left - PAD.l) / iw;
    setAt(from + Math.max(0, Math.min(1, part)) * span);
  }

  const tipW = 96;
  const tipX = at === null ? 0 : Math.max(PAD.l, Math.min(PAD.l + iw - tipW, x(at) - tipW / 2));

  return (
    <section className="card soc" style={{ "--d": 3 } as CSSProperties} aria-label="Заряд станції">
      <div className="card-head">
        <h2>Заряд станції</h2>
        {sub && <span className="card-sub">{sub}</span>}
      </div>
      {pts.length < 2 ? (
        <p className="hint">Даних поки мало.</p>
      ) : (
        <div
          className="soc-plot"
          ref={measure}
          onPointerDown={move}
          onPointerMove={move}
          onPointerLeave={() => setAt(null)}
          onPointerCancel={() => setAt(null)}
        >
          {w > 0 && (
            <svg width={w} height={PAD.t + PH + PAD.b} role="img" aria-label={`Заряд станції зараз ${v.soc}%`}>
              <defs>
                <linearGradient id="soc-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" style={{ stopColor: "var(--accent)", stopOpacity: 0.32 }} />
                  <stop offset="1" style={{ stopColor: "var(--accent)", stopOpacity: 0 }} />
                </linearGradient>
              </defs>
              {bands.map(b => (
                <rect key={b.a} className="soc-band" x={x(b.a)} y={PAD.t} width={Math.max(2, x(b.b) - x(b.a))} height={PH} rx={3} />
              ))}
              {[0, 50, 100].map(g => (
                <g key={g}>
                  <line className="soc-grid" x1={PAD.l} x2={PAD.l + iw} y1={y(g)} y2={y(g)} />
                  <text className="soc-axis" x={PAD.l - 8} y={y(g) + 4} textAnchor="end">
                    {g}%
                  </text>
                </g>
              ))}
              {ticks.map(t => (
                <text key={t} className="soc-axis" x={x(t)} y={PAD.t + PH + 20} textAnchor="middle">
                  {clock(t)}
                </text>
              ))}
              <path className="soc-area" d={area} fill="url(#soc-fill)" />
              <path className="soc-line" d={d} pathLength={1} />
              {last && <circle className="soc-dot" cx={x(last.t)} cy={y(last.v)} r={5} />}
              {at !== null && value !== null && (
                <g className="soc-tip">
                  <line x1={x(at)} x2={x(at)} y1={PAD.t} y2={PAD.t + PH} />
                  <circle cx={x(at)} cy={y(value)} r={5} />
                  <rect x={tipX} y={2} width={tipW} height={26} rx={13} />
                  <text x={tipX + tipW / 2} y={19} textAnchor="middle">
                    {clock(at)} · {value}%
                  </text>
                </g>
              )}
            </svg>
          )}
        </div>
      )}
      {bands.length > 0 && pts.length >= 2 && (
        <p className="hint">
          <i className="lg lg-band" /> світла не було
        </p>
      )}
    </section>
  );
}
