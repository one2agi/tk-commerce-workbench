import type { NextConfig } from "next";

const config: NextConfig = {
  // 严格本地单用户：仅允许 loopback 主机头。
  experimental: {
    serverActions: {
      allowedOrigins: ["127.0.0.1", "localhost"]
    }
  }
};

export default config;
