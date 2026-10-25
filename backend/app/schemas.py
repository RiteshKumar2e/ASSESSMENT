"""Pydantic response models. They document the API (OpenAPI at /docs) and validate output."""

from __future__ import annotations

from typing import Generic, Literal, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class Metrics(BaseModel):
    """Accuracy statistics. Error = forecast - actual (MW); positive means wind under-delivered."""

    n: int = Field(description="Matched hourly observations")
    mae: float | None = Field(None, description="Mean absolute error, MW")
    rmse: float | None = Field(None, description="Root mean squared error, MW")
    bias: float | None = Field(None, description="Mean(forecast - actual), MW")
    nmae: float | None = Field(None, description="MAE / mean actual")
    wape: float | None = Field(None, description="sum|F-A| / sum A; null when sum A is 0")
    mean_actual: float | None = None
    mean_horizon_h: float | None = Field(None, description="Mean lead time, hours")
    p50_abs: float | None = None
    p90_abs: float | None = None
    max_abs: float | None = None
    q10: float | None = Field(None, description="10th percentile of signed error")
    q90: float | None = Field(None, description="90th percentile of signed error (P90 shortfall)")
    q95: float | None = None
    shortfall_share: float | None = Field(None, description="Share of hours with forecast > actual")


class SlimMetrics(BaseModel):
    n: int
    mae: float | None = None
    rmse: float | None = None
    bias: float | None = None
    wape: float | None = None
    p90_abs: float | None = None
    q10: float | None = None
    q90: float | None = None
    mean_horizon_h: float | None = None


class Health(BaseModel):
    status: Literal["ok"]
    actuals: int
    forecast_runs: int
    data_mode: Literal["snapshot"] = "snapshot"
    fetched_at: str | None


class PublishSlot(BaseModel):
    time: str
    count: int


class Meta(BaseModel):
    delivery_first_day: str
    delivery_last_day: str
    default_cutoff: str
    max_horizon_h: int
    publish_schedule_utc: list[PublishSlot]
    source: str | None
    fetched_at: str | None


# --- day / overview ------------------------------------------------------------------


class HourlyPoint(BaseModel):
    time: str
    forecast: float | None
    corrected_forecast: float | None
    final_forecast: float | None
    actual: float | None
    band_low: float | None
    band_high: float | None


class HalfHourPoint(BaseModel):
    time: str
    actual: float | None


class LeadInPoint(BaseModel):
    time: str
    actual: float | None
    forecast: float | None


class DayRevision(BaseModel):
    published: str
    forecast_mwh: float
    available_at_decision: bool


class BandQuantiles(BaseModel):
    q10: float | None
    q90: float | None


class DayDetail(BaseModel):
    date: str
    decision_cutoff: str
    forecast_published: str | None
    final_forecast_published: str | None
    next_run_after_cutoff: str | None
    band_quantiles: BandQuantiles
    trailing_bias: float | None
    forecast_mwh: float
    actual_mwh: float
    metrics: Metrics
    hourly: list[HourlyPoint]
    half_hourly: list[HalfHourPoint]
    lead_in: list[LeadInPoint]
    revisions: list[DayRevision]
    expected_hours: int


class DailyRow(SlimMetrics):
    date: str
    forecast_mwh: float
    actual_mwh: float


class Overview(BaseModel):
    day: DayDetail
    month: Metrics
    daily: list[DailyRow]


# --- forecast explorer -----------------------------------------------------------------


class RunSummary(BaseModel):
    published: str
    available_at_decision: bool
    is_decision_run: bool
    hours_covered: int
    values: list[float | None] = Field(description="MW per delivery hour, aligned with `targets`")


class ForecastRow(BaseModel):
    start_time: str
    publish_time: str
    lead_h: float
    forecast_mw: float
    actual_mw: float | None
    error_mw: float | None
    abs_error_mw: float | None


class ForecastExplorer(BaseModel):
    date: str
    decision_cutoff: str
    decision_run: str | None
    selected_run: str | None
    targets: list[str]
    actual_half_hourly: list[HalfHourPoint]
    runs: list[RunSummary]
    rows: list[ForecastRow]
    metrics: Metrics


class TargetRevision(BaseModel):
    published: str
    lead_h: float
    forecast_mw: float
    available_at_decision: bool


class TargetRevisions(BaseModel):
    start_time: str
    decision_cutoff: str
    actual_mw: float | None
    revisions: list[TargetRevision]


# --- accuracy --------------------------------------------------------------------------


class HourRow(SlimMetrics):
    hour: int


class HistogramBin(BaseModel):
    from_mw: int = Field(alias="from")
    to_mw: int = Field(alias="to")
    count: int

    model_config = {"populate_by_name": True}


class ScatterPoint(BaseModel):
    time: str
    forecast: float
    actual: float


class LeadBucket(SlimMetrics):
    from_h: int
    to_h: int


class Finding(BaseModel):
    rule: str
    text: str


class Accuracy(BaseModel):
    mode: Literal["decision", "horizon"]
    summary: Metrics
    corrected_summary: Metrics | None
    by_hour: list[HourRow]
    daily: list[DailyRow]
    histogram: list[HistogramBin]
    scatter: list[ScatterPoint]
    lead_buckets: list[LeadBucket]
    findings: list[Finding]


class HorizonPoint(SlimMetrics):
    horizon_h: int


# --- data explorer ----------------------------------------------------------------------


class Page(BaseModel, Generic[T]):
    total: int
    page: int
    page_size: int
    rows: list[T]


class ActualRecord(BaseModel):
    start_time: str
    generation_mw: float


class ForecastRecord(BaseModel):
    publish_time: str
    start_time: str
    lead_h: float
    generation_mw: float


class MatchedRecord(BaseModel):
    delivery_date: str
    start_time: str
    publish_time: str
    lead_h: float
    forecast_mw: float
    actual_mw: float
    error_mw: float
    abs_error_mw: float


class Unmatched(BaseModel):
    start_time: str
    reason: str


class ShortDay(BaseModel):
    date: str
    runs: int


class DataQuality(BaseModel):
    first_delivery_day: str
    last_delivery_day: str
    actual_intervals_expected: int
    actual_intervals_present: int
    missing_actuals: list[str]
    forecast_runs: int
    expected_runs_per_day: int
    days_with_missing_runs: list[ShortDay]
    matched_hours_expected: int
    matched_hours: int
    unmatched: list[Unmatched]
    cleaning: dict
    source: str | None
    fetched_at: str | None
    requested: dict
