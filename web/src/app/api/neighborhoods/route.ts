import { NextResponse } from 'next/server'
import { connectToDatabase } from '@/lib/db'
import {
  computeAndCacheCommutes,
  getNeighborhoodBases,
  getNeighborhoodsForWork,
  mergeNeighborhoodsWithCommutes,
} from '@/lib/neighborhoods'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const workLat = Number(searchParams.get('workLat') ?? 40.7484)
  const workLng = Number(searchParams.get('workLng') ?? -73.9857)
  const workAddress = searchParams.get('workAddress')?.trim() ?? ''

  if (Number.isNaN(workLat) || Number.isNaN(workLng)) {
    return NextResponse.json({ error: 'workLat and workLng must be numbers' }, { status: 400 })
  }

  const departureTime = searchParams.get('departureTime') ?? '8:00am'
  const arriveBy = searchParams.get('arriveBy') === 'true'

  if (!workAddress) {
    return NextResponse.json(getNeighborhoodsForWork(workLat, workLng))
  }

  try {
    await connectToDatabase()
    const commuteRows = await computeAndCacheCommutes(workAddress, workLat, workLng, departureTime, arriveBy)
    const commuteByNtaCode = new Map(commuteRows.map((row) => [row.ntaCode, row]))
    const neighborhoods = mergeNeighborhoodsWithCommutes(
      getNeighborhoodBases(),
      commuteByNtaCode,
      workLat,
      workLng
    )
    return NextResponse.json(neighborhoods)
  } catch (error) {
    console.error('Neighborhoods commute merge error:', error)
    return NextResponse.json(getNeighborhoodsForWork(workLat, workLng))
  }
}
