import { useEffect, useState } from "react";
import type { DataQuality, MatchedRecord, Meta, Page } from "../api";
import { Direction, EmptyState, ErrorState, ExportButton, LoadingBlock, PageHead, Panel, useApi } from "../components/common";
import { fmt0, hours, signed, ukDate, ukDateTime, ukShortDateTime } from "../format";

export default function MethodView({ meta, cutoff }: { meta: Meta; cutoff: string }) {
  return (
    <>
      <PageHead
        title="Method & data"
        purpose="How forecasts are selected and scored, what data was retrieved from Elexon, and the matched observations behind every number."
      />
      <div className="cols top">
        <Method meta={meta} />
        <Quality cutoff={cutoff} />
      </div>
      <MatchedTable meta={meta} cutoff={cutoff} />
    </>
  );
}

function Method({ meta }: { meta: Meta }) {
  return (
    <Panel title="Method">
      <div className="panel-body prose">
        <h3>Scope</h3>
        <p>
          GB national wind only, from Elexon BMRS. Purchase decisions made in January 2026, so delivery days{" "}
          {ukDate(meta.delivery_first_day)} to {ukDate(meta.delivery_last_day)}.
        </p>
        <h3>Which forecast counts</h3>
        <ul>
          <li>
            For delivery day D, the forecast used is the latest WINDFOR run published at or before D-1 at the decision
            cutoff (UK local time). Runs published later are never used, even if they are more accurate.
          </li>
          <li>
            The default cutoff, 09:20, is gate closure of the GB hourly day-ahead auctions. It is configurable; later
            cutoffs see later runs.
          </li>
          <li>
            WINDFOR runs arrive {meta.publish_schedule_utc.length} times a day ({meta.publish_schedule_utc.map((s) => s.time).join(", ")}{" "}
            UTC). Each run also restates a few hours already past its publish time; those rows are discarded.
          </li>
        </ul>
        <h3>Matching and metrics</h3>
        <ul>
          <li>
            An hourly forecast for <code>startTime</code> T is compared with the FUELHH half-hour starting at T. Hours without
            both values are excluded.
          </li>
          <li>
            Error = forecast − actual (MW). MAE, RMSE, bias and WAPE are computed over matched hours only. WAPE is not
            reported when total actual generation is zero.
          </li>
          <li>
            Day energy (GWh) = Σ hourly forecast MW × 1 h, and Σ half-hourly actual MW × 0.5 h.
          </li>
        </ul>
        <h3>Limits</h3>
        <ul>
          <li>
            January showed a persistent over-forecast. A plausible contributor is curtailment: FUELHH is metered output
            after constraint actions, while WINDFOR forecasts available output. This is a hypothesis, not a finding.
          </li>
          <li>Wind forecast error is not a procurement volume. Demand, embedded generation and prices are out of scope.</li>
          <li>One month of data gives indicative percentiles, not a seasonal calibration.</li>
        </ul>
      </div>
    </Panel>
  );
}

function Quality({ cutoff }: { cutoff: string }) {
  const q = useApi<DataQuality>(`/api/data-quality?cutoff=${encodeURIComponent(cutoff)}`);
  const d = q.data;
  const fq = d?.cleaning.forecasts;
  const aq = d?.cleaning.actuals;
  return (
    <Panel title="Data quality and retrieval" subtitle={`Computed by the backend for the ${cutoff} cutoff`}>
      <div className="panel-body">
        {q.error ? (
          <ErrorState message={q.error} onRetry={q.retry} />
        ) : !d ? (
          <LoadingBlock rows={3} />
        ) : (
          <>
            <dl className="kv">
              <dt>Actual half-hours present</dt>
              <dd>
                {fmt0(d.actual_intervals_present)} / {fmt0(d.actual_intervals_expected)}
              </dd>
              <dt>Delivery hours matched (forecast and actual)</dt>
              <dd>
                {fmt0(d.matched_hours)} / {fmt0(d.matched_hours_expected)}
              </dd>
              <dt>Forecast runs loaded</dt>
              <dd>{fmt0(d.forecast_runs)}</dd>
              <dt>Days with fewer than {d.expected_runs_per_day} runs</dt>
              <dd>{d.days_with_missing_runs.length}</dd>
              <dt>FUELHH rows received / invalid / duplicate</dt>
              <dd>
                {fmt0(aq?.received)} / {fmt0(aq?.invalid)} / {fmt0(aq?.duplicate)}
              </dd>
              <dt>WINDFOR rows received / invalid / duplicate</dt>
              <dd>
                {fmt0(fq?.received)} / {fmt0(fq?.invalid)} / {fmt0(fq?.duplicate)}
              </dd>
              <dt>WINDFOR rows dropped (hour before publish time)</dt>
              <dd>{fmt0(fq?.before_publish)}</dd>
              <dt>Retrieved from Elexon</dt>
              <dd>{d.fetched_at ? ukDateTime(d.fetched_at) : "–"}</dd>
            </dl>
            {d.unmatched.length > 0 && (
              <p style={{ fontSize: 12.5, color: "var(--warning)", margin: "12px 0 0" }}>
                {d.unmatched.length} unmatched hours, e.g. {ukShortDateTime(d.unmatched[0].start_time)}: {d.unmatched[0].reason}.
              </p>
            )}
            <p style={{ fontSize: 12, color: "var(--muted)", margin: "12px 0 0" }}>
              Requested FUELHH settlement dates {d.requested.fuelhh_settlement_dates?.join(" to ")}; WINDFOR publish times{" "}
              {d.requested.windfor_publish_times?.map((t) => t.slice(0, 16).replace("T", " ")).join(" to ")} UTC.
            </p>
            <div className="control-row" style={{ marginTop: 14, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, color: "var(--muted)", marginRight: 4 }}>Download CSV:</span>
              {(["matched", "actuals", "forecasts"] as const).map((ds) => (
                <ExportButton
                  key={ds}
                  small
                  params={{ dataset: ds, cutoff }}
                  label={ds === "matched" ? "Matched observations" : ds === "actuals" ? "Actuals" : "Forecast records"}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

function MatchedTable({ meta, cutoff }: { meta: Meta; cutoff: string }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 24;

  // Debounce typing so every keystroke does not hit the API.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(1), [cutoff]);

  const params = new URLSearchParams({ cutoff, page: String(page), page_size: String(pageSize) });
  if (query) params.set("search", query);
  const res = useApi<Page<MatchedRecord>>(`/api/matched?${params}`);
  const p = res.data;
  const pages = p ? Math.max(1, Math.ceil(p.total / pageSize)) : 1;

  return (
    <Panel
      title="Matched observations"
      subtitle={`Every hour used in the accuracy figures: forecast available at the ${cutoff} cutoff vs actual`}
      aside={
        <div className="control-row">
          <label className="sr-only" htmlFor="matched-search">
            Filter matched observations
          </label>
          <input
            id="matched-search"
            className="input search"
            type="search"
            maxLength={64}
            placeholder="Filter, e.g. 2026-01-28 or T05:00"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ExportButton params={{ dataset: "matched", cutoff, ...(query ? { search: query } : {}) }} />
        </div>
      }
    >
      <div className="panel-body flush">
        {res.error ? (
          <ErrorState message={res.error} onRetry={res.retry} />
        ) : !p ? (
          <div style={{ padding: "0 18px" }}>
            <LoadingBlock rows={3} />
          </div>
        ) : p.total === 0 ? (
          <EmptyState
            action={
              <button className="btn" onClick={() => setSearch("")}>
                Clear filter
              </button>
            }
          >
            No observations match “{query}”. Search matches dates and times as they appear in the data, e.g. 2026-01-28 or
            T05:00 (UTC).
          </EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th className="text">Delivery hour (UK)</th>
                    <th className="text hide-sm">Forecast published (UK)</th>
                    <th className="hide-sm">Lead</th>
                    <th>Forecast MW</th>
                    <th className="hide-xs">Actual MW</th>
                    <th>Error MW</th>
                    <th className="text hide-sm">Direction</th>
                  </tr>
                </thead>
                <tbody>
                  {p.rows.map((r) => (
                    <tr key={r.start_time}>
                      <td className="text">{ukShortDateTime(r.start_time)}</td>
                      <td className="text hide-sm">{ukShortDateTime(r.publish_time)}</td>
                      <td className="hide-sm">{hours(r.lead_h)}</td>
                      <td>{fmt0(r.forecast_mw)}</td>
                      <td className="hide-xs">{fmt0(r.actual_mw)}</td>
                      <td>{signed(r.error_mw)}</td>
                      <td className="text hide-sm">
                        <Direction error={r.error_mw} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <span>
                {fmt0((p.page - 1) * pageSize + 1)}–{fmt0(Math.min(p.page * pageSize, p.total))} of {fmt0(p.total)} hours ·
                delivery {ukDate(meta.delivery_first_day)} to {ukDate(meta.delivery_last_day)}
              </span>
              <span className="control-row">
                <button className="btn small" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Previous
                </button>
                <span className="num">
                  Page {p.page} of {pages}
                </span>
                <button className="btn small" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                  Next
                </button>
              </span>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
