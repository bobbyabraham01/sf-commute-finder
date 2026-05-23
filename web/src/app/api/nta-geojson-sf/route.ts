/**
 * Serves SF neighborhood polygon GeoJSON for the choropleth map layer.
 *
 * Fetches from DataSF's public API (the city's open data portal) and
 * transforms each feature to include a consistent `ntaCode` property that
 * matches the codes in sf-neighborhoods.ts.
 *
 * In-memory cache so the DataSF API is only hit once per server restart.
 */

import { NextResponse } from 'next/server'
import { sfNameToCode } from '@/lib/sf-neighborhoods'

export const runtime = 'nodejs'

// DataSF Analysis Neighborhoods (41 official SF neighborhoods as polygons)
const DATASF_URL =
  'https://data.sfgov.org/resource/p5b7-5n3h.geojson?$limit=100'

let cachedGeoJson: object | null = null
let cacheTime = 0
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

export async function GET() {
  const now = Date.now()
  if (cachedGeoJson && now - cacheTime < CACHE_TTL_MS) {
    return NextResponse.json(cachedGeoJson, {
      headers: { 'Cache-Control': 'public, max-age=86400' },
    })
  }

  try {
    const res = await fetch(DATASF_URL, { next: { revalidate: 86400 } })
    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch SF GeoJSON' }, { status: 502 })
    }

    const raw = (await res.json()) as {
      type: string
      features: Array<{
        type: string
        geometry: object
        properties: Record<string, string>
      }>
    }

    // Add ntaCode property to each feature so MapClient can match
    // choropleth colors using the same key as our neighborhood data.
    // DataSF uses `nhood` as the neighborhood name field.
    const transformed = {
      ...raw,
      features: raw.features.map((f) => ({
        ...f,
        properties: {
          ...f.properties,
          ntaCode: sfNameToCode(f.properties.nhood ?? ''),
        },
      })),
    }

    cachedGeoJson = transformed
    cacheTime = now

    return NextResponse.json(transformed, {
      headers: { 'Cache-Control': 'public, max-age=86400' },
    })
  } catch (err) {
    console.error('nta-geojson-sf fetch error:', err)
    return NextResponse.json({ error: 'Could not load SF neighborhood boundaries' }, { status: 502 })
  }
}
