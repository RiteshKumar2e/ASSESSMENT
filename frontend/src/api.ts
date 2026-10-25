// Typed client for the FastAPI backend. Shapes mirror backend/app/schemas.py.

export interface Metrics {
  n: number;
  mae?: number | null;
  rmse?: number | null;
  bias?: number | null;
  nmae?: number | null;
  wape?: number | null;
  mean_actual?: number | null;
  mean_horizon_h?: number | null;
  p50_abs?: number | null;
  p90_abs?: number | null;
  max_abs?: number | null;
  q10?: number | null;
  q90?: number | null;
  q95?: number | null;
  shortfall_share?: number | null;
}

export interface Slim {
  n: number;
  mae: number;
  rmse: number;
  bias: number;
  wape: number | null;
  p90_abs: number;
  q10: number;
  q90: number;
  mean_horizon_h: number;
}

export interface Meta {
  delivery_first_day: string;
  delivery_last_day: string;
  default_cutoff: string;
  max_horizon_h: number;
  publish_schedule_utc: { time: string; count: number }[];
  source: string | null;
  fetched_at: string | null;
}

export interface HourlyPoint {
  time: string;
  forecast: number | null;
  corrected_forecast: number | null;
  final_forecast: number | null;
  actual: number | null;
  band_low: number | null;
  band_high: number | null;
}

export interface DayDetail {
  date: string;
  decision_cutoff: string;
  forecast_published: string | null;
  final_forecast_published: string | null;
  next_run_after_cutoff: string | null;
  band_quantiles: { q10: number | null; q90: number | null };
  trailing_bias: number | null;
  forecast_mwh: number;
  actual_mwh: number;
  metrics: Metrics;
  hourly: HourlyPoint[];
  half_hourly: { time: string; actual: number | null }[];
  revisions: { published: string; forecast_mwh: number; available_at_decision: boolean }[];
  expected_hours: number;
}

export type DailyRow = Slim & { date: string; forecast_mwh: number; actual_mwh: number };

export interface Overview {
  day: DayDetail;
  month: Metrics;
  daily: DailyRow[];
}

export interface Accuracy {
  mode: "decision" | "horizon";
  summary: Metrics;
  corrected_summary: Metrics | null;
  by_hour: (Slim & { hour: number })[];
  daily: DailyRow[];
  histogram: { from: number; to: number; count: number }[];
  scatter: { time: string; forecast: number; actual: number }[];
  lead_buckets: (Slim & { from_h: number; to_h: number })[];
  findings: { rule: string; text: string }[];
}

export type HorizonPoint = Slim & { horizon_h: number };

export interface Page<T> {
  total: number;
  page: number;
  page_size: number;
  rows: T[];
}

export interface MatchedRecord {
  delivery_date: string;
  start_time: string;
  publish_time: string;
  lead_h: number;
  forecast_mw: number;
  actual_mw: number;
  error_mw: number;
  abs_error_mw: number;
}

export interface DataQuality {
  first_delivery_day: string;
  last_delivery_day: string;
  actual_intervals_expected: number;
  actual_intervals_present: number;
  missing_actuals: string[];
  forecast_runs: number;
  expected_runs_per_day: number;
  days_with_missing_runs: { date: string; runs: number }[];
  matched_hours_expected: number;
  matched_hours: number;
  unmatched: { start_time: string; reason: string }[];
  cleaning: {
    actuals?: { received: number; invalid: number; duplicate: number; kept: number };
    forecasts?: { received: number; invalid: number; duplicate: number; before_publish: number; kept: number; runs: number };
  };
  source: string | null;
  fetched_at: string | null;
  requested: { fuelhh_settlement_dates?: string[]; windfor_publish_times?: string[] };
}

// Empty in dev and when served by FastAPI (same origin); set for a separately hosted API.
export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

/** Fetch with user-facing error messages. Server details are only shown for our own 4xx messages. */
async function request(path: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`);
  } catch {
    throw new Error("The data service could not be reached. Check your connection and that the API is running.");
  }
  if (res.ok) return res;
  if (res.status >= 500) throw new Error("The data service hit an unexpected problem. Please try again.");
  let detail = "The request was not accepted.";
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") detail = body.detail;
    else if (Array.isArray(body?.detail)) detail = "One of the filters has an invalid value.";
  } catch {
    /* non-JSON error body */
  }
  throw new Error(detail.charAt(0).toUpperCase() + detail.slice(1));
}

export async function getJson<T>(path: string): Promise<T> {
  return (await request(path)).json() as Promise<T>;
}

/** Download a CSV from /api/export. Resolves with what was saved so the UI can confirm it. */
export async function downloadCsv(params: Record<string, string>): Promise<{ filename: string; rows: number }> {
  const res = await request(`/api/export?${new URLSearchParams(params)}`);
  const text = await res.text();
  const match = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "");
  const filename = match?.[1] ?? "windforecast_export.csv";
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const lines = text.trim() ? text.trim().split(/\r?\n/).length : 0;
  return { filename, rows: Math.max(lines - 1, 0) };
}

export interface TargetRevisions {
  start_time: string;
  decision_cutoff: string;
  actual_mw: number | null;
  revisions: { published: string; lead_h: number; forecast_mw: number; available_at_decision: boolean }[];
}
