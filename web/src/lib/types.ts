export interface LegSummary {
  walkMinutes: number
  subwayMinutes: number
  railMinutes: number
  busMinutes: number
  ferryMinutes: number
  carMinutes?: number   // driving estimate — used when walk access leg would be > 20 min
}

export interface Neighborhood {
  ntaCode: string
  name: string
  borough: string
  centroid: [number, number]
  commuteMinutes: number
  medianRent: number
  legs?: LegSummary
  safetyRating?: number   // 1–5 (1=high crime, 5=very safe) — SF only for now
  description?: string    // short blurb for newcomers — SF only for now
  summerHigh?: number     // avg summer high °F
  summerLow?: number      // avg summer low °F
  winterHigh?: number     // avg winter high °F
  winterLow?: number      // avg winter low °F
}

export interface WorkLocation {
  lat: number
  lng: number
  displayName: string
}

export interface CommuteResult {
  ntaCode: string
  minutes: number
  legs: LegSummary
}
