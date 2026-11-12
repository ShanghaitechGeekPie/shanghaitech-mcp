import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker image runs `node server.js` from .next/standalone.
  output: "standalone",
  poweredByHeader: false,
  outputFileTracingIncludes: {
    "/api/mcp": ["./lib/**/*.ts"],
  },
};

export default nextConfig;
