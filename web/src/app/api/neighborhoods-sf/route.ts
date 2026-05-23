import { NextResponse } from 'next/server'
import { connectToDatabase } from '@/lib/db'
import {
  computeAndCacheSFCommutes,
  getSFNeighborhoodsForWork,
  mergeSFNeighborhoodsWithCommutes,
} from '@/lib/sf-neighborhoods'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  // Default: 505 Howard St, SF (SoMa)
  const workLat = Number(searchParams.get('workLat') ?? 37.7874)
  const workLng = Number(searchParams.get('workLng') ?? -122.3964)
  const workAddress = searchParams.get('workAddress')?.trim() ?? ''
  const departureTime = searchParams.get('departureTime') ?? '8:00am'
  const arriveBy = searchParams.get('arriveBy') === 'true'

  if (Number.isNaN(workLat) || Number.isNaN(workLng)) {
    return NextResponse.json({ error: 'workLat and workLng must be numbers' }, { status: 400 })
  }

  // No address provided — return mock commutes (used on first load)
  if (!workAddress) {
    return NextResponse.json(getSFNeighborhoodsForWork(workLat, workLng))
  }

  try {
    await connectToDatabase()
    const commuteRows = await computeAndCacheSFCommutes(workAddress, workLat, workLng, departureTime, arriveBy)
    const commuteByNtaCode = new Map(commuteRows.map((row) => [row.ntaCode, row]))
    const neighborhoods = mergeSFNeighborhoodsWithCommutes(commuteByNtaCode, workLat, workLng)
    return NextResponse.json(neighborhoods)
  } catch (error) {
    console.error('SF neighborhoods commute merge error:', error)
    // Graceful fallback to mock commutes on DB/OTP failure
    return NextResponse.json(getSFNeighborhoodsForWork(workLat, workLng))
  }
}
