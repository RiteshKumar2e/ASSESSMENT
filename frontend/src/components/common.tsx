import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { downloadCsv, getJson } from "../api";
import { addDays, ukDate } from "../format";
import { useNotify } from "./feedback";

/** Fetch JSON for `path`; refetches when the path changes and ignores stale responses. */
export function useApi<T>(path: string | null) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState((s) => ({ data: s.data, loading: true }));
    getJson<T>(path)
      .then((data) => live && setState({ data, loading: false }))
      .catch((e: Error) => live && setState({ error: e.message, loading: false }));
    return () => {
      live = false;
    };
  }, [path, attempt]);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { ...state, retry };
}

// --- layout ------------------------------------------------------------------------

export function PageHead({ title, purpose, children }: { title: string; purpose: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{purpose}</p>
      </div>
      {children && <div className="filters">{children}</div>}
    </header>
  );
}

export function Panel({
  title,
  subtitle,
  aside,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

// --- measurements ------------------------------------------------------------------

export function Info({ text }: { text: string }) {
  return (
    <span className="info" title={text} aria-label={text} role="img">
      <Icon name="info" size={13} />
    </span>
  );
}

export function MeasureGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="measure-group">
      <h2>{title}</h2>
      <div className="items">{children}</div>
    </div>
  );
}

export function Measure({
  label,
  value,
  unit,
  sub,
  info,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  info?: string;
}) {
  return (
    <div className="measure">
      <div className="k">
        {label}
        {info && <Info text={info} />}
      </div>
      <div className="v">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

/** Direction of a signed error, shown with text and a glyph so colour is never the only cue. */
export function Direction({ error }: { error: number | null | undefined }) {
  if (error == null) return <span className="muted">–</span>;
  if (Math.abs(error) < 0.5) return <span className="dir">on target</span>;
  return error > 0 ? <span className="dir over">▲ over</span> : <span className="dir under">▼ under</span>;
}

// --- charts ------------------------------------------------------------------------

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
}

export function TooltipBox({ title, rows }: { title: string; rows: TooltipRow[] }) {
  return (
    <div className="tooltip">
      <div className="t">{title}</div>
      {rows.map((r) => (
        <div className="row" key={r.label}>
          <span>
            {r.color && <span className="key-square" style={{ background: r.color }} />}
            {r.label}
          </span>
          <span>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export const AXIS = { stroke: "var(--border-strong)", tickLine: false } as const;
export const GRID = { stroke: "var(--grid)", vertical: false } as const;

// --- states --------------------------------------------------------------------------

export function Skeleton({ height = 16, width = "100%" }: { height?: number; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} aria-hidden />;
}

export function LoadingBlock({ rows = 3 }: { rows?: number }) {
  return (
    <div style={{ display: "grid", gap: 12, padding: "8px 0" }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={i === 0 ? 220 : 18} width={i === 0 ? "100%" : `${70 - i * 10}%`} />
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state error" role="alert">
      <div>Could not load data. {message}</div>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <div>{children}</div>
      {action}
    </div>
  );
}

/** Wraps a chart so assistive tech gets a text summary; the visual SVG is hidden from it. */
export function ChartFigure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <figure className="chart-figure">
      <div aria-hidden="true">{children}</div>
      <figcaption className="sr-only">{summary}</figcaption>
    </figure>
  );
}

// --- filters -----------------------------------------------------------------------

const CUTOFF_PRESETS = [
  { value: "09:20", label: "09:20 · GB day-ahead auction" },
  { value: "11:00", label: "11:00 · Late morning" },
  { value: "15:30", label: "15:30 · Half-hourly auction" },
];

export const CUTOFF_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function CutoffFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isPreset = CUTOFF_PRESETS.some((p) => p.value === value);
  // The time box keeps its own draft so an incomplete entry is never sent to the API.
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [value]);

  const commit = (v: string) => {
    setDraft(v);
    if (CUTOFF_PATTERN.test(v)) {
      setError(null);
      if (v !== value) onChange(v);
    } else {
      setError("Enter a complete time (hours and minutes, UK time).");
    }
  };

  return (
    <div className="filter">
      <label htmlFor="cutoff">
        Decision cutoff <span className="hint">· D-1, UK time</span>
      </label>
      <div className="control-row">
        <select
          id="cutoff"
          className="select"
          value={isPreset ? value : "custom"}
          onChange={(e) => e.target.value !== "custom" && onChange(e.target.value)}
        >
          {CUTOFF_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom time</option>
        </select>
        <input
          className={`input time ${error ? "invalid" : ""}`}
          type="time"
          step={60}
          required
          aria-label="Decision cutoff time (UK)"
          aria-invalid={!!error}
          aria-describedby={error ? "cutoff-error" : undefined}
          value={draft}
          onChange={(e) => commit(e.target.value)}
        />
      </div>
      {error && (
        <span className="field-error" id="cutoff-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** CSV download with real success / failure feedback. */
export function ExportButton({
  params,
  label = "CSV",
  small,
}: {
  params: Record<string, string>;
  label?: string;
  small?: boolean;
}) {
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const { filename, rows } = await downloadCsv(params);
      notify("success", `Downloaded ${filename} (${rows.toLocaleString("en-GB")} rows).`);
    } catch (e) {
      notify("error", `Export failed. ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className={`btn ${small ? "small" : ""}`} onClick={run} disabled={busy} aria-busy={busy}>
      <Icon name="download" size={14} />
      {busy ? "Preparing…" : label}
    </button>
  );
}

export function DeliveryDateFilter({
  value,
  min,
  max,
  onChange,
}: {
  value: string;
  min: string;
  max: string;
  onChange: (v: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const pick = (v: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return setError("Enter a complete date.");
    if (v < min || v > max) return setError(`Choose a day between ${ukDate(min)} and ${ukDate(max)}.`);
    setError(null);
    onChange(v);
  };
  return (
    <div className="filter">
      <span className="label" id="delivery-label">
        Delivery day
      </span>
      <div className="control-row" role="group" aria-labelledby="delivery-label">
        <button className="btn icon" aria-label="Previous delivery day" disabled={value <= min} onClick={() => pick(addDays(value, -1))}>
          <Icon name="chevron-left" />
        </button>
        <label className={`input date-display ${error ? "invalid" : ""}`}>
          {ukDate(value)}
          <input
            type="date"
            value={value}
            min={min}
            max={max}
            required
            aria-label="Choose delivery day"
            aria-invalid={!!error}
            aria-describedby={error ? "date-error" : undefined}
            onChange={(e) => pick(e.target.value)}
          />
        </label>
        <button className="btn icon" aria-label="Next delivery day" disabled={value >= max} onClick={() => pick(addDays(value, 1))}>
          <Icon name="chevron-right" />
        </button>
      </div>
      {error && (
        <span className="field-error" id="date-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

// --- icons (inline, monochrome, 1.5px stroke) ----------------------------------------

const PATHS: Record<string, ReactNode> = {
  brief: (
    <>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18M8 2v4M16 2v4M7 13h4M7 17h7" />
    </>
  ),
  accuracy: (
    <>
      <path d="M3 3v18h18" />
      <path d="M7 15l4-5 3 3 5-7" />
    </>
  ),
  method: (
    <>
      <path d="M5 4h11l3 3v13H5z" />
      <path d="M9 10h6M9 14h6M9 18h3" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.5" />
    </>
  ),
  "chevron-left": <path d="M15 6l-6 6 6 6" />,
  "chevron-right": <path d="M9 6l6 6-6 6" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  );
}

/** Renders children only once they approach the viewport; keeps first paint cheap on chart-heavy pages. */
export function LazyMount({ height, children }: { height: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (shown || !ref.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setShown(true), {
      rootMargin: "300px",
    });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [shown]);
  return (
    <div ref={ref} style={shown ? undefined : { minHeight: height }}>
      {shown ? children : null}
    </div>
  );
}
