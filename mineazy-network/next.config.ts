import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The topology map streams a live snapshot; keep every page dynamic so the
  // console always renders current monitoring state rather than a build-time
  // snapshot.
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    agentUpgrade: false as never,
  },
  // Tailwind v4 is wired through postcss.config.mjs. Turbopack applies the
  // project's PostCSS config natively — adding a `turbopack.rules` entry for
  // "*.css" would run the same transform twice through the webpack-loader
  // bridge, which only supports loaders that emit JavaScript.
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
