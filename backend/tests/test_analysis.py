from datetime import date, datetime, time, timedelta, timezone

import pytest

from app import analysis as a
from app.store import Dataset, ForecastRun

UTC = timezone.utc


def ts(day: int, hour: int, minute: int = 0, month: int = 1) -> datetime:
    return datetime(2026, month, day, hour, minute, tzinfo=UTC)


def make_dataset(offset_mw: float = 100.0) -> Dataset:
    """Actuals are a flat 1000 MW; every run forecasts 1000 + offset for 3 days ahead.

    Runs are published daily at 07:30 and 09:30 UTC, mirroring the real schedule
    around the 09:20 gate closure.
    """
    actuals = {}
    t = ts(1, 0)
    while t < ts(10, 0):
        actuals[t] = 1000.0
        t += timedelta(minutes=30)
    runs = []
    for d in range(1, 9):
        for hh, mm, extra in ((7, 30, 0.0), (9, 30, 50.0)):
            pub = ts(d, hh, mm)
            start = pub.replace(minute=0) + timedelta(hours=1)
            pts = {start + timedelta(hours=i): 1000.0 + offset_mw + extra for i in range(60)}
            runs.append(ForecastRun(pub, pts))
    return Dataset(actuals=actuals, runs=runs)


def test_decision_cutoff_is_previous_day_local_time():
    assert a.decision_cutoff(date(2026, 1, 15), time(9, 20)) == ts(14, 9, 20)


def test_decision_cutoff_respects_bst():
    # 1 July is BST (UTC+1): 09:20 local == 08:20 UTC.
    assert a.decision_cutoff(date(2026, 7, 1), time(9, 20)) == datetime(2026, 6, 30, 8, 20, tzinfo=UTC)


def test_clock_change_days_have_23_and_25_hours():
    assert len(a.hourly_targets(date(2026, 3, 29))) == 23
    assert len(a.hourly_targets(date(2026, 10, 25))) == 25
    assert len(a.hourly_targets(date(2026, 1, 15))) == 24


def test_decision_uses_run_published_before_cutoff_not_after():
    ds = make_dataset()
    pairs = a.decision_pairs(ds, time(9, 20), [date(2026, 1, 5)])
    assert len(pairs) == 24
    # The 09:30 run (+50 MW) is published after gate closure and must be ignored.
    assert {p.published for p in pairs} == {ts(4, 7, 30)}
    assert all(p.error == pytest.approx(100.0) for p in pairs)


def test_later_cutoff_picks_up_later_run():
    ds = make_dataset()
    pairs = a.decision_pairs(ds, time(10, 0), [date(2026, 1, 5)])
    assert {p.published for p in pairs} == {ts(4, 9, 30)}


def test_horizon_pairs_respect_minimum_lead_time():
    ds = make_dataset()
    for p in a.horizon_pairs(ds, 6, [date(2026, 1, 5)]):
        assert p.target - p.published >= timedelta(hours=6)


def test_metrics_signs_and_values():
    ds = make_dataset(offset_mw=200.0)
    m = a.metrics(a.decision_pairs(ds, time(9, 20), [date(2026, 1, 5)]))
    assert m["mae"] == pytest.approx(200.0)
    assert m["rmse"] == pytest.approx(200.0)
    assert m["bias"] == pytest.approx(200.0)  # forecast above actual => positive (shortfall)
    assert m["nmae"] == pytest.approx(0.2)
    assert m["shortfall_share"] == 1.0


def test_metrics_empty():
    assert a.metrics([]) == {"n": 0}


def test_quantile_matches_linear_interpolation():
    assert a.quantile([1, 2, 3, 4], 0.5) == pytest.approx(2.5)
    assert a.quantile([10], 0.9) == 10
    assert a.quantile([], 0.5) is None


def test_trailing_bias_uses_only_settled_days():
    ds = make_dataset(offset_mw=100.0)
    # Day 5's decision is on day 4 09:20; day 3 is the latest fully-settled delivery day.
    bias = a.trailing_bias(ds, date(2026, 1, 5), time(9, 20), window_days=2)
    assert bias == pytest.approx(100.0)


def test_corrected_pairs_remove_constant_bias():
    ds = make_dataset(offset_mw=100.0)
    pairs = a.corrected_pairs(ds, time(9, 20), [date(2026, 1, 6)])
    assert all(p.error == pytest.approx(0.0) for p in pairs)


def test_day_detail_reports_decision_and_next_run():
    ds = make_dataset()
    cut = time(9, 20)
    detail = a.day_detail(
        ds, date(2026, 1, 5), cut, a.decision_pairs(ds, cut, a.delivery_days(date(2026, 1, 3), date(2026, 1, 8)))
    )
    assert detail["forecast_published"] == "2026-01-04T07:30:00Z"
    assert detail["next_run_after_cutoff"] == "2026-01-04T09:30:00Z"
    assert len(detail["hourly"]) == 24
    assert len(detail["half_hourly"]) == 48
    assert detail["actual_mwh"] == pytest.approx(24_000)


# --- delivery window ---------------------------------------------------------------


def test_study_window_is_decisions_made_in_january():
    days = a.delivery_days()
    assert days[0] == date(2026, 1, 2) and days[-1] == date(2026, 2, 1) and len(days) == 31
    decisions = {a.decision_cutoff(d, time(9, 20)).date() for d in days}
    assert min(decisions) == date(2026, 1, 1) and max(decisions) == date(2026, 1, 31)


# --- matching and metrics -----------------------------------------------------------


def test_missing_actuals_are_excluded_from_accuracy():
    ds = make_dataset()
    del ds.actuals[ts(5, 10)]
    del ds.actuals[ts(5, 11)]
    pairs = a.decision_pairs(ds, time(9, 20), [date(2026, 1, 5)])
    assert len(pairs) == 22
    assert ts(5, 10) not in {p.target for p in pairs}


def test_forecast_is_matched_to_actual_with_same_start_time():
    ds = make_dataset()
    ds.actuals[ts(5, 12)] = 700.0  # the :00 half-hour is the match ...
    ds.actuals[ts(5, 12, 30)] = 5000.0  # ... the :30 one is not
    pair = next(p for p in a.decision_pairs(ds, time(9, 20), [date(2026, 1, 5)]) if p.target == ts(5, 12))
    assert pair.actual == 700.0 and pair.error == pytest.approx(400.0)


def test_metrics_on_known_errors():
    pairs = [
        a.Pair(ts(5, h), date(2026, 1, 5), f, act, ts(4, 7, 30))
        for h, (f, act) in enumerate([(110, 100), (90, 100), (130, 100), (100, 100)])
    ]
    m = a.metrics(pairs)
    assert m["mae"] == pytest.approx(12.5)  # (10 + 10 + 30 + 0) / 4
    assert m["rmse"] == pytest.approx((1100 / 4) ** 0.5)
    assert m["bias"] == pytest.approx(7.5)
    assert m["wape"] == pytest.approx(50 / 400)


def test_wape_is_none_when_there_was_no_wind():
    pairs = [a.Pair(ts(5, 0), date(2026, 1, 5), 50.0, 0.0, ts(4, 7, 30))]
    m = a.metrics(pairs)
    assert m["wape"] is None and m["nmae"] is None and m["mae"] == 50.0


# --- revisions -----------------------------------------------------------------------


def test_revisions_for_one_hour_are_flagged_against_the_cutoff():
    ds = make_dataset()
    cut = a.decision_cutoff(date(2026, 1, 5), time(9, 20))
    rev = a.revisions_for_target(ds, ts(5, 12), cut)
    published = [r["published"] for r in rev["revisions"]]
    assert published == sorted(published) and len(published) > 2
    after = [r for r in rev["revisions"] if not r["available_at_decision"]]
    assert {r["published"] for r in after} == {"2026-01-04T09:30:00Z", "2026-01-05T07:30:00Z", "2026-01-05T09:30:00Z"}
    assert rev["actual_mw"] == 1000.0


def test_runs_for_day_marks_exactly_one_decision_run():
    ds = make_dataset()
    runs = a.runs_for_day(ds, date(2026, 1, 5), time(9, 20))
    decision = [r for r in runs if r["is_decision_run"]]
    assert [r["published"] for r in decision] == ["2026-01-04T07:30:00Z"]
    assert all(r["available_at_decision"] for r in runs if r["published"] <= "2026-01-04T07:30:00Z")


def test_forecast_rows_for_a_specific_run():
    ds = make_dataset()
    rows = a.forecast_rows(ds, date(2026, 1, 5), ts(4, 9, 30))
    assert len(rows) == 24
    assert rows[0]["forecast_mw"] == 1150.0 and rows[0]["error_mw"] == 150.0 and rows[0]["abs_error_mw"] == 150.0
    assert a.forecast_rows(ds, date(2026, 1, 5), ts(4, 8, 0)) == []


def test_lead_buckets_cover_expected_ranges():
    ds = make_dataset()
    buckets = a.lead_buckets(ds, [date(2026, 1, 5)])
    assert [(b["from_h"], b["to_h"]) for b in buckets] == list(a.LEAD_BUCKETS)
    assert all(b["mae"] >= 100 for b in buckets)


# --- interpretation and data quality ---------------------------------------------------


def test_interpretation_uses_computed_numbers():
    ds = make_dataset()
    pairs = a.decision_pairs(ds, time(9, 20), a.delivery_days(date(2026, 1, 3), date(2026, 1, 8)))
    s = a.metrics(pairs)
    findings = a.interpretation(s, a.daily(pairs), a.by_hour_of_day(pairs), [])
    assert findings[0]["rule"] == "|bias| >= 50% of MAE"
    assert "+100 MW" in findings[0]["text"]
    assert a.interpretation({"n": 0}, [], [], []) == []


def test_data_quality_reports_missing_actuals():
    ds = make_dataset()
    q = a.data_quality(ds, time(9, 20))
    # The synthetic data only covers 1-9 Jan, so most of the window is missing.
    assert q["actual_intervals_expected"] == 31 * 48
    assert q["actual_intervals_present"] < q["actual_intervals_expected"]
    assert q["matched_hours"] < q["matched_hours_expected"]
    assert {u["reason"] for u in q["unmatched"]} <= {
        "no forecast run before cutoff",
        "decision run does not cover this hour",
        "no actual generation",
    }
