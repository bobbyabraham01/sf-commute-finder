import type { NextConfig } from 'next'
import path from 'path'

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, '..'),
  reactStrictMode: false,
  outputFileTracingIncludes: {
    '/api/nta-geojson': ['./public/data/nta.geojson'],
  },
}

export default nextConfig
