import { useState, type CSSProperties } from "react";
import { Bolt, BoltOff } from "./Icons";
import { clock, dayLabel, dayStart, dur, hourCells, type CellKind, type DayRow, type HourCell, type PlanDay } from "../convex/lib/logic";

const weekday = new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", weekday: "short" });
const dateLong = new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", day: "numeric", month: "long" });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(".", "");
const MISMATCH_MS = 5 * 60_000;
const STATE: Record<CellKind, string> = {
  on: "є світло",
  off: "немає світла",
  lost: "немає зв'язку",
  maybe: "можливе відключення",
  none: "немає даних",
};

/** Графік по годинах у стилі «Київ Цифровий»: тиждень зверху, 24 плитки, легенда. */
export function DayGrid({
  rows,
  plan,
  now,
  sel,
  onSel,
}: {
  rows: DayRow[];
  plan: PlanDay[];
  now: number;
  sel: number | null;
  onSel: (start: number) => void;
}) {
  const week = rows.slice(0, 7).reverse();
  const today = dayStart(now);
  const [pickState, setPickState] = useState<{ day: number; from: number } | null>(null);
  let idx = week.findIndex(r => r.start === (sel ?? today));
  if (idx < 0) idx = Math.max(0, week.findIndex(r => r.start === today));
  const row = week[idx];
  if (!row) return null;
  const cells = hourCells(row, plan, now);
  const pick = pickState?.day === row.start ? pickState.from : null;
  const setPick = (from: number | null) => setPickState(from === null ? null : { day: row.start, from });
  const picked = pick === null ? null : (cells.find(c => c.from === pick) ?? null);
  const status = plan.find(p => p.start === row.start)?.status;
  const rel = dayLabel(row.start, now);
  const title = ["сьогодні", "вчора", "завтра"].includes(rel) ? `${cap(rel)}, ${dateLong.format(row.start)}` : `${cap(weekday.format(row.start))}, ${dateLong.format(row.start)}`;
  const tag = row.start < today ? null : status === "emergency" ? "екстрені відключення" : !status || status === "waiting" ? "графіка ще немає" : null;

  return (
    <section className="card sched" style={{ "--d": 2 } as CSSProperties}>
      <div className="seg-ctl" role="tablist" aria-label="День" style={{ "--n": week.length, "--i": idx } as CSSProperties}>
        <span className="seg-thumb" aria-hidden="true" />
        {week.map((r, i) => (
          <button
            key={r.start}
            type="button"
            role="tab"
            aria-selected={i === idx}
            aria-label={`${dayLabel(r.start, now)}, ${dateLong.format(r.start)}`}
            className={i === idx ? "seg-btn on" : "seg-btn"}
            onClick={() => {
              onSel(r.start);
              setPickState(null);
            }}
          >
            {cap(weekday.format(r.start))}
            {r.start === today && <i className="today-dot" aria-hidden="true" />}
          </button>
        ))}
      </div>

      <div className="sched-head">
        <p className="sched-title">{title}</p>
        {tag && <span className="tag">{tag}</span>}
      </div>

      <div className="tiles" key={row.start}>
        {cells.map((c, i) => (
          <Tile key={c.from} c={c} i={i} end={row.end} picked={pick === c.from} onPick={() => setPick(pick === c.from ? null : c.from)} />
        ))}
      </div>

      {picked && <Detail key={picked.from} c={picked} end={row.end} now={now} emergency={status === "emergency"} />}

      <ul className="kd-legend">
        <li>
          <i className="lg lg-now" /> зараз
        </li>
        <li>
          <i className="lg k-on" /> є світло
        </li>
        <li>
          <i className="lg k-off" /> немає світла
        </li>
        <li>
          <i className="lg k-maybe" /> можливе відключення
        </li>
        <li>
          <i className="lg lg-flag" /> не за графіком
        </li>
      </ul>
    </section>
  );
}

function Tile({ c, i, end, picked, onPick }: { c: HourCell; i: number; end: number; picked: boolean; onPick: () => void }) {
  const span = c.to - c.from;
  const pos = (t: number) => ((t - c.from) / span) * 100;
  const single: CellKind | null = c.parts.length === 1 ? c.parts[0].kind : null;
  const flag = c.mismatch >= MISMATCH_MS;
  return (
    <button
      type="button"
      className={`tile ${single ? `k-${single}` : "mixed"}${c.current ? " current" : ""}${picked ? " picked" : ""}`}
      style={{ "--i": i } as CSSProperties}
      aria-pressed={picked}
      aria-label={`${clock(c.from)}–${clock(c.to, end)}, ${single ? STATE[single] : "змішано"}${flag ? ", не за графіком" : ""}`}
      onClick={onPick}
    >
      <span className="tile-bg" aria-hidden="true">
        {c.parts.map(p => (
          <i key={`${p.from}-${p.kind}`} className={`k-${p.kind}`} style={{ left: `${pos(p.from)}%`, width: `${pos(p.to) - pos(p.from)}%` }} />
        ))}
      </span>
      <span className="tile-label">
        {single === "on" && <Bolt size={15} className="ico-bolt" />}
        {single === "off" && <BoltOff size={15} />}
        <span className="tile-time">{clock(c.from)}</span>
      </span>
      {flag && <span className="tile-flag" aria-hidden="true" />}
    </button>
  );
}

function Detail({ c, end, now, emergency }: { c: HourCell; end: number; now: number; emergency: boolean }) {
  const span = (p: { from: number; to: number }) => `${clock(p.from)}–${clock(p.to, end)}`;
  const plan = emergency
    ? "екстрені відключення, графік не діє"
    : !c.scheduled
    ? "графіка на цей день немає"
    : c.planned.length
      ? c.planned.map(p => `${p.kind === "possible" ? "можливе відключення" : "відключення"} ${span(p)}`).join(", ")
      : "світло є";
  const past = c.parts.filter(p => p.from < now).map(p => ({ ...p, to: Math.min(p.to, now) }));
  const offs = past.filter(p => p.kind === "off" || p.kind === "lost");
  const known = past.some(p => p.kind === "on" || p.kind === "off" || p.kind === "lost");
  const fact = c.future
    ? null
    : !known
      ? "даних немає"
      : offs.length
        ? offs.map(p => `${p.kind === "lost" ? "немає зв'язку" : "світла не було"} ${span(p)} (${dur(p.to - p.from)})`).join(", ")
        : "світло було";
  return (
    <div className="detail" role="status">
      <p className="detail-time">
        {clock(c.from)}–{clock(c.to, end)}
        {c.mismatch >= MISMATCH_MS && <span className="tag warn">не за графіком · {dur(c.mismatch)}</span>}
      </p>
      <dl>
        <dt>За графіком</dt>
        <dd>{plan}</dd>
        <dt>{c.future ? "Прогноз" : "Насправді"}</dt>
        <dd>
          {fact ??
            (c.planned.some(p => p.kind === "planned")
              ? "очікується відключення"
              : c.planned.length
                ? "можливе відключення"
                : c.scheduled
                  ? "світло має бути"
                  : "невідомо")}
        </dd>
      </dl>
    </div>
  );
}
