import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const config: NextConfig = {
  // 严格本地单用户：仅允许 loopback 主机头。
  experimental: {
    serverActions: {
      allowedOrigins: ["127.0.0.1", "localhost"]
    }
  },
  turbopack: {
    root: fileURLToPath(new URL("../..", import.meta.url))
  },
  // Web may consume pure contracts, config, and UI projections from domain.
  // Stateful infrastructure packages (@tk/db and @tk/adapters) stay outside
  // the browser bundle.
  transpilePackages: ["@tk/contracts", "@tk/config", "@tk/domain"]
};

export default config;
