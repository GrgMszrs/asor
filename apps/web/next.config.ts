import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.ASOR_API_URL ?? "http://api:8000"}/:path*`,
      },
    ];
  },
};

export default nextConfig;
