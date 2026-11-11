import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  outputFileTracingIncludes: {
    "/api/mcp": ["./lib/**/*.ts"],
  },
};

export default nextConfig;
