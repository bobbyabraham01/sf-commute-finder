'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  CircleMarker,
  GeoJSON as GeoJsonLayer,
  MapContainer,
  Marker,
  TileLayer,
  Tooltip,
  useMap,
} from 'react-leaflet'
import L from 'leaflet'
import type { Neighborhood, WorkLocation } from '@/lib/types'

interface Props {
  neighborhoods: Neighborhood[]
  selectedNta: string | null
  onSelect: (ntaCode: string) => void
  workLocation: WorkLocation
  city?: 'nyc' | 'sf'
}

/**
 * Smooth gradient color scale:
 *   0–30 min  → dark green → bright green
 *  30–60 min  → bright green → yellow
 *  60–90 min  → yellow → red
 *    90+ min  → gray (out of range)
 */
function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t)
}

function commuteColor(minutes: number): string {
  if (minutes >= 90) return '#9ca3af' // gray — out of range

  if (minutes <= 30) {
    const t = minutes / 30
    return `rgb(${lerp(22, 34, t)},${lerp(101, 197, t)},${lerp(52, 94, t)})`
  }

  if (minutes <= 60) {
    const t = (minutes - 30) / 30
    return `rgb(${lerp(34, 234, t)},${lerp(197, 179, t)},${lerp(94, 8, t)})`
  }

  const t = (minutes - 60) / 30
  return `rgb(${lerp(234, 220, t)},${lerp(179, 38, t)},${lerp(8, 38, t)})`
}

const workIcon = L.divIcon({
  className: 'work-pin',
  html: `<div style="
    width: 28px; height: 28px; border-radius: 50%;
    background: #1a73e8; border: 3px solid white;
    box-shadow: 0 0 0 2px #1a73e8, 0 2px 6px rgba(0,0,0,0.3);
    display: flex; align-items: center; justify-content: center;
    color: white; font-weight: 700; font-size: 14px;
  ">W</div>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
})

function RecenterOnWork({ workLocation }: { workLocation: WorkLocation }) {
  const map = useMap()
  useEffect(() => {
    map.setView([workLocation.lat, workLocation.lng], map.getZoom())
  }, [workLocation.lat, workLocation.lng, map])
  return null
}

function MapLegend() {
  const map = useMap()
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const LegendControl = (L.Control as any).extend({
      onAdd(): HTMLElement {
        const div = L.DomUtil.create('div')
        div.innerHTML = `
          <div style="
            background: white; padding: 8px 10px; border-radius: 8px;
            box-shadow: 0 1px 6px rgba(0,0,0,0.18); font-size: 11px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          ">
            <div style="font-weight: 700; margin-bottom: 6px; font-size: 12px;">Commute time</div>
            <div style="display:flex;align-items:stretch;gap:0;margin-bottom:4px">
              <div style="width:12px;border-radius:2px 0 0 2px;background:linear-gradient(to bottom,rgb(22,101,52),rgb(34,197,94))"></div>
              <div style="width:12px;background:linear-gradient(to bottom,rgb(34,197,94),rgb(234,179,8))"></div>
              <div style="width:12px;border-radius:0 2px 2px 0;background:linear-gradient(to bottom,rgb(234,179,8),rgb(220,38,38))"></div>
              <div style="display:flex;flex-direction:column;justify-content:space-between;margin-left:6px;line-height:1.5;color:#374151">
                <span>0 min</span>
                <span>30 min</span>
                <span>60 min</span>
                <span>90+ min</span>
              </div>
            </div>
            <div style="display:flex;align-items:center;margin-top:4px;padding-top:4px;border-top:1px solid #f3f4f6">
              <span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:#9ca3af;margin-right:6px;vertical-align:middle;flex-shrink:0"></span>
              <span style="color:#6b7280">Out of range / filtered</span>
            </div>
          </div>
        `
        return div
      },
    })
    const legend = new LegendControl({ position: 'bottomright' })
    legend.addTo(map)
    return () => { legend.remove() }
  }, [map])
  return null
}

export default function MapClient({ neighborhoods, selectedNta, onSelect, workLocation, city = 'nyc' }: Props) {
  const [ntaGeoJson, setNtaGeoJson] = useState<object | null>(null)

  // Fetch the polygon GeoJSON for choropleth — endpoint differs by city.
  // Re-fetch whenever city changes.
  useEffect(() => {
    setNtaGeoJson(null)
    const endpoint = city === 'sf' ? '/api/nta-geojson-sf' : '/api/nta-geojson'
    fetch(endpoint)
      .then((r) => r.json())
      .then(setNtaGeoJson)
      .catch(() => { /* silently skip choropleth if endpoint unavailable */ })
  }, [city])

  // Fast lookup: ntaCode → commuteMinutes
  const commuteByNta = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of neighborhoods) m.set(n.ntaCode, n.commuteMinutes)
    return m
  }, [neighborhoods])

  // Changing sum forces GeoJSON layer to remount with fresh colors
  const choroplethKey = useMemo(
    () => `${city}-${neighborhoods.reduce((s, n) => s + n.commuteMinutes, 0)}`,
    [city, neighborhoods],
  )

  // NYC GeoJSON uses `nta2020`; SF GeoJSON (transformed by nta-geojson-sf route) uses `ntaCode`
  function getNtaCode(properties: Record<string, string> | undefined): string | undefined {
    if (!properties) return undefined
    return properties.ntaCode ?? properties.nta2020
  }

  return (
    <MapContainer center={[workLocation.lat, workLocation.lng]} zoom={12} scrollWheelZoom={true}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <RecenterOnWork workLocation={workLocation} />
      <MapLegend />

      {/* Choropleth: shade neighborhood polygons by commute time */}
      {ntaGeoJson && (
        <GeoJsonLayer
          key={choroplethKey}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data={ntaGeoJson as any}
          style={(feature) => {
            const ntaCode = getNtaCode(feature?.properties)
            const minutes = ntaCode ? commuteByNta.get(ntaCode) : undefined
            if (minutes === undefined) {
              return { fillColor: '#d1d5db', fillOpacity: 0.25, weight: 0.4, color: '#bbb' }
            }
            return {
              fillColor: commuteColor(minutes),
              fillOpacity: 0.38,
              weight: 0.8,
              color: '#555',
            }
          }}
          onEachFeature={(feature, layer) => {
            const ntaCode = getNtaCode(feature.properties)
            const n = ntaCode ? neighborhoods.find((nb) => nb.ntaCode === ntaCode) : undefined
            if (n) {
              layer.bindTooltip(
                `<strong>${n.name}</strong><br/>${n.commuteMinutes} min · $${n.medianRent.toLocaleString()}/mo`,
              )
              layer.on('click', () => onSelect(n.ntaCode))
            }
          }}
        />
      )}

      {/* Work location marker */}
      <Marker position={[workLocation.lat, workLocation.lng]} icon={workIcon}>
        <Tooltip>Work: {workLocation.displayName}</Tooltip>
      </Marker>

      {/* Circle markers — covers suburban towns (NYC) and Oakland (SF) that have no polygon */}
      {neighborhoods.map((n) => {
        const isSelected = n.ntaCode === selectedNta
        return (
          <CircleMarker
            key={n.ntaCode}
            center={[n.centroid[1], n.centroid[0]]}
            radius={isSelected ? 10 : 5}
            pathOptions={{
              color: isSelected ? '#1a73e8' : commuteColor(n.commuteMinutes),
              fillColor: commuteColor(n.commuteMinutes),
              fillOpacity: isSelected ? 1 : 0.7,
              weight: isSelected ? 3 : 1,
            }}
            eventHandlers={{ click: () => onSelect(n.ntaCode) }}
          >
            <Tooltip>
              <strong>{n.name}</strong> ({n.borough})
              <br />
              {n.commuteMinutes} min · ${n.medianRent.toLocaleString()}/mo
            </Tooltip>
          </CircleMarker>
        )
      })}
    </MapContainer>
  )
}
