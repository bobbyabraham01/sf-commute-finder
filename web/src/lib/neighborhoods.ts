import fs from 'fs'
import path from 'path'
import { CommuteCache } from './commuteCache'
import type { CommuteResult, Neighborhood } from './types'

interface RawFeature {
  type: 'Feature'
  properties: {
    nta2020: string
    ntaname: string
    ntatype: string
    boroname: string
  }
  geometry: { type: 'MultiPolygon' | 'Polygon'; coordinates: number[][][] | number[][][][] }
}

const OTP_PLAN_URL = process.env.OTP_PLAN_URL || 'http://localhost:8080/otp/routers/default/plan'
const OTP_BATCH_SIZE = 10
const CACHE_VERSION = 'v7' // bumped: suburban total minutes derived from displayed legs only
const WALKING_MPH = 3
const SHORT_DISTANCE_WALK_ONLY_MILES = 1.25

/** Returns the next Monday's date as M/D/YYYY — used to anchor OTP queries to a weekday. */
function getNextMondayDateStr(): string {
  const today = new Date()
  const day = today.getDay() // 0=Sun … 6=Sat
  const daysUntilMonday = day === 0 ? 1 : day === 1 ? 7 : 8 - day
  const monday = new Date(today)
  monday.setDate(today.getDate() + daysUntilMonday)
  return `${monday.getMonth() + 1}/${monday.getDate()}/${monday.getFullYear()}`
}

type RawLeg = { mode: string; duration?: number }

/**
 * Summarise OTP legs into display-ready minute buckets.
 *
 * egressWalkOnly=true  →  suburban (NJ / Westchester / CT) destinations.
 *   People drive to their train station, so the walk at the origin is
 *   irrelevant.  Only count walk legs that occur AFTER the last transit
 *   leg (i.e. the walk from Penn / Grand Central to the office).
 *
 * egressWalkOnly=false  →  NYC NTA destinations (default).
 *   Count all walk legs so the sidebar can show door-to-door walking.
 */
function parseLegSummary(
  legs: RawLeg[],
  egressWalkOnly = false,
): import('./types').LegSummary {
  const isTransit = (l: RawLeg) => !['WALK', 'BICYCLE', 'CAR'].includes(l.mode)

  let walkLegs = legs.filter((l) => l.mode === 'WALK')

  if (egressWalkOnly) {
    // Find the last transit leg; only walk legs after it count.
    let lastTransitIdx = -1
    for (let i = legs.length - 1; i >= 0; i--) {
      if (isTransit(legs[i])) { lastTransitIdx = i; break }
    }
    if (lastTransitIdx >= 0) {
      walkLegs = legs.slice(lastTransitIdx + 1).filter((l) => l.mode === 'WALK')
    }
  }

  const sumModes = (...modes: string[]) =>
    legs.filter((l) => modes.includes(l.mode)).reduce((acc, l) => acc + (l.duration ?? 0), 0)
  const walkDuration = walkLegs.reduce((acc, l) => acc + (l.duration ?? 0), 0)

  return {
    walkMinutes: Math.round(walkDuration / 60),
    subwayMinutes: Math.round(sumModes('SUBWAY', 'TRAM', 'CABLE_CAR') / 60),
    railMinutes: Math.round(sumModes('RAIL') / 60),
    busMinutes: Math.round(sumModes('BUS') / 60),
    ferryMinutes: Math.round(sumModes('FERRY') / 60),
  }
}

const LONG_WALK_THRESHOLD_MINUTES = 20

/**
 * Rough driving time estimate based on straight-line distance.
 * Uses a blended speed: slower for short city hops, faster for longer highway runs.
 * Not meant to be precise — just a realistic sanity-check against transit.
 */
function estimateDriveMinutes(distMiles: number): number {
  const avgMph = distMiles < 10 ? 22 : distMiles < 25 ? 28 : 34
  return Math.max(8, Math.round((distMiles * 1.35 / avgMph) * 60))
}

const BOROUGH_RENT_BASE: Record<string, number> = {
  // NYC boroughs
  Manhattan: 4200,
  Brooklyn: 3000,
  Queens: 2500,
  Bronx: 1900,
  'Staten Island': 1700,
  // NJ — existing
  'Jersey City': 3200,
  Hoboken: 3600,
  Newark: 2300,
  // NJ — Morris & Essex / Montclair lines
  'South Orange': 2700,
  Maplewood: 2600,
  Millburn: 3400,
  Summit: 3200,
  Chatham: 3000,
  Madison: 2800,
  Morristown: 2600,
  Montclair: 3000,
  // NJ — Northeast Corridor
  Elizabeth: 1800,
  Rahway: 2000,
  Cranford: 2400,
  Westfield: 2800,
  // Westchester — existing
  Yonkers: 2600,
  'New Rochelle': 2800,
  'White Plains': 3000,
  // Westchester — New Haven Line
  Pelham: 3200,
  Larchmont: 3800,
  Mamaroneck: 3400,
  Harrison: 3000,
  Rye: 4200,
  'Port Chester': 2500,
  // Westchester — Harlem Line
  'Mount Vernon': 2200,
  Bronxville: 4500,
  Tuckahoe: 2800,
  Scarsdale: 4800,
  Pleasantville: 2800,
  Chappaqua: 3800,
  // Westchester — Hudson Line
  'Dobbs Ferry': 3200,
  Tarrytown: 3200,
  Ossining: 2600,
  // Connecticut — New Haven Line
  Greenwich: 5500,
  Stamford: 3200,
}
const MIDTOWN_LAT = 40.7549
const MIDTOWN_LNG = -73.9857

let cached: Array<Omit<Neighborhood, 'commuteMinutes'>> | null = null

const EXPANDED_DESTINATIONS: Array<{
  ntaCode: string
  name: string
  borough: string
  centroid: [number, number]
}> = [
  // All [lng, lat] coordinates are pinned to the actual train/ferry station,
  // not the town center, so OTP measures station→work with no walking padding.

  // NJ Transit — existing (station coords)
  { ntaCode: 'NJ-JC',  name: 'Jersey City',           borough: 'Jersey City',   centroid: [-74.0431, 40.7194] }, // Grove St station
  { ntaCode: 'NJ-HOB', name: 'Hoboken',                borough: 'Hoboken',       centroid: [-74.0249, 40.7357] }, // Hoboken Terminal
  { ntaCode: 'NJ-NWK', name: 'Newark',                 borough: 'Newark',        centroid: [-74.1648, 40.7348] }, // Newark Penn Station
  // NJ Transit — Northeast Corridor (→ Penn Station)
  { ntaCode: 'NJ-ELZ', name: 'Elizabeth',              borough: 'Elizabeth',     centroid: [-74.2131, 40.6670] }, // Elizabeth station
  { ntaCode: 'NJ-RAH', name: 'Rahway',                 borough: 'Rahway',        centroid: [-74.2786, 40.6083] }, // Rahway station
  { ntaCode: 'NJ-CRN', name: 'Cranford',               borough: 'Cranford',      centroid: [-74.3000, 40.6567] }, // Cranford station
  { ntaCode: 'NJ-WFD', name: 'Westfield',              borough: 'Westfield',     centroid: [-74.3478, 40.6571] }, // Westfield station
  // NJ Transit — Morris & Essex Lines (→ Penn Station)
  { ntaCode: 'NJ-SPO', name: 'South Orange',           borough: 'South Orange',  centroid: [-74.2621, 40.7519] }, // South Orange station
  { ntaCode: 'NJ-MAP', name: 'Maplewood',              borough: 'Maplewood',     centroid: [-74.2738, 40.7317] }, // Maplewood station
  { ntaCode: 'NJ-MLB', name: 'Millburn / Short Hills', borough: 'Millburn',      centroid: [-74.3003, 40.7263] }, // Millburn station
  { ntaCode: 'NJ-SUM', name: 'Summit',                 borough: 'Summit',        centroid: [-74.3592, 40.7154] }, // Summit station
  { ntaCode: 'NJ-CHT', name: 'Chatham',                borough: 'Chatham',       centroid: [-74.3841, 40.7407] }, // Chatham station
  { ntaCode: 'NJ-MAD', name: 'Madison',                borough: 'Madison',       centroid: [-74.4192, 40.7598] }, // Madison station
  { ntaCode: 'NJ-MOR', name: 'Morristown',             borough: 'Morristown',    centroid: [-74.4817, 40.7990] }, // Morristown station
  // NJ Transit — Montclair-Boonton Line (→ Penn Station)
  { ntaCode: 'NJ-MTL', name: 'Montclair',              borough: 'Montclair',     centroid: [-74.2131, 40.8140] }, // Bay Street station
  // Metro-North — Harlem Line (→ Grand Central)
  { ntaCode: 'WC-YON', name: 'Yonkers',                borough: 'Yonkers',       centroid: [-73.8988, 40.9312] }, // Yonkers station
  { ntaCode: 'WC-MTV', name: 'Mount Vernon',           borough: 'Mount Vernon',  centroid: [-73.8413, 40.9135] }, // Mt Vernon West station
  { ntaCode: 'WC-BRX', name: 'Bronxville',             borough: 'Bronxville',    centroid: [-73.8333, 40.9382] }, // Bronxville station
  { ntaCode: 'WC-TUK', name: 'Tuckahoe',               borough: 'Tuckahoe',      centroid: [-73.8263, 40.9525] }, // Tuckahoe station
  { ntaCode: 'WC-SCD', name: 'Scarsdale',              borough: 'Scarsdale',     centroid: [-73.7962, 40.9966] }, // Scarsdale station
  { ntaCode: 'WC-WP',  name: 'White Plains',           borough: 'White Plains',  centroid: [-73.7629, 41.0330] }, // White Plains station
  { ntaCode: 'WC-PLV', name: 'Pleasantville',          borough: 'Pleasantville', centroid: [-73.7909, 41.1331] }, // Pleasantville station
  { ntaCode: 'WC-CHQ', name: 'Chappaqua',              borough: 'Chappaqua',     centroid: [-73.7639, 41.1577] }, // Chappaqua station
  // Metro-North — New Haven Line (→ Grand Central)
  { ntaCode: 'WC-NR',  name: 'New Rochelle',           borough: 'New Rochelle',  centroid: [-73.7831, 40.9107] }, // New Rochelle station
  { ntaCode: 'WC-PLM', name: 'Pelham',                 borough: 'Pelham',        centroid: [-73.8062, 40.9108] }, // Pelham station
  { ntaCode: 'WC-LAR', name: 'Larchmont',              borough: 'Larchmont',     centroid: [-73.7518, 40.9262] }, // Larchmont station
  { ntaCode: 'WC-MAM', name: 'Mamaroneck',             borough: 'Mamaroneck',    centroid: [-73.7359, 40.9456] }, // Mamaroneck station
  { ntaCode: 'WC-HRR', name: 'Harrison',               borough: 'Harrison',      centroid: [-73.7138, 40.9698] }, // Harrison station
  { ntaCode: 'WC-RYE', name: 'Rye',                    borough: 'Rye',           centroid: [-73.6875, 40.9811] }, // Rye station
  { ntaCode: 'WC-PCH', name: 'Port Chester',           borough: 'Port Chester',  centroid: [-73.6682, 40.9956] }, // Port Chester station
  { ntaCode: 'CT-GRW', name: 'Greenwich',              borough: 'Greenwich',     centroid: [-73.6289, 41.0182] }, // Greenwich station
  { ntaCode: 'CT-STM', name: 'Stamford',               borough: 'Stamford',      centroid: [-73.5412, 41.0467] }, // Stamford station
  // Metro-North — Hudson Line (→ Grand Central)
  { ntaCode: 'WC-DFR', name: 'Dobbs Ferry',            borough: 'Dobbs Ferry',   centroid: [-73.8742, 41.0100] }, // Dobbs Ferry station
  { ntaCode: 'WC-TAR', name: 'Tarrytown',              borough: 'Tarrytown',     centroid: [-73.8631, 41.0673] }, // Tarrytown station
  { ntaCode: 'WC-OSS', name: 'Ossining',               borough: 'Ossining',      centroid: [-73.8632, 41.1597] }, // Ossining station
]

function readNtaGeojson(): RawFeature[] {
  const candidatePaths = [
    path.join(process.cwd(), 'server', 'data', 'nta.geojson'),
    path.join(process.cwd(), '..', 'server', 'data', 'nta.geojson'),
  ]

  for (const filePath of candidatePaths) {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { features: RawFeature[] }
      return raw.features
    }
  }

  throw new Error('Could not find server/data/nta.geojson')
}

/**
 * Computes the area-weighted centroid of a single polygon ring using the
 * standard shoelace formula.  Returns the centroid and the absolute area.
 * Unlike a simple vertex average, this guarantees the result sits inside
 * (or very close to) the polygon's actual interior.
 */
function ringCentroid(ring: number[][]): { cx: number; cy: number; area: number } {
  let cx = 0
  let cy = 0
  let area = 0
  const n = ring.length
  for (let i = 0; i < n - 1; i++) {
    const x0 = ring[i][0],  y0 = ring[i][1]
    const x1 = ring[i + 1][0], y1 = ring[i + 1][1]
    const cross = x0 * y1 - x1 * y0
    area += cross
    cx += (x0 + x1) * cross
    cy += (y0 + y1) * cross
  }
  area /= 2
  const absArea = Math.abs(area)
  if (absArea < 1e-12) return { cx: ring[0][0], cy: ring[0][1], area: 0 }
  cx /= 6 * area
  cy /= 6 * area
  return { cx, cy, area: absArea }
}

/**
 * Returns the [lng, lat] centroid for a GeoJSON Polygon or MultiPolygon.
 * Uses area-weighted centroids across all sub-polygons so waterfront NTAs
 * don't get pulled into the water by a dense cluster of coastal vertices.
 */
function approxCentroid(geom: RawFeature['geometry']): [number, number] {
  const polygons: number[][][][] =
    geom.type === 'Polygon' ? [geom.coordinates as number[][][]] : (geom.coordinates as number[][][][])

  let totalArea = 0
  let weightedLng = 0
  let weightedLat = 0

  for (const polygon of polygons) {
    // Use only the outer ring (index 0); holes (subsequent rings) are ignored.
    const { cx, cy, area } = ringCentroid(polygon[0])
    totalArea += area
    weightedLng += cx * area
    weightedLat += cy * area
  }

  if (totalArea === 0) {
    // Degenerate fallback: simple vertex average of outer ring
    const ring = polygons[0][0]
    const lng = ring.reduce((s, v) => s + v[0], 0) / ring.length
    const lat = ring.reduce((s, v) => s + v[1], 0) / ring.length
    return [lng, lat]
  }

  return [weightedLng / totalArea, weightedLat / totalArea]
}

function distMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = 3958.8
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * r * Math.asin(Math.sqrt(a))
}

function estimateWalkMinutes(distanceMiles: number): number {
  // 3 mph baseline walking speed, rounded up to a whole minute.
  return Math.max(1, Math.ceil((distanceMiles / WALKING_MPH) * 60))
}

function mockRent(borough: string, lat: number, lng: number, name: string): number {
  const base = BOROUGH_RENT_BASE[borough] ?? 2500
  const d = distMiles(MIDTOWN_LAT, MIDTOWN_LNG, lat, lng)
  const adjusted = base - d * 80
  const jitter = ((name.charCodeAt(0) + name.length * 7) % 11) * 30 - 150
  return Math.max(1400, Math.round(adjusted + jitter))
}

function mockCommute(workLat: number, workLng: number, lat: number, lng: number, name: string): number {
  const d = distMiles(workLat, workLng, lat, lng)
  const jitter = ((name.charCodeAt(name.length - 1) + name.length) % 7) - 3
  return Math.max(8, Math.round(8 + d * 5.5 + jitter))
}

export function getNeighborhoodBases(): Array<Omit<Neighborhood, 'commuteMinutes'>> {
  if (cached) return cached

  cached = readNtaGeojson()
    .filter((f) => f.properties.ntatype === '0')
    .map((f) => {
      const centroid = approxCentroid(f.geometry)
      const [lng, lat] = centroid
      return {
        ntaCode: f.properties.nta2020,
        name: f.properties.ntaname,
        borough: f.properties.boroname,
        centroid,
        medianRent: mockRent(f.properties.boroname, lat, lng, f.properties.ntaname),
      }
    })

  const expanded = EXPANDED_DESTINATIONS.map((d) => ({
    ...d,
    medianRent: mockRent(d.borough, d.centroid[1], d.centroid[0], d.name),
  }))
  cached = [...cached, ...expanded]
  return cached
}

export function getNeighborhoodsForWork(workLat: number, workLng: number): Neighborhood[] {
  return getNeighborhoodBases().map((n) => ({
    ...n,
    commuteMinutes: mockCommute(workLat, workLng, n.centroid[1], n.centroid[0], n.name),
  }))
}

function normalizeWorkAddress(address: string, departureHour: string, arriveBy: boolean): string {
  return `${CACHE_VERSION}:${address.trim().toLowerCase()}:${departureHour}:${arriveBy ? 'arrive' : 'depart'}`
}

async function getOtpRoute(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
  departureTime: string,
  arriveBy = false,
): Promise<{ minutes: number; rawLegs: RawLeg[] } | null> {
  const params = new URLSearchParams({
    fromPlace: `${fromLat},${fromLon}`,
    toPlace: `${toLat},${toLon}`,
    mode: 'TRANSIT,WALK',
    arriveBy: arriveBy ? 'true' : 'false',
    numItineraries: '1',
    time: departureTime,
    date: getNextMondayDateStr(),
  })

  try {
    const response = await fetch(`${OTP_PLAN_URL}?${params.toString()}`)
    if (!response.ok) return null
    const data = (await response.json()) as {
      plan?: {
        itineraries?: Array<{
          duration?: number
          legs: Array<{ mode: string; duration?: number }>
        }>
      }
    }
    const itinerary = data.plan?.itineraries?.[0]
    if (!itinerary || typeof itinerary.duration !== 'number') return null

    // Reject pure-walk itineraries. When OTP can't find a transit connection
    // (e.g. centroid snapped to a point far from stations) it falls back to
    // walking the whole distance. We only call getOtpRoute for trips already
    // confirmed to be > SHORT_DISTANCE_WALK_ONLY_MILES, so a walk-only result
    // here is always a routing failure — return null and let the caller fall
    // back to the mock commute rather than caching a bogus number.
    const hasTransitLeg = (itinerary.legs ?? []).some(
      (l) => !['WALK', 'BICYCLE', 'CAR'].includes(l.mode)
    )
    if (!hasTransitLeg) return null

    return {
      minutes: Math.max(1, Math.round(itinerary.duration / 60)),
      rawLegs: itinerary.legs ?? [],
    }
  } catch {
    return null
  }
}

export async function computeAndCacheCommutes(
  workAddress: string,
  workLat: number,
  workLon: number,
  departureTime = '8:00am',
  arriveBy = false,
): Promise<CommuteResult[]> {
  const departureHour = departureTime.replace(':', '').replace('am', '').replace('pm', '').padStart(2, '0')
  const normalizedAddress = normalizeWorkAddress(workAddress, departureHour, arriveBy)
  const baseNeighborhoods = getNeighborhoodBases()
  const ntaCodes = baseNeighborhoods.map((n) => n.ntaCode)

  const cachedRows = await CommuteCache.find({
    workAddress: normalizedAddress,
    ntaCode: { $in: ntaCodes },
  }).lean()

  const cachedByCode = new Map(
    cachedRows.map((row) => [row.ntaCode, { minutes: row.minutes, legs: row.legs }])
  )
  const toCompute = baseNeighborhoods.filter((n) => !cachedByCode.has(n.ntaCode))
  const freshResults: CommuteResult[] = []

  const EMPTY_LEGS: import('./types').LegSummary = {
    walkMinutes: 0, subwayMinutes: 0, railMinutes: 0, busMinutes: 0, ferryMinutes: 0,
  }

  for (let i = 0; i < toCompute.length; i += OTP_BATCH_SIZE) {
    const batch = toCompute.slice(i, i + OTP_BATCH_SIZE)
    const batchResults = await Promise.all(
      batch.map(async (n) => {
        const targetLat = n.centroid[1]
        const targetLon = n.centroid[0]
        const straightLineMiles = distMiles(workLat, workLon, targetLat, targetLon)

        if (straightLineMiles <= SHORT_DISTANCE_WALK_ONLY_MILES) {
          const minutes = estimateWalkMinutes(straightLineMiles)
          return {
            ntaCode: n.ntaCode,
            minutes,
            legs: { ...EMPTY_LEGS, walkMinutes: minutes },
          }
        }

        const route = await getOtpRoute(workLat, workLon, targetLat, targetLon, departureTime, arriveBy)
        // If OTP can't find a transit route, fall back to a driving estimate
        // so the neighborhood still gets a legs object (rather than being dropped).
        if (route == null) {
          const driveMin = estimateDriveMinutes(straightLineMiles)
          return { ntaCode: n.ntaCode, minutes: driveMin, legs: { ...EMPTY_LEGS, carMinutes: driveMin } }
        }
        // Suburban destinations: people drive to the station, so only count
        // the egress walk (city station → office), not the access walk.
        const isSuburban =
          n.ntaCode.startsWith('NJ-') ||
          n.ntaCode.startsWith('WC-') ||
          n.ntaCode.startsWith('CT-')
        const legs = parseLegSummary(route.rawLegs, isSuburban)
        // If the walk access leg is > 20 min, transit is impractical — use a
        // driving estimate instead so the commute number reflects reality.
        if (legs.walkMinutes > LONG_WALK_THRESHOLD_MINUTES) {
          const driveMin = estimateDriveMinutes(straightLineMiles)
          return { ntaCode: n.ntaCode, minutes: driveMin, legs: { ...EMPTY_LEGS, carMinutes: driveMin } }
        }
        // For suburban destinations, recalculate the total from the displayed
        // legs so the header matches the breakdown (OTP's raw duration includes
        // the access walk we've stripped out).
        const minutes = isSuburban
          ? legs.walkMinutes + legs.subwayMinutes + legs.railMinutes + legs.busMinutes + legs.ferryMinutes
          : route.minutes
        return { ntaCode: n.ntaCode, minutes, legs }
      })
    )

    const validRows = batchResults.filter((item): item is CommuteResult => item !== null)
    if (validRows.length === 0) continue

    await Promise.all(
      validRows.map((item) =>
        CommuteCache.updateOne(
          { workAddress: normalizedAddress, ntaCode: item.ntaCode },
          { $set: { minutes: item.minutes, legs: item.legs, updatedAt: new Date() } },
          { upsert: true }
        )
      )
    )

    for (const row of validRows) {
      cachedByCode.set(row.ntaCode, { minutes: row.minutes, legs: row.legs })
      freshResults.push(row)
    }
  }

  console.log(
    `Commute cache for "${normalizedAddress}": ${cachedRows.length} hits, ${freshResults.length} new`
  )

  return baseNeighborhoods
    .map((n) => {
      const hit = cachedByCode.get(n.ntaCode)
      return hit == null ? null : { ntaCode: n.ntaCode, minutes: hit.minutes, legs: hit.legs as import('./types').LegSummary }
    })
    .filter((row): row is CommuteResult => row !== null)
}

export function mergeNeighborhoodsWithCommutes(
  base: Array<Omit<Neighborhood, 'commuteMinutes'>>,
  commuteByNtaCode: Map<string, CommuteResult>,
  workLat: number,
  workLng: number
): Neighborhood[] {
  return base.map((n) => {
    const result = commuteByNtaCode.get(n.ntaCode)
    return {
      ...n,
      commuteMinutes:
        result?.minutes ?? mockCommute(workLat, workLng, n.centroid[1], n.centroid[0], n.name),
      legs: result?.legs,
    }
  })
}
