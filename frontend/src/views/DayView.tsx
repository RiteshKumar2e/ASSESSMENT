import { useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DayDetail, Meta, Overview, TargetRevisions } from "../api";
import {
  AXIS,
  ChartFigure,
  CutoffFilter,
  DeliveryDateFilter,
  Direction,
  EmptyState,
  ErrorState,
  ExportButton,
  GRID,
  LazyMount,
  LoadingBlock,
  Measure,
  MeasureGroup,
  PageHead,
  Panel,
  TooltipBox,
  useApi,
} from "../components/common";
import {
  between,
  duration,
  fmt0,
  gwhValue,
  hours,
  mw,
  niceTicks,
  signedMw,
  signedPct,
  tzName,
  ukDate,
  ukDateTime,
  ukShortDateTime,
  ukTime,
} from "../format";

interface Props {
  meta: Meta;
  date: string;
  cutoff: string;
  onDate: (d: string) => void;
  onCutoff: (c: string) => void;
}

export default function DayView({ meta, date, cutoff, onDate, onCutoff }: Props) {
  const res = useApi<Overview>(`/api/overview?date=${date}&cutoff=${encodeURIComponent(cutoff)}`);
  const d = res.data?.day;
  const [inspect, setInspect] = useState<string | null>(null);
  useEffect(() => setInspect(null), [date]);

  return (
    <>
      <PageHead
        title="Day-ahead brief"
        purpose="The wind forecast that was available when the day-ahead purchase was made, set against what was later metered."
      >
        <DeliveryDateFilter value={date} min={meta.delivery_first_day} max={meta.delivery_last_day} onChange={onDate} />
        <CutoffFilter value={cutoff} onChange={onCutoff} />
      </PageHead>

      {res.error ? (
        <ErrorState message={res.error} onRetry={res.retry} />
      ) : !d ? (
        <LoadingBlock rows={4} />
      ) : !d.forecast_published ? (
        <EmptyState>No WINDFOR forecast had been published before this cutoff.</EmptyState>
      ) : (
        <div style={{ opacity: res.loading ? 0.6 : 1, transition: "opacity 0.15s" }}>
          <DecisionContext d={d} />
          <Measurements d={d} />
          <MainChart d={d} />
          <div className="cols">
            <LargestErrors d={d} onInspect={setInspect} />
            <Revisions d={d} />
          </div>
          <LazyMount height={360}>
            <HourHistory d={d} cutoff={cutoff} hour={inspect ?? defaultHour(d)} onHour={setInspect} />
          </LazyMount>
        </div>
      )}
    </>
  );
}

// --- decision context -----------------------------------------------------------------

function DecisionContext({ d }: { d: DayDetail }) {
  const published = d.forecast_published!;
  const lead = between(published, d.decision_cutoff);
  const late = d.next_run_after_cutoff;
  return (
    <dl className="context">
      <div>
        <dt>Delivery day</dt>
        <dd>
          {ukDate(d.date)}
          <small>
            {d.expected_hours} hourly intervals · {tzName(d.hourly[0]?.time ?? d.decision_cutoff)}
          </small>
        </dd>
      </div>
      <div>
        <dt>Decision cutoff</dt>
        <dd>
          {ukDateTime(d.decision_cutoff)}
          <small>Purchase committed on D-1</small>
        </dd>
      </div>
      <div>
        <dt>Forecast used</dt>
        <dd>
          WINDFOR run of {ukTime(published)} {tzName(published)}
          <small>
            {lead < 60_000 ? "Published at the cutoff time" : `Published ${duration(lead)} before the cutoff`} · mean
            lead {hours(d.metrics.mean_horizon_h)}
          </small>
        </dd>
      </div>
      <div className={late ? "late" : undefined}>
        <dt>Next forecast run</dt>
        <dd>
          {late ? (
            <>
              {ukTime(late)} {tzName(late)}, {duration(between(d.decision_cutoff, late))} after the cutoff
              <small>Not available for this decision</small>
            </>
          ) : (
            <>
              None before delivery
              <small>The forecast used was the last one</small>
            </>
          )}
        </dd>
      </div>
    </dl>
  );
}

// --- measurements -----------------------------------------------------------------------

function Measurements({ d }: { d: DayDetail }) {
  const m = d.metrics;
  const forecasts = d.hourly.map((h) => h.forecast).filter((v): v is number => v != null);
  const mean = forecasts.length ? forecasts.reduce((a, b) => a + b, 0) / forecasts.length : null;
  const overHours = d.hourly.filter((h) => h.forecast != null && h.actual != null && h.forecast > h.actual).length;
  return (
    <div className="measures">
      <MeasureGroup title="Known at the cutoff">
        <Measure
          label="Forecast wind energy"
          value={gwhValue(d.forecast_mwh)}
          unit="GWh"
          sub={`Sum of ${forecasts.length} hourly forecasts`}
          info="Energy over the delivery day: each hourly MW forecast × 1 hour, summed."
        />
        <Measure label="Mean forecast output" value={fmt0(mean)} unit="MW" sub="Average over the day" />
      </MeasureGroup>
      <MeasureGroup title="Observed after delivery">
        <Measure
          label="Actual wind energy"
          value={gwhValue(d.actual_mwh)}
          unit="GWh"
          sub={`${signedPct(d.actual_mwh / d.forecast_mwh - 1)} vs forecast`}
          info="Metered FUELHH wind: each half-hourly MW average × 0.5 hour, summed."
        />
        <Measure
          label="Mean absolute error"
          value={fmt0(m.mae)}
          unit="MW"
          sub={`${m.n} of ${d.expected_hours} hours matched`}
          info="Mean of |forecast − actual| over the matched hours of this day."
        />
        <Measure
          label="Mean bias"
          value={signedMw(m.bias).replace(" MW", "")}
          unit="MW"
          sub={`Over-forecast in ${overHours} of ${m.n} hours`}
          info="Mean of (forecast − actual). Positive: wind came in below the forecast."
        />
      </MeasureGroup>
      <MeasureGroup title="January reference, same cutoff">
        <Measure
          label="P90 over-forecast"
          value={fmt0(d.band_quantiles.q90)}
          unit="MW"
          sub="Exceeded in 1 of 10 hours"
          info="90th percentile of (forecast − actual) across all other January delivery days at this cutoff. In 90% of those hours, wind fell short of the forecast by less than this, or exceeded it."
        />
      </MeasureGroup>
    </div>
  );
}

// --- main chart -------------------------------------------------------------------------

interface Row {
  t: number;
  actual: number | null;
  forecast: number | null; // only on the hour, the forecast's native resolution
  hourForecast: number | null; // forecast for the hour containing this half-hour (tooltip)
  corrected: number | null;
  final: number | null;
  band: [number, number] | null;
}

type Overlay = "band" | "corrected" | "final";

const OVERLAYS: { key: Overlay; label: string; title: string }[] = [
  {
    key: "band",
    label: "P10–P90 range",
    title: "Forecast shifted by the 10th and 90th percentile errors seen on the other January days at this cutoff.",
  },
  {
    key: "corrected",
    label: "Bias-adjusted forecast",
    title: "Forecast minus its mean error over the 7 delivery days fully settled before the cutoff (D-8 to D-2).",
  },
  {
    key: "final",
    label: "Last forecast before delivery",
    title: "The final WINDFOR run published before the delivery day began. Not available at the cutoff.",
  },
];

function MainChart({ d }: { d: DayDetail }) {
  const [on, setOn] = useState<Record<Overlay, boolean>>({ band: false, corrected: false, final: false });

  const rows = useMemo<Row[]>(() => {
    const hourly = new Map(d.hourly.map((h) => [new Date(h.time).getTime(), h]));
    return d.half_hourly.map((hh) => {
      const t = new Date(hh.time).getTime();
      const h = hourly.get(t);
      const owner = hourly.get(t - (t % 3_600_000));
      return {
        t,
        actual: hh.actual,
        forecast: h?.forecast ?? null,
        hourForecast: owner?.forecast ?? null,
        corrected: h?.corrected_forecast ?? null,
        final: h?.final_forecast ?? null,
        band: h && h.band_low != null && h.band_high != null ? [h.band_low, h.band_high] : null,
      };
    });
  }, [d]);

  const missing = d.half_hourly.filter((h) => h.actual == null).length;
  const tz = tzName(d.hourly[0]?.time ?? d.decision_cutoff);
  const narrow = useNarrow();
  const step = narrow ? 6 : 3;
  const ticks = rows.filter((r) => new Date(r.t).getUTCMinutes() === 0 && (r.t / 3_600_000) % step === 0).map((r) => r.t);
  const withActual = d.half_hourly.length - missing;
  const yMax = Math.max(
    0,
    ...rows.flatMap((r) => [
      r.actual ?? 0,
      r.forecast ?? 0,
      on.band && r.band ? r.band[1] : 0,
      on.corrected ? (r.corrected ?? 0) : 0,
      on.final ? (r.final ?? 0) : 0,
    ]),
  );
  const yTicks = niceTicks(yMax);
  const fc = d.hourly.map((h) => h.forecast).filter((v): v is number => v != null);
  const summary =
    `Line chart for ${ukDate(d.date)}. The forecast available at the cutoff ranges from ${fmt0(Math.min(...fc))} to ${fmt0(Math.max(...fc))} MW. ` +
    (withActual
      ? `Actual generation was recorded for ${withActual} of ${d.half_hourly.length} half-hours; mean absolute error ${fmt0(d.metrics.mae)} MW. Full values are in the hourly table below.`
      : "No actual generation is available for this day.");
  const last = rows.length ? rows[rows.length - 1].t + 1_800_000 : 0;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Wind generation: forecast at cutoff vs actual</h2>
          <p>
            {ukDate(d.date)} · MW · UK time ({tz}) · forecast hourly, actual half-hourly
          </p>
        </div>
        <div className="control-row" style={{ flexWrap: "wrap", gap: "8px 16px" }}>
        <div className="overlays" role="group" aria-label="Optional overlays">
          <span>Overlays:</span>
          {OVERLAYS.map((o) => (
            <label key={o.key} title={o.title}>
              <input type="checkbox" checked={on[o.key]} onChange={() => setOn({ ...on, [o.key]: !on[o.key] })} />
              {o.label}
            </label>
          ))}
        </div>
        <ExportButton small label="Hourly CSV" params={{ dataset: "explorer", date: d.date, cutoff: cutoffParam(d) }} />
        </div>
      </div>
      <div className="panel-body">
        <div className="legend" style={{ marginBottom: 8 }}>
          <span className="item">
            <span className="key-line" style={{ background: "var(--forecast)" }} />
            Forecast available at cutoff ({ukTime(d.forecast_published!)} run)
          </span>
          <span className="item">
            <span className="key-line" style={{ background: "var(--actual)" }} />
            Actual, metered after delivery
          </span>
          {on.band && (
            <span className="item">
              <span className="key-area" style={{ background: "var(--forecast)", opacity: 0.16 }} />
              P10–P90 range
            </span>
          )}
          {on.corrected && (
            <span className="item">
              <span className="key-dash" style={{ borderColor: "var(--accent)" }} />
              Bias-adjusted
            </span>
          )}
          {on.final && (
            <span className="item">
              <span className="key-dash" style={{ borderColor: "var(--faint)" }} />
              Last before delivery
            </span>
          )}
        </div>
        <ChartFigure summary={summary}>
        <ResponsiveContainer width="100%" height={narrow ? 260 : 340}>
          <ComposedChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 4 }}>
            <CartesianGrid {...GRID} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[rows[0]?.t ?? 0, last]}
              ticks={ticks}
              tickFormatter={(t) => ukTime(new Date(t).toISOString())}
              {...AXIS}
            />
            <YAxis width={58} domain={[0, yTicks[yTicks.length - 1]]} ticks={yTicks} tickFormatter={(v) => fmt0(v)} {...AXIS} />
            <Tooltip content={<ChartTooltip on={on} />} cursor={{ stroke: "var(--border-strong)" }} />
            {on.band && (
              <Area dataKey="band" stroke="none" fill="var(--forecast)" fillOpacity={0.12} connectNulls isAnimationActive={false} activeDot={false} />
            )}
            {on.final && (
              <Line dataKey="final" stroke="var(--faint)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls isAnimationActive={false} />
            )}
            {on.corrected && (
              <Line dataKey="corrected" stroke="var(--accent)" strokeWidth={1.75} strokeDasharray="6 3" dot={false} connectNulls isAnimationActive={false} />
            )}
            {/* Hourly forecast points are joined; gaps in actuals are left as gaps. */}
            <Line dataKey="forecast" stroke="var(--forecast)" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
            <Line dataKey="actual" stroke="var(--actual)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
        </ChartFigure>
      </div>
      <div className="chart-foot">
        <span>
          Forecast: WINDFOR run published {ukDateTime(d.forecast_published!, false)}. Actual: FUELHH wind outturn.
          Hourly forecasts are compared with the half-hour starting on the hour.
        </span>
        <span>
          {withActual === 0
            ? "Actual generation is not available for this day yet, so no error can be calculated."
            : missing
              ? `${missing} half-hours without actual data are left blank, not interpolated.`
              : "No missing actuals."}
        </span>
      </div>
    </section>
  );
}

// Overlay values only appear in the tooltip when that overlay is switched on.
function ChartTooltip({
  active,
  payload,
  on,
}: {
  active?: boolean;
  payload?: { payload: Row }[];
  on: Record<Overlay, boolean>;
}) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  const start = new Date(r.t).toISOString();
  const end = new Date(r.t + 1_800_000).toISOString();
  const onHour = r.forecast != null;
  const rows = [
    { label: "Actual", value: mw(r.actual), color: "var(--actual)" },
    {
      label: onHour ? "Forecast" : "Forecast (hour)",
      value: mw(onHour ? r.forecast : r.hourForecast),
      color: "var(--forecast)",
    },
    {
      label: "Error (F − A)",
      value: onHour && r.actual != null ? signedMw(r.forecast! - r.actual) : "not matched",
    },
  ];
  if (on.band && r.band) rows.push({ label: "P10–P90", value: `${fmt0(r.band[0])}–${fmt0(r.band[1])} MW` });
  if (on.corrected && r.corrected != null) rows.push({ label: "Bias-adjusted", value: mw(r.corrected) });
  if (on.final && r.final != null) rows.push({ label: "Last before delivery", value: mw(r.final) });
  return <TooltipBox title={`${ukTime(start)}–${ukTime(end)} ${tzName(start)}`} rows={rows} />;
}

// --- tables ---------------------------------------------------------------------------------

function LargestErrors({ d, onInspect }: { d: DayDetail; onInspect: (t: string) => void }) {
  const [all, setAll] = useState(false);
  const matched = d.hourly
    .filter((h) => h.forecast != null && h.actual != null)
    .map((h) => ({ ...h, error: h.forecast! - h.actual! }));
  const rows = all ? matched : [...matched].sort((a, b) => Math.abs(b.error) - Math.abs(a.error)).slice(0, 8);
  return (
    <Panel
      title={all ? "All delivery hours" : "Largest hourly errors"}
      subtitle={
        matched.length === 0
          ? "No hours could be matched: actual generation is not available yet"
          : all
            ? "Chronological. Select an hour to see its forecast history."
            : "The 8 hours with the biggest |forecast − actual|. Select one to see its forecast history."
      }
      aside={
        <button className="btn small" onClick={() => setAll(!all)}>
          {all ? "Show largest only" : `Show all ${matched.length} hours`}
        </button>
      }
    >
      <div className="panel-body flush">
        {matched.length === 0 ? (
          <EmptyState>Errors appear once metered actuals exist for this day. Try an earlier delivery day.</EmptyState>
        ) : (
        <div className={`table-wrap ${all ? "scroll" : ""}`}>
          <table className="data">
            <thead>
              <tr>
                <th className="text">Hour ({tzName(d.decision_cutoff)})</th>
                <th>Forecast MW</th>
                <th>Actual MW</th>
                <th>Error MW</th>
                <th className="text hide-sm">Direction</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.time} className="clickable" onClick={() => onInspect(h.time)}>
                  <td className="text">
                    <button className="btn link" onClick={() => onInspect(h.time)}>
                      {ukTime(h.time)}
                      <span className="hide-sm">–{ukTime(new Date(new Date(h.time).getTime() + 3_600_000).toISOString())}</span>
                      <span className="sr-only">: show forecast history</span>
                    </button>
                  </td>
                  <td>{fmt0(h.forecast)}</td>
                  <td>{fmt0(h.actual)}</td>
                  <td>{signedMw(h.error).replace(" MW", "")}</td>
                  <td className="text hide-sm">
                    <Direction error={h.error} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </div>
    </Panel>
  );
}

function Revisions({ d }: { d: DayDetail }) {
  const used = d.revisions.find((r) => r.published === d.forecast_published);
  const dayStart = d.hourly[0]?.time;
  return (
    <Panel
      title="Forecast revisions for this day"
      subtitle="Each WINDFOR run that covered the whole delivery day, with its total forecast energy"
    >
      <div className="panel-body flush">
        {d.revisions.length === 0 ? (
          <EmptyState>No forecast run covered the whole delivery day before it started.</EmptyState>
        ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="text">Published</th>
                <th className="hide-sm">Before delivery</th>
                <th>Forecast GWh</th>
                <th className="hide-xs">vs used</th>
                <th className="text">Status</th>
              </tr>
            </thead>
            <tbody>
              {d.revisions.map((r) => {
                const isUsed = r.published === d.forecast_published;
                return (
                  <tr key={r.published}>
                    <td className="text">{ukShortDateTime(r.published)}</td>
                    <td className="hide-sm">{dayStart ? duration(between(r.published, dayStart)) : "–"}</td>
                    <td>{gwhValue(r.forecast_mwh)}</td>
                    <td className="hide-xs">{used && !isUsed ? signedPct(r.forecast_mwh / used.forecast_mwh - 1) : "–"}</td>
                    <td className="text">
                      {isUsed ? (
                        <span className="tag used">Used at cutoff</span>
                      ) : r.available_at_decision ? (
                        <span className="tag">Earlier run</span>
                      ) : (
                        <span className="tag late">After cutoff</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="text">Actual outturn</td>
                <td className="hide-sm" />
                <td>{gwhValue(d.actual_mwh)}</td>
                <td className="hide-xs">{used ? signedPct(d.actual_mwh / used.forecast_mwh - 1) : "–"}</td>
                <td className="text muted">Metered</td>
              </tr>
            </tfoot>
          </table>
        </div>
        )}
      </div>
    </Panel>
  );
}

// --- one delivery hour: forecast history ------------------------------------------------

function cutoffParam(d: DayDetail) {
  // decision_cutoff is UTC; the API takes the UK-local HH:MM.
  return new Date(d.decision_cutoff).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
}

function defaultHour(d: DayDetail) {
  const matched = d.hourly.filter((h) => h.forecast != null && h.actual != null);
  if (!matched.length) return d.hourly[12]?.time ?? d.hourly[0]?.time;
  return matched.reduce((a, b) => (Math.abs(b.forecast! - b.actual!) > Math.abs(a.forecast! - a.actual!) ? b : a)).time;
}

function HourHistory({ d, cutoff, hour, onHour }: { d: DayDetail; cutoff: string; hour: string; onHour: (t: string) => void }) {
  const res = useApi<TargetRevisions>(`/api/forecasts/revisions?start_time=${encodeURIComponent(hour)}&cutoff=${encodeURIComponent(cutoff)}`);
  const r = res.data;
  const data = (r?.revisions ?? []).map((x) => ({ ...x, t: new Date(x.published).getTime() }));
  const cutT = new Date(d.decision_cutoff).getTime();
  const end = ukTime(new Date(new Date(hour).getTime() + 3_600_000).toISOString());
  return (
    <Panel
      title="Forecast history for one delivery hour"
      subtitle="Every WINDFOR run that forecast this hour, by publication time. Only runs left of the cutoff line could inform the purchase."
      aside={
        <div className="filter">
          <label htmlFor="hour-pick">Delivery hour ({tzName(hour)})</label>
          <select id="hour-pick" className="select" value={hour} onChange={(e) => onHour(e.target.value)}>
            {d.hourly.map((h) => (
              <option key={h.time} value={h.time}>
                {ukTime(h.time)}–{ukTime(new Date(new Date(h.time).getTime() + 3_600_000).toISOString())}
              </option>
            ))}
          </select>
        </div>
      }
    >
      <div className="panel-body">
        {res.error ? (
          <ErrorState message={res.error} onRetry={res.retry} />
        ) : !r ? (
          <LoadingBlock rows={1} />
        ) : data.length === 0 ? (
          <EmptyState>No forecast runs covered this hour.</EmptyState>
        ) : (
          <div className="cols even" style={{ marginBottom: 0 }}>
            <ChartFigure
              summary={`Forecasts for ${ukTime(hour)} to ${end} from ${data.length} runs ranged from ${fmt0(Math.min(...data.map((x) => x.forecast_mw)))} to ${fmt0(Math.max(...data.map((x) => x.forecast_mw)))} MW. Actual: ${mw(r.actual_mw)}. Values are listed in the adjacent table.`}
            >
              <div className="legend" style={{ marginBottom: 6 }}>
                <span className="item">
                  <span className="key-line" style={{ background: "var(--forecast)" }} />
                  Forecast for {ukTime(hour)}–{end}
                </span>
                {r.actual_mw != null && (
                  <span className="item">
                    <span className="key-dash" style={{ borderColor: "var(--actual)" }} />
                    Actual {mw(r.actual_mw)}
                  </span>
                )}
                <span className="item">
                  <span className="key-dash" style={{ borderColor: "var(--ink-2)" }} />
                  Decision cutoff
                </span>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={data} margin={{ top: 6, right: 12, bottom: 0, left: 4 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    scale="time"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(t) => ukShortDateTime(new Date(t).toISOString())}
                    minTickGap={40}
                    {...AXIS}
                  />
                  <YAxis width={58} tickFormatter={(v) => fmt0(v)} domain={["auto", "auto"]} {...AXIS} />
                  <Tooltip
                    content={({ active, payload }) =>
                      active && payload?.length ? (
                        <TooltipBox
                          title={`Run ${ukDateTime(payload[0].payload.published, false)}`}
                          rows={[
                            { label: "Forecast", value: mw(payload[0].payload.forecast_mw), color: "var(--forecast)" },
                            { label: "Lead time", value: hours(payload[0].payload.lead_h) },
                            { label: "At cutoff", value: payload[0].payload.available_at_decision ? "available" : "published later" },
                          ]}
                        />
                      ) : null
                    }
                  />
                  {r.actual_mw != null && (
                    <ReferenceLine y={r.actual_mw} stroke="var(--actual)" strokeDasharray="5 4" ifOverflow="extendDomain" />
                  )}
                  <ReferenceLine x={cutT} stroke="var(--ink-2)" strokeDasharray="3 3" />
                  <Line dataKey="forecast_mw" stroke="var(--forecast)" strokeWidth={2} dot={{ r: 3, fill: "var(--forecast)" }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartFigure>
            <div className="table-wrap scroll" style={{ maxHeight: 260 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th className="text">Published</th>
                    <th className="hide-sm">Lead</th>
                    <th>Forecast MW</th>
                    <th className="hide-xs">Error MW</th>
                    <th className="text">At cutoff</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data].reverse().map((x) => (
                    <tr key={x.published}>
                      <td className="text">{ukShortDateTime(x.published)}</td>
                      <td className="hide-sm">{hours(x.lead_h)}</td>
                      <td>{fmt0(x.forecast_mw)}</td>
                      <td className="hide-xs">{r.actual_mw != null ? signedMw(x.forecast_mw - r.actual_mw).replace(" MW", "") : "–"}</td>
                      <td className="text">
                        {x.published === d.forecast_published ? (
                          <span className="tag used">Used</span>
                        ) : x.available_at_decision ? (
                          <span className="tag">Available</span>
                        ) : (
                          <span className="tag late">After cutoff</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function useNarrow(query = "(max-width: 600px)") {
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return narrow;
}
