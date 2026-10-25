// Per-route <title> and meta description for a client-rendered app. Static defaults,
// Open Graph tags and (when SITE_URL is set at build time) canonical URLs live in
// index.html; see vite.config.ts. Crawlers that do not run JavaScript only see those.
import { useEffect } from "react";
import { ROUTES, type RouteId } from "./router";

const SITE_URL = (import.meta.env.VITE_SITE_URL ?? "").replace(/\/$/, "");

export const PAGE_META: Record<RouteId, { title: string; description: string }> = {
  brief: {
    title: "Wind Forecast Monitor | UK Wind Generation",
    description:
      "Day-ahead brief for GB wind: the Elexon WINDFOR forecast available at the procurement cutoff, compared with metered FUELHH wind generation for January 2026 decisions.",
  },
  accuracy: {
    title: "Forecast Accuracy | Wind Forecast Monitor",
    description:
      "MAE, RMSE, bias and WAPE of GB national wind forecasts available at the day-ahead cutoff, by delivery day, hour and lead time, January 2026.",
  },
  method: {
    title: "Method & Data | Wind Forecast Monitor",
    description:
      "How Wind Forecast Monitor selects Elexon wind forecasts at the decision cutoff, matches them to actual generation and scores accuracy, with data-quality checks.",
  },
  privacy: {
    title: "Privacy Policy | Wind Forecast Monitor",
    description: "What information Wind Forecast Monitor collects (none of a personal nature in the application itself) and which services it relies on.",
  },
  terms: {
    title: "Terms of Use | Wind Forecast Monitor",
    description: "Terms for using Wind Forecast Monitor, an analytical tool built on public Elexon BMRS data, including data accuracy limitations.",
  },
  notfound: {
    title: "Page not found | Wind Forecast Monitor",
    description: "The requested page does not exist in Wind Forecast Monitor.",
  },
};

export function usePageMeta(route: RouteId) {
  useEffect(() => {
    const { title, description } = PAGE_META[route];
    document.title = title;
    setMeta('meta[name="description"]', description);
    setMeta('meta[property="og:title"]', title);
    setMeta('meta[property="og:description"]', description);
    setMeta('meta[name="twitter:title"]', title);
    setMeta('meta[name="twitter:description"]', description);
    const robots = document.querySelector('meta[name="robots"]');
    if (robots) robots.setAttribute("content", route === "notfound" ? "noindex" : "index, follow");
    // Canonical and og:url only exist when the production domain is configured.
    if (SITE_URL && route !== "notfound") {
      const url = `${SITE_URL}${ROUTES[route]}`;
      document.querySelector('link[rel="canonical"]')?.setAttribute("href", url);
      setMeta('meta[property="og:url"]', url);
    }
  }, [route]);
}

function setMeta(selector: string, content: string) {
  document.querySelector(selector)?.setAttribute("content", content);
}
