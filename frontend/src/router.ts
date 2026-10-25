// A minimal path router (no dependency): pathname picks the page, query string carries
// the shareable filters (?date=&cutoff=). The backend serves index.html for these paths.
import { useEffect, useState } from "react";

export type RouteId = "brief" | "accuracy" | "method" | "privacy" | "terms" | "notfound";

export const ROUTES: Record<Exclude<RouteId, "notfound">, string> = {
  brief: "/",
  accuracy: "/accuracy",
  method: "/method",
  privacy: "/privacy",
  terms: "/terms",
};

export function routeFor(pathname: string): RouteId {
  const clean = pathname.replace(/\/+$/, "") || "/";
  const hit = (Object.entries(ROUTES) as [RouteId, string][]).find(([, p]) => p === clean);
  return hit ? hit[0] : "notfound";
}

export interface Location {
  route: RouteId;
  params: URLSearchParams;
}

const read = (): Location => ({ route: routeFor(window.location.pathname), params: new URLSearchParams(window.location.search) });

/** Links from the earlier hash-based version (#view=accuracy&date=...) keep working. */
function migrateHash() {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const view = hash.get("view");
  if (!view) return;
  const path = view === "accuracy" ? "/accuracy" : view === "method" ? "/method" : "/";
  hash.delete("view");
  const qs = hash.toString();
  window.history.replaceState(null, "", `${path}${qs ? `?${qs}` : ""}`);
}

export function useLocation(): Location {
  const [loc, setLoc] = useState<Location>(() => {
    migrateHash();
    return read();
  });
  useEffect(() => {
    const sync = () => setLoc(read());
    window.addEventListener("popstate", sync);
    window.addEventListener("app:navigate", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("app:navigate", sync);
    };
  }, []);
  return loc;
}

/** Push a new entry (page change) or replace the current one (filter change). */
export function navigate(path: string, params?: URLSearchParams, replace = false) {
  const qs = params?.toString();
  const url = `${path}${qs ? `?${qs}` : ""}`;
  if (url === `${window.location.pathname}${window.location.search}`) return;
  if (replace) window.history.replaceState(null, "", url);
  else {
    window.history.pushState(null, "", url);
    window.scrollTo(0, 0);
  }
  window.dispatchEvent(new Event("app:navigate"));
}

/** Left-click navigates in-app; modified clicks (new tab, etc.) fall through to the browser. */
export function onLinkClick(e: React.MouseEvent<HTMLAnchorElement>, path: string, params?: URLSearchParams) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(path, params);
}
