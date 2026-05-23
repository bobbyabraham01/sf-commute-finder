import type { NextConfig } from 'next'
import path from 'path'

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, '..'),
  reactStrictMode: false,
  webpack: (config) => {
    config.module.rules.push({ test: /\.geojson$/, type: 'json' })
    return config
  },
}

export default nextConfig
