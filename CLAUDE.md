# NYC Commute Finder — Project context for Claude

You are working with **Bobby**, a basic coder who knows JavaScript, HTML/CSS, React, and some GitHub. He's not a professional engineer. Walk him through every step. Explain what each file does as you create it. When something fails, give a clear next action — never just dump errors.

## What we're building

A web app that takes a work address in the tri-state area and returns every NYC (and eventually NJ + Westchester) neighborhood with:
- Door-to-door public-transit commute time, and
- Median rent.

Sortable list, interactive map, scatter chart of commute vs. rent. Designed to be published for general use eventually.

## Stack (Next.js + Mongo + OTP, TypeScript)

- **web/** — Next.js 15 + TypeScript app. Contains both UI and API routes (`/api/*`) in one project. Runs on `:5173`.
- **MongoDB Atlas** — stores cached commute minutes for `(workAddress, ntaCode)` tuples.
- **otp/** — OpenTripPlanner 2.x, Java app on `:8080` that computes transit routes from GTFS + OSM.
- **server/** and **client/** — legacy Express/Vite code kept temporarily for reference during migration.
- **Hosting plan** — `web/` on Vercel, OTP on Render or Fly.io with prebuilt graph, MongoDB on Atlas.

## File map

```
nyc-commute/
├── README.md
├── CLAUDE.md
├── package.json
├── web/
│   ├── package.json
│   ├── next.config.ts
│   ├── tsconfig.json
│   ├── .env.local.example
│   └── src/
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── page.tsx
│       │   ├── globals.css
│       │   └── api/
│       │       ├── health/route.ts
│       │       ├── geocode/route.ts
│       │       ├── commutes/route.ts
│       │       └── neighborhoods/route.ts
│       ├── components/
│       │   ├── AppClient.tsx
│       │   ├── MapClient.tsx
│       │   └── NeighborhoodList.tsx
│       └── lib/
│           ├── types.ts
│           ├── db.ts
│           ├── geocode.ts
│           ├── commuteCache.ts
│           └── neighborhoods.ts
├── otp/
├── server/                        # legacy reference during migration
└── client/                        # legacy reference during migration
```

## Phase plan & status

1. ✅ **Phase 1 — Scaffold app.** Initial list + map completed.
2. ✅ **Phase 2 — Geocoding + 197 residential NTAs.** Nominatim + full NTA dataset completed.
3. ✅ **Phase 3 — OpenTripPlanner with tri-state transit feeds.** OTP graph built and tested.
4. ⏳ **Phase 4 — Real commute API + Mongo cache (CURRENT).** Migrated to Next API routes: `POST /api/commutes` + cache merge in `GET /api/neighborhoods`. Added short-distance walking-first logic and starter NJ/Westchester destination zones.
5. ⬜ **Phase 5 — Rent data.** HUD Fair Market Rents + curated market CSV with source toggle.
6. ⬜ **Phase 6 — Commute-vs-rent scatter chart.** Recharts with click interactions.
7. ⬜ **Phase 7 — Deploy.** `web` to Vercel, OTP to Render/Fly, Mongo on Atlas.

## Key decisions made

- **Neighborhood definition** — official NYC NTAs (~197 residential), not popular names or zip codes.
- **Routing** — OpenTripPlanner (open-source GTFS routing), not Google Maps API.
- **Rent data** — HUD + curated CSV, with a UI toggle.
- **TypeScript everywhere** — retained after migration to Next.js.
- **No `localStorage`** in the app.
- **Migration decision** — consolidate UI + API into a single Next.js app to improve build speed and reduce stack complexity.

## How to run locally

```bash
cd ~/Code/nyc-commute
npm run install:all         # one time
cp web/.env.local.example web/.env.local
# Fill in real MONGO_URI in web/.env.local

npm run dev                 # tab 1: Next app on http://localhost:5173
npm run dev:otp             # tab 2: OTP on :8080
```

## Environment variables (`web/.env.local`)

```env
MONGO_URI=mongodb+srv://<username>:<password>@<cluster-url>/nyc_commute?retryWrites=true&w=majority&appName=nyc-commute
OTP_PLAN_URL=http://localhost:8080/otp/routers/default/plan
```

## OTP feed notes

- `otp/build-config.json` now includes:
  - MTA Subway
  - LIRR
  - Metro-North
  - NJ Transit (`otp/nj-transit.zip`)
- If `nj-transit.zip` is missing, OTP graph build/load may fail. Keep feed files present before starting OTP.

## Phase 4 implementation notes (current)

- `POST /api/commutes` takes `{ workAddress, workLat, workLon }`.
- The route checks Mongo cache first, computes missing OTP routes in batches, then upserts cache rows.
- `GET /api/neighborhoods` can merge cached/real commute minutes into neighborhood objects and falls back to mock commute values when OTP misses a route.
- For very short distances, commute uses walking-time estimate instead of transit to avoid unrealistic nearby results.
- Destination list now includes NYC NTAs plus starter point-based zones: Jersey City, Hoboken, Newark, Yonkers, New Rochelle, White Plains.
- Frontend submit flow:
  1. geocode address
  2. warm commute cache via `/api/commutes`
  3. fetch `/api/neighborhoods` with `workAddress`, `workLat`, `workLng`

## Conventions

- Always read this file at session start.
- When a phase completes, update the status checkboxes above.
- Small commits, descriptive messages.
- Bobby runs all install commands on his own machine.
- When Bobby reports an error, ask him to paste exact terminal output.
