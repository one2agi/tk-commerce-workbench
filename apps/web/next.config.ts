import type { NextConfig } from "next";

const config: NextConfig = {
  // 严格本地单用户：仅允许 loopback 主机头。
  experimental: {
    serverActions: {
      allowedOrigins: ["127.0.0.1", "localhost"]
    }
  },
  // Web may only consume @tk/contracts (a pure-types + zod package). All
  // other packages (@tk/db, @tk/adapters, @tk/domain) must stay outside the
  // bundle. TranspilePackages lets Next/Turbopack actually walk into the
  // .ts source of those workspace packages.
  transpilePackages: ["@tk/contracts", "@tk/config"]
};

export default config;