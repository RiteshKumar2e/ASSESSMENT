import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { Accuracy, HorizonPoint, Meta } from "../api";
import {
  AXIS,
  ChartFigure,
  CutoffFilter,
  EmptyState,
  ErrorState,
  ExportButton,
  GRID,
  LazyMount,
  LoadingBlock,
  Direction,
  Measure,
  MeasureGroup,
  PageHead,
  Panel,
  TooltipBox,
  useApi,
} from "../components/common";
import { compactMw, fmt0, gw, gwh, hours, mw, niceTicks, pct, shortDate, signed, signedMw, ukDate, ukDateTime } from "../format";

interface Props {
  meta: Meta;
  cutoff: string;
  onCutoff: (c: string) => void;
  onOpenDay: (d: string) => void;
}

export default function AccuracyView({ meta, cutoff, onCutoff, onOpenDay }: Props) {
  const [mode, setMode] = useState<"decision" | "horizon">("decision");
  const [lead, setLead] = useState(24);
  const path =
    mode === "decision"
      ? `/api/accuracy?mode=decision&cutoff=${encodeURIComponent(cutoff)}`
      : `/api/accuracy?mode=horizon&hours=${lead}`;
  const acc = useApi<Accuracy>(path);
  const curve = useApi<HorizonPoint[]>("/api/horizon-curve");
  const a = acc.data;

  return (
    <>
      <PageHead
        title="Forecast accuracy"
        purpose={`How far the selected forecast was from metered wind, over all delivery days ${shortDate(meta.delivery_first_day)} – ${shortDate(meta.delivery_last_day)} 2026.`}
      >
        <div className="filter">
          <span className="label">Forecast evaluated</span>
          <div className="segmented" role="group" aria-label="Forecast evaluated">
            <button aria-pressed={mode === "decision"} onClick={() => setMode("decision")}>
              Latest at cutoff
            </button>
            <button aria-pressed={mode === "horizon"} onClick={() => setMode("horizon")}>
              Fixed lead time
            </button>
          </div>
        </div>
        {mode === "decision" ? (
          <CutoffFilter value={cutoff} onChange={onCutoff} />
        ) : (
          <div className="filter">
            <label htmlFor="lead">
              Published at least <span className="hint">· before each hour</span>
            </label>
            <div className="control-row" style={{ height: "var(--control-h)" }}>
              <input id="lead" type="range" min={0} max={meta.max_horizon_h} value={lead} onChange={(e) => setLead(Number(e.target.value))} />
              <span className="num" style={{ minWidth: 44, fontWeight: 600 }}>
                {lead} h
              </span>
            </div>
          </div>
        )}
      </PageHead>

      {acc.error ? (
        <ErrorState message={acc.error} onRetry={acc.retry} />
      ) : !a ? (
        <LoadingBlock rows={4} />
      ) : a.summary.n === 0 ? (
        <EmptyState
          action={
            <button className="btn" onClick={() => (mode === "decision" ? onCutoff("09:20") : setLead(24))}>
              Reset to the default selection
            </button>
          }
        >
          No delivery hours have both a selected forecast and a metered actual for this selection, so no accuracy can be
          calculated.
        </EmptyState>
      ) : (
        <div style={{ opacity: acc.loading ? 0.6 : 1, transition: "opacity 0.15s" }}>
          <div className="lede-row">
            <Lede a={a} mode={mode} cutoff={cutoff} lead={lead} />
            {mode === "decision" && <ExportButton label="Matched hours CSV" params={{ dataset: "matched", cutoff }} />}
          </div>
          <Measurements a={a} />
          <div className="cols even">
            <Findings a={a} />
            <Definitions />
          </div>
          <DailyErrors a={a} onOpenDay={onOpenDay} />
          <LazyMount height={340}>
            <div className="cols even">
              <LeadCurve data={curve.data} error={curve.error} mode={mode} lead={lead} meanLead={a.summary.mean_horizon_h} />
              <LeadBuckets a={a} />
            </div>
          </LazyMount>
          <LazyMount height={320}>
            <div className="cols even">
              <Distribution a={a} />
              <ByHour a={a} />
            </div>
          </LazyMount>
          <LazyMount height={420}>
            <ScatterPanel a={a} />
          </LazyMount>
        </div>
      )}
    </>
  );
}

function Lede({ a, mode, cutoff, lead }: { a: Accuracy; mode: string; cutoff: string; lead: number }) {
  const s = a.summary;
  if (!s.n) return <p className="lede">No matched hours for this selection.</p>;
  return (
    <p className="lede">
      {mode === "decision" ? (
        <>
          For each delivery day, the forecast evaluated is the latest WINDFOR run published before <strong>{cutoff}</strong>{" "}
          UK time on the previous day.
        </>
      ) : (
        <>
          For each delivery hour, the forecast evaluated is the latest WINDFOR run published at least <strong>{lead} h</strong>{" "}
          earlier.
        </>
      )}{" "}
      Across <strong>{fmt0(s.n)}</strong> matched hours it missed metered wind by <strong>{mw(s.mae)}</strong> on average,
      and was above the actual in <strong>{pct(s.shortfall_share)}</strong> of hours.
    </p>
  );
}

function Measurements({ a }: { a: Accuracy }) {
  const s = a.summary;
  return (
    <div className="measures">
      <MeasureGroup title="Size of error">
        <Measure label="MAE" value={fmt0(s.mae)} unit="MW" sub={`${pct(s.nmae)} of mean output`} info="Mean absolute error: mean of |forecast − actual| over matched hours." />
        <Measure label="RMSE" value={fmt0(s.rmse)} unit="MW" sub="Weights large misses more" info="Root mean squared error: √mean((forecast − actual)²)." />
        <Measure label="WAPE" value={s.wape == null ? "–" : (s.wape * 100).toFixed(1)} unit="%" sub="Σ|error| ÷ Σ actual" info="Weighted absolute percentage error: sum of |forecast − actual| divided by sum of actual. Undefined if there was no wind." />
      </MeasureGroup>
      <MeasureGroup title="Direction and coverage">
        <Measure label="Mean bias" value={signed(s.bias)} unit="MW" sub={`Forecast above actual in ${pct(s.shortfall_share)} of hours`} info="Mean of (forecast − actual). Positive: the forecast overstated wind." />
        <Measure label="Matched hours" value={fmt0(s.n)} sub={`Mean lead ${hours(s.mean_horizon_h)}`} info="Delivery hours with both a selected forecast and a metered actual. Unmatched hours are excluded from every metric." />
      </MeasureGroup>
      <MeasureGroup title="Tails">
        <Measure label="P90 over-forecast" value={fmt0(s.q90)} unit="MW" sub="Exceeded in 1 of 10 hours" info="90th percentile of (forecast − actual)." />
        <Measure label="P10" value={signed(s.q10)} unit="MW" sub="Under-forecast side" info="10th percentile of (forecast − actual). Negative: wind exceeded the forecast." />
      </MeasureGroup>
    </div>
  );
}

function Findings({ a }: { a: Accuracy }) {
  const c = a.corrected_summary;
  const items = [...a.findings];
  if (c?.mae != null && a.summary.mae) {
    items.push({
      rule: "trailing 7-day bias removed (decision mode)",
      text: `Subtracting each day's trailing bias, known at the cutoff, would have changed MAE from ${fmt0(a.summary.mae)} to ${fmt0(c.mae)} MW (${pct(c.mae / a.summary.mae - 1)}).`,
    });
  }
  return (
    <Panel title="What the numbers show" subtitle="Each statement is generated from the figures above by the stated rule">
      <div className="panel-body flush">
        <ul className="findings">
          {items.map((f) => (
            <li key={f.rule}>
              <span>{f.text}</span>
              <span className="rule">Rule: {f.rule}</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function Definitions() {
  return (
    <Panel title="Definitions" subtitle="Error = forecast − actual, in MW, per matched delivery hour">
      <div className="panel-body">
        <dl className="defs">
          <dt>MAE</dt>
          <dd>Mean of |error|. The typical size of a miss.</dd>
          <dt>RMSE</dt>
          <dd>Square root of the mean squared error. Large misses count more.</dd>
          <dt>Bias</dt>
          <dd>Mean error. Positive means the forecast overstated wind (over-forecast).</dd>
          <dt>WAPE</dt>
          <dd>Σ|error| ÷ Σ actual. Not shown when total actual is zero.</dd>
          <dt>P90 / P10</dt>
          <dd>Percentiles of the signed error. 90% of hours had an error below P90.</dd>
          <dt>Matching</dt>
          <dd>
            Hourly forecast for T vs the FUELHH half-hour starting at T. Hours missing either value are excluded. Wind
            forecast error is not the same as the volume to buy: demand and prices are out of scope.
          </dd>
        </dl>
      </div>
    </Panel>
  );
}

function DailyErrors({ a, onOpenDay }: { a: Accuracy; onOpenDay: (d: string) => void }) {
  return (
    <Panel
      title="Mean error by delivery day"
      subtitle="MW. Above zero: forecast above actual (over-forecast). Select a day to open its brief."
      aside={
        <div className="legend">
          <span className="item">
            <span className="key-square" style={{ background: "var(--negative)" }} />▲ Over-forecast
          </span>
          <span className="item">
            <span className="key-square" style={{ background: "var(--under)" }} />▼ Under-forecast
          </span>
        </div>
      }
    >
      <div className="panel-body">
        <ChartFigure summary={dailySummary(a)}>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={a.daily} margin={{ top: 6, right: 8, bottom: 0, left: 4 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="date" tickFormatter={shortDate} interval="preserveStartEnd" minTickGap={18} {...AXIS} />
            <YAxis tickFormatter={compactMw} width={44} {...AXIS} />
            <ReferenceLine y={0} stroke="var(--faint)" />
            <Tooltip
              cursor={{ fill: "var(--surface-muted)" }}
              content={({ active, payload }) =>
                active && payload?.length ? (
                  <TooltipBox
                    title={ukDate(payload[0].payload.date)}
                    rows={[
                      { label: "Mean error", value: signedMw(payload[0].payload.bias) },
                      { label: "MAE", value: mw(payload[0].payload.mae) },
                      { label: "Forecast energy", value: gwh(payload[0].payload.forecast_mwh) },
                      { label: "Actual energy", value: gwh(payload[0].payload.actual_mwh) },
                    ]}
                  />
                ) : null
              }
            />
            <Bar dataKey="bias" maxBarSize={20} radius={[3, 3, 3, 3]} isAnimationActive={false} cursor="pointer" onClick={(_, i) => onOpenDay(a.daily[i].date)}>
              {a.daily.map((r) => (
                <Cell key={r.date} fill={r.bias >= 0 ? "var(--negative)" : "var(--under)"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        </ChartFigure>
        <details className="table-toggle">
          <summary>Daily figures as a table</summary>
          <div className="table-wrap scroll">
            <table className="data">
              <thead>
                <tr>
                  <th className="text">Delivery day</th>
                  <th className="hide-sm">Forecast GWh</th>
                  <th className="hide-sm">Actual GWh</th>
                  <th>MAE MW</th>
                  <th>Mean error MW</th>
                  <th className="text hide-sm">Direction</th>
                </tr>
              </thead>
              <tbody>
                {a.daily.map((r) => (
                  <tr key={r.date}>
                    <td className="text">
                      <button className="btn link" onClick={() => onOpenDay(r.date)}>
                        <span className="hide-xs">{ukDate(r.date)}</span>
                        <span className="show-xs">{shortDate(r.date)}</span>
                      </button>
                    </td>
                    <td className="hide-sm">{(r.forecast_mwh / 1000).toFixed(1)}</td>
                    <td className="hide-sm">{(r.actual_mwh / 1000).toFixed(1)}</td>
                    <td>{fmt0(r.mae)}</td>
                    <td>{signed(r.bias)}</td>
                    <td className="text hide-sm">
                      <Direction error={r.bias} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </Panel>
  );
}

function LeadCurve({
  data,
  error,
  mode,
  lead,
  meanLead,
}: {
  data?: HorizonPoint[];
  error?: string;
  mode: string;
  lead: number;
  meanLead?: number | null;
}) {
  return (
    <Panel title="Error by lead time" subtitle="Latest run published at least N hours before each hour. MW. Shaded: typical day-ahead leads (16–40 h).">
      <div className="panel-body">
        <div className="legend" style={{ marginBottom: 6 }}>
          <span className="item">
            <span className="key-line" style={{ background: "var(--forecast)" }} />
            MAE
          </span>
          <span className="item">
            <span className="key-line" style={{ background: "var(--negative)" }} />
            Mean bias
          </span>
        </div>
        {error ? (
          <ErrorState message={error} />
        ) : !data ? (
          <LoadingBlock rows={1} />
        ) : (
          <ChartFigure summary={`Mean absolute error rises from ${fmt0(data[0]?.mae)} MW for forecasts published at least 0 hours ahead to ${fmt0(data[data.length - 1]?.mae)} MW at ${data[data.length - 1]?.horizon_h} hours. Bucketed values are in the adjacent table.`}>
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={data} margin={{ top: 14, right: 8, bottom: 14, left: 4 }}>
              <CartesianGrid {...GRID} />
              <ReferenceArea x1={16} x2={40} fill="var(--surface-muted)" fillOpacity={1} />
              <XAxis
                dataKey="horizon_h"
                type="number"
                domain={[0, "dataMax"]}
                ticks={[0, 6, 12, 18, 24, 30, 36, 42, 48]}
                label={{ value: "Minimum lead time (h)", position: "insideBottom", offset: -10 }}
                {...AXIS}
              />
              <YAxis tickFormatter={compactMw} width={44} {...yScale(Math.max(...data.map((p) => p.mae)))} {...AXIS} />
              <Tooltip
                content={({ active, payload }) =>
                  active && payload?.length ? (
                    <TooltipBox
                      title={`Published ≥ ${payload[0].payload.horizon_h} h before`}
                      rows={[
                        { label: "MAE", value: mw(payload[0].payload.mae), color: "var(--forecast)" },
                        { label: "Mean bias", value: signedMw(payload[0].payload.bias), color: "var(--negative)" },
                        { label: "Actual mean lead", value: hours(payload[0].payload.mean_horizon_h) },
                      ]}
                    />
                  ) : null
                }
              />
              {mode === "horizon" && <ReferenceLine x={lead} stroke="var(--ink-2)" strokeDasharray="3 3" />}
              {mode === "decision" && meanLead != null && (
                <ReferenceLine x={Math.round(meanLead)} stroke="var(--ink-2)" strokeDasharray="3 3" label={{ value: "cutoff", position: "top", fill: "var(--muted)", fontSize: 11 }} />
              )}
              <Line dataKey="bias" stroke="var(--negative)" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line dataKey="mae" stroke="var(--forecast)" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
          </ChartFigure>
        )}
      </div>
    </Panel>
  );
}

function LeadBuckets({ a }: { a: Accuracy }) {
  return (
    <Panel title="Accuracy by lead-time bucket" subtitle="Every forecast point for the delivery window, not just the latest run">
      <div className="panel-body flush">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="text">Lead time</th>
                <th className="hide-sm">Points</th>
                <th>MAE MW</th>
                <th className="hide-sm">RMSE MW</th>
                <th>Bias MW</th>
                <th>WAPE</th>
              </tr>
            </thead>
            <tbody>
              {a.lead_buckets.map((b) => (
                <tr key={b.from_h}>
                  <td className="text">
                    {b.from_h}–{b.to_h} h
                  </td>
                  <td className="hide-sm">{fmt0(b.n)}</td>
                  <td>{fmt0(b.mae)}</td>
                  <td className="hide-sm">{fmt0(b.rmse)}</td>
                  <td>{signed(b.bias)}</td>
                  <td>{pct(b.wape)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Panel>
  );
}

function Distribution({ a }: { a: Accuracy }) {
  return (
    <Panel title="Distribution of hourly errors" subtitle="Hours per 500 MW band of forecast − actual">
      <div className="panel-body">
        <ChartFigure summary={`Histogram of ${fmt0(a.summary.n)} hourly errors. ${pct(a.summary.shortfall_share)} of hours were over-forecast (positive error); the 10th to 90th percentile range is ${signed(a.summary.q10)} to ${signed(a.summary.q90)} MW.`}>
        <ResponsiveContainer width="100%" height={230}>
          <BarChart data={a.histogram} margin={{ top: 6, right: 8, bottom: 0, left: 4 }} barCategoryGap={1}>
            <CartesianGrid {...GRID} />
            {/* Bins are labelled by their lower edge; only round thousands get a label. */}
            <XAxis dataKey="from" interval={0} tickFormatter={(v: number) => (v % 1000 === 0 ? compactMw(v) : "")} {...AXIS} />
            <YAxis width={36} allowDecimals={false} {...AXIS} />
            <Tooltip
              cursor={{ fill: "var(--surface-muted)" }}
              content={({ active, payload }) =>
                active && payload?.length ? (
                  <TooltipBox
                    title={`${signedMw(payload[0].payload.from)} to ${signedMw(payload[0].payload.to)}`}
                    rows={[{ label: "Hours", value: String(payload[0].payload.count) }]}
                  />
                ) : null
              }
            />
            <Bar dataKey="count" radius={[2, 2, 0, 0]} isAnimationActive={false}>
              {a.histogram.map((b) => (
                <Cell key={b.from} fill={b.from >= 0 ? "var(--negative)" : "var(--under)"} fillOpacity={0.85} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        </ChartFigure>
      </div>
    </Panel>
  );
}

function ByHour({ a }: { a: Accuracy }) {
  return (
    <Panel title="Error by hour of day" subtitle="MAE (bars) and mean bias (line) by delivery hour, UK time. MW">
      <div className="panel-body">
        <ChartFigure summary={byHourSummary(a)}>
        <ResponsiveContainer width="100%" height={230}>
          <ComposedChart data={a.by_hour} margin={{ top: 6, right: 8, bottom: 0, left: 4 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="hour" tickFormatter={(h) => `${String(h).padStart(2, "0")}:00`} interval={3} {...AXIS} />
            <YAxis tickFormatter={compactMw} width={40} {...yScale(Math.max(...a.by_hour.map((h) => Math.max(h.mae, h.bias))))} {...AXIS} />
            <Tooltip
              cursor={{ fill: "var(--surface-muted)" }}
              content={({ active, payload }) =>
                active && payload?.length ? (
                  <TooltipBox
                    title={`${String(payload[0].payload.hour).padStart(2, "0")}:00–${String((payload[0].payload.hour + 1) % 24).padStart(2, "0")}:00`}
                    rows={[
                      { label: "MAE", value: mw(payload[0].payload.mae), color: "var(--forecast)" },
                      { label: "Mean bias", value: signedMw(payload[0].payload.bias), color: "var(--negative)" },
                      { label: "Hours", value: String(payload[0].payload.n) },
                    ]}
                  />
                ) : null
              }
            />
            <Bar dataKey="mae" fill="var(--forecast)" fillOpacity={0.85} maxBarSize={16} radius={[2, 2, 0, 0]} isAnimationActive={false} />
            <Line dataKey="bias" stroke="var(--negative)" strokeWidth={2} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
        </ChartFigure>
      </div>
    </Panel>
  );
}

function ScatterPanel({ a }: { a: Accuracy }) {
  const max = Math.max(...a.scatter.map((p) => Math.max(p.forecast, p.actual)), 0);
  const top = Math.ceil(max / 5000) * 5000;
  const ticks = Array.from({ length: top / 5000 + 1 }, (_, i) => i * 5000);
  return (
    <Panel title="Forecast vs actual, hour by hour" subtitle="GW. Points below the diagonal are hours where wind came in under the forecast.">
      <div className="panel-body">
        <ChartFigure summary={`Scatter of ${fmt0(a.scatter.length)} hours, forecast against actual. ${pct(a.summary.shortfall_share)} of points lie below the diagonal (actual lower than forecast).`}>
        <ResponsiveContainer width="100%" height={320}>
          <ScatterChart margin={{ top: 6, right: 12, bottom: 16, left: 4 }}>
            <CartesianGrid stroke="var(--grid)" />
            <XAxis dataKey="forecast" type="number" domain={[0, top]} ticks={ticks} tickFormatter={gw} label={{ value: "Forecast (GW)", position: "insideBottom", offset: -10 }} {...AXIS} />
            <YAxis dataKey="actual" type="number" domain={[0, top]} ticks={ticks} tickFormatter={gw} width={44} label={{ value: "Actual (GW)", angle: -90, position: "insideLeft", offset: 10 }} {...AXIS} />
            <ZAxis range={[18, 18]} />
            <ReferenceLine segment={[{ x: 0, y: 0 }, { x: top, y: top }]} stroke="var(--faint)" strokeDasharray="4 4" />
            <Tooltip
              cursor={false}
              content={({ active, payload }) =>
                active && payload?.length ? (
                  <TooltipBox
                    title={ukDateTime(payload[0].payload.time)}
                    rows={[
                      { label: "Forecast", value: mw(payload[0].payload.forecast), color: "var(--forecast)" },
                      { label: "Actual", value: mw(payload[0].payload.actual), color: "var(--actual)" },
                      { label: "Error (F − A)", value: signedMw(payload[0].payload.forecast - payload[0].payload.actual) },
                    ]}
                  />
                ) : null
              }
            />
            <Scatter data={a.scatter} fill="var(--forecast)" fillOpacity={0.4} isAnimationActive={false} />
          </ScatterChart>
        </ResponsiveContainer>
        </ChartFigure>
      </div>
    </Panel>
  );
}

function dailySummary(a: Accuracy) {
  const over = a.daily.filter((d) => d.bias > 0).length;
  const worst = a.daily.reduce((x, y) => (y.bias > x.bias ? y : x), a.daily[0]);
  return `Bar chart of mean error for ${a.daily.length} delivery days. The forecast was too high on average on ${over} days; the largest mean over-forecast was ${signed(worst?.bias)} MW on ${worst ? ukDate(worst.date) : "–"}. A table version follows.`;
}

function byHourSummary(a: Accuracy) {
  const peak = a.by_hour.reduce((x, y) => (y.mae > x.mae ? y : x), a.by_hour[0]);
  return `Mean absolute error by hour of day. Highest at ${String(peak?.hour ?? 0).padStart(2, "0")}:00 UK time with ${fmt0(peak?.mae)} MW.`;
}

function yScale(max: number) {
  const ticks = niceTicks(max);
  return { ticks, domain: [0, ticks[ticks.length - 1]] as [number, number] };
}
