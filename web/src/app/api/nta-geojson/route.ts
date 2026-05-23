import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export const runtime = 'nodejs'

export async function GET() {
  const candidatePaths = [
    path.join(process.cwd(), 'public', 'data', 'nta.geojson'),
    path.join(process.cwd(), 'server', 'data', 'nta.geojson'),
    path.join(process.cwd(), '..', 'server', 'data', 'nta.geojson'),
  ]

  for (const filePath of candidatePaths) {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
        type: string
        features: Array<{ properties: { ntatype: string }; [key: string]: unknown }>
      }
      // Only return residential NTAs (ntatype '0'), same filter as the server side
      return NextResponse.json(
        { ...raw, features: raw.features.filter((f) => f.properties.ntatype === '0') },
        { headers: { 'Cache-Control': 'public, max-age=86400' } },
      )
    }
  }

  return NextResponse.json({ error: 'nta.geojson not found' }, { status: 404 })
}
