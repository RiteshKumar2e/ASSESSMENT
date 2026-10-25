"""Rebuild data/snapshot.json from the Elexon API.

Usage:  python -m app.snapshot
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, time, timedelta, timezone

from .config import DELIVERY_FIRST_DAY, DELIVERY_LAST_DAY, MAX_HORIZON_HOURS, WARMUP_DAYS, settings
from .elexon import fetch_wind_actuals, fetch_wind_forecasts
from .store import Dataset, fmt_ts


def build() -> Dataset:
    # Actuals: every delivery day, plus a warm-up period for the bias correction.
    first_day = DELIVERY_FIRST_DAY - timedelta(days=WARMUP_DAYS)
    actuals = fetch_wind_actuals(first_day, DELIVERY_LAST_DAY)
    # Forecasts: every run that could be "latest" for a target in the window at any
    # supported lead time, up to the end of the last delivery day.
    pub_from = datetime.combine(first_day, time(0), tzinfo=timezone.utc) - timedelta(hours=MAX_HORIZON_HOURS + 6)
    pub_to = datetime.combine(DELIVERY_LAST_DAY + timedelta(days=1), time(0), tzinfo=timezone.utc)
    forecasts = fetch_wind_forecasts(pub_from, pub_to)
    meta = {
        "source": "Elexon BMRS Insights API (FUELHH fuelType=WIND, WINDFOR)",
        "fetched_at": fmt_ts(datetime.now(timezone.utc)),
        "requested": {
            "fuelhh_settlement_dates": [first_day.isoformat(), DELIVERY_LAST_DAY.isoformat()],
            "windfor_publish_times": [fmt_ts(pub_from), fmt_ts(pub_to)],
        },
    }
    return Dataset.from_raw(actuals, forecasts, meta)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    dataset = build()
    path = settings.snapshot_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dataset.to_json(), separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {path}: {len(dataset.actuals)} actuals, {len(dataset.runs)} forecast runs")
    print("Cleaning:", json.dumps(dataset.meta["cleaning"]))


if __name__ == "__main__":
    main()
