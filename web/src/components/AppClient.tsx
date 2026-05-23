'use client'

import { FormEvent, useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import axios from 'axios'
import type { Neighborhood, WorkLocation } from '@/lib/types'
import NeighborhoodList from './NeighborhoodList'
import FilterPanel from './FilterPanel'

const MapClient = dynamic(() => import('./MapClient'), { ssr: false })

type City = 'nyc' | 'sf'

const QUICK_OFFICES: Array<{ label: string; city: City; address: string; lat?: number; lng?: number }> = [
  { label: 'Intuit (SF)', city: 'sf', address: '505 Howard St, San Francisco, CA' },
  { label: 'ZS Associates (South SF)', city: 'sf', address: '611 Gateway Blvd, South San Francisco, CA', lat: 37.6557, lng: -122.4019 },
  { label: 'Intuit (Mountain View)', city: 'sf', address: '2700 Coast Ave, Mountain View, CA' },
]

const CITY_CONFIG: Record<City, {
  label: string
  flag: string
  defaultAddress: string
  defaultLocation: WorkLocation
  neighborhoodsEndpoint: string
  commutesEndpoint: string
  maxRentLimit: number
  defaultRegions: string[]
}> = {
  nyc: {
    label: 'New York',
    flag: '🗽',
    defaultAddress: '350 5th Ave, New York, NY',
    defaultLocation: { lat: 40.7484, lng: -73.9857, displayName: 'Empire State Building' },
    neighborhoodsEndpoint: '/api/neighborhoods',
    commutesEndpoint: '/api/commutes',
    maxRentLimit: 6000,
    defaultRegions: ['nyc', 'nj', 'westchester'],
  },
  sf: {
    label: 'San Francisco',
    flag: '🌉',
    defaultAddress: '505 Howard St, San Francisco, CA',
    defaultLocation: { lat: 37.7874, lng: -122.3964, displayName: '505 Howard St, SoMa' },
    neighborhoodsEndpoint: '/api/neighborhoods-sf',
    commutesEndpoint: '/api/commutes-sf',
    maxRentLimit: 7000,
    defaultRegions: ['sf', 'oakland', 'east-bay', 'peninsula', 'south-bay', 'marin'],
  },
}

const DEPARTURE_TIMES = [
  '6:00am', '6:30am', '7:00am', '7:30am', '8:00am', '8:30am',
  '9:00am', '9:30am', '10:00am', '5:00pm', '6:00pm', '7:00pm',
]

function getRegion(ntaCode: string, city: City): string {
  if (city === 'nyc') {
    if (ntaCode.startsWith('NJ-')) return 'nj'
    if (ntaCode.startsWith('WC-') || ntaCode.startsWith('CT-')) return 'westchester'
    return 'nyc'
  }
  if (ntaCode.startsWith('OAK-')) return 'oakland'
  if (ntaCode.startsWith('EB-')) return 'east-bay'
  if (ntaCode.startsWith('PEN-')) return 'peninsula'
  if (ntaCode.startsWith('SB-')) return 'south-bay'
  if (ntaCode.startsWith('MARIN-')) return 'marin'
  return 'sf'
}

export default function AppClient() {
  const [city, setCity] = useState<City>('nyc')
  const config = CITY_CONFIG[city]

  // Per-city address inputs so switching preserves what the user typed
  const [nycAddress, setNycAddress] = useState(CITY_CONFIG.nyc.defaultAddress)
  const [sfAddress, setSfAddress] = useState(CITY_CONFIG.sf.defaultAddress)
  const workAddress = city === 'nyc' ? nycAddress : sfAddress
  const setWorkAddress = city === 'nyc' ? setNycAddress : setSfAddress

  const [activeWorkAddress, setActiveWorkAddress] = useState(config.defaultAddress)
  const [workLocation, setWorkLocation] = useState<WorkLocation>(config.defaultLocation)
  const [neighborhoods, setNeighborhoods] = useState<Neighborhood[]>([])
  const [selectedNta, setSelectedNta] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [geocoding, setGeocoding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [departureTime, setDepartureTime] = useState('8:00am')
  const [activeDepartureTime, setActiveDepartureTime] = useState('8:00am')
  const [arriveBy, setArriveBy] = useState(false)
  const [activeArriveBy, setActiveArriveBy] = useState(false)

  const [maxCommute, setMaxCommute] = useState(120)
  const [maxRent, setMaxRent] = useState(config.maxRentLimit)
  const [activeRegions, setActiveRegions] = useState<Set<string>>(
    new Set(config.defaultRegions),
  )
  const [minSummerHigh, setMinSummerHigh] = useState(60)

  // When city switches, reset work location, filters, AND neighborhood list to that city's defaults
  useEffect(() => {
    const cfg = CITY_CONFIG[city]
    setActiveWorkAddress(cfg.defaultAddress)
    setWorkLocation(cfg.defaultLocation)
    setMaxRent(cfg.maxRentLimit)
    setActiveRegions(new Set(cfg.defaultRegions))
    setMinSummerHigh(60)
    setSelectedNta(null)
    setError(null)
    setNeighborhoods([])
    setDepartureTime('8:00am')
    setActiveDepartureTime('8:00am')
    setArriveBy(false)
    setActiveArriveBy(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city])

  const toggleRegion = (r: string) => {
    setActiveRegions((prev) => {
      const next = new Set(prev)
      if (next.has(r)) next.delete(r)
      else next.add(r)
      return next
    })
  }

  const filteredNeighborhoods = useMemo(() => {
    return neighborhoods.filter((n) =>
      // commuteMinutes may be undefined if not yet computed — include those rather than hiding them
      (n.commuteMinutes == null || n.commuteMinutes <= maxCommute) &&
      n.medianRent <= maxRent &&
      activeRegions.has(getRegion(n.ntaCode, city)) &&
      (n.summerHigh == null || n.summerHigh >= minSummerHigh)
    )
  }, [neighborhoods, maxCommute, maxRent, activeRegions, city, minSummerHigh])

  // Clear selection if it gets filtered out
  useEffect(() => {
    if (selectedNta && !filteredNeighborhoods.some((n) => n.ntaCode === selectedNta)) {
      setSelectedNta(null)
    }
  }, [filteredNeighborhoods, selectedNta])

  // Fetch neighborhoods whenever city, location, or departure time changes.
  // An AbortController cancels any in-flight request when dependencies change,
  // preventing a slow NYC fetch from overwriting SF results (the "0 of 232" race).
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    const cfg = CITY_CONFIG[city]

    axios
      .get<Neighborhood[]>(cfg.neighborhoodsEndpoint, {
        params: {
          workLat: workLocation.lat,
          workLng: workLocation.lng,
          workAddress: activeWorkAddress,
          departureTime: activeDepartureTime,
          arriveBy: activeArriveBy,
        },
        signal: controller.signal,
      })
      .then((res) => {
        setNeighborhoods(res.data)
        setLoading(false)
      })
      .catch((err) => {
        if (axios.isCancel(err)) return   // city switched mid-flight — ignore stale result
        setError(err.message)
        setLoading(false)
      })

    return () => controller.abort()
  }, [city, workLocation.lat, workLocation.lng, activeWorkAddress, activeDepartureTime, activeArriveBy])

  async function triggerGeocode(address: string, targetCity: City) {
    if (!address.trim()) return
    setError(null)
    setGeocoding(true)
    const cfg = CITY_CONFIG[targetCity]

    try {
      const res = await axios.get<WorkLocation>('/api/geocode', {
        params: { q: address },
      })
      const nextLocation = res.data

      // Warm commute cache before showing results
      await axios.post(cfg.commutesEndpoint, {
        workAddress: address,
        workLat: nextLocation.lat,
        workLon: nextLocation.lng,
        departureTime,
        arriveBy,
      })

      setWorkLocation(nextLocation)
      setActiveWorkAddress(address)
      setActiveDepartureTime(departureTime)
      setActiveArriveBy(arriveBy)
    } catch (err) {
      const msg =
        axios.isAxiosError(err) && err.response?.status === 404
          ? `Couldn't find "${address}". Try a more specific address.`
          : targetCity === 'sf'
          ? 'Geocoding failed. Make sure SF OTP (port 8081) and Mongo are running.'
          : 'Geocoding failed. Check that OTP and Mongo are running.'
      setError(msg)
    } finally {
      setGeocoding(false)
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    await triggerGeocode(workAddress, city)
  }

  async function selectOffice(address: string, targetCity: City, lat?: number, lng?: number) {
    // Fill the address input for that city
    if (targetCity === 'nyc') setNycAddress(address)
    else setSfAddress(address)
    // Switch city tab if needed (triggers a reset, but triggerGeocode below overwrites it)
    if (targetCity !== city) setCity(targetCity)

    if (lat !== undefined && lng !== undefined) {
      // Skip geocoding — use hardcoded coordinates directly
      setError(null)
      setGeocoding(true)
      const cfg = CITY_CONFIG[targetCity]
      try {
        await axios.post(cfg.commutesEndpoint, {
          workAddress: address, workLat: lat, workLon: lng, departureTime, arriveBy,
        })
        setWorkLocation({ lat, lng, displayName: address })
        setActiveWorkAddress(address)
        setActiveDepartureTime(departureTime)
        setActiveArriveBy(arriveBy)
      } catch {
        // commutes warming failed — still show cached results
        setWorkLocation({ lat, lng, displayName: address })
        setActiveWorkAddress(address)
        setActiveDepartureTime(departureTime)
        setActiveArriveBy(arriveBy)
      } finally {
        setGeocoding(false)
      }
    } else {
      await triggerGeocode(address, targetCity)
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-top">
          <h1>{city === 'sf' ? 'SF' : 'NYC'} Commute Finder</h1>
          <div className="city-switcher">
            {(['nyc', 'sf'] as City[]).map((c) => (
              <button
                key={c}
                className={`city-tab ${city === c ? 'city-tab--active' : ''}`}
                onClick={() => setCity(c)}
              >
                {CITY_CONFIG[c].flag} {CITY_CONFIG[c].label}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="address-form">
          <input
            type="text"
            value={workAddress}
            onChange={(e) => setWorkAddress(e.target.value)}
            placeholder="Your work address"
            aria-label="Work address"
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 0, background: '#f1f3f4', borderRadius: 6, padding: 2, marginLeft: 8, flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setArriveBy(false)}
              style={{
                padding: '4px 10px', border: 'none', borderRadius: 5, fontSize: 12, fontWeight: 500,
                background: !arriveBy ? '#fff' : 'transparent',
                color: !arriveBy ? '#1a73e8' : '#666',
                boxShadow: !arriveBy ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Leave at
            </button>
            <button
              type="button"
              onClick={() => setArriveBy(true)}
              style={{
                padding: '4px 10px', border: 'none', borderRadius: 5, fontSize: 12, fontWeight: 500,
                background: arriveBy ? '#fff' : 'transparent',
                color: arriveBy ? '#1a73e8' : '#666',
                boxShadow: arriveBy ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Arrive by
            </button>
          </div>
          <select
            value={departureTime}
            onChange={(e) => setDepartureTime(e.target.value)}
            aria-label="Departure time"
            style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc' }}
          >
            {DEPARTURE_TIMES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <button type="submit" disabled={geocoding}>
            {geocoding ? 'Finding…' : 'Update'}
          </button>
        </form>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          <span style={{ fontSize: 11, color: '#888', fontWeight: 500, whiteSpace: 'nowrap' }}>Quick select:</span>
          {QUICK_OFFICES.map((o) => {
            const isActive = activeWorkAddress === o.address && city === o.city
            return (
              <button
                key={o.label}
                type="button"
                onClick={() => selectOffice(o.address, o.city, o.lat, o.lng)}
                disabled={geocoding}
                style={{
                  fontSize: 11,
                  padding: '3px 10px',
                  borderRadius: 99,
                  border: isActive ? '1.5px solid #1a73e8' : '1px solid #ccc',
                  background: isActive ? '#e8f0fe' : '#f8f9fa',
                  color: isActive ? '#1a73e8' : '#444',
                  fontWeight: isActive ? 600 : 400,
                  cursor: geocoding ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'all 0.15s',
                }}
              >
                {o.label}
              </button>
            )
          })}
        </div>
        <span className="work-location-label" title={workLocation.displayName}>
          📍 {workLocation.displayName.split(',').slice(0, 2).join(',')}
        </span>
      </header>

      <main className="app-main">
        <aside className="sidebar">
          {error && <p style={{ padding: 16, color: 'crimson' }}>{error}</p>}
          {geocoding && !error && (
            <p style={{ padding: 16 }}>Computing commute times… (first run can take ~30s)</p>
          )}

          <FilterPanel
            maxCommute={maxCommute}
            setMaxCommute={setMaxCommute}
            maxRent={maxRent}
            setMaxRent={setMaxRent}
            maxRentLimit={config.maxRentLimit}
            activeRegions={activeRegions}
            toggleRegion={toggleRegion}
            total={neighborhoods.length}
            filtered={filteredNeighborhoods.length}
            city={city}
            minSummerHigh={minSummerHigh}
            setMinSummerHigh={setMinSummerHigh}
          />

          {loading && <p style={{ padding: 16 }}>Loading neighborhoods…</p>}
          {!loading && (
            <NeighborhoodList
              neighborhoods={filteredNeighborhoods}
              selectedNta={selectedNta}
              onSelect={setSelectedNta}
              city={city}
            />
          )}
        </aside>

        <div className="map-container">
          <MapClient
            neighborhoods={filteredNeighborhoods}
            selectedNta={selectedNta}
            onSelect={setSelectedNta}
            workLocation={workLocation}
            city={city}
          />
        </div>
      </main>
    </div>
  )
}
