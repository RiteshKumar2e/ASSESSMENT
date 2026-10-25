"""Elexon client behaviour against a mocked transport (no network)."""

from datetime import date, datetime, timezone

import httpx
import pytest

from app import elexon


def client_for(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(elexon._time, "sleep", lambda s: None)


def test_actuals_are_chunked_by_week_and_filtered_to_wind():
    calls = []

    def handler(request: httpx.Request):
        calls.append(dict(request.url.params))
        return httpx.Response(
            200, json=[{"fuelType": "WIND", "startTime": "x"}, {"fuelType": "CCGT", "startTime": "y"}]
        )

    rows = elexon.fetch_wind_actuals(date(2026, 1, 1), date(2026, 1, 10), client=client_for(handler))
    assert [(c["settlementDateFrom"], c["settlementDateTo"]) for c in calls] == [
        ("2026-01-01", "2026-01-07"),
        ("2026-01-08", "2026-01-10"),
    ]
    assert all(c["fuelType"] == "WIND" for c in calls)
    assert len(rows) == 2 and all(r["fuelType"] == "WIND" for r in rows)


def test_forecast_publish_window_is_chunked():
    calls = []

    def handler(request: httpx.Request):
        calls.append(request.url.params["publishDateTimeFrom"])
        return httpx.Response(200, json=[])

    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    end = datetime(2026, 1, 15, tzinfo=timezone.utc)
    assert elexon.fetch_wind_forecasts(start, end, client=client_for(handler)) == []
    assert calls == ["2026-01-01T00:00:00Z", "2026-01-08T00:00:00Z"]


def test_retries_rate_limit_then_succeeds():
    responses = iter([httpx.Response(429, headers={"Retry-After": "1"}), httpx.Response(200, json=[{"a": 1}])])
    rows = elexon._get(client_for(lambda r: next(responses)), "/x", {})
    assert rows == [{"a": 1}]


def test_gives_up_after_repeated_server_errors():
    with pytest.raises(elexon.ElexonError, match="HTTP 503"):
        elexon._get(client_for(lambda r: httpx.Response(503)), "/x", {})


def test_network_errors_raise_elexon_error():
    def handler(request):
        raise httpx.ConnectError("boom")

    with pytest.raises(elexon.ElexonError, match="network error"):
        elexon._get(client_for(handler), "/x", {})


@pytest.mark.parametrize("body", ['{"data": []}', "not json", "[1, 2]"])
def test_malformed_responses_are_rejected(body):
    with pytest.raises(elexon.ElexonError):
        elexon._get(client_for(lambda r: httpx.Response(200, text=body)), "/x", {})


def test_client_error_is_not_retried():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(400)

    with pytest.raises(elexon.ElexonError, match="HTTP 400"):
        elexon._get(client_for(handler), "/x", {})
    assert len(calls) == 1
