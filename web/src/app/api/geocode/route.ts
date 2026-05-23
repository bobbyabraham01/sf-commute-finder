import { NextResponse } from 'next/server'
import { geocode } from '@/lib/geocode'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')?.trim()
  if (!q) {
    return NextResponse.json({ error: 'Missing query param ?q=' }, { status: 400 })
  }

  try {
    const result = await geocode(q)
    if (!result) {
      return NextResponse.json({ error: 'No match found' }, { status: 404 })
    }
    return NextResponse.json(result)
  } catch (error) {
    console.error('Geocode error:', error)
    return NextResponse.json({ error: 'Geocoder upstream failure' }, { status: 502 })
  }
}
