"""FastAPI application: JSON API under /api, plus the built React app when present.

Routes are thin: they validate parameters, pick cached pair sets and hand off to the
pure functions in ``analysis``. Nothing here talks to Elexon; data comes from the
snapshot loaded by ``store.get_dataset``.
"""

from __future__ import annotations

import csv
import io
import logging
import re
from collections import Counter
from collections.abc import Callable
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta
from functools import lru_cache
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import analysis, schemas
from .config import CURVE_MAX_HOURS, DEFAULT_CUTOFF, DELIVERY_FIRST_DAY, DELIVERY_LAST_DAY, settings
from .store import fmt_ts, get_dataset, parse_ts

logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("wind_forecast")


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Warm the caches for the default view so the first page load is fast.
    ds = get_dataset()
    log.info("snapshot loaded: %d actuals, %d forecast runs", len(ds.actuals), len(ds.runs))
    _decision_pairs(DEFAULT_CUTOFF)
    _horizon_curve()
    _lead_buckets()
    yield


app = FastAPI(
    lifespan=lifespan,
    title="Wind Forecast Monitor API",
    description="GB national wind: forecasts available at day-ahead decision time vs actual generation. "
    "January 2026 purchase decisions. Data: Elexon BMRS (FUELHH, WINDFOR).",
    version="2.0.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["GET"],
    allow_headers=["*"],
    # Lets a frontend on another origin (Vercel) read the CSV file name from /api/export.
    expose_headers=["Content-Disposition"],
)
# JS bundles and JSON compress roughly 4:1; worthwhile when no proxy/CDN does it upstream.
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Content Security Policy for the built frontend: everything is self-hosted. Inline
# styles are needed by React style props and Recharts; no inline scripts are allowed.
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
    "font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; "
    "object-src 'none'"
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    headers = response.headers
    headers.setdefault("X-Content-Type-Options", "nosniff")
    headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    if not request.url.path.startswith(("/api/", "/docs", "/redoc", "/openapi.json")):
        headers.setdefault("Content-Security-Policy", CSP)
    path = request.url.path
    if path.startswith("/assets/"):
        # Vite fingerprints these file names, so they can be cached for a year.
        headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
    elif not path.startswith("/api/") and headers.get("content-type", "").startswith("text/html"):
        headers.setdefault("Cache-Control", "no-cache")
    if settings.enable_hsts:
        # Only behind HTTPS; browsers then refuse plain HTTP for a year.
        headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


@app.exception_handler(Exception)
async def unexpected_error(request: Request, exc: Exception):
    # Log the detail server-side; never send stack traces to the browser.
    log.exception("unhandled error on %s", request.url.path)
    return JSONResponse({"detail": "Unexpected server error."}, status_code=500)


CUTOFF_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
DEFAULT_CUTOFF_STR = DEFAULT_CUTOFF.strftime("%H:%M")
CutoffQ = Query(DEFAULT_CUTOFF_STR, description="Decision time on D-1, UK local, HH:MM")


# --- parameter helpers -------------------------------------------------------------------


def parse_cutoff(value: str) -> time:
    match = CUTOFF_RE.match(value)
    if not match:
        raise HTTPException(422, "cutoff must be HH:MM (UK local time)")
    return time(int(match[1]), int(match[2]))


def check_day(day: date) -> date:
    if not DELIVERY_FIRST_DAY <= day <= DELIVERY_LAST_DAY:
        raise HTTPException(404, f"delivery day must be within {DELIVERY_FIRST_DAY}..{DELIVERY_LAST_DAY}")
    return day


def day_range(date_from: date | None, date_to: date | None) -> tuple[date, date]:
    first = check_day(date_from or DELIVERY_FIRST_DAY)
    last = check_day(date_to or DELIVERY_LAST_DAY)
    if first > last:
        raise HTTPException(422, "date_from must be on or before date_to")
    return first, last


def parse_instant(value: str, name: str) -> datetime:
    try:
        return parse_ts(value)
    except ValueError as exc:
        raise HTTPException(422, f"{name} must be an ISO-8601 timestamp, e.g. 2026-01-15T07:30:00Z") from exc


def search_filter(rows: list[dict], search: str | None) -> list[dict]:
    if not search:
        return rows
    needle = search.strip().lower()
    return [r for r in rows if any(needle in str(v).lower() for v in r.values())]


def paginate(rows: list[dict], page: int, page_size: int) -> dict:
    start = (page - 1) * page_size
    return {"total": len(rows), "page": page, "page_size": page_size, "rows": rows[start : start + page_size]}


def to_csv(rows: list[dict], filename: str) -> Response:
    buf = io.StringIO()
    if rows:
        writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    return Response(
        buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --- cached computations -----------------------------------------------------------------


@lru_cache(maxsize=32)
def _decision_pairs(cutoff: time) -> list[analysis.Pair]:
    return analysis.decision_pairs(get_dataset(), cutoff)


@lru_cache(maxsize=32)
def _corrected_pairs(cutoff: time) -> list[analysis.Pair]:
    return analysis.corrected_pairs(get_dataset(), cutoff)


@lru_cache(maxsize=128)
def _horizon_pairs(hours: int) -> list[analysis.Pair]:
    return analysis.horizon_pairs(get_dataset(), hours)


@lru_cache(maxsize=1)
def _horizon_curve() -> list[dict]:
    return analysis.horizon_curve(get_dataset())


@lru_cache(maxsize=1)
def _lead_buckets() -> list[dict]:
    return analysis.lead_buckets(get_dataset())


# --- reference -----------------------------------------------------------------------------


@app.get("/api/health", tags=["reference"], response_model=schemas.Health)
def health():
    ds = get_dataset()
    return {
        "status": "ok",
        "actuals": len(ds.actuals),
        "forecast_runs": len(ds.runs),
        "fetched_at": ds.meta.get("fetched_at"),
    }


@app.get("/api/meta", tags=["reference"], response_model=schemas.Meta)
def meta():
    ds = get_dataset()
    schedule = Counter(r.published.strftime("%H:%M") for r in ds.runs)
    return {
        "delivery_first_day": DELIVERY_FIRST_DAY.isoformat(),
        "delivery_last_day": DELIVERY_LAST_DAY.isoformat(),
        "default_cutoff": DEFAULT_CUTOFF_STR,
        "max_horizon_h": CURVE_MAX_HOURS,
        # Typical WINDFOR publication times (UTC) and how often each occurred.
        "publish_schedule_utc": [{"time": t, "count": c} for t, c in sorted(schedule.items()) if c > 3],
        "source": ds.meta.get("source"),
        "fetched_at": ds.meta.get("fetched_at"),
    }


# --- overview ------------------------------------------------------------------------------


@app.get("/api/overview", tags=["overview"], response_model=schemas.Overview)
def overview(day: date = Query(..., alias="date"), cutoff: str = CutoffQ):
    """One delivery day as seen at decision time, plus the month-level context."""
    cut = parse_cutoff(cutoff)
    pairs = _decision_pairs(cut)
    return {
        "day": analysis.day_detail(get_dataset(), check_day(day), cut, pairs),
        "month": analysis.metrics(pairs),
        "daily": analysis.daily(pairs, get_dataset()),
    }


# --- forecast explorer ---------------------------------------------------------------------


def _explorer(day: date, cut: time, published: str | None, hour_from: int, hour_to: int) -> dict:
    ds = get_dataset()
    cutoff_utc = analysis.decision_cutoff(day, cut)
    decision = ds.latest_run_at(cutoff_utc)
    if published:
        run_time = parse_instant(published, "published")
        if ds.run_at(run_time) is None:
            raise HTTPException(404, f"no forecast run published at {published}")
    else:
        run_time = decision.published if decision else None
    rows = analysis.forecast_rows(ds, day, run_time) if run_time else []
    rows = [r for r in rows if hour_from <= parse_ts(r["start_time"]).astimezone(analysis.LONDON).hour <= hour_to]
    pairs = [
        analysis.Pair(parse_ts(r["start_time"]), day, r["forecast_mw"], r["actual_mw"], run_time)
        for r in rows
        if r["actual_mw"] is not None
    ]
    start, end = analysis.local_day_bounds(day)
    half_hourly, t = [], start
    while t < end:
        half_hourly.append({"time": fmt_ts(t), "actual": ds.actuals.get(t)})
        t += timedelta(minutes=30)
    return {
        "date": day.isoformat(),
        "decision_cutoff": fmt_ts(cutoff_utc),
        "decision_run": fmt_ts(decision.published) if decision else None,
        "selected_run": fmt_ts(run_time) if run_time else None,
        "targets": [fmt_ts(t) for t in analysis.hourly_targets(day)],
        "actual_half_hourly": half_hourly,
        "runs": analysis.runs_for_day(ds, day, cut),
        "rows": rows,
        "metrics": analysis.metrics(pairs),
    }


@app.get("/api/forecasts", tags=["forecasts"], response_model=schemas.ForecastExplorer)
def forecasts(
    day: date = Query(..., alias="date"),
    cutoff: str = CutoffQ,
    published: str | None = Query(None, description="Inspect a specific run instead of the decision-time run"),
    hour_from: int = Query(0, ge=0, le=23, description="First delivery hour (UK local)"),
    hour_to: int = Query(23, ge=0, le=23, description="Last delivery hour (UK local)"),
):
    """Every forecast run for a delivery day, and an hourly table for the selected run."""
    if hour_from > hour_to:
        raise HTTPException(422, "hour_from must be <= hour_to")
    return _explorer(check_day(day), parse_cutoff(cutoff), published, hour_from, hour_to)


@app.get("/api/forecasts/revisions", tags=["forecasts"], response_model=schemas.TargetRevisions)
def revisions(start_time: str = Query(..., description="Delivery hour, ISO-8601 UTC"), cutoff: str = CutoffQ):
    """How the forecast for one delivery hour evolved across runs."""
    target = parse_instant(start_time, "start_time")
    day = check_day(target.astimezone(analysis.LONDON).date())
    cutoff_utc = analysis.decision_cutoff(day, parse_cutoff(cutoff))
    return {**analysis.revisions_for_target(get_dataset(), target, cutoff_utc), "decision_cutoff": fmt_ts(cutoff_utc)}


# --- accuracy ------------------------------------------------------------------------------


@app.get("/api/accuracy", tags=["accuracy"], response_model=schemas.Accuracy)
def accuracy(
    mode: Literal["decision", "horizon"] = "decision",
    cutoff: str = CutoffQ,
    hours: int = Query(24, ge=0, le=CURVE_MAX_HOURS, description="Minimum lead time in horizon mode"),
    bin_mw: int = Query(500, ge=100, le=5000),
):
    cut = parse_cutoff(cutoff)
    pairs = _decision_pairs(cut) if mode == "decision" else _horizon_pairs(hours)
    summary = analysis.metrics(pairs)
    by_hour = analysis.by_hour_of_day(pairs)
    daily = analysis.daily(pairs, get_dataset())
    buckets = _lead_buckets()
    return {
        "mode": mode,
        "summary": summary,
        # What a trailing-bias adjustment would have achieved (decision mode only).
        "corrected_summary": analysis.metrics(_corrected_pairs(cut)) if mode == "decision" else None,
        "by_hour": by_hour,
        "daily": daily,
        "histogram": analysis.histogram(pairs, bin_mw),
        "scatter": analysis.scatter(pairs),
        "lead_buckets": buckets,
        "findings": analysis.interpretation(summary, daily, by_hour, buckets),
    }


@app.get("/api/horizon-curve", tags=["accuracy"], response_model=list[schemas.HorizonPoint])
def horizon_curve():
    return _horizon_curve()


# --- data explorer -----------------------------------------------------------------------------


def _actual_records(first: date, last: date) -> list[dict]:
    ds = get_dataset()
    start, _ = analysis.local_day_bounds(first)
    _, end = analysis.local_day_bounds(last)
    return [{"start_time": fmt_ts(t), "generation_mw": v} for t, v in sorted(ds.actuals.items()) if start <= t < end]


def _forecast_records(first: date, last: date) -> list[dict]:
    """Raw WINDFOR points whose delivery hour falls in the selected days."""
    ds = get_dataset()
    start, _ = analysis.local_day_bounds(first)
    _, end = analysis.local_day_bounds(last)
    rows = []
    for run in ds.runs_between(start - timedelta(hours=analysis.MAX_HORIZON_HOURS), end):
        for t, v in sorted(run.points.items()):
            if start <= t < end:
                rows.append(
                    {
                        "publish_time": fmt_ts(run.published),
                        "start_time": fmt_ts(t),
                        "lead_h": (t - run.published).total_seconds() / 3600,
                        "generation_mw": v,
                    }
                )
    return rows


def _matched_records(first: date, last: date, cut: time) -> list[dict]:
    return [
        r
        for r in analysis.matched_rows(_decision_pairs(cut))
        if first.isoformat() <= r["delivery_date"] <= last.isoformat()
    ]


DATASETS: dict[str, Callable[..., list[dict]]] = {
    "actuals": lambda first, last, cut: _actual_records(first, last),
    "forecasts": lambda first, last, cut: _forecast_records(first, last),
    "matched": _matched_records,
}


@app.get("/api/actuals", tags=["data"], response_model=schemas.Page[schemas.ActualRecord])
def actual_records(
    date_from: date | None = None,
    date_to: date | None = None,
    search: str | None = Query(None, max_length=64),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
):
    first, last = day_range(date_from, date_to)
    return paginate(search_filter(_actual_records(first, last), search), page, page_size)


@app.get("/api/forecast-records", tags=["data"], response_model=schemas.Page[schemas.ForecastRecord])
def forecast_records(
    date_from: date | None = None,
    date_to: date | None = None,
    search: str | None = Query(None, max_length=64),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
):
    first, last = day_range(date_from, date_to)
    return paginate(search_filter(_forecast_records(first, last), search), page, page_size)


@app.get("/api/matched", tags=["data"], response_model=schemas.Page[schemas.MatchedRecord])
def matched_records(
    cutoff: str = CutoffQ,
    date_from: date | None = None,
    date_to: date | None = None,
    search: str | None = Query(None, max_length=64),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
):
    first, last = day_range(date_from, date_to)
    rows = _matched_records(first, last, parse_cutoff(cutoff))
    return paginate(search_filter(rows, search), page, page_size)


@app.get("/api/data-quality", tags=["data"], response_model=schemas.DataQuality)
def data_quality(cutoff: str = CutoffQ):
    return analysis.data_quality(get_dataset(), parse_cutoff(cutoff))


@app.get("/api/export", tags=["data"], response_class=Response)
def export(
    dataset: Literal["actuals", "forecasts", "matched", "explorer"],
    cutoff: str = CutoffQ,
    date_from: date | None = None,
    date_to: date | None = None,
    search: str | None = Query(None, max_length=64),
    day: date | None = Query(None, alias="date", description="explorer only"),
    published: str | None = Query(None, description="explorer only"),
    hour_from: int = Query(0, ge=0, le=23),
    hour_to: int = Query(23, ge=0, le=23),
):
    """CSV of exactly what the matching table shows, with the same filters."""
    cut = parse_cutoff(cutoff)
    if dataset == "explorer":
        if day is None:
            raise HTTPException(422, "date is required for the explorer export")
        rows = _explorer(check_day(day), cut, published, hour_from, hour_to)["rows"]
        name = f"wind_forecast_forecast_{day.isoformat()}.csv"
    else:
        first, last = day_range(date_from, date_to)
        rows = search_filter(DATASETS[dataset](first, last, cut), search)
        name = f"wind_forecast_{dataset}_{first.isoformat()}_{last.isoformat()}.csv"
    log.info("export %s: %d rows", dataset, len(rows))
    return to_csv(rows, name)


# --- static frontend: served from STATIC_DIR when the built app is present ---------------------

# Client-side routes (keep in sync with frontend/src/router.ts). Any other path still
# gets the app shell, which renders its 404 page, but with a real 404 status.
SPA_ROUTES = {"", "accuracy", "method", "privacy", "terms"}


@app.get("/api/{path:path}", include_in_schema=False)
def unknown_api(path: str):
    raise HTTPException(404, "Unknown API route.")


STATIC_DIR = settings.static_dir
if STATIC_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> FileResponse:
        clean = path.strip("/")
        candidate = (STATIC_DIR / clean).resolve()
        if clean and candidate.is_file() and STATIC_DIR.resolve() in candidate.parents:
            return FileResponse(candidate)
        status = 200 if clean in SPA_ROUTES else 404
        return FileResponse(STATIC_DIR / "index.html", status_code=status)
