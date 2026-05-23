/**
 * SF Commute Finder — neighborhood data for San Francisco and Oakland.
 *
 * Architecture mirrors neighborhoods.ts but:
 *  - All data is hardcoded (no local GeoJSON file required).
 *  - Uses OTP_PLAN_URL_SF (port 8081) for Bay Area routing via 511.org GTFS.
 *  - No "egressWalkOnly" flag — all SF/Oakland destinations are urban transit.
 *  - safetyRating and description fields for each neighborhood.
 */

import { CommuteCache } from './commuteCache'
import type { CommuteResult, Neighborhood } from './types'

const OTP_PLAN_URL_SF =
  process.env.OTP_PLAN_URL_SF || 'http://localhost:8081/otp/routers/default/plan'
const OTP_BATCH_SIZE = 10
const SF_CACHE_VERSION = 'sf-v3'
const WALKING_MPH = 3
const SHORT_DISTANCE_WALK_ONLY_MILES = 1.0
const LONG_WALK_THRESHOLD_MINUTES = 20

/**
 * Rough driving time estimate based on straight-line distance.
 * Uses a blended speed: slower for short city hops, faster for longer highway runs.
 */
function estimateDriveMinutes(distMiles: number): number {
  const avgMph = distMiles < 10 ? 22 : distMiles < 25 ? 28 : 34
  return Math.max(8, Math.round((distMiles * 1.35 / avgMph) * 60))
}

// 505 Howard St, SF (SoMa) — default work location
const SF_WORK_LAT = 37.7874
const SF_WORK_LNG = -122.3964

type RawLeg = { mode: string; duration?: number }

/**
 * Converts a DataSF neighborhood name → sfCode key.
 * Used both here and in the nta-geojson-sf route so choropleth matching is consistent.
 * Example: "Castro/Upper Market" → "SF-CastroUpperMarket"
 */
export function sfNameToCode(name: string): string {
  return 'SF-' + name.replace(/[^a-zA-Z0-9]/g, '')
}

function parseLegSummary(legs: RawLeg[]): import('./types').LegSummary {
  const sumModes = (...modes: string[]) =>
    legs.filter((l) => modes.includes(l.mode)).reduce((acc, l) => acc + (l.duration ?? 0), 0)
  const walkDuration = legs.filter((l) => l.mode === 'WALK').reduce((acc, l) => acc + (l.duration ?? 0), 0)
  return {
    walkMinutes:   Math.round(walkDuration / 60),
    // Muni Metro (TRAM / SUBWAY) + cable car → buckets as "subway"
    subwayMinutes: Math.round(sumModes('SUBWAY', 'TRAM', 'CABLE_CAR') / 60),
    // BART + Caltrain (RAIL) → bucket as "rail"
    railMinutes:   Math.round(sumModes('RAIL') / 60),
    busMinutes:    Math.round(sumModes('BUS') / 60),
    ferryMinutes:  Math.round(sumModes('FERRY') / 60),
  }
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
  return Math.max(1, Math.ceil((distanceMiles / WALKING_MPH) * 60))
}

function mockCommute(workLat: number, workLng: number, lat: number, lng: number, name: string): number {
  const d = distMiles(workLat, workLng, lat, lng)
  const jitter = ((name.charCodeAt(name.length - 1) + name.length) % 7) - 3
  return Math.max(5, Math.round(6 + d * 9 + jitter))
}

/** Next Monday date string for OTP queries (anchors to a typical weekday). */
function getNextMondayDateStr(): string {
  const today = new Date()
  const day = today.getDay()
  const daysUntilMonday = day === 0 ? 1 : day === 1 ? 7 : 8 - day
  const monday = new Date(today)
  monday.setDate(today.getDate() + daysUntilMonday)
  return `${monday.getMonth() + 1}/${monday.getDate()}/${monday.getFullYear()}`
}

async function getOtpRoute(
  fromLat: number, fromLon: number,
  toLat: number,   toLon: number,
  departureTime: string,
  arriveBy = false,
): Promise<{ minutes: number; rawLegs: RawLeg[] } | null> {
  const params = new URLSearchParams({
    fromPlace: `${fromLat},${fromLon}`,
    toPlace:   `${toLat},${toLon}`,
    mode: 'TRANSIT,WALK',
    arriveBy: arriveBy ? 'true' : 'false',
    numItineraries: '1',
    time: departureTime,
    date: getNextMondayDateStr(),
  })
  try {
    const response = await fetch(`${OTP_PLAN_URL_SF}?${params.toString()}`)
    if (!response.ok) return null
    const data = (await response.json()) as {
      plan?: { itineraries?: Array<{ duration?: number; legs: Array<{ mode: string; duration?: number }> }> }
    }
    const itinerary = data.plan?.itineraries?.[0]
    if (!itinerary || typeof itinerary.duration !== 'number') return null
    const hasTransitLeg = (itinerary.legs ?? []).some(
      (l) => !['WALK', 'BICYCLE', 'CAR'].includes(l.mode)
    )
    if (!hasTransitLeg) return null
    return {
      minutes:  Math.max(1, Math.round(itinerary.duration / 60)),
      rawLegs: itinerary.legs ?? [],
    }
  } catch {
    return null
  }
}

function normalizeWorkAddress(address: string, departureHour: string, arriveBy: boolean): string {
  return `${SF_CACHE_VERSION}:${address.trim().toLowerCase()}:${departureHour}:${arriveBy ? 'arrive' : 'depart'}`
}

// ─── Static neighborhood data ────────────────────────────────────────────────
//
// centroid is [lng, lat] — same convention as NYC neighborhoods.ts
// safetyRating: 1 (high crime) → 5 (very safe)
// description: 1–2 sentences for someone relocating from NYC

interface SFNeighborhoodBase extends Omit<Neighborhood, 'commuteMinutes'> {
  safetyRating: number
  description: string
  summerHigh: number
  summerLow: number
  winterHigh: number
  winterLow: number
}

const SF_NEIGHBORHOODS: SFNeighborhoodBase[] = [
  // ── San Francisco ──────────────────────────────────────────────────────────
  // Temperature key: summerHigh/Low = Jun–Aug avg °F, winterHigh/Low = Dec–Feb avg °F
  // SF microclimates vary dramatically — the fog belt (Outer Sunset, Richmond) runs
  // ~10°F cooler in summer than the sunny "Banana Belt" (Mission, Noe Valley, Potrero).
  // Oakland is 5–15°F warmer than SF in summer and gets real sunshine.
  {
    ntaCode: sfNameToCode('Bayview Hunters Point'),
    name: 'Bayview Hunters Point',
    borough: 'San Francisco',
    centroid: [-122.384, 37.735],
    medianRent: 2300,
    safetyRating: 2,
    description: 'Industrial waterfront neighborhood in rapid transition — Chase Center and UCSF Mission Bay are nearby. Authentic and affordable, but exercise caution at night.',
    summerHigh: 70, summerLow: 56, winterHigh: 58, winterLow: 47,
  },
  {
    ntaCode: sfNameToCode('Bernal Heights'),
    name: 'Bernal Heights',
    borough: 'San Francisco',
    centroid: [-122.416, 37.741],
    medianRent: 3900,
    safetyRating: 4,
    description: 'Hilly village feel with tight-knit community vibes — think a sunnier, hillier Park Slope. Great dog parks, local coffee shops, and Mission-adjacent dining.',
    summerHigh: 72, summerLow: 57, winterHigh: 59, winterLow: 47,
  },
  {
    ntaCode: sfNameToCode('Castro/Upper Market'),
    name: 'Castro/Upper Market',
    borough: 'San Francisco',
    centroid: [-122.435, 37.762],
    medianRent: 3800,
    safetyRating: 4,
    description: "SF's West Village — the iconic LGBTQ+ epicenter with Victorian Painted Ladies, lively bars, and a proud community. Very walkable and well-connected.",
    summerHigh: 72, summerLow: 57, winterHigh: 59, winterLow: 47,
  },
  {
    ntaCode: sfNameToCode('Chinatown'),
    name: 'Chinatown',
    borough: 'San Francisco',
    centroid: [-122.407, 37.795],
    medianRent: 1900,
    safetyRating: 3,
    description: "Denser and more atmospheric than NYC's Chinatown, with authentic dim sum and herb shops on steep hills. Borders the Tenderloin — use normal city awareness.",
    summerHigh: 66, summerLow: 54, winterHigh: 57, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Excelsior'),
    name: 'Excelsior',
    borough: 'San Francisco',
    centroid: [-122.431, 37.722],
    medianRent: 2900,
    safetyRating: 3,
    description: 'Diverse working-class neighborhood with excellent Filipino, Mexican, and Chinese food. Think Jackson Heights but hillier — one of SF\'s most authentic and affordable areas.',
    summerHigh: 70, summerLow: 56, winterHigh: 58, winterLow: 47,
  },
  {
    ntaCode: sfNameToCode('Financial District/South Beach'),
    name: 'Financial District/South Beach',
    borough: 'San Francisco',
    centroid: [-122.396, 37.790],
    medianRent: 4000,
    safetyRating: 4,
    description: "SF's FiDi — Salesforce Tower, the Ferry Building, and waterfront promenades. Pricey and corporate by day, quieter at night. Like a smaller, prettier Lower Manhattan.",
    summerHigh: 67, summerLow: 55, winterHigh: 57, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Glen Park'),
    name: 'Glen Park',
    borough: 'San Francisco',
    centroid: [-122.435, 37.733],
    medianRent: 3900,
    safetyRating: 5,
    description: 'A hidden gem — small-town quiet tucked in a canyon, BART direct to SoMa. Think a calmer, greener Brooklyn Heights. Excellent for families who want city access with suburban peace.',
    summerHigh: 71, summerLow: 56, winterHigh: 58, winterLow: 47,
  },
  {
    ntaCode: sfNameToCode('Haight Ashbury'),
    name: 'Haight Ashbury',
    borough: 'San Francisco',
    centroid: [-122.448, 37.769],
    medianRent: 3400,
    safetyRating: 3,
    description: "The 60s counterculture neighborhood that never fully let go. Vintage shops, Victorians, and Golden Gate Park access. Rougher street scene than the tourist image suggests — similar to the East Village's edgier blocks.",
    summerHigh: 67, summerLow: 55, winterHigh: 58, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Hayes Valley'),
    name: 'Hayes Valley',
    borough: 'San Francisco',
    centroid: [-122.424, 37.776],
    medianRent: 3900,
    safetyRating: 4,
    description: 'Trendy, walkable, boutique-heavy — Nolita meets Williamsburg. Close to City Hall, SF Symphony, and BART. One of the best neighborhoods for young professionals new to the city.',
    summerHigh: 68, summerLow: 56, winterHigh: 58, winterLow: 47,
  },
  {
    ntaCode: sfNameToCode('Inner Richmond'),
    name: 'Inner Richmond',
    borough: 'San Francisco',
    centroid: [-122.466, 37.779],
    medianRent: 3300,
    safetyRating: 4,
    description: "Very livable, diverse, and great food — known as SF's 'New Chinatown' with incredible Asian dining. Think the Upper West Side's quieter, foggier cousin. Good for families.",
    summerHigh: 65, summerLow: 54, winterHigh: 57, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Inner Sunset'),
    name: 'Inner Sunset',
    borough: 'San Francisco',
    centroid: [-122.468, 37.762],
    medianRent: 3500,
    safetyRating: 4,
    description: 'Foggy, cozy, and authentic — UCSF students, families, and long-time SF residents. Ocean Beach nearby, Golden Gate Park at your door. The Upper West Side meets a beach town.',
    summerHigh: 64, summerLow: 53, winterHigh: 56, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Japantown'),
    name: 'Japantown',
    borough: 'San Francisco',
    centroid: [-122.430, 37.785],
    medianRent: 3400,
    safetyRating: 4,
    description: 'One of only three remaining Japantowns in the US — cherry blossoms, ramen, mochi, and cultural festivals. Tucked between Pacific Heights and Western Addition.',
    summerHigh: 67, summerLow: 55, winterHigh: 57, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Lakeshore'),
    name: 'Lakeshore',
    borough: 'San Francisco',
    centroid: [-122.477, 37.726],
    medianRent: 2900,
    safetyRating: 4,
    description: 'Quiet residential neighborhood next to Lake Merced and San Francisco State. More suburban feel — like a calmer version of outer Queens.',
    summerHigh: 63, summerLow: 53, winterHigh: 56, winterLow: 45,
  },
  {
    ntaCode: sfNameToCode('Lincoln Park'),
    name: 'Lincoln Park',
    borough: 'San Francisco',
    centroid: [-122.499, 37.786],
    medianRent: 3900,
    safetyRating: 5,
    description: 'Dramatic cliffside park neighborhood with ocean views and the Legion of Honor museum. Very quiet and residential — truly unique, nothing like this exists in NYC.',
    summerHigh: 62, summerLow: 52, winterHigh: 56, winterLow: 45,
  },
  {
    ntaCode: sfNameToCode('Lone Mountain/USF'),
    name: 'Lone Mountain/USF',
    borough: 'San Francisco',
    centroid: [-122.452, 37.778],
    medianRent: 3200,
    safetyRating: 4,
    description: 'University district on a quiet hilltop with a student-and-family mix. Between the Richmond and Inner Sunset — good bones, well-maintained.',
    summerHigh: 66, summerLow: 54, winterHigh: 57, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Marina'),
    name: 'Marina',
    borough: 'San Francisco',
    centroid: [-122.437, 37.803],
    medianRent: 4300,
    safetyRating: 5,
    description: "SF's Upper East Side — young professionals, brunch culture, boutiques, and sailboats on the Bay. Beautiful Victorians and views of the Golden Gate. Expensive but extremely livable.",
    summerHigh: 67, summerLow: 55, winterHigh: 57, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('McLaren Park'),
    name: 'McLaren Park',
    borough: 'San Francisco',
    centroid: [-122.423, 37.718],
    medianRent: 2400,
    safetyRating: 3,
    description: "SF's second-largest park neighborhood — quiet and overlooked. Adjacent to Excelsior, great for outdoorsy types who want affordable SF.",
    summerHigh: 70, summerLow: 56, winterHigh: 58, winterLow: 47,
  },
  {
    ntaCode: sfNameToCode('Mission'),
    name: 'Mission',
    borough: 'San Francisco',
    centroid: [-122.415, 37.759],
    medianRent: 3700,
    safetyRating: 3,
    description: 'The soul of SF — murals, taquerias, bars, and tech workers. The NYC equivalent is Brooklyn: gentrifying but still authentic, with the best weather in the city (sunniest microclimate). Mixed safety depending on the block.',
    summerHigh: 74, summerLow: 58, winterHigh: 59, winterLow: 48,
  },
  {
    ntaCode: sfNameToCode('Mission Bay'),
    name: 'Mission Bay',
    borough: 'San Francisco',
    centroid: [-122.393, 37.770],
    medianRent: 3900,
    safetyRating: 4,
    description: "Brand-new neighborhood built from scratch — Chase Center (Warriors arena), UCSF Mission Bay campus, and gleaming glass condos. SF's version of Hudson Yards, but less sterile.",
    summerHigh: 68, summerLow: 55, winterHigh: 57, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Nob Hill'),
    name: 'Nob Hill',
    borough: 'San Francisco',
    centroid: [-122.416, 37.793],
    medianRent: 4200,
    safetyRating: 4,
    description: "Old money SF — cable cars, grand hotels like the Fairmont, and panoramic Bay views. Think Park Avenue meets San Francisco. The lower slopes border the Tenderloin, so location within the neighborhood matters.",
    summerHigh: 65, summerLow: 54, winterHigh: 57, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Noe Valley'),
    name: 'Noe Valley',
    borough: 'San Francisco',
    centroid: [-122.431, 37.750],
    medianRent: 4600,
    safetyRating: 5,
    description: "Nicknamed 'Stroller Valley' — one of SF's safest and most family-friendly areas. Lively 24th St commercial strip, sunny microclimate, and great schools. Like a Park Slope that's even more expensive.",
    summerHigh: 73, summerLow: 57, winterHigh: 59, winterLow: 47,
  },
  {
    ntaCode: sfNameToCode('North Beach'),
    name: 'North Beach',
    borough: 'San Francisco',
    centroid: [-122.410, 37.806],
    medianRent: 4200,
    safetyRating: 4,
    description: "SF's answer to Little Italy meets Greenwich Village — Beat Generation history at City Lights Books, great Italian food, and Coit Tower above. Touristy by day, genuinely fun at night.",
    summerHigh: 66, summerLow: 54, winterHigh: 57, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Outer Mission'),
    name: 'Outer Mission',
    borough: 'San Francisco',
    centroid: [-122.434, 37.721],
    medianRent: 2800,
    safetyRating: 3,
    description: 'Working-class Latino neighborhood, affordable and authentic. Similar vibe to the Inner Mission but quieter and further out — think the Bronx equivalent of Brooklyn.',
    summerHigh: 70, summerLow: 56, winterHigh: 58, winterLow: 47,
  },
  {
    ntaCode: sfNameToCode('Outer Richmond'),
    name: 'Outer Richmond',
    borough: 'San Francisco',
    centroid: [-122.497, 37.779],
    medianRent: 3000,
    safetyRating: 4,
    description: 'Foggy, calm, and beautifully diverse — great Asian and Russian food, near Ocean Beach. Often called "the Avenues." Think Flushing but hillier, with better light.',
    summerHigh: 62, summerLow: 52, winterHigh: 56, winterLow: 45,
  },
  {
    ntaCode: sfNameToCode('Pacific Heights'),
    name: 'Pacific Heights',
    borough: 'San Francisco',
    centroid: [-122.435, 37.793],
    medianRent: 5300,
    safetyRating: 5,
    description: "SF's most prestigious residential neighborhood — mansions, consulate row, and some of the best views in the city. The Upper East Side but with Victorian architecture and no subway noise.",
    summerHigh: 67, summerLow: 55, winterHigh: 57, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Portola'),
    name: 'Portola',
    borough: 'San Francisco',
    centroid: [-122.409, 37.727],
    medianRent: 2800,
    safetyRating: 3,
    description: 'One of SF\'s most underrated neighborhoods — increasingly popular with artists and young families. Affordable, good bones, close to McLaren Park.',
    summerHigh: 70, summerLow: 56, winterHigh: 58, winterLow: 47,
  },
  {
    ntaCode: sfNameToCode('Potrero Hill'),
    name: 'Potrero Hill',
    borough: 'San Francisco',
    centroid: [-122.401, 37.762],
    medianRent: 3800,
    safetyRating: 4,
    description: 'Sunny microclimate (rare in SF!), industrial-creative vibe, and great restaurants. Think Gowanus fully gentrified — startup offices, dog parks, and stunning views of downtown.',
    summerHigh: 73, summerLow: 57, winterHigh: 59, winterLow: 47,
  },
  {
    ntaCode: sfNameToCode('Presidio'),
    name: 'Presidio',
    borough: 'San Francisco',
    centroid: [-122.466, 37.799],
    medianRent: 4200,
    safetyRating: 5,
    description: 'A national park inside the city — redwood forests, converted military housing, and views of the Golden Gate Bridge. Nothing like this exists in any NYC neighborhood.',
    summerHigh: 63, summerLow: 53, winterHigh: 56, winterLow: 45,
  },
  {
    ntaCode: sfNameToCode('Presidio Heights'),
    name: 'Presidio Heights',
    borough: 'San Francisco',
    centroid: [-122.449, 37.788],
    medianRent: 5100,
    safetyRating: 5,
    description: 'Ultra-quiet, very wealthy residential stretch between Pacific Heights and the Presidio. Old money, grand homes, and almost zero street noise.',
    summerHigh: 66, summerLow: 54, winterHigh: 57, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Russian Hill'),
    name: 'Russian Hill',
    borough: 'San Francisco',
    centroid: [-122.419, 37.801],
    medianRent: 4400,
    safetyRating: 5,
    description: "Home of Lombard Street (the crookedest street in the world) and jaw-dropping Bay views. Think the Upper West Side with more personality. Steep hills, charming streets.",
    summerHigh: 65, summerLow: 54, winterHigh: 57, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Seacliff'),
    name: 'Seacliff',
    borough: 'San Francisco',
    centroid: [-122.492, 37.787],
    medianRent: 5800,
    safetyRating: 5,
    description: "One of SF's most exclusive neighborhoods — oceanfront, quiet, and almost entirely single-family homes. Think the Hamptons but you live there year-round.",
    summerHigh: 62, summerLow: 52, winterHigh: 56, winterLow: 45,
  },
  {
    ntaCode: sfNameToCode('South of Market'),
    name: 'South of Market (SoMa)',
    borough: 'San Francisco',
    centroid: [-122.406, 37.778],
    medianRent: 3500,
    safetyRating: 3,
    description: "Tech central — Salesforce, Twitter/X, and hundreds of startups. Warehouses-turned-event-spaces, galleries, and nightclubs. SF's Meatpacking District meets DUMBO. Patchy safety, especially near 6th and 7th St.",
    summerHigh: 68, summerLow: 56, winterHigh: 58, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Sunset'),
    name: 'Sunset',
    borough: 'San Francisco',
    centroid: [-122.487, 37.754],
    medianRent: 3000,
    safetyRating: 4,
    description: 'Miles of quiet avenues stretching to Ocean Beach — consistently foggy but very livable. Strong Asian community, excellent food, affordable for SF. Like a larger, calmer Outer Richmond.',
    summerHigh: 62, summerLow: 52, winterHigh: 56, winterLow: 45,
  },
  {
    ntaCode: sfNameToCode('Tenderloin'),
    name: 'Tenderloin',
    borough: 'San Francisco',
    centroid: [-122.414, 37.784],
    medianRent: 1900,
    safetyRating: 1,
    description: "SF's most challenging neighborhood — the highest concentration of drug activity and homelessness in the city, right next to Union Square. Extremely cheap, but not recommended for newcomers.",
    summerHigh: 67, summerLow: 55, winterHigh: 57, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Treasure Island'),
    name: 'Treasure Island',
    borough: 'San Francisco',
    centroid: [-122.370, 37.824],
    medianRent: 2200,
    safetyRating: 3,
    description: 'A man-made island in the Bay with stunning views and very limited transit — ferry to the Ferry Building. Affordable but isolated; active redevelopment underway.',
    summerHigh: 65, summerLow: 54, winterHigh: 57, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Twin Peaks'),
    name: 'Twin Peaks',
    borough: 'San Francisco',
    centroid: [-122.447, 37.752],
    medianRent: 3600,
    safetyRating: 4,
    description: "At the geographic center of SF with 360° panoramic views. Quiet, residential, and less touristy than it looks. Think a hillier, windier Riverside Drive.",
    summerHigh: 64, summerLow: 53, winterHigh: 56, winterLow: 45,
  },
  {
    ntaCode: sfNameToCode('Visitacion Valley'),
    name: 'Visitacion Valley',
    borough: 'San Francisco',
    centroid: [-122.415, 37.714],
    medianRent: 2400,
    safetyRating: 2,
    description: "Historically underserved neighborhood at SF's southern edge — affordable and diverse but with higher crime rates. Improving rapidly but still a developing area.",
    summerHigh: 70, summerLow: 56, winterHigh: 58, winterLow: 47,
  },
  {
    ntaCode: sfNameToCode('West of Twin Peaks'),
    name: 'West of Twin Peaks',
    borough: 'San Francisco',
    centroid: [-122.458, 37.745],
    medianRent: 3300,
    safetyRating: 4,
    description: 'A quiet collection of residential hillside neighborhoods (Forest Hill, West Portal, St. Francis Wood) mostly accessible by MUNI. Suburban feeling with city access — good for families.',
    summerHigh: 64, summerLow: 53, winterHigh: 57, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Western Addition'),
    name: 'Western Addition',
    borough: 'San Francisco',
    centroid: [-122.436, 37.781],
    medianRent: 3300,
    safetyRating: 3,
    description: "Historically the heart of SF's Black community, now rapidly gentrifying. A mix of jazz clubs, Victorian flats, and new condos. Think Harlem but smaller — authentic history, mixed present.",
    summerHigh: 68, summerLow: 55, winterHigh: 58, winterLow: 46,
  },
  {
    ntaCode: sfNameToCode('Oceanview/Merced/Ingleside'),
    name: 'Oceanview/Merced/Ingleside',
    borough: 'San Francisco',
    centroid: [-122.460, 37.729],
    medianRent: 2800,
    safetyRating: 3,
    description: 'Quiet outer neighborhoods near SFSU and Balboa Park BART. Affordable, family-friendly, and less known — good value for budget-conscious renters.',
    summerHigh: 65, summerLow: 54, winterHigh: 57, winterLow: 46,
  },

  // ── Peninsula ─────────────────────────────────────────────────────────────
  // The Peninsula runs down the western shore of the Bay from SF to San Jose.
  // Temps rise steadily as you move south — South SF is still foggy, but
  // Redwood City and beyond are warm and mostly sunny.
  {
    ntaCode: 'PEN-southsf',
    name: 'South San Francisco',
    borough: 'Peninsula',
    centroid: [-122.408, 37.654],
    medianRent: 2800,
    safetyRating: 3,
    description: 'The "Industrial City" is home to a booming biotech/pharma corridor and very reasonable rents for the Bay Area. Still foggy like SF but cheaper — think a quieter, more suburban outer Brooklyn.',
    summerHigh: 68, summerLow: 53, winterHigh: 58, winterLow: 45,
  },
  {
    ntaCode: 'PEN-dalycity',
    name: 'Daly City',
    borough: 'Peninsula',
    centroid: [-122.469, 37.688],
    medianRent: 2600,
    safetyRating: 3,
    description: 'Dense, diverse, and perpetually foggy — some of the lowest rents directly on BART in the Bay Area. Strong Filipino community and great food. A no-frills starter neighborhood for budget-conscious newcomers.',
    summerHigh: 63, summerLow: 51, winterHigh: 56, winterLow: 44,
  },
  {
    ntaCode: 'PEN-sanbruno',
    name: 'San Bruno',
    borough: 'Peninsula',
    centroid: [-122.411, 37.630],
    medianRent: 2900,
    safetyRating: 4,
    description: "Quiet, safe, and walkable to Caltrain — a straightforward suburban town that punches above its weight on value. Think a mellower, sunnier version of the outer boroughs. SFO is right next door, which some love.",
    summerHigh: 70, summerLow: 54, winterHigh: 58, winterLow: 45,
  },
  {
    ntaCode: 'PEN-millbrae',
    name: 'Millbrae',
    borough: 'Peninsula',
    centroid: [-122.388, 37.600],
    medianRent: 3200,
    safetyRating: 5,
    description: 'Small, affluent, and uniquely positioned — the only Bay Area city served by both BART and Caltrain. Excellent dim sum scene, great schools, very safe. Like a calmer, sunnier Forest Hills.',
    summerHigh: 72, summerLow: 54, winterHigh: 58, winterLow: 45,
  },
  {
    ntaCode: 'PEN-burlingame',
    name: 'Burlingame',
    borough: 'Peninsula',
    centroid: [-122.365, 37.584],
    medianRent: 3800,
    safetyRating: 5,
    description: "One of the Bay Area's most charming small cities — beautiful tree-lined streets, a walkable downtown, and excellent Caltrain access. Think Montclair NJ but sunny, Spanish-revival, and on the Bay.",
    summerHigh: 74, summerLow: 56, winterHigh: 59, winterLow: 45,
  },
  {
    ntaCode: 'PEN-sanmateo',
    name: 'San Mateo',
    borough: 'Peninsula',
    centroid: [-122.325, 37.563],
    medianRent: 3200,
    safetyRating: 4,
    description: "Mid-Peninsula hub with a lively downtown, diverse neighborhoods, and strong Caltrain connections. More affordable than Burlingame but just as livable — like a younger, more casual version of that same Montclair vibe.",
    summerHigh: 75, summerLow: 56, winterHigh: 59, winterLow: 45,
  },
  {
    ntaCode: 'PEN-redwoodcity',
    name: 'Redwood City',
    borough: 'Peninsula',
    centroid: [-122.236, 37.486],
    medianRent: 2900,
    safetyRating: 3,
    description: "\"Climate Best by Government Test\" — its actual official slogan, and not wrong. Noticeably warmer than SF, rapidly gentrifying downtown, and among the more affordable Peninsula options. Think a warmer, sunnier Jersey City.",
    summerHigh: 80, summerLow: 57, winterHigh: 60, winterLow: 45,
  },
  {
    ntaCode: 'PEN-menlopark',
    name: 'Menlo Park',
    borough: 'Peninsula',
    centroid: [-122.182, 37.453],
    medianRent: 3800,
    safetyRating: 5,
    description: "Home to Sand Hill Road (VC capital of the world) and Facebook/Meta HQ. Quiet, leafy, expensive, and warm. Think Great Neck meets Silicon Valley — very residential, very safe, excellent schools.",
    summerHigh: 81, summerLow: 57, winterHigh: 60, winterLow: 44,
  },
  {
    ntaCode: 'PEN-paloalto',
    name: 'Palo Alto',
    borough: 'Peninsula',
    centroid: [-122.143, 37.442],
    medianRent: 4200,
    safetyRating: 5,
    description: "Stanford's hometown and the spiritual center of Silicon Valley. Walkable University Ave, beautiful tree-lined neighborhoods, and genuinely warm summers. Think Cambridge MA but richer, sunnier, and with better burritos.",
    summerHigh: 82, summerLow: 57, winterHigh: 60, winterLow: 44,
  },

  // ── South Bay ─────────────────────────────────────────────────────────────
  // True Silicon Valley — warm, sunny, suburban. No marine fog, real summers.
  {
    ntaCode: 'SB-mountainview',
    name: 'Mountain View',
    borough: 'South Bay',
    centroid: [-122.084, 37.386],
    medianRent: 3400,
    safetyRating: 4,
    description: "Google's hometown — a surprisingly lively downtown (Castro St), great restaurants, and warm sunny summers. Very bikeable, Caltrain-connected. Like a teched-up, sunnier Hoboken, but spread out.",
    summerHigh: 84, summerLow: 58, winterHigh: 61, winterLow: 44,
  },
  {
    ntaCode: 'SB-sunnyvale',
    name: 'Sunnyvale',
    borough: 'South Bay',
    centroid: [-122.036, 37.369],
    medianRent: 3300,
    safetyRating: 4,
    description: "One of the safest large cities in California — clean, orderly, and tech-company dense (Apple, LinkedIn, AMD nearby). Lacks NYC energy but great value for the climate and safety. Think a sprawling, warmer Edison NJ.",
    summerHigh: 85, summerLow: 58, winterHigh: 61, winterLow: 43,
  },
  {
    ntaCode: 'SB-santaclara',
    name: 'Santa Clara',
    borough: 'South Bay',
    centroid: [-121.952, 37.354],
    medianRent: 3000,
    safetyRating: 4,
    description: "Home to Intel, NVIDIA, and Levi's Stadium. Very suburban and car-dependent but among the better values in the South Bay. Warm all summer with almost zero fog. Think a tech-campus version of outer Queens.",
    summerHigh: 85, summerLow: 59, winterHigh: 61, winterLow: 43,
  },
  {
    ntaCode: 'SB-sanjose',
    name: 'San Jose (Downtown)',
    borough: 'South Bay',
    centroid: [-121.886, 37.339],
    medianRent: 2600,
    safetyRating: 3,
    description: "The Bay Area's largest city and most affordable major hub — warm, diverse, and genuinely improving downtown scene. Long commute to SF but great for those working in the South Bay. Think a sunnier, calmer version of Newark.",
    summerHigh: 87, summerLow: 60, winterHigh: 62, winterLow: 43,
  },

  // ── East Bay additions ─────────────────────────────────────────────────────
  {
    ntaCode: 'EB-berkeley',
    name: 'Berkeley',
    borough: 'East Bay',
    centroid: [-122.273, 37.872],
    medianRent: 2800,
    safetyRating: 3,
    description: "UC Berkeley's city — politically electric, intellectually alive, and home to some of the best restaurants in the Bay Area (Chez Panisse country). Like a bigger, warmer, funkier version of Cambridge MA. BART to SF is ~20 min.",
    summerHigh: 72, summerLow: 57, winterHigh: 57, winterLow: 44,
  },
  {
    ntaCode: 'EB-emeryville',
    name: 'Emeryville',
    borough: 'East Bay',
    centroid: [-122.285, 37.832],
    medianRent: 2900,
    safetyRating: 3,
    description: "A tiny, formerly industrial city between Oakland and Berkeley that's now a walkable grid of tech offices, IKEA, and decent apartments. Think Long Island City before the Amazon HQ hype — practical, accessible, not glamorous.",
    summerHigh: 73, summerLow: 57, winterHigh: 58, winterLow: 45,
  },
  {
    ntaCode: 'EB-alameda',
    name: 'Alameda',
    borough: 'East Bay',
    centroid: [-122.242, 37.767],
    medianRent: 2700,
    safetyRating: 4,
    description: "An island city with Victorian housing stock, quiet tree-lined streets, and small-town charm just minutes from Oakland. Very safe, good schools, and warmer than SF. Like a smaller, chiller version of Hoboken on the Bay.",
    summerHigh: 74, summerLow: 57, winterHigh: 59, winterLow: 45,
  },

  // ── Marin County ──────────────────────────────────────────────────────────
  // North of the Golden Gate — dramatic scenery, excellent schools, car-dependent.
  {
    ntaCode: 'MARIN-sausalito',
    name: 'Sausalito',
    borough: 'Marin',
    centroid: [-122.485, 37.859],
    medianRent: 3600,
    safetyRating: 5,
    description: "Houseboat community and hillside village right across the Golden Gate — stunning Bay views, ferry to SF's Ferry Building, and a European small-town feel. Very expensive, very beautiful, and nothing like anything in NYC.",
    summerHigh: 69, summerLow: 54, winterHigh: 57, winterLow: 44,
  },
  {
    ntaCode: 'MARIN-millvalley',
    name: 'Mill Valley',
    borough: 'Marin',
    centroid: [-122.545, 37.906],
    medianRent: 4200,
    safetyRating: 5,
    description: "Tucked into redwood-draped hills, Mill Valley is quintessential Marin — earthy, wealthy, and surrounded by Mt. Tamalpais trails. Warm summers, top schools, and a charming downtown square. Think the Connecticut suburbs but with hiking.",
    summerHigh: 79, summerLow: 56, winterHigh: 58, winterLow: 43,
  },
  {
    ntaCode: 'MARIN-sanrafael',
    name: 'San Rafael',
    borough: 'Marin',
    centroid: [-122.531, 37.974],
    medianRent: 3100,
    safetyRating: 4,
    description: "Marin's largest and most affordable city — a real downtown with restaurants, a farmers market, and more diverse housing options than its pricier neighbors. Warm and sunny. Think White Plains but with better access to nature.",
    summerHigh: 82, summerLow: 56, winterHigh: 59, winterLow: 43,
  },

  // ── Oakland ────────────────────────────────────────────────────────────────
  // Oakland is significantly warmer and sunnier than SF — no marine layer.
  {
    ntaCode: 'OAK-downtown',
    name: 'Downtown Oakland',
    borough: 'Oakland',
    centroid: [-122.271, 37.805],
    medianRent: 2200,
    safetyRating: 3,
    description: 'Oakland\'s city center, undergoing a renaissance with restaurants, galleries, and tech spillover from SF. Rough around the edges but genuinely exciting — like Brooklyn in 2005.',
    summerHigh: 78, summerLow: 59, winterHigh: 59, winterLow: 45,
  },
  {
    ntaCode: 'OAK-uptown',
    name: 'Uptown Oakland',
    borough: 'Oakland',
    centroid: [-122.268, 37.811],
    medianRent: 2500,
    safetyRating: 3,
    description: "Oakland's arts and nightlife hub — the Fox Theater, tons of restaurants, and vibrant murals. Feels like Williamsburg meets Bed-Stuy. BART to SF is about 15 minutes.",
    summerHigh: 78, summerLow: 59, winterHigh: 59, winterLow: 45,
  },
  {
    ntaCode: 'OAK-lake-merritt',
    name: 'Lake Merritt',
    borough: 'Oakland',
    centroid: [-122.257, 37.806],
    medianRent: 2600,
    safetyRating: 3,
    description: "A gorgeous tidal lagoon in the middle of Oakland — jogging paths, farmers markets, and lake-view apartments. Like Prospect Park but warmer and way cheaper.",
    summerHigh: 79, summerLow: 60, winterHigh: 59, winterLow: 46,
  },
  {
    ntaCode: 'OAK-grand-lake',
    name: 'Grand Lake',
    borough: 'Oakland',
    centroid: [-122.239, 37.814],
    medianRent: 2900,
    safetyRating: 4,
    description: "Charming neighborhood around Grand Lake with a beloved farmers market and the Grand Lake Theatre. Very walkable, family-friendly, and one of Oakland's best values.",
    summerHigh: 79, summerLow: 59, winterHigh: 59, winterLow: 45,
  },
  {
    ntaCode: 'OAK-temescal',
    name: 'Temescal',
    borough: 'Oakland',
    centroid: [-122.274, 37.831],
    medianRent: 2900,
    safetyRating: 4,
    description: "Oakland's hottest neighborhood — craft coffee, excellent restaurants, vintage shops. Think Park Slope but with better weather and half the cost. Very popular with SF transplants.",
    summerHigh: 78, summerLow: 59, winterHigh: 58, winterLow: 45,
  },
  {
    ntaCode: 'OAK-rockridge',
    name: 'Rockridge',
    borough: 'Oakland',
    centroid: [-122.251, 37.837],
    medianRent: 3100,
    safetyRating: 4,
    description: "Oakland's most NYC-like neighborhood — walkable, tree-lined, great restaurants on College Ave, BART direct to the city. Think Upper West Side prices at Brooklyn prices.",
    summerHigh: 77, summerLow: 58, winterHigh: 58, winterLow: 44,
  },
  {
    ntaCode: 'OAK-montclair',
    name: 'Montclair',
    borough: 'Oakland',
    centroid: [-122.210, 37.820],
    medianRent: 3400,
    safetyRating: 5,
    description: "Hidden in the Oakland Hills — a village feel with excellent schools, hiking trails at your door, and stunning Bay views. Bus to BART. Like a gentler, warmer Montclair NJ.",
    summerHigh: 74, summerLow: 56, winterHigh: 56, winterLow: 42,
  },
  {
    ntaCode: 'OAK-fruitvale',
    name: 'Fruitvale',
    borough: 'Oakland',
    centroid: [-122.224, 37.775],
    medianRent: 2000,
    safetyRating: 2,
    description: "Vibrant Latino neighborhood centered around the Fruitvale BART station. Authentic taquerias and panaderias — very affordable but exercise caution, especially at night.",
    summerHigh: 80, summerLow: 60, winterHigh: 60, winterLow: 46,
  },
  {
    ntaCode: 'OAK-jack-london',
    name: 'Jack London Square',
    borough: 'Oakland',
    centroid: [-122.278, 37.795],
    medianRent: 2600,
    safetyRating: 3,
    description: "Oakland's waterfront district — ferry terminal to SF, restaurants, and a Sunday farmers market. More suburban-feeling than the rest of Oakland, with easy Bay access.",
    summerHigh: 76, summerLow: 58, winterHigh: 58, winterLow: 45,
  },
]

// Build a lookup by ntaCode for fast access
const SF_BY_CODE = new Map(SF_NEIGHBORHOODS.map((n) => [n.ntaCode, n]))

export function getSFNeighborhoodBases(): Array<Omit<Neighborhood, 'commuteMinutes'>> {
  return SF_NEIGHBORHOODS
}

export function getSFNeighborhoodsForWork(workLat: number, workLng: number): Neighborhood[] {
  return SF_NEIGHBORHOODS.map((n) => ({
    ...n,
    commuteMinutes: mockCommute(workLat, workLng, n.centroid[1], n.centroid[0], n.name),
  }))
}

export async function computeAndCacheSFCommutes(
  workAddress: string,
  workLat: number,
  workLon: number,
  departureTime = '8:00am',
  arriveBy = false,
): Promise<CommuteResult[]> {
  const departureHour = departureTime.replace(':', '').replace('am', '').replace('pm', '').padStart(2, '0')
  const normalizedAddress = normalizeWorkAddress(workAddress, departureHour, arriveBy)
  const ntaCodes = SF_NEIGHBORHOODS.map((n) => n.ntaCode)

  const cachedRows = await CommuteCache.find({
    workAddress: normalizedAddress,
    ntaCode: { $in: ntaCodes },
  }).lean()

  const cachedByCode = new Map(
    cachedRows.map((row) => [row.ntaCode, { minutes: row.minutes, legs: row.legs }])
  )
  const toCompute = SF_NEIGHBORHOODS.filter((n) => !cachedByCode.has(n.ntaCode))

  const EMPTY_LEGS: import('./types').LegSummary = {
    walkMinutes: 0, subwayMinutes: 0, railMinutes: 0, busMinutes: 0, ferryMinutes: 0,
  }

  for (let i = 0; i < toCompute.length; i += OTP_BATCH_SIZE) {
    const batch = toCompute.slice(i, i + OTP_BATCH_SIZE)
    const batchResults = await Promise.all(
      batch.map(async (n) => {
        const targetLat = n.centroid[1]
        const targetLon = n.centroid[0]
        const miles = distMiles(workLat, workLon, targetLat, targetLon)

        if (miles <= SHORT_DISTANCE_WALK_ONLY_MILES) {
          const minutes = estimateWalkMinutes(miles)
          return { ntaCode: n.ntaCode, minutes, legs: { ...EMPTY_LEGS, walkMinutes: minutes } }
        }

        const route = await getOtpRoute(workLat, workLon, targetLat, targetLon, departureTime, arriveBy)
        // If OTP can't find a transit route, fall back to a driving estimate
        // so the neighborhood still gets a legs object (rather than being dropped).
        if (route == null) {
          const driveMin = estimateDriveMinutes(miles)
          return { ntaCode: n.ntaCode, minutes: driveMin, legs: { ...EMPTY_LEGS, carMinutes: driveMin } }
        }
        const legs = parseLegSummary(route.rawLegs)
        // If the walk access leg is > 20 min, transit is impractical — use a
        // driving estimate instead so the commute number reflects reality.
        if (legs.walkMinutes > LONG_WALK_THRESHOLD_MINUTES) {
          const driveMin = estimateDriveMinutes(miles)
          return { ntaCode: n.ntaCode, minutes: driveMin, legs: { ...EMPTY_LEGS, carMinutes: driveMin } }
        }
        return { ntaCode: n.ntaCode, minutes: route.minutes, legs }
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
    }
  }

  console.log(
    `SF commute cache for "${normalizedAddress}": ${cachedRows.length} hits, ${toCompute.length - cachedRows.length} new`
  )

  return SF_NEIGHBORHOODS
    .map((n) => {
      const hit = cachedByCode.get(n.ntaCode)
      return hit == null ? null : { ntaCode: n.ntaCode, minutes: hit.minutes, legs: hit.legs as import('./types').LegSummary }
    })
    .filter((row): row is CommuteResult => row !== null)
}

export function mergeSFNeighborhoodsWithCommutes(
  commuteByNtaCode: Map<string, CommuteResult>,
  workLat: number,
  workLng: number,
): Neighborhood[] {
  return SF_NEIGHBORHOODS.map((n) => {
    const result = commuteByNtaCode.get(n.ntaCode)
    return {
      ...n,
      commuteMinutes:
        result?.minutes ?? mockCommute(workLat, workLng, n.centroid[1], n.centroid[0], n.name),
      legs: result?.legs,
    }
  })
}

export { SF_WORK_LAT, SF_WORK_LNG }
