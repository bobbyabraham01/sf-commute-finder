# NYC Commute Finder

Find NYC neighborhoods by public-transit commute time and median rent.

## Project layout

```
nyc-commute/
├── web/       Next.js + TypeScript app (UI + API routes)
├── otp/       OpenTripPlanner 2.x graph + jar
├── server/    legacy Express backend (kept for reference during migration)
├── client/    legacy Vite frontend (kept for reference during migration)
└── package.json
```

## First-time setup

From inside `nyc-commute/`:

```bash
npm run install:all
```

Then create `web/.env.local` from `web/.env.local.example` and add your real values.

## Running locally

Open two terminals in the repo root:

Terminal 1 (Next app):

```bash
npm run dev
```

Terminal 2 (OTP):

```bash
npm run dev:otp
```

Before running `dev:otp`, make sure `otp/nj-transit.zip` exists (NJ Transit GTFS).

Open [http://localhost:5173](http://localhost:5173).

## Environment variables (`web/.env.local`)

```env
MONGO_URI=mongodb+srv://<username>:<password>@<cluster-url>/nyc_commute?retryWrites=true&w=majority&appName=nyc-commute
OTP_PLAN_URL=http://localhost:8080/otp/routers/default/plan
```

## API routes (Next.js)

- `GET /api/health`
- `GET /api/geocode?q=...`
- `POST /api/commutes`
- `GET /api/neighborhoods?workLat=...&workLng=...&workAddress=...`

## Current destination coverage

- Full NYC residential NTAs (official polygons)
- Starter expansion zones (point-based) for:
  - Jersey City
  - Hoboken
  - Newark
  - Yonkers
  - New Rochelle
  - White Plains

## Phase plan

1. ✅ Scaffold frontend/backend app
2. ✅ Geocoding + full residential NYC NTA dataset
3. ✅ OpenTripPlanner setup with MTA/LIRR/Metro-North
4. ⏳ Real commute API + MongoDB cache (in progress)
5. ⬜ Rent data sources (HUD + curated CSV toggle)
6. ⬜ Commute-vs-rent scatter chart
7. ⬜ Deploy
