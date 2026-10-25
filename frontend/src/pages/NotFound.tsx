import { ROUTES, onLinkClick } from "../router";

export default function NotFound() {
  const path = window.location.pathname;
  return (
    <section className="notfound" aria-labelledby="nf-title">
      <p className="eyebrow">404</p>
      <h1 id="nf-title">Page not found</h1>
      <p>
        There is no page at <code className="break">{path}</code>. It may have been mistyped, or the link may be out of
        date.
      </p>
      <div className="control-row" style={{ flexWrap: "wrap" }}>
        <a className="btn primary" href={ROUTES.brief} onClick={(e) => onLinkClick(e, ROUTES.brief)}>
          Open the day-ahead brief
        </a>
        <a className="btn" href={ROUTES.accuracy} onClick={(e) => onLinkClick(e, ROUTES.accuracy)}>
          Forecast accuracy
        </a>
      </div>
    </section>
  );
}
