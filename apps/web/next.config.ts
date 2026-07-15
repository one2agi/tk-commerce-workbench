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
  webpack(config) {
    // Workspace packages publish TypeScript sources while keeping Node-style
    // `.js` specifiers. Teach webpack to resolve those specifiers to the source
    // `.ts` files so server-only repository composition can be bundled.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"]
    };
    return config;
  },
  // Web may consume pure contracts, config, and UI projections from domain.
  // Stateful infrastructure packages (@tk/db and @tk/adapters) stay outside
  // the browser bundle.
  transpilePackages: ["@tk/contracts", "@tk/config", "@tk/domain", "@tk/db"]
};

export default config;
