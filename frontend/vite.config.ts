import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Public, indexable pages. Kept in sync with src/router.ts and the backend's SPA_ROUTES.
const PUBLIC_PATHS = ["/", "/accuracy", "/method", "/privacy", "/terms"];

/**
 * SEO files depend on the production domain, which must not be guessed. With
 * VITE_SITE_URL set at build time we emit absolute canonical/OG URLs and a sitemap;
 * without it, robots.txt is still produced but no sitemap or canonical link.
 */
function seoFiles(siteUrl: string): Plugin {
  const base = siteUrl.replace(/\/$/, "");
  return {
    name: "seo-files",
    transformIndexHtml(html) {
      if (!base) return html;
      return html
        .replace(/content="\/og-image\.png"/g, `content="${base}/og-image.png"`)
        .replace(
          "</head>",
          `    <link rel="canonical" href="${base}/" />\n    <meta property="og:url" content="${base}/" />\n  </head>`,
        );
    },
    generateBundle() {
      const robots = ["User-agent: *", "Allow: /", "Disallow: /api/"];
      if (base) robots.push("", `Sitemap: ${base}/sitemap.xml`);
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robots.join("\n") + "\n" });
      if (!base) return;
      const urls = PUBLIC_PATHS.map((p) => `  <url><loc>${base}${p}</loc></url>`).join("\n");
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), seoFiles(env.VITE_SITE_URL ?? "")],
    build: {
      rollupOptions: {
        // Recharts and React change rarely; a separate chunk caches across app releases.
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            if (/node_modules[\/](react|react-dom|scheduler)[\/]/.test(id)) return "react";
            return "charts"; // recharts and its d3 / lodash dependencies
          },
        },
      },
    },
    server: {
      // In dev, /api is proxied to FastAPI. 127.0.0.1 rather than localhost: Node resolves
      // localhost to ::1 first, uvicorn listens on IPv4 only, and the proxy would return 500.
      proxy: { "/api": env.VITE_PROXY_TARGET || "http://127.0.0.1:8001" },
    },
  };
});
