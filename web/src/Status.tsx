import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../convex/_generated/api";
import { Chart } from "./Chart";
import { Battery, SocChart } from "./Station";
import { DayGrid } from "./DayGrid";
import { Alert, Bolt, BoltOff, Calendar, Help, Logout, WifiOff } from "./Icons";
import {
  days,
  clock,
  dur,
  HISTORY_DAYS,
  dayStart,
  intervals,
  note,
  planPill,
  time,
  TITLES,
  view,
  type DayRow,
  type PlanDay,
  type Segment,
  type SocSample,
  type View,
} from "../convex/lib/logic";

/** Поточний час, що оновлюється кожні 15 с: тривалість росте, а «немає зв'язку» з'являється само. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, 15_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  return now;
}

export function StatusPage() {
  const { signOut } = useAuthActions();
  // Підписки Convex: сторінка оновлюється сама, щойно в базі змінився стан або журнал.
  const state = useQuery(api.power.state);
  const events = useQuery(api.power.events);
  const samples = useQuery(api.power.soc);
  const plan = useQuery(api.schedule.plan);
  const group = useQuery(api.schedule.group);
  const who = useQuery(api.power.me);
  const now = useNow();

  if (state === undefined || events === undefined) {
    return (
      <main className="app">
        <p className="loading" aria-label="Завантаження">
          <i />
          <i />
          <i />
        </p>
      </main>
    );
  }

  // Годинник телефона може відставати від сервера: «зараз» не раніше за останній сигнал.
  const at = Math.max(now, state?.lastSeen ?? 0);
  const v = view(state, events, at);
  return (
    <StatusView
      v={v}
      rows={days(state, events, at)}
      samples={samples ?? []}
      outages={intervals(state, events, at)}
      plan={plan ?? []}
      group={group ?? null}
      who={who ?? null}
      onSignOut={() => void signOut()}
    />
  );
}

/** Сама сторінка: лише малює готові дані, без Convex. */
export function StatusView({
  v,
  rows,
  samples,
  outages,
  plan,
  group,
  who,
  onSignOut,
}: {
  v: View;
  rows: DayRow[];
  samples: SocSample[];
  outages: Segment[];
  plan: PlanDay[];
  group: string | null;
  who: string | null;
  onSignOut: () => void;
}) {
  const pill = planPill(plan, v);
  const [day, setDay] = useState<number | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const withPlan = withTomorrow(rows, plan, v.now);
  const foot = [
    v.lastSeen !== null && `сигнал плати ${time(v.lastSeen)}`,
    v.rssi !== null && `Wi-Fi ${v.rssi} dBm`,
    v.fw && `прошивка ${v.fw}`,
    who,
  ].filter(Boolean);

  return (
    <main className="app">
      <header className="topbar">
        <span className={`live${v.status === "lost" ? " off" : ""}`}>
          <i aria-hidden="true" />
          {v.status === "lost" ? "без зв'язку" : "наживо"}
        </span>
        <h1>Світло вдома</h1>
        <button type="button" className="icon-btn" aria-label="Вийти" onClick={onSignOut}>
          <Logout size={20} />
        </button>
      </header>

      <section className={`card hero s-${v.status}`} key={v.status} role="status" style={{ "--d": 0 } as CSSProperties}>
        <div className="hero-top">
          <span className="hero-icon" aria-hidden="true">
            {v.status === "on" && <Bolt size={30} />}
            {v.status === "off" && <BoltOff size={30} />}
            {v.status === "lost" && <WifiOff size={30} />}
            {v.status === "unknown" && <Help size={30} />}
          </span>
          <div>
            <p className="eyebrow">{group && plan.length ? `Черга ${group}` : "Зараз"}</p>
            <p className="hero-title">{TITLES[v.status]}</p>
          </div>
        </div>
        <p className="hero-note">{note(v)}</p>
        {pill && (
          <div className="hero-pills">
            <span className={`pill pill-${pill.kind}`}>
              <Calendar size={16} />
              {pill.text}
            </span>
          </div>
        )}
        {pill?.warn && (
          <p className="hero-warn">
            <Alert size={16} />
            {pill.warn}
          </p>
        )}
      </section>

      <Battery v={v} samples={samples} />

      {v.status !== "unknown" && (
        <div ref={grid} className="anchor">
          <DayGrid rows={withPlan} plan={plan} now={v.now} sel={day} onSel={setDay} />
        </div>
      )}

      <SocChart samples={samples} outages={outages} v={v} />

      {v.status !== "unknown" && (
        <section className="card" style={{ "--d": 4 } as CSSProperties}>
          <div className="card-head">
            <h2>Тиждень</h2>
            <span className="card-sub">{HISTORY_DAYS} днів</span>
          </div>
          <Chart
            rows={withPlan.slice(0, 7)}
            now={v.now}
            plan={plan}
            onPick={start => {
              setDay(start);
              grid.current?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          />
        </section>
      )}

      <section className="card" style={{ "--d": 5 } as CSSProperties}>
        <div className="card-head">
          <h2>Відключення</h2>
          <span className="card-sub">{v.outages.length ? `разом ${dur(v.total)}` : `${HISTORY_DAYS} днів`}</span>
        </div>
        {v.outages.length === 0 ? (
          <p className="hint">Відключень не було.</p>
        ) : (
          <ul className="olist">
            {v.outages.map(o => {
              const sameDay = o.end !== null && dayStart(o.end) === dayStart(o.start);
              return (
                <li key={o.start} className={o.end === null ? "active" : undefined}>
                  <span className="o-ico" aria-hidden="true">
                    <BoltOff size={18} />
                  </span>
                  <span className="o-main">
                    <span className="o-when">
                      {time(o.start)} – {o.end === null ? "зараз" : sameDay ? clock(o.end) : time(o.end)}
                    </span>
                    {(o.end === null || o.endedBy === "lost") && (
                      <span className="o-sub">{o.end === null ? "триває" : "зник зв'язок"}</span>
                    )}
                  </span>
                  <span className="o-dur">{dur((o.end ?? v.now) - o.start)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <footer className="foot">{foot.join(" · ")}</footer>
    </main>
  );
}

/** Додає зверху рядок «завтра», якщо офіційний графік відомий хоч на якийсь день. */
function withTomorrow(rows: DayRow[], plan: PlanDay[], now: number): DayRow[] {
  if (!plan.length) return rows;
  const start = dayStart(dayStart(now) + 26 * 3600_000);
  const end = dayStart(start + 26 * 3600_000);
  return [{ start, end, segments: [], off: 0 }, ...rows];
}
