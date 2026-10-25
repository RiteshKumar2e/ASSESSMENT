"""Cleaning rules applied when raw Elexon rows become a Dataset."""

from datetime import datetime, timezone

from app.store import Dataset

UTC = timezone.utc


def ts(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 1, 2, hour, minute, tzinfo=UTC)


def actual(start: str, gen, pub: str | None = None) -> dict:
    row = {"startTime": start, "generation": gen, "fuelType": "WIND"}
    if pub:
        row["publishTime"] = pub
    return row


def fc(pub: str, start: str, gen) -> dict:
    return {"publishTime": pub, "startTime": start, "generation": gen}


def test_invalid_actuals_are_rejected_and_counted():
    rows = [
        actual("2026-01-02T08:00:00Z", 100),
        actual("2026-01-02T08:30:00Z", None),
        actual("2026-01-02T09:00:00Z", "abc"),
        actual("2026-01-02T09:30:00Z", -5),
        actual("2026-01-02T10:00:00Z", float("nan")),
        actual("not-a-time", 10),
        {"generation": 10},
    ]
    ds = Dataset.from_raw(rows, [])
    assert ds.actuals == {ts(8): 100.0}
    assert ds.meta["cleaning"]["actuals"] == {"received": 7, "invalid": 6, "duplicate": 0, "kept": 1}


def test_duplicate_actual_latest_publication_wins_regardless_of_order():
    newer = actual("2026-01-02T08:00:00Z", 2, "2026-01-02T09:30:00Z")
    older = actual("2026-01-02T08:00:00Z", 1, "2026-01-02T08:30:00Z")
    assert Dataset.from_raw([older, newer], []).actuals[ts(8)] == 2
    assert Dataset.from_raw([newer, older], []).actuals[ts(8)] == 2
    assert Dataset.from_raw([older, newer], []).meta["cleaning"]["actuals"]["duplicate"] == 1


def test_exact_duplicate_actual_keeps_last_row():
    rows = [
        actual("2026-01-02T08:00:00Z", 1, "2026-01-02T08:30:00Z"),
        actual("2026-01-02T08:00:00Z", 3, "2026-01-02T08:30:00Z"),
    ]
    assert Dataset.from_raw(rows, []).actuals[ts(8)] == 3


def test_forecast_points_before_publish_time_are_dropped():
    rows = [
        fc("2026-01-02T07:30:00Z", "2026-01-02T06:00:00Z", 1),
        fc("2026-01-02T07:30:00Z", "2026-01-02T08:00:00Z", 2),
    ]
    ds = Dataset.from_raw([], rows)
    assert list(ds.runs[0].points) == [ts(8)]
    assert ds.meta["cleaning"]["forecasts"]["before_publish"] == 1


def test_forecast_duplicates_and_invalid_values():
    rows = [
        fc("2026-01-02T07:30:00Z", "2026-01-02T08:00:00Z", 2),
        fc("2026-01-02T07:30:00Z", "2026-01-02T08:00:00Z", 5),
        fc("2026-01-02T07:30:00Z", "2026-01-02T09:00:00Z", None),
        fc("garbage", "2026-01-02T09:00:00Z", 1),
    ]
    ds = Dataset.from_raw([], rows)
    assert ds.runs[0].points == {ts(8): 5.0}
    stats = ds.meta["cleaning"]["forecasts"]
    assert (stats["duplicate"], stats["invalid"], stats["kept"], stats["runs"]) == (1, 2, 1, 1)


def test_multiple_runs_are_kept_separately_and_sorted():
    rows = [
        fc("2026-01-02T09:30:00Z", "2026-01-02T12:00:00Z", 3),
        fc("2026-01-02T07:30:00Z", "2026-01-02T12:00:00Z", 1),
    ]
    ds = Dataset.from_raw([], rows)
    assert [r.published for r in ds.runs] == [ts(7, 30), ts(9, 30)]
    assert ds.run_at(ts(9, 30)).points[ts(12)] == 3
    assert ds.run_at(ts(8)) is None


def test_snapshot_roundtrip_preserves_data_and_meta():
    ds = Dataset.from_raw([actual("2026-01-02T08:00:00Z", 1)], [fc("2026-01-02T07:30:00Z", "2026-01-02T08:00:00Z", 2)])
    again = Dataset.from_json(ds.to_json())
    assert again.actuals == ds.actuals
    assert again.runs == ds.runs
    assert again.meta == ds.meta
