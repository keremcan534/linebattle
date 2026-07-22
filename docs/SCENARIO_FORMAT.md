# Scenario format (v1)

A scenario is a single JSON file in `public/data/scenarios/`. It declares the map, the sides and the order of battle. **Adding a campaign requires no TypeScript.**

Load a different scenario by changing `SCENARIO_URL` in `src/app/App.tsx`.

## Skeleton

```jsonc
{
  "formatVersion": 1,
  "id": "barbarossa-1941",
  "name": "Operation Barbarossa",
  "description": "…",
  "startDate": "1941-06-22T03:15:00Z",   // ISO 8601, treated as UTC
  "playerFaction": "germany",            // must match a faction id
  "map":       { … },
  "factions":  [ … ],
  "templates": { … },
  "divisions": [ … ]
}
```

`formatVersion` is validated at load. Bump it when a change would silently misread older files.

## `map`

```jsonc
"map": {
  "projection": { "type": "lcc", "lon0": 28, "lat0": 52, "lat1": 44, "lat2": 62 },
  "bounds": { "minLon": 6, "minLat": 38, "maxLon": 51, "maxLat": 66 },
  "terrainCellSizeKm": 4,
  "layers": {
    "land":     "../geo/land.geojson",     // required
    "lakes":    "../geo/lakes.geojson",
    "rivers":   "../geo/rivers.geojson",
    "cities":   "../geo/cities.geojson",
    "overlays": "../geo/terrain-overlays.geojson",
    "borders":  "../geo/borders-1941.geojson"
  }
}
```

- **`projection`** — `lcc` (Lambert Conformal Conic) or `equirect`. Set `lat1`/`lat2` to bracket your theatre's latitudes; scale error is zero along those parallels. For a theatre far from the poles, `equirect` is fine.
- **`bounds`** — the playable extent. The camera clamps to it and the terrain raster covers exactly it.
- **`terrainCellSizeKm`** — 4 km gives ~810k cells for the Eastern Front (~800 KB). Halving it quadruples memory.
- **`layers`** — paths are resolved relative to the scenario file.

## `factions`

```jsonc
{ "id": "germany", "name": "Germany", "alliance": "axis",
  "color": "#5c6b7a", "accentColor": "#e8eef4" }
```

Factions sharing an `alliance` are friendly; different alliances are hostile. `color` fills the counter, `accentColor` draws its frame and branch device.

## `templates`

Reusable stat blocks, so a hundred rifle divisions do not repeat a hundred stat lines.

```jsonc
"soviet-rifle": {
  "branch": "infantry",       // infantry | motorised | mechanised | armoured
                              // cavalry | mountain | airborne | artillery | security
  "maxManpower": 14500,
  "maxOrganisation": 36,
  "speedKmh": 1.25,           // sustained OPERATIONAL speed, not road speed
  "softAttack": 20, "hardAttack": 6, "defence": 24,
  "hardness": 0.04,           // 0..1, armoured share
  "experience": 0.15, "morale": 0.6, "supply": 0.7   // defaults
}
```

**On `speedKmh`:** this is sustained operational movement including halts, not vehicle top speed. 3.0 km/h ≈ 72 km/day, about what a panzer division managed in the opening week; 1.25 km/h ≈ 30 km/day for marching infantry. Terrain, supply and organisation scale it down from there.

`branch` selects the APP-6 device drawn on the counter.

## `divisions`

```jsonc
{ "id": "ger-3pz", "template": "panzer", "faction": "germany",
  "name": "3. Panzer-Division", "shortName": "3.Pz",
  "formation": "Panzergruppe 2",
  "lon": 23.42, "lat": 52.30,
  "organisation": 0.6, "strength": 0.9,     // optional, 0..1 of the template max
  "experience": 0.5, "morale": 0.8, "supply": 0.7 }
```

- `id` must be unique; `template` and `faction` must exist or the load fails loudly.
- Positions are **geographic** — authors think in lon/lat, never in kilometres.
- `strength` and `organisation` are *fractions* of the template maximum. Everything else is absolute 0..1.
- `shortName` is drawn on the counter; keep it under ~7 characters.

**A division must start on passable ground.** Water is impassable, and a unit placed in a lake cannot move. To check a new order of battle:

```js
// in the dev console, with the game running
const w = __game.engine.world;
[...w.divisions.values()].filter(d => !w.terrain.isPassableAt(d.position)).map(d => d.name)
```

## Terrain overlays

`overlays` is a GeoJSON `FeatureCollection` whose features carry a `terrain` property:

```jsonc
{ "type": "Feature",
  "properties": { "terrain": "marsh", "name": "Pripyat Marshes" },
  "geometry": { "type": "Polygon", "coordinates": [ … ] } }
```

Accepted values: `forest`, `marsh`, `hills`, `mountains`, `urban`. Anything not covered is plains. Overlays are painted over land in a fixed class order, then lakes are painted last so an inland sea always wins.

These polygons describe how ground **fights**, not how it looks — coarse is correct. Movement and defence modifiers per class live in `src/core/terrain/terrainTypes.ts`.

## Borders

`borders` is a GeoJSON `FeatureCollection` mixing boundary lines and country labels. **Borders are drawn, never enforced** — they carry no gameplay meaning and never block movement. Each scenario points at a file for *its own date*, which is why the political layer is scenario data rather than a global asset: a 1944 scenario ships `borders-1944.geojson` and nothing else changes.

```jsonc
// a boundary
{ "type": "Feature",
  "properties": { "kind": "border", "left": "Germany", "right": "Soviet Union",
                  "name": "Molotov-Ribbentrop line", "rank": 1 },
  "geometry": { "type": "LineString", "coordinates": [[22.95, 54.38], … ] } }

// a country name
{ "type": "Feature",
  "properties": { "kind": "label", "name": "SOVIET UNION", "rank": 1 },
  "geometry": { "type": "Point", "coordinates": [36.5, 54.5] } }
```

- **`rank`** drives level of detail: `1` front-defining (always drawn), `2` regional, `3` background context (hidden when zoomed out). Labels also scale their size and tracking by rank.
- **`left`/`right`** name the countries either side. Unused today; there so political logic has somewhere to read from later.
- The collection should carry a top-level `"asOf": "YYYY-MM-DD"` so the date a file represents is never ambiguous.

**Authoring a new date:** no open dataset covers 1940–41 (`historical-basemaps` has 1938 and 1945, both wrong for Barbarossa, and is GPL-3.0), so these are hand-drawn to ~10–25 km. When adding a file, add assertions to `src/core/geo/borders.test.ts` for a few facts you are sure of — a city that must sit on the line, two cities that must end up on opposite sides. That catches the mistyped digit that hand-drawing always eventually produces.

## Regenerating map data

```bash
npm run data:prepare
```

Edit `BBOX` in `scripts/prepare-map-data.mjs` to change the theatre, then update `map.bounds` to match. Downloads are cached in `scripts/.cache/`.
