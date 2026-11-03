import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { z } from "zod";

const mergedReleaseRedirects = z
  .record(z.string(), z.string())
  .parse(JSON.parse(readFileSync(new URL("./app/updates/merged-release-redirects.json", import.meta.url), "utf8")));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Separate caches when an isolated preview runs beside the main dev server.
  distDir:
    process.env.NEXT_BUILD_DIR !== undefined && process.env.NEXT_BUILD_DIR !== ""
      ? process.env.NEXT_BUILD_DIR
      : ".next",
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [
          {
            type: "host",
            value: "ready.new",
          },
        ],
        destination: "https://ready.app/meet",
        // @external Next.js Redirect.permanent API field
        permanent: true,
      },
      ...Object.entries(mergedReleaseRedirects).map(([source, destination]) => ({
        source,
        destination,
        // @external Next.js Redirect.permanent API field
        permanent: true,
      })),
      ...[
        "2026-05-02-introducing-ready",
        "2026-05-07-a-more-reliable-foundation",
        "2026-05-18-look-it-up-without-leaving",
      ].map((slug) => ({
        source: `/updates/${slug}`,
        destination: "/updates/2026-05-18-introducing-ready",
        // @external Next.js Redirect.permanent API field
        permanent: true,
      })),
      {
        source: "/changelog/:path*",
        destination: "/updates/:path*",
        // @external Next.js Redirect.permanent API field
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
