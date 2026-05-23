import { NextResponse } from 'next/server'
import { connectToDatabase } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET() {
  await connectToDatabase()
  return NextResponse.json({ ok: true, time: new Date().toISOString() })
}
