"""API tests: the committed January 2026 snapshot, plus an empty dataset."""

import pytest
from fastapi.testclient import TestClient

from app import main
from app.store import Dataset

client = TestClient(main.app)


def test_health():
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["data_mode"] == "snapshot"
    assert body["forecast_runs"] > 200


def test_meta_exposes_study_window():
    body = client.get("/api/meta").json()
    assert body["delivery_first_day"] == "2026-01-02"
    assert body["delivery_last_day"] == "2026-02-01"
    assert body["default_cutoff"] == "09:20"


def test_overview_uses_run_published_before_cutoff():
    body = client.get("/api/overview?date=2026-01-15").json()
    day = body["day"]
    assert day["decision_cutoff"] == "2026-01-14T09:20:00Z"
    assert day["forecast_published"] == "2026-01-14T07:30:00Z"
    assert day["next_run_after_cutoff"] == "2026-01-14T09:30:00Z"
    assert len(day["hourly"]) == 24 and day["metrics"]["n"] == 24
    assert body["month"]["n"] == 31 * 24


@pytest.mark.parametrize(
    ("url", "status"),
    [
        ("/api/overview?date=2025-12-15", 404),
        ("/api/overview?date=2026-01-15&cutoff=9am", 422),
        ("/api/forecasts?date=2026-01-15&hour_from=10&hour_to=2", 422),
        ("/api/forecasts?date=2026-01-15&published=2026-01-14T08:00:00Z", 404),
        ("/api/forecasts/revisions?start_time=yesterday", 422),
        ("/api/actuals?date_from=2026-01-20&date_to=2026-01-10", 422),
        ("/api/export?dataset=explorer", 422),
        ("/api/nope", 404),
    ],
)
def test_bad_parameters(url, status):
    assert client.get(url).status_code == status


def test_forecast_explorer_specific_run_and_hour_filter():
    body = client.get("/api/forecasts?date=2026-01-15&published=2026-01-14T15:30:00Z&hour_from=6&hour_to=11").json()
    assert body["decision_run"] == "2026-01-14T07:30:00Z"
    assert body["selected_run"] == "2026-01-14T15:30:00Z"
    assert len(body["rows"]) == 6
    assert sum(r["is_decision_run"] for r in body["runs"]) == 1


def test_revisions_for_one_hour():
    body = client.get("/api/forecasts/revisions?start_time=2026-01-15T12:00:00Z").json()
    assert body["actual_mw"] is not None
    assert any(r["available_at_decision"] for r in body["revisions"])
    assert any(not r["available_at_decision"] for r in body["revisions"])


def test_accuracy_modes():
    dec = client.get("/api/accuracy?mode=decision").json()
    hor = client.get("/api/accuracy?mode=horizon&hours=4").json()
    assert dec["summary"]["n"] == 31 * 24
    assert 0 < dec["summary"]["wape"] < 1
    assert dec["corrected_summary"]["mae"] < dec["summary"]["mae"]
    assert hor["corrected_summary"] is None
    assert hor["summary"]["mae"] < dec["summary"]["mae"]
    assert len(dec["lead_buckets"]) == 5
    assert dec["findings"] and all(f["rule"] for f in dec["findings"])
    assert {"from", "to", "count"} <= set(dec["histogram"][0])


def test_horizon_curve():
    curve = client.get("/api/horizon-curve").json()
    assert curve[0]["horizon_h"] == 0
    assert curve[-1]["horizon_h"] == 48


def test_data_explorer_pagination_and_search():
    page = client.get("/api/actuals?page=2&page_size=10").json()
    assert page["total"] == 31 * 48 and page["page"] == 2 and len(page["rows"]) == 10
    matched = client.get("/api/matched?date_from=2026-01-28&date_to=2026-01-28").json()
    assert matched["total"] == 24
    searched = client.get("/api/matched?search=T05:00:00Z").json()
    assert searched["total"] == 31


def test_data_quality_on_real_snapshot():
    q = client.get("/api/data-quality").json()
    assert q["actual_intervals_present"] == q["actual_intervals_expected"] == 31 * 48
    assert q["matched_hours"] == q["matched_hours_expected"] == 31 * 24
    assert q["cleaning"]["forecasts"]["before_publish"] > 0


def test_csv_export_matches_table_filters():
    resp = client.get("/api/export?dataset=matched&date_from=2026-01-28&date_to=2026-01-28")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    lines = resp.text.strip().splitlines()
    assert lines[0].startswith("delivery_date,start_time,publish_time")
    assert len(lines) == 25
    explorer = client.get("/api/export?dataset=explorer&date=2026-01-15&hour_from=0&hour_to=5")
    assert len(explorer.text.strip().splitlines()) == 7


@pytest.fixture
def empty_dataset(monkeypatch):
    empty = Dataset(actuals={}, runs=[], meta={})
    monkeypatch.setattr(main, "get_dataset", lambda: empty)
    for fn in (
        main._decision_pairs,
        main._corrected_pairs,
        main._horizon_pairs,
        main._horizon_curve,
        main._lead_buckets,
    ):
        fn.cache_clear()
    yield
    for fn in (
        main._decision_pairs,
        main._corrected_pairs,
        main._horizon_pairs,
        main._horizon_curve,
        main._lead_buckets,
    ):
        fn.cache_clear()


def test_empty_data_returns_well_formed_empty_results(empty_dataset):
    overview = client.get("/api/overview?date=2026-01-15").json()
    assert overview["day"]["forecast_published"] is None
    assert overview["day"]["metrics"] == {"n": 0} | {k: None for k in overview["day"]["metrics"] if k != "n"}
    acc = client.get("/api/accuracy").json()
    assert acc["summary"]["n"] == 0 and acc["findings"] == [] and acc["histogram"] == []
    assert client.get("/api/actuals").json()["total"] == 0
    q = client.get("/api/data-quality").json()
    assert q["matched_hours"] == 0
    assert client.get("/api/export?dataset=actuals").text == ""


def test_security_headers_present():
    resp = client.get("/api/health")
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
    assert resp.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert "Strict-Transport-Security" not in resp.headers  # only when ENABLE_HSTS=true


def test_unknown_api_route_is_json_404():
    resp = client.get("/api/does-not-exist")
    assert resp.status_code == 404
    assert resp.json() == {"detail": "Unknown API route."}


def test_search_length_is_limited():
    assert client.get("/api/matched?search=" + "x" * 65).status_code == 422


@pytest.mark.skipif(not main.STATIC_DIR.is_dir(), reason="frontend build not present")
def test_spa_routes_and_404_status():
    for path in ["/", "/accuracy", "/method", "/privacy", "/terms"]:
        resp = client.get(path)
        assert resp.status_code == 200, path
        assert "Content-Security-Policy" in resp.headers
    missing = client.get("/no-such-page")
    assert missing.status_code == 404
    assert '<div id="root">' in missing.text


def test_daily_energy_matches_day_view():
    day = client.get("/api/overview?date=2026-01-28").json()["day"]
    daily = {d["date"]: d for d in client.get("/api/accuracy").json()["daily"]}
    assert daily["2026-01-28"]["actual_mwh"] == pytest.approx(day["actual_mwh"])
    assert daily["2026-01-28"]["forecast_mwh"] == pytest.approx(day["forecast_mwh"])


def test_export_filename_is_readable_cross_origin():
    resp = client.get("/api/export?dataset=matched", headers={"Origin": "https://example.org"})
    assert "Content-Disposition" in resp.headers.get("access-control-expose-headers", "")
    assert 'filename="wind_forecast_matched_' in resp.headers["content-disposition"]
