interface GeocodeResult {
  lat: number
  lng: number
  displayName: string
}

const geocodeCache = new Map<string, GeocodeResult>()

export async function geocode(address: string): Promise<GeocodeResult | null> {
  const key = address.trim().toLowerCase()
  if (!key) return null

  const cached = geocodeCache.get(key)
  if (cached) return cached

  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', address)
  url.searchParams.set('format', 'json')
  url.searchParams.set('limit', '1')

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'nyc-commute-finder/0.1 (local development)',
    },
  })

  if (!response.ok) {
    throw new Error(`Nominatim HTTP ${response.status}`)
  }

  const rows = (await response.json()) as Array<{
    lat: string
    lon: string
    display_name: string
  }>

  if (rows.length === 0) return null

  const row = rows[0]
  const result = {
    lat: Number(row.lat),
    lng: Number(row.lon),
    displayName: row.display_name,
  }
  geocodeCache.set(key, result)
  return result
}
