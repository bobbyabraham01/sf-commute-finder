'use client'

interface Props {
  maxCommute: number
  setMaxCommute: (v: number) => void
  maxRent: number
  setMaxRent: (v: number) => void
  maxRentLimit?: number
  activeRegions: Set<string>
  toggleRegion: (r: string) => void
  total: number
  filtered: number
  city?: 'nyc' | 'sf'
  minSummerHigh?: number
  setMinSummerHigh?: (v: number) => void
}

const NYC_REGIONS = [
  { id: 'nyc', label: 'NYC' },
  { id: 'nj', label: 'NJ' },
  { id: 'westchester', label: 'Westchester/CT' },
]

const SF_REGIONS = [
  { id: 'sf', label: 'San Francisco' },
  { id: 'oakland', label: 'Oakland' },
  { id: 'east-bay', label: 'East Bay' },
  { id: 'peninsula', label: 'Peninsula' },
  { id: 'south-bay', label: 'South Bay' },
  { id: 'marin', label: 'Marin' },
]

export default function FilterPanel({
  maxCommute,
  setMaxCommute,
  maxRent,
  setMaxRent,
  maxRentLimit = 6000,
  activeRegions,
  toggleRegion,
  total,
  filtered,
  city = 'nyc',
  minSummerHigh = 60,
  setMinSummerHigh,
}: Props) {
  const regions = city === 'sf' ? SF_REGIONS : NYC_REGIONS

  return (
    <div className="filter-panel">
      <div className="filter-row">
        <label className="filter-label">Commute</label>
        <input
          type="range"
          min={10}
          max={120}
          step={5}
          value={maxCommute}
          onChange={(e) => setMaxCommute(Number(e.target.value))}
          className="filter-slider"
        />
        <span className="filter-value">≤ {maxCommute} min</span>
      </div>

      <div className="filter-row">
        <label className="filter-label">Rent</label>
        <input
          type="range"
          min={1000}
          max={maxRentLimit}
          step={100}
          value={maxRent}
          onChange={(e) => setMaxRent(Number(e.target.value))}
          className="filter-slider"
        />
        <span className="filter-value">≤ ${maxRent.toLocaleString()}</span>
      </div>

      {city === 'sf' && setMinSummerHigh && (
        <div className="filter-row">
          <label className="filter-label">☀️ Summer</label>
          <input
            type="range"
            min={60}
            max={88}
            step={1}
            value={minSummerHigh}
            onChange={(e) => setMinSummerHigh(Number(e.target.value))}
            className="filter-slider"
          />
          <span className="filter-value">
            {minSummerHigh <= 60 ? 'Any' : `≥ ${minSummerHigh}°F`}
          </span>
        </div>
      )}

      <div className="filter-row filter-row--pills">
        <label className="filter-label">Region</label>
        <div className="filter-pills">
          {regions.map((r) => (
            <button
              key={r.id}
              className={`filter-pill ${activeRegions.has(r.id) ? 'filter-pill--on' : ''}`}
              onClick={() => toggleRegion(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="filter-count">
        {filtered === total
          ? `${total} neighborhoods`
          : `${filtered} of ${total} neighborhoods`}
      </div>
    </div>
  )
}
