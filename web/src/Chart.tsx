import { Calendar } from "./Icons";
import {
  dayLabel,
  dur,
  forecastFor,
  hours,
  planFor,
  planTotal,
  wallFrac,
  type DayRow,
  type PlanDay,
} from "../convex/lib/logic";

const HOURS = [0, 6, 12, 18, 24];

/** Тиждень рядками: доба за київським часом, шкала 0–24. Натискання на рядок відкриває цей день по годинах. */
export function Chart({ rows, now, plan, onPick }: { rows: DayRow[]; now: number; plan: PlanDay[]; onPick: (start: number) => void }) {
  const hasPlan = plan.length > 0;

  return (
    <section className="chart" aria-label="Графік світла по днях">
      {hasPlan && (
        <ul className="legend">
          <li>
            <span className="swatch swatch-plan" aria-hidden="true" /> графік
          </li>
          <li>
            <span className="swatch seg-forecast" aria-hidden="true" /> прогноз
          </li>
        </ul>
      )}

      <div className="chart-row chart-axis" aria-hidden="true">
        <span />
        <div className="hours">
          {HOURS.map(h => (
            <span key={h} style={{ left: `${(h / 24) * 100}%` }}>
              {h}
            </span>
          ))}
        </div>
        <span />
      </div>

      {rows.map(row => {
        const pos = (t: number) => wallFrac(t, row.start, row.end) * 100;
        const isToday = now >= row.start && now < row.end;
        const slots = planFor(plan, row.start);
        const planned = planTotal(plan, row.start);
        const future = row.start > now;
        return (
          <button
            type="button"
            className="chart-row"
            key={row.start}
            aria-label={`${dayLabel(row.start, now)}: без світла ${row.off > 0 ? dur(row.off) : "не було"}`}
            onClick={() => onPick(row.start)}
          >
            <span className="day">{shortDay(row.start, now)}</span>
            <div className={hasPlan ? "lanes with-plan" : "lanes"}>
              {hasPlan && (
                <div className="plan-lane" aria-hidden="true">
                  {slots.map(p => (
                    <span key={p.from} className={`plan plan-${p.kind}`} style={{ left: `${pos(p.from)}%`, width: `${pos(p.to) - pos(p.from)}%` }} />
                  ))}
                </div>
              )}
              <div className="bar">
                {forecastFor(plan, row.start, now).map(p => (
                  <span key={p.from} className="seg seg-forecast" style={{ left: `${pos(p.from)}%`, width: `${pos(p.to) - pos(p.from)}%` }} aria-hidden="true" />
                ))}
              {row.segments.map(seg => (
                <span key={`${seg.from}-${seg.kind}`} className={`seg seg-${seg.kind}`} style={{ left: `${pos(seg.from)}%`, width: `${pos(seg.to) - pos(seg.from)}%` }} />
              ))}
              {[6, 12, 18].map(h => (
                <span key={h} className="tick" style={{ left: `${(h / 24) * 100}%` }} aria-hidden="true" />
              ))}
              {isToday && <span className="now" style={{ left: `${pos(now)}%` }} aria-hidden="true" />}
            </div>
            </div>
            <span className="sum">
              {!future && (row.off > 0 ? dur(row.off) : row.segments.length ? "—" : "")}
              {hasPlan && (planned > 0 || future) && (
                <small>
                  <Calendar size={11} />
                  {planned > 0 ? hours(planned) : "—"}
                </small>
              )}
            </span>
          </button>
        );
      })}
    </section>
  );
}

const wd = new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", weekday: "short" });
const dnum = new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", day: "numeric" });

/** «сьогодні», «вчора», «завтра» або «Пт 13». */
function shortDay(start: number, now: number): string {
  const rel = dayLabel(start, now);
  if (["сьогодні", "вчора", "завтра"].includes(rel)) return rel;
  const w = wd.format(start).replace(".", "");
  return `${w.charAt(0).toUpperCase()}${w.slice(1)} ${dnum.format(start)}`;
}
