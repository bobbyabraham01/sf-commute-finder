import { NextResponse } from 'next/server'
import { connectToDatabase } from '@/lib/db'
import { computeAndCacheCommutes } from '@/lib/neighborhoods'

export const runtime = 'nodejs'

interface CommutesRequestBody {
  workAddress: string
  workLat: number
  workLon: number
  departureTime?: string
  arriveBy?: boolean
}

export async function POST(req: Request) {
  const body = (await req.json()) as Partial<CommutesRequestBody>
  const workAddress = body.workAddress?.trim()
  const workLat = Number(body.workLat)
  const workLon = Number(body.workLon)
  const departureTime = body.departureTime ?? '8:00am'
  const arriveBy = body.arriveBy === true

  if (!workAddress) {
    return NextResponse.json({ error: 'workAddress is required' }, { status: 400 })
  }
  if (Number.isNaN(workLat) || Number.isNaN(workLon)) {
    return NextResponse.json({ error: 'workLat and workLon must be numbers' }, { status: 400 })
  }

  try {
    await connectToDatabase()
    const results = await computeAndCacheCommutes(workAddress, workLat, workLon, departureTime, arriveBy)
    return NextResponse.json(results)
  } catch (error) {
    console.error('Commute compute error:', error)
    return NextResponse.json({ error: 'Failed to compute commute times' }, { status: 502 })
  }
}
