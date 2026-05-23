'use client'

import { Fragment, useMemo, useState } from 'react'
import type { Neighborhood, LegSummary } from '@/lib/types'

type SortKey = 'name' | 'commuteMinutes' | 'driveMinutes' | 'medianRent'
type SortDir = 'asc' | 'desc'

interface Props {
  neighborhoods: Neighborhood[]
  selectedNta: string | null
  onSelect: (ntaCode: string) => void
  city?: 'nyc' | 'sf'
}

function SafetyStars({ rating }: { rating: number }) {
  const colors: Record<number, string> = {
    1: '#dc2626', 2: '#f97316', 3: '#eab308', 4: '#22c55e', 5: '#16a34a',
  }
  const labels: Record<number, string> = {
    1: 'High crime', 2: 'Use caution', 3: 'Mixed safety', 4: 'Generally safe', 5: 'Very safe',
  }
  const color = colors[rating] ?? '#9ca3af'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, color }} title={labels[rating]}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} style={{ opacity: i < rating ? 1 : 0.2 }}>★</span>
      ))}
      <span style={{ color: '#888', marginLeft: 4 }}>{labels[rating]}</span>
    </span>
  )
}

function LegBreakdown({ legs, city }: { legs: LegSummary; city: 'nyc' | 'sf' }) {
  const isSF = city === 'sf'
  if (legs.carMinutes) {
    return (
      <tr>
        <td colSpan={4} style={{ padding: '6px 12px 10px', background: '#f0f6ff', borderBottom: '1px solid #dde6f5' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: '#444' }}
            title="Transit unavailable or walk to nearest stop exceeds walk threshold — driving estimate shown.">
            <span style={{ fontSize: 16 }}>🚗</span>
            <span style={{ fontWeight: 600 }}>{legs.carMinutes} min</span>
            <span style={{ color: '#888' }}>Drive est. · no practical transit found</span>
          </span>
        </td>
      </tr>
    )
  }
  const items = [
    { icon: '🚶', label: 'Walk',                          minutes: legs.walkMinutes },
    { icon: '🚇', label: isSF ? 'Muni/Tram' : 'Subway',  minutes: legs.subwayMinutes },
    { icon: '🚆', label: isSF ? 'BART/Train' : 'Train',  minutes: legs.railMinutes },
    { icon: '🚌', label: 'Bus',                           minutes: legs.busMinutes },
    { icon: '⛴️', label: 'Ferry',                        minutes: legs.ferryMinutes },
  ].filter((item) => item.minutes > 0)

  if (items.length === 0) return null

  return (
    <tr>
      <td colSpan={4} style={{ padding: '6px 12px 10px', background: '#f0f6ff', borderBottom: '1px solid #dde6f5' }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {items.map((item) => (
            <span key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: '#444' }}>
              <span style={{ fontSize: 16 }}>{item.icon}</span>
              <span style={{ fontWeight: 600 }}>{item.minutes} min</span>
              <span style={{ color: '#888' }}>{item.label}</span>
            </span>
          ))}
        </div>
      </td>
    </tr>
  )
}

function getParkAndRideNote(ntaCode: string): string | null {
  if (ntaCode.startsWith('PEN-')) return '🚗→🚆 Caltrain stations nearby — drive to Millbrae, Burlingame, or 22nd St'
  if (ntaCode.startsWith('SB-'))  return '🚗→🚆 Caltrain/VTA accessible from South Bay stations'
  if (ntaCode.startsWith('EB-') || ntaCode.startsWith('OAK-')) return '🚗→🚇 BART stations have parking — consider driving to nearest BART stop'
  if (ntaCode.startsWith('MARIN-')) return '🚗→⛴️ Ferry terminal parking at Larkspur or Sausalito'
  return null
}

function TempBadge({ label, high, low, icon }: { label: string; high: number; low: number; icon: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#444', background: '#eef2ff', borderRadius: 6, padding: '2px 8px' }}>
      <span>{icon}</span>
      <span style={{ fontWeight: 600 }}>{label}</span>
      <span style={{ color: '#666' }}>{high}° / {low}°F</span>
    </span>
  )
}

function NeighborhoodDetail({ n }: { n: Neighborhood }) {
  const hasTemps = n.summerHigh != null && n.summerLow != null && n.winterHigh != null && n.winterLow != null
  const parkAndRide = getParkAndRideNote(n.ntaCode)
  if (n.safetyRating == null && !n.description && !hasTemps && !parkAndRide) return null
  return (
    <tr>
      <td colSpan={4} style={{ padding: '8px 12px 12px', background: '#f8fafc', borderBottom: '1px solid #dde6f5' }}>
        {n.safetyRating != null && (
          <div style={{ marginBottom: 6 }}>
            <SafetyStars rating={n.safetyRating} />
          </div>
        )}
        {hasTemps && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: n.description || parkAndRide ? 6 : 0 }}>
            <TempBadge label="Summer" high={n.summerHigh!} low={n.summerLow!} icon="☀️" />
            <TempBadge label="Winter" high={n.winterHigh!} low={n.winterLow!} icon="🌧️" />
          </div>
        )}
        {parkAndRide && (
          <p style={{ margin: '0 0 6px', fontSize: 12, color: '#1a56db', fontStyle: 'italic' }}>
            {parkAndRide}
          </p>
        )}
        {n.description && (
          <p style={{ margin: 0, fontSize: 12, color: '#555', lineHeight: 1.55 }}>
            {n.description}
          </p>
        )}
      </td>
    </tr>
  )
}

function TransitCell({ n }: { n: Neighborhood }) {
  const carMins = n.legs?.carMinutes ?? 0
  const walkMins = n.legs?.walkMinutes ?? 0
  // Only label as "Drive only" for genuinely car-dependent areas (outside SF proper)
  // In-city SF neighborhoods always have transit — carMinutes here means OTP failed, not that transit doesn't exist
  const isUrbanSF = n.ntaCode.startsWith('SF-')
  const isCarOnly = carMins > 0 && !isUrbanSF
  const heavyWalk = !isCarOnly && walkMins > 30

  if (isCarOnly) {
    return (
      <td style={{ color: '#888', fontSize: 13 }}>
        <span title="No practical transit found — driving recommended">🚗 Drive only</span>
      </td>
    )
  }
  return (
    <td>
      <div>{n.commuteMinutes} min</div>
      {heavyWalk && (
        <div style={{ fontSize: 11, color: '#f97316' }} title={`Includes ${walkMins} min walking`}>
          🚶 {walkMins} min walk
        </div>
      )}
    </td>
  )
}

function DriveCell({ n }: { n: Neighborhood }) {
  if (n.driveMinutes == null) return <td style={{ color: '#bbb' }}>—</td>
  return <td>{n.driveMinutes} min</td>
}

export default function NeighborhoodList({ neighborhoods, selectedNta, onSelect, city = 'nyc' }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('commuteMinutes')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const sorted = useMemo(() => {
    const list = [...neighborhoods]
    list.sort((a, b) => {
      const av = sortKey === 'driveMinutes'
        ? (a.driveMinutes ?? 9999)
        : sortKey === 'name'
        ? a.name
        : a[sortKey]
      const bv = sortKey === 'driveMinutes'
        ? (b.driveMinutes ?? 9999)
        : sortKey === 'name'
        ? b.name
        : b[sortKey]
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
    })
    return list
  }, [neighborhoods, sortKey, sortDir])

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  function arrow(key: SortKey) {
    if (key !== sortKey) return ''
    return sortDir === 'asc' ? ' ↑' : ' ↓'
  }

  return (
    <table className="sidebar-table">
      <thead>
        <tr>
          <th onClick={() => handleSort('name')} style={{ cursor: 'pointer' }}>Neighborhood{arrow('name')}</th>
          <th onClick={() => handleSort('commuteMinutes')} style={{ cursor: 'pointer' }}>Transit{arrow('commuteMinutes')}</th>
          <th onClick={() => handleSort('driveMinutes')} style={{ cursor: 'pointer' }}>Drive{arrow('driveMinutes')}</th>
          <th onClick={() => handleSort('medianRent')} style={{ cursor: 'pointer' }}>Rent{arrow('medianRent')}</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((n) => (
          <Fragment key={n.ntaCode}>
            <tr
              onClick={() => onSelect(n.ntaCode)}
              style={{ background: selectedNta === n.ntaCode ? '#ddeeff' : undefined, cursor: 'pointer' }}
            >
              <td>
                <div>
                  {n.name}
                  <span className="borough-tag">{n.borough}</span>
                </div>
                {n.summerHigh != null && n.winterHigh != null && (
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                    ☀️ {n.summerHigh}°F&nbsp;&nbsp;🌧️ {n.winterHigh}°F
                  </div>
                )}
              </td>
              <TransitCell n={n} />
              <DriveCell n={n} />
              <td>${n.medianRent.toLocaleString()}</td>
            </tr>
            {selectedNta === n.ntaCode && n.legs && (
              <LegBreakdown legs={n.legs} city={city} />
            )}
            {selectedNta === n.ntaCode && (
              <NeighborhoodDetail n={n} />
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}
