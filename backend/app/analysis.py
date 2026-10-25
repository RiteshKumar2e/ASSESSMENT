"""Forecast selection and accuracy analytics. Pure functions over a ``Dataset``.

Conventions
-----------
* Times are tz-aware UTC internally; delivery days are UK local days.
* Forecasts are hourly; an hourly forecast for T is compared with the FUELHH
  half-hour whose startTime is T (exact timestamp match).
* error = forecast - actual  (MW). Positive => wind under-delivered vs the forecast
  (over-forecast); negative => wind exceeded it (under-forecast). This is a wind
  forecast error, not a procurement volume: demand and prices are out of scope.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, replace
from datetime import date, datetime, time, timedelta, timezone

from .config import (
    BIAS_WINDOW_DAYS,
    CURVE_MAX_HOURS,
    DELIVERY_FIRST_DAY,
    DELIVERY_LAST_DAY,
    EXPECTED_RUNS_PER_DAY,
    LONDON,
    MAX_HORIZON_HOURS,
)
from .store import Dataset, fmt_ts


@dataclass(frozen=True)
class Pair:
    target: datetime
    day: date
    forecast: float
    actual: float
    published: datetime

    @property
    def error(self) -> float:
        return self.forecast - self.actual

    @property
    def horizon_h(self) -> float:
        return (self.target - self.published).total_seconds() / 3600


# --- calendar helpers -------------------------------------------------------------


def delivery_days(first: date = DELIVERY_FIRST_DAY, last: date = DELIVERY_LAST_DAY) -> list[date]:
    return [first + timedelta(days=i) for i in range((last - first).days + 1)]


def local_day_bounds(day: date) -> tuple[datetime, datetime]:
    """UTC [start, end) of a UK local day (23/25h on clock-change days)."""
    start = datetime.combine(day, time(0), tzinfo=LONDON).astimezone(timezone.utc)
    end = datetime.combine(day + timedelta(days=1), time(0), tzinfo=LONDON).astimezone(timezone.utc)
    return start, end


def hourly_targets(day: date) -> list[datetime]:
    start, end = local_day_bounds(day)
    n = int((end - start).total_seconds() // 3600)
    return [start + timedelta(hours=i) for i in range(n)]


def decision_cutoff(day: date, cutoff: time) -> datetime:
    """Moment (UTC) the day-ahead purchase for ``day`` is made: D-1 at local ``cutoff``."""
    return datetime.combine(day - timedelta(days=1), cutoff, tzinfo=LONDON).astimezone(timezone.utc)


# --- forecast selection -----------------------------------------------------------


def decision_pairs(ds: Dataset, cutoff: time, days: Iterable[date] | None = None) -> list[Pair]:
    """For each delivery day, the latest forecast available at the decision cutoff."""
    pairs: list[Pair] = []
    for day in days or delivery_days():
        run = ds.latest_run_at(decision_cutoff(day, cutoff))
        if run is None:
            continue
        for target in hourly_targets(day):
            fc, act = run.points.get(target), ds.actuals.get(target)
            if fc is not None and act is not None:
                pairs.append(Pair(target, day, fc, act, run.published))
    return pairs


def horizon_pairs(ds: Dataset, hours: float, days: Iterable[date] | None = None) -> list[Pair]:
    """For each target hour, the latest forecast published at least ``hours`` before it."""
    pairs: list[Pair] = []
    lead = timedelta(hours=hours)
    for day in days or delivery_days():
        for target in hourly_targets(day):
            run = ds.latest_run_at(target - lead)
            if run is None:
                continue
            fc, act = run.points.get(target), ds.actuals.get(target)
            if fc is not None and act is not None:
                pairs.append(Pair(target, day, fc, act, run.published))
    return pairs


def trailing_bias(ds: Dataset, day: date, cutoff: time, window_days: int = BIAS_WINDOW_DAYS) -> float | None:
    """Mean decision-time error over delivery days fully settled before ``day``'s cutoff.

    Day D's cutoff is on D-1, so the newest complete day is D-2. Only information
    available to the desk at decision time is used (no look-ahead).
    """
    history = [day - timedelta(days=k) for k in range(2, 2 + window_days)]
    errors = [p.error for p in decision_pairs(ds, cutoff, history)]
    return sum(errors) / len(errors) if errors else None


def corrected_pairs(ds: Dataset, cutoff: time, days: Iterable[date] | None = None) -> list[Pair]:
    """Decision-time pairs with the trailing bias removed from each day's forecast."""
    out: list[Pair] = []
    by_day: dict[date, list[Pair]] = defaultdict(list)
    for p in decision_pairs(ds, cutoff, days):
        by_day[p.day].append(p)
    for day, pairs in by_day.items():
        bias = trailing_bias(ds, day, cutoff) or 0.0
        out += [replace(p, forecast=max(p.forecast - bias, 0.0)) for p in pairs]
    return out


# --- statistics -------------------------------------------------------------------


def quantile(values: list[float], q: float) -> float | None:
    """Linear-interpolated quantile (same as numpy's default)."""
    if not values:
        return None
    xs = sorted(values)
    pos = (len(xs) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def metrics(pairs: list[Pair]) -> dict:
    n = len(pairs)
    if n == 0:
        return {"n": 0}
    errors = [p.error for p in pairs]
    abs_errors = [abs(e) for e in errors]
    mean_actual = sum(p.actual for p in pairs) / n
    mae = sum(abs_errors) / n
    total_actual = sum(p.actual for p in pairs)
    return {
        "n": n,
        "mae": mae,
        "rmse": math.sqrt(sum(e * e for e in errors) / n),
        "bias": sum(errors) / n,
        "nmae": mae / mean_actual if mean_actual else None,
        # WAPE = sum|F - A| / sum A; undefined when there was no wind at all.
        "wape": sum(abs_errors) / total_actual if total_actual > 0 else None,
        "mean_actual": mean_actual,
        "mean_horizon_h": sum(p.horizon_h for p in pairs) / n,
        "p50_abs": quantile(abs_errors, 0.5),
        "p90_abs": quantile(abs_errors, 0.9),
        "max_abs": max(abs_errors),
        "q10": quantile(errors, 0.1),
        "q90": quantile(errors, 0.9),
        "q95": quantile(errors, 0.95),
        "shortfall_share": sum(1 for e in errors if e > 0) / n,
    }


def _slim(m: dict) -> dict:
    keys = ("n", "mae", "rmse", "bias", "wape", "p90_abs", "q10", "q90", "mean_horizon_h")
    return {k: m.get(k) for k in keys}


def by_hour_of_day(pairs: list[Pair]) -> list[dict]:
    groups: dict[int, list[Pair]] = defaultdict(list)
    for p in pairs:
        groups[p.target.astimezone(LONDON).hour].append(p)
    return [{"hour": h, **_slim(metrics(groups[h]))} for h in sorted(groups)]


def actual_energy_mwh(ds: Dataset, day: date) -> float:
    """Metered wind energy for a UK delivery day: every half-hourly MW value × 0.5 h."""
    start, end = local_day_bounds(day)
    total, t = 0.0, start
    while t < end:
        total += ds.actuals.get(t, 0.0) * 0.5
        t += timedelta(minutes=30)
    return total


def daily(pairs: list[Pair], ds: Dataset | None = None) -> list[dict]:
    groups: dict[date, list[Pair]] = defaultdict(list)
    for p in pairs:
        groups[p.day].append(p)
    out = []
    for d in sorted(groups):
        g = groups[d]
        out.append(
            {
                "date": d.isoformat(),
                **_slim(metrics(g)),
                # Forecast is hourly, so 1 MW over 1 h = 1 MWh. Actual energy uses all
                # half-hours (same definition as the day view) when the dataset is given.
                "forecast_mwh": sum(p.forecast for p in g),
                "actual_mwh": actual_energy_mwh(ds, d) if ds else sum(p.actual for p in g),
            }
        )
    return out


def histogram(pairs: list[Pair], bin_mw: int = 500) -> list[dict]:
    counts: dict[int, int] = defaultdict(int)
    for p in pairs:
        counts[math.floor(p.error / bin_mw)] += 1
    if not counts:
        return []
    return [
        {"from": b * bin_mw, "to": (b + 1) * bin_mw, "count": counts.get(b, 0)}
        for b in range(min(counts), max(counts) + 1)
    ]


def scatter(pairs: list[Pair]) -> list[dict]:
    return [{"time": fmt_ts(p.target), "forecast": p.forecast, "actual": p.actual} for p in pairs]


def horizon_curve(ds: Dataset, max_hours: int = CURVE_MAX_HOURS) -> list[dict]:
    out = []
    for h in range(0, max_hours + 1):
        m = metrics(horizon_pairs(ds, h))
        if m["n"]:
            out.append({"horizon_h": h, **_slim(m)})
    return out


# --- single delivery day view -----------------------------------------------------


def day_detail(ds: Dataset, day: date, cutoff: time, all_decision_pairs: list[Pair]) -> dict:
    """Everything the desk needs for one delivery day."""
    start, end = local_day_bounds(day)
    cutoff_utc = decision_cutoff(day, cutoff)
    run = ds.latest_run_at(cutoff_utc)
    final_run = ds.latest_run_at(start - timedelta(seconds=1))
    next_runs = ds.runs_between(cutoff_utc + timedelta(seconds=1), start)
    targets = hourly_targets(day)
    bias = trailing_bias(ds, day, cutoff)

    # Uncertainty band from the *other* delivery days' decision-time errors
    # (leave-one-day-out, so the day being viewed never calibrates its own band).
    other_errors = [p.error for p in all_decision_pairs if p.day != day]
    q10, q90 = quantile(other_errors, 0.1), quantile(other_errors, 0.9)

    half_hourly = []
    t = start
    while t < end:
        half_hourly.append({"time": fmt_ts(t), "actual": ds.actuals.get(t)})
        t += timedelta(minutes=30)

    hourly = []
    for target in targets:
        fc = run.points.get(target) if run else None
        hourly.append(
            {
                "time": fmt_ts(target),
                "forecast": fc,
                "corrected_forecast": max(fc - bias, 0.0) if fc is not None and bias is not None else None,
                "final_forecast": final_run.points.get(target) if final_run else None,
                "actual": ds.actuals.get(target),
                "band_low": max(fc - q90, 0.0) if fc is not None and q90 is not None else None,
                "band_high": fc - q10 if fc is not None and q10 is not None else None,
            }
        )

    # Lead-in: what happened between the decision and the start of delivery, so the
    # chart can show the decision moment on the same time axis.
    lead_in = []
    t = cutoff_utc.replace(minute=0 if cutoff_utc.minute < 30 else 30, second=0)
    while t < start:
        lead_in.append({"time": fmt_ts(t), "actual": ds.actuals.get(t), "forecast": run.points.get(t) if run else None})
        t += timedelta(minutes=30)

    actual_mwh = actual_energy_mwh(ds, day)
    forecast_mwh = sum(h["forecast"] for h in hourly if h["forecast"] is not None)

    revisions = []
    for r in ds.runs_between(start - timedelta(hours=MAX_HORIZON_HOURS), start - timedelta(seconds=1)):
        if all(t in r.points for t in targets):
            revisions.append(
                {
                    "published": fmt_ts(r.published),
                    "forecast_mwh": sum(r.points[t] for t in targets),
                    "available_at_decision": r.published <= cutoff_utc,
                }
            )

    return {
        "date": day.isoformat(),
        "decision_cutoff": fmt_ts(cutoff_utc),
        "forecast_published": fmt_ts(run.published) if run else None,
        "final_forecast_published": fmt_ts(final_run.published) if final_run else None,
        "next_run_after_cutoff": fmt_ts(next_runs[0].published) if next_runs else None,
        "band_quantiles": {"q10": q10, "q90": q90},
        "trailing_bias": bias,
        "forecast_mwh": forecast_mwh,
        "actual_mwh": actual_mwh,
        "metrics": metrics([p for p in all_decision_pairs if p.day == day]),
        "hourly": hourly,
        "half_hourly": half_hourly,
        "lead_in": lead_in,
        "revisions": revisions,
        "expected_hours": len(targets),
    }


# --- lead-time buckets --------------------------------------------------------------

LEAD_BUCKETS = ((0, 6), (6, 12), (12, 24), (24, 36), (36, 48))


def lead_buckets(ds: Dataset, days: Iterable[date] | None = None) -> list[dict]:
    """Accuracy of *every* forecast point (not just the latest), grouped by lead time.

    Buckets are [from, to) except the last, which includes its upper edge.
    """
    targets = {t for day in (days or delivery_days()) for t in hourly_targets(day)}
    last_hi = LEAD_BUCKETS[-1][1]
    groups: dict[tuple[int, int], list[Pair]] = defaultdict(list)
    for run in ds.runs:
        for target, fc in run.points.items():
            act = ds.actuals.get(target)
            if target not in targets or act is None:
                continue
            lead = (target - run.published).total_seconds() / 3600
            for lo, hi in LEAD_BUCKETS:
                if lo <= lead < hi or (hi == last_hi and lead == hi):
                    day = target.astimezone(LONDON).date()
                    groups[(lo, hi)].append(Pair(target, day, fc, act, run.published))
                    break
    return [
        {"from_h": lo, "to_h": hi, **_slim(metrics(groups[(lo, hi)]))} for lo, hi in LEAD_BUCKETS if groups[(lo, hi)]
    ]


# --- forecast explorer ----------------------------------------------------------------


def runs_for_day(ds: Dataset, day: date, cutoff: time) -> list[dict]:
    """Every run that forecasts at least one hour of ``day``, flagged against the cutoff."""
    start, end = local_day_bounds(day)
    targets = hourly_targets(day)
    cutoff_utc = decision_cutoff(day, cutoff)
    decision = ds.latest_run_at(cutoff_utc)
    out = []
    for r in ds.runs_between(start - timedelta(hours=MAX_HORIZON_HOURS), end):
        values = [r.points.get(t) for t in targets]
        covered = sum(v is not None for v in values)
        if covered:
            out.append(
                {
                    "published": fmt_ts(r.published),
                    "available_at_decision": r.published <= cutoff_utc,
                    "is_decision_run": decision is not None and r.published == decision.published,
                    "hours_covered": covered,
                    "values": values,
                }
            )
    return out


def forecast_rows(ds: Dataset, day: date, run_published: datetime) -> list[dict]:
    """Hourly table for one run over one delivery day, matched to actuals."""
    run = ds.run_at(run_published)
    if run is None:
        return []
    rows = []
    for target in hourly_targets(day):
        fc = run.points.get(target)
        if fc is None:
            continue
        act = ds.actuals.get(target)
        err = fc - act if act is not None else None
        rows.append(
            {
                "start_time": fmt_ts(target),
                "publish_time": fmt_ts(run.published),
                "lead_h": (target - run.published).total_seconds() / 3600,
                "forecast_mw": fc,
                "actual_mw": act,
                "error_mw": err,
                "abs_error_mw": abs(err) if err is not None else None,
            }
        )
    return rows


def revisions_for_target(ds: Dataset, target: datetime, cutoff_utc: datetime) -> dict:
    """How the forecast for one delivery hour changed across successive runs."""
    rows = [
        {
            "published": fmt_ts(r.published),
            "lead_h": (target - r.published).total_seconds() / 3600,
            "forecast_mw": r.points[target],
            "available_at_decision": r.published <= cutoff_utc,
        }
        for r in ds.runs_between(target - timedelta(hours=MAX_HORIZON_HOURS), target)
        if target in r.points
    ]
    return {"start_time": fmt_ts(target), "actual_mw": ds.actuals.get(target), "revisions": rows}


# --- matched observations ---------------------------------------------------------------


def matched_rows(pairs: list[Pair]) -> list[dict]:
    return [
        {
            "delivery_date": p.day.isoformat(),
            "start_time": fmt_ts(p.target),
            "publish_time": fmt_ts(p.published),
            "lead_h": p.horizon_h,
            "forecast_mw": p.forecast,
            "actual_mw": p.actual,
            "error_mw": p.error,
            "abs_error_mw": abs(p.error),
        }
        for p in pairs
    ]


# --- rule-based interpretation ------------------------------------------------------------


def interpretation(summary: dict, daily_rows: list[dict], by_hour: list[dict], buckets: list[dict]) -> list[dict]:
    """Plain-language findings, each produced by a stated rule over computed numbers."""
    out: list[dict] = []
    if not summary.get("n"):
        return out
    mae, bias = summary["mae"], summary["bias"]
    share = summary["shortfall_share"]
    if abs(bias) >= 0.5 * mae:
        direction = "over-forecast" if bias > 0 else "under-forecast"
        hours_share = share if bias > 0 else 1 - share
        out.append(
            {
                "rule": "|bias| >= 50% of MAE",
                "text": f"Errors are systematic, not random. Wind was {direction} in {hours_share:.0%} of hours, "
                f"with a mean bias of {bias:+,.0f} MW against an MAE of {mae:,.0f} MW.",
            }
        )
    else:
        out.append(
            {
                "rule": "|bias| < 50% of MAE",
                "text": f"Errors are mostly random: the mean bias of {bias:+,.0f} MW is small relative to the "
                f"{mae:,.0f} MW MAE.",
            }
        )
    if summary.get("q90") is not None:
        out.append(
            {
                "rule": "90th percentile of signed error",
                "text": f"In 9 of 10 hours, wind fell short of the forecast by less than {summary['q90']:,.0f} MW "
                "(or exceeded it).",
            }
        )
    if daily_rows:
        worst = max(daily_rows, key=lambda d: d["mae"])
        out.append(
            {
                "rule": "delivery day with the highest MAE",
                "text": f"The worst day was {_uk_date(worst['date'])}: "
                f"MAE {worst['mae']:,.0f} MW, bias {worst['bias']:+,.0f} MW.",
            }
        )
    if by_hour:
        peak = max(by_hour, key=lambda h: h["mae"])
        out.append(
            {
                "rule": "hour of day with the highest MAE",
                "text": f"Errors were largest around {peak['hour']:02d}:00 UK time (MAE {peak['mae']:,.0f} MW).",
            }
        )
    if len(buckets) >= 2 and buckets[0]["mae"]:
        growth = buckets[-1]["mae"] / buckets[0]["mae"] - 1
        out.append(
            {
                "rule": "MAE of the longest vs shortest lead-time bucket",
                "text": f"Forecasts made {buckets[-1]['from_h']}-{buckets[-1]['to_h']} h ahead have {growth:+.0%} MAE "
                f"compared with those made {buckets[0]['from_h']}-{buckets[0]['to_h']} h ahead.",
            }
        )
    return out


# --- data quality ---------------------------------------------------------------------------


def data_quality(ds: Dataset, cutoff: time) -> dict:
    first, _ = local_day_bounds(DELIVERY_FIRST_DAY)
    _, last = local_day_bounds(DELIVERY_LAST_DAY)
    expected, missing = 0, []
    t = first
    while t < last:
        expected += 1
        if t not in ds.actuals:
            missing.append(fmt_ts(t))
        t += timedelta(minutes=30)

    runs_by_day: dict[date, int] = defaultdict(int)
    for r in ds.runs:
        runs_by_day[r.published.astimezone(LONDON).date()] += 1
    publish_days = delivery_days(DELIVERY_FIRST_DAY - timedelta(days=1), DELIVERY_LAST_DAY - timedelta(days=1))
    short_days = [
        {"date": d.isoformat(), "runs": runs_by_day.get(d, 0)}
        for d in publish_days
        if runs_by_day.get(d, 0) < EXPECTED_RUNS_PER_DAY
    ]

    expected_pairs = sum(len(hourly_targets(d)) for d in delivery_days())
    unmatched = []
    for day in delivery_days():
        run = ds.latest_run_at(decision_cutoff(day, cutoff))
        for target in hourly_targets(day):
            reason = None
            if run is None:
                reason = "no forecast run before cutoff"
            elif target not in run.points:
                reason = "decision run does not cover this hour"
            elif target not in ds.actuals:
                reason = "no actual generation"
            if reason:
                unmatched.append({"start_time": fmt_ts(target), "reason": reason})

    return {
        "first_delivery_day": DELIVERY_FIRST_DAY.isoformat(),
        "last_delivery_day": DELIVERY_LAST_DAY.isoformat(),
        "actual_intervals_expected": expected,
        "actual_intervals_present": expected - len(missing),
        "missing_actuals": missing[:100],
        "forecast_runs": len(ds.runs),
        "expected_runs_per_day": EXPECTED_RUNS_PER_DAY,
        "days_with_missing_runs": short_days,
        "matched_hours_expected": expected_pairs,
        "matched_hours": expected_pairs - len(unmatched),
        "unmatched": unmatched[:100],
        "cleaning": ds.meta.get("cleaning", {}),
        "source": ds.meta.get("source"),
        "fetched_at": ds.meta.get("fetched_at"),
        "requested": ds.meta.get("requested", {}),
    }


def _uk_date(iso: str) -> str:
    """'2026-01-28' -> 'Wed 28 Jan 2026'."""
    d = date.fromisoformat(iso)
    return f"{d:%a} {d.day} {d:%b %Y}"
