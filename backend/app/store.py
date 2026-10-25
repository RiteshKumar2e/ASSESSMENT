"""In-memory dataset of wind actuals and forecast runs, backed by a JSON snapshot.

The study window (January 2026) is historical, so the data is fetched once from
Elexon and committed as ``data/snapshot.json``. This keeps the deployed app fast and
independent of upstream availability. ``python -m app.snapshot`` rebuilds it.

Cleaning rules applied in :meth:`Dataset.from_raw` (all counted in ``quality``):

* rows with a missing/unparseable timestamp or a missing, non-numeric, NaN or
  negative ``generation`` are rejected;
* duplicate actuals for one ``startTime``: the latest ``publishTime`` wins, and on an
  exact tie the row that appears last in the response wins;
* duplicate forecast rows for one (``publishTime``, ``startTime``): the last row wins;
* forecast rows whose ``startTime`` is before their ``publishTime`` are dropped:
  each WINDFOR run restates a few elapsed hours, and those are not forecasts.
"""

from __future__ import annotations

import bisect
import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

from .config import settings


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def fmt_ts(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _valid_generation(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    value = float(value)
    return value if math.isfinite(value) and value >= 0 else None


def _valid_ts(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return parse_ts(value)
    except ValueError:
        return None


@dataclass(frozen=True)
class ForecastRun:
    """One WINDFOR publication: hourly MW values keyed by target start time."""

    published: datetime
    points: dict[datetime, float]


@dataclass
class Dataset:
    actuals: dict[datetime, float]
    runs: list[ForecastRun]  # sorted by publish time
    meta: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.runs.sort(key=lambda r: r.published)
        self._publish_times = [r.published for r in self.runs]

    def latest_run_at(self, moment: datetime) -> ForecastRun | None:
        """Most recent forecast run published at or before ``moment``."""
        idx = bisect.bisect_right(self._publish_times, moment) - 1
        return self.runs[idx] if idx >= 0 else None

    def runs_between(self, start: datetime, end: datetime) -> list[ForecastRun]:
        """Runs with ``start <= published <= end``."""
        lo = bisect.bisect_left(self._publish_times, start)
        hi = bisect.bisect_right(self._publish_times, end)
        return self.runs[lo:hi]

    def run_at(self, published: datetime) -> ForecastRun | None:
        idx = bisect.bisect_left(self._publish_times, published)
        if idx < len(self.runs) and self._publish_times[idx] == published:
            return self.runs[idx]
        return None

    @classmethod
    def from_raw(cls, actual_rows: list[dict], forecast_rows: list[dict], meta: dict | None = None) -> Dataset:
        """Build from raw Elexon rows, applying the cleaning rules in the module docstring."""
        aq = {"received": len(actual_rows), "invalid": 0, "duplicate": 0}
        latest_actual: dict[datetime, tuple[datetime | None, float]] = {}
        for row in actual_rows:
            start = _valid_ts(row.get("startTime"))
            gen = _valid_generation(row.get("generation"))
            if start is None or gen is None:
                aq["invalid"] += 1
                continue
            pub = _valid_ts(row.get("publishTime"))
            if start in latest_actual:
                aq["duplicate"] += 1
                prev_pub = latest_actual[start][0]
                if prev_pub is not None and (pub is None or pub < prev_pub):
                    continue
            latest_actual[start] = (pub, gen)
        actuals = {k: v for k, (_, v) in latest_actual.items()}
        aq["kept"] = len(actuals)

        fq = {"received": len(forecast_rows), "invalid": 0, "duplicate": 0, "before_publish": 0}
        grouped: dict[datetime, dict[datetime, float]] = {}
        for row in forecast_rows:
            published = _valid_ts(row.get("publishTime"))
            start = _valid_ts(row.get("startTime"))
            gen = _valid_generation(row.get("generation"))
            if published is None or start is None or gen is None:
                fq["invalid"] += 1
                continue
            if start < published:
                fq["before_publish"] += 1
                continue
            points = grouped.setdefault(published, {})
            if start in points:
                fq["duplicate"] += 1
            points[start] = gen
        runs = [ForecastRun(p, pts) for p, pts in grouped.items()]
        fq["kept"] = sum(len(r.points) for r in runs)
        fq["runs"] = len(runs)

        meta = dict(meta or {})
        meta["cleaning"] = {"actuals": aq, "forecasts": fq}
        return cls(actuals=actuals, runs=runs, meta=meta)

    # --- snapshot (de)serialisation -------------------------------------------------

    def to_json(self) -> dict:
        return {
            "meta": self.meta,
            "actuals": [[fmt_ts(k), v] for k, v in sorted(self.actuals.items())],
            "forecasts": {
                fmt_ts(run.published): [[fmt_ts(k), v] for k, v in sorted(run.points.items())] for run in self.runs
            },
        }

    @classmethod
    def from_json(cls, payload: dict) -> Dataset:
        actuals = {parse_ts(k): float(v) for k, v in payload["actuals"]}
        runs = [
            ForecastRun(parse_ts(pub), {parse_ts(k): float(v) for k, v in pts})
            for pub, pts in payload["forecasts"].items()
        ]
        return cls(actuals=actuals, runs=runs, meta=payload.get("meta", {}))


def load_snapshot(path: Path | None = None) -> Dataset:
    with (path or settings.snapshot_path).open(encoding="utf-8") as fh:
        return Dataset.from_json(json.load(fh))


@lru_cache(maxsize=1)
def get_dataset() -> Dataset:
    return load_snapshot()
