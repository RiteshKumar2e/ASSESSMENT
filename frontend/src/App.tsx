import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type { DataQuality, Meta } from "./api";
import { CUTOFF_PATTERN, ErrorState, Icon, LoadingBlock, PageHead, useApi } from "./components/common";
import { FeedbackProvider } from "./components/feedback";
import { fmt0, ukDate } from "./format";
import NotFound from "./pages/NotFound";
import { ROUTES, navigate, onLinkClick, useLocation, type RouteId } from "./router";
import { usePageMeta } from "./seo";
import DayView from "./views/DayView";

// The brief is the landing page; everything else loads on demand.
const AccuracyView = lazy(() => import("./views/AccuracyView"));
const MethodView = lazy(() => import("./views/MethodView"));
const Privacy = lazy(() => import("./pages/Legal").then((m) => ({ default: m.Privacy })));
const Terms = lazy(() => import("./pages/Legal").then((m) => ({ default: m.Terms })));

const NAV: { id: RouteId; label: string; icon: string }[] = [
  { id: "brief", label: "Day-ahead brief", icon: "brief" },
  { id: "accuracy", label: "Forecast accuracy", icon: "accuracy" },
  { id: "method", label: "Method & data", icon: "method" },
];

const DEFAULT_DATE = "2026-01-15";
const CONTACT = (import.meta.env.VITE_CONTACT_EMAIL ?? "").trim();

export default function App() {
  return (
    <FeedbackProvider>
      <Shell />
    </FeedbackProvider>
  );
}

function Shell() {
  const { route, params } = useLocation();
  usePageMeta(route);
  const meta = useApi<Meta>("/api/meta");
  const m = meta.data;
  const menu = useMobileMenu(route);

  // Filters live in the query string so every view can be shared as a link.
  const rawDate = params.get("date");
  const rawCutoff = params.get("cutoff");
  const cutoff = rawCutoff ?? m?.default_cutoff ?? "09:20";
  const date = rawDate ?? DEFAULT_DATE;
  const badParam =
    m &&
    ((rawCutoff != null && !CUTOFF_PATTERN.test(rawCutoff)) ||
      (rawDate != null && (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) || rawDate < m.delivery_first_day || rawDate > m.delivery_last_day)));

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(window.location.search);
    next.set(key, value);
    navigate(window.location.pathname, next, true);
  };
  const keep = () => {
    const keepParams = new URLSearchParams();
    if (rawDate && !badParam) keepParams.set("date", rawDate);
    if (rawCutoff && !badParam) keepParams.set("cutoff", rawCutoff);
    return keepParams;
  };

  const page = (() => {
    if (route === "notfound") return <NotFound />;
    if (route === "privacy") return <Privacy />;
    if (route === "terms") return <Terms />;
    if (!m) return meta.error ? <ErrorState message={meta.error} onRetry={meta.retry} /> : <LoadingBlock rows={4} />;
    if (badParam)
      return (
        <>
        <PageHead title="This link has an invalid filter" purpose="The delivery day or cutoff in the address could not be used." />
        <div className="state error" role="alert">
          <div>
            This link contains an invalid filter
            {rawDate ? ` (delivery day “${rawDate}”)` : ""}
            {rawCutoff ? ` (cutoff “${rawCutoff}”)` : ""}. Delivery days run from {ukDate(m.delivery_first_day)} to{" "}
            {ukDate(m.delivery_last_day)}, and the cutoff must be a time such as 09:20.
          </div>
          <button className="btn" onClick={() => navigate(window.location.pathname, new URLSearchParams(), true)}>
            Reset filters
          </button>
        </div>
        </>
      );
    if (route === "brief")
      return <DayView meta={m} date={date} cutoff={cutoff} onDate={(d) => setParam("date", d)} onCutoff={(c) => setParam("cutoff", c)} />;
    if (route === "accuracy")
      return (
        <AccuracyView
          meta={m}
          cutoff={cutoff}
          onCutoff={(c) => setParam("cutoff", c)}
          onOpenDay={(d) => navigate(ROUTES.brief, new URLSearchParams({ ...Object.fromEntries(keep()), date: d }))}
        />
      );
    return <MethodView meta={m} cutoff={cutoff} />;
  })();

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside id="sidebar" className={`sidebar ${menu.open ? "open" : ""}`} aria-label="Main navigation" ref={menu.panelRef}>
        <a className="wordmark" href={ROUTES.brief} onClick={(e) => onLinkClick(e, ROUTES.brief, keep())}>
          <Logo />
          <div>
            <strong>Wind Forecast Monitor</strong>
            <span>GB day-ahead procurement</span>
          </div>
        </a>
        <nav className="nav">
          {NAV.map((n) => (
            <a
              key={n.id}
              href={ROUTES[n.id as keyof typeof ROUTES]}
              aria-current={route === n.id ? "page" : undefined}
              onClick={(e) => {
                menu.close();
                onLinkClick(e, ROUTES[n.id as keyof typeof ROUTES], keep());
              }}
            >
              <Icon name={n.icon} />
              {n.label}
            </a>
          ))}
        </nav>
        <DataStatus cutoff={badParam ? "09:20" : cutoff} />
      </aside>
      {menu.open && <div className="scrim" onClick={menu.close} aria-hidden />}

      <div className="main-wrap">
        <header className="mobilebar">
          <button
            className="btn icon"
            ref={menu.buttonRef}
            aria-label={menu.open ? "Close navigation" : "Open navigation"}
            aria-expanded={menu.open}
            aria-controls="sidebar"
            onClick={menu.toggle}
          >
            <Icon name={menu.open ? "close" : "menu"} />
          </button>
          <strong>Wind Forecast Monitor</strong>
        </header>
        <main className="main" id="main" tabIndex={-1}>
          <Suspense fallback={<LoadingBlock rows={4} />}>{page}</Suspense>
        </main>
        <footer className="site-footer">
          <span>
            Source:{" "}
            <a href="https://bmrs.elexon.co.uk/" target="_blank" rel="noopener noreferrer">
              Elexon BMRS<span className="sr-only"> (opens in a new tab)</span>
            </a>{" "}
            datasets FUELHH and WINDFOR. Historical data for January 2026 decisions.
          </span>
          <nav aria-label="Legal and information" className="footer-links">
            <a href={ROUTES.method} onClick={(e) => onLinkClick(e, ROUTES.method, keep())}>
              Method &amp; data
            </a>
            <a href={ROUTES.privacy} onClick={(e) => onLinkClick(e, ROUTES.privacy)}>
              Privacy
            </a>
            <a href={ROUTES.terms} onClick={(e) => onLinkClick(e, ROUTES.terms)}>
              Terms
            </a>
            {CONTACT && <a href={`mailto:${CONTACT}`}>{CONTACT}</a>}
          </nav>
        </footer>
      </div>
    </div>
  );
}

/** Off-canvas navigation on small screens: Escape closes, focus moves in and back out. */
function useMobileMenu(route: RouteId) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const close = () => setOpen(false);
  useEffect(() => close(), [route]);
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("nav a")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return { open, close, toggle: () => setOpen((o) => !o), buttonRef, panelRef };
}

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      <path
        d="M7 12h12.5a3 3 0 1 0-3-3M7 16.5h17.5a3 3 0 1 1-3 3M7 21h9"
        fill="none"
        stroke="#fff"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Data coverage straight from /api/data-quality; nothing here is assumed. */
function DataStatus({ cutoff }: { cutoff: string }) {
  const q = useApi<DataQuality>(`/api/data-quality?cutoff=${encodeURIComponent(cutoff)}`);
  const d = q.data;
  if (!d)
    return (
      <div className="status">
        {q.error ? (
          <>
            <div className="title">
              <span className="dot bad" aria-hidden />
              Data status unavailable
            </div>
            <button className="btn link" onClick={q.retry}>
              Retry
            </button>
          </>
        ) : (
          "Checking data…"
        )}
      </div>
    );
  const complete = d.actual_intervals_present === d.actual_intervals_expected && d.matched_hours === d.matched_hours_expected;
  return (
    <div className="status">
      <div className="title">
        <span className={`dot ${complete ? "" : "warn"}`} aria-hidden />
        {complete ? "Data complete" : "Data has gaps"}
      </div>
      <div className="row">
        <span>Actual half-hours</span>
        <b>
          {fmt0(d.actual_intervals_present)}/{fmt0(d.actual_intervals_expected)}
        </b>
      </div>
      <div className="row">
        <span>Matched hours</span>
        <b>
          {fmt0(d.matched_hours)}/{fmt0(d.matched_hours_expected)}
        </b>
      </div>
      <div className="row">
        <span>Forecast runs</span>
        <b>{fmt0(d.forecast_runs)}</b>
      </div>
      {d.fetched_at && (
        <div className="note">
          Historical snapshot, retrieved from Elexon on{" "}
          {new Date(d.fetched_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.
        </div>
      )}
    </div>
  );
}
