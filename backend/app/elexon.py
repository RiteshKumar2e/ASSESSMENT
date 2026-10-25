"""Client for the Elexon BMRS Insights API stream endpoints.

Both datasets are public (no API key). The ``/stream`` endpoints return a plain JSON
array with no pagination, so large windows are split into 7-day chunks to keep each
response small. Transient failures (timeouts, 5xx, 429) are retried with backoff.
"""

from __future__ import annotations

import logging
import time as _time
from datetime import date, datetime, timedelta

import httpx

from .config import ELEXON_BASE_URL

log = logging.getLogger(__name__)

CHUNK_DAYS = 7
MAX_ATTEMPTS = 4
RETRY_STATUS = {429, 500, 502, 503, 504}


class ElexonError(RuntimeError):
    """Elexon could not be reached or returned something unusable."""


def _get(client: httpx.Client, path: str, params: dict, sleep=_time.sleep) -> list[dict]:
    url = f"{ELEXON_BASE_URL}{path}"
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = client.get(url, params=params, timeout=60)
        except httpx.TransportError as exc:
            if attempt == MAX_ATTEMPTS:
                raise ElexonError(f"{path}: network error after {attempt} attempts: {exc}") from exc
            log.warning("Elexon %s network error (attempt %d): %s", path, attempt, exc)
            sleep(2**attempt)
            continue

        if resp.status_code in RETRY_STATUS and attempt < MAX_ATTEMPTS:
            wait = float(resp.headers.get("Retry-After", 2**attempt))
            log.warning("Elexon %s returned %d (attempt %d), retrying in %.0fs", path, resp.status_code, attempt, wait)
            sleep(wait)
            continue
        if resp.status_code != 200:
            raise ElexonError(f"{path}: HTTP {resp.status_code}")

        try:
            body = resp.json()
        except ValueError as exc:
            raise ElexonError(f"{path}: response is not JSON") from exc
        if not isinstance(body, list) or not all(isinstance(r, dict) for r in body):
            raise ElexonError(f"{path}: expected a JSON array of records")
        return body
    raise ElexonError(f"{path}: gave up after {MAX_ATTEMPTS} attempts")


def fetch_wind_actuals(first: date, last: date, client: httpx.Client | None = None) -> list[dict]:
    """FUELHH half-hourly outturn for WIND, settlement dates first..last inclusive."""
    rows: list[dict] = []
    with client or httpx.Client() as c:
        start = first
        while start <= last:
            end = min(start + timedelta(days=CHUNK_DAYS - 1), last)
            params = {"settlementDateFrom": start.isoformat(), "settlementDateTo": end.isoformat(), "fuelType": "WIND"}
            rows += _get(c, "/datasets/FUELHH/stream", params)
            start = end + timedelta(days=1)
    # The fuelType filter is applied server-side; re-check so nothing else slips in.
    return [r for r in rows if r.get("fuelType") == "WIND"]


def fetch_wind_forecasts(
    published_from: datetime, published_to: datetime, client: httpx.Client | None = None
) -> list[dict]:
    """WINDFOR forecasts with publishTime in [published_from, published_to)."""
    rows: list[dict] = []
    with client or httpx.Client() as c:
        start = published_from
        while start < published_to:
            end = min(start + timedelta(days=CHUNK_DAYS), published_to)
            params = {
                "publishDateTimeFrom": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "publishDateTimeTo": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            rows += _get(c, "/datasets/WINDFOR/stream", params)
            start = end
    return rows
