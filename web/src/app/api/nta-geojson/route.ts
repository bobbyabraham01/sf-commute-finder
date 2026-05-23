import { NextResponse } from 'next/server'
import ntaData from '../../../../public/data/nta.json'

export const runtime = 'nodejs'

export async function GET() {
  const raw = ntaData as {
    type: string
    features: Array<{ properties: { ntatype: string }; [key: string]: unknown }>
  }

  return NextResponse.json(
    { ...raw, features: raw.features.filter((f) => f.properties.ntatype === '0') },
    { headers: { 'Cache-Control': 'public, max-age=86400' } },
  )
}
