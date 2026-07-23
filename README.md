# Linebattle

A browser-based **real-time operational strategy game** on a continuous real-world map — the historical map animations where flagged formations creep across Europe day by day, except you command the armies.

No provinces. No tiles. A division holds a position in kilometres and marches across real terrain.

**Playable now — three campaigns, three theatres:**

| Campaign | Date | Theatre | Divisions |
|---|---|---|---|
| Operation Barbarossa | 22 Jun 1941 | Eastern Front | 112 |
| Second Battle of El Alamein | 23 Oct 1942 | Western Desert | 28 |
| Operation Overlord | 6 Jun 1944 | Normandy | 36 |

```bash
npm install
npm run data:prepare   # once — downloads and clips Natural Earth map data
npm run dev
```

---

## What exists today (Milestones 1–3)

| | |
|---|---|
| **Map** | Natural Earth vector coastlines, lakes, rivers and cities. Each theatre is clipped offline and gets its own projection and source resolution — 1:50m at 4 km cells for a 3000 km front, 1:10m at 2 km for Normandy, where the whole scenario is an argument about one coastline |
| **Terrain** | Nine classes rasterised from GeoJSON at load; 996 × 825 grid at 4 km/cell on the Eastern Front |
| **Borders** | Hand-authored period boundaries and country labels — drawn, never enforced (toggle with `B`) |
| **Camera** | Free pan and zoom, 0.02–4 px/km, level-of-detail city labels |
| **Units** | 112 divisions, procedural APP-6 counters, strength and organisation bars |
| **Movement** | Continuous, terrain-modified, with A* pathfinding, solid enemy collision and formed-unit zones of control |
| **Combat** | Automatic on contact — organisation-based, terrain and supply driven, retreat and pursuit, combat bubbles |
| **Supply** | Binary capital connectivity: friendly territory is supplied only while a land route to a logistics root remains open; seven-day pocket collapse |
| **Operational AI** | Executes persistent sectors and scenario phases: defensive opening doctrine, winter halts and a single-theatre Schwerpunkt without individual-unit scripting |
| **Liquid frontline** | Scenario-authored opening control plus a persistent 16 km wash driven by physical presence; its moving boundary is divided into stable 60 km operational segments |
| **Strategic intent** | Place up to three attack and three defense objectives; nearby headquarters concentrate sectors without turning divisions into free agents |
| **Weather** | Rasputitsa, deep winter and desert summer, derived from the date and the scenario's climate |
| **Recruitment** | Continuous formation raising with scenario-specific cadence and force ceilings; recruits rapidly deploy behind the least-loaded connected front sector |
| **Simulation** | Fixed twelve-hour strategic tick with 15-minute combat substeps, deterministic and decoupled from frame rate |
| **Randomness** | Seeded, saveable RNG; `Math.random` banned in `core/` at lint level |
| **Scenarios** | Pure JSON — order of battle, stats, projection and map layers are all data |
| **Tests** | 196 tests in plain Node, no DOM — determinism, combat fairness, pathfinding, projection, scenarios |

```bash
npm test      # 196 tests
npm run check # lint + typecheck + tests
```

### Measured, not assumed

| | |
|---|---|
| Frame cost, 112 divisions @1080p | **0.17 ms** (budget is 16.7 ms) |
| Frame cost, 1000 divisions | **0.81 ms** |
| Projection round-trip | exact to **1e-9°** |
| Operational distance error | **< 0.55%** vs. haversine |
| Determinism | identical world hash across runs, seeds, and batch sizes |
| Bocage vs open ground | **10.7 vs 35.6 km/day** — the hedgerows are terrain you feel |
| Scenario load | 36–67 ms including terrain rasterisation |
| Tick cost, 44 battles + supply flooding | **1.36 ms** (budget 16.7 ms) |
| Pathfinding 57 divisions on one order | **4 ms** |
| Combat fairness | stronger force wins **25 / 25** seeds; durations still vary |
| Barbarossa, 75 simulated days | advance to **38.1°E**, supply 0.60, 44 of 57 divisions alive |

## Controls

| Input | Action |
|---|---|
| Left click | Select division |
| Left drag | Box-select your divisions |
| Shift + click | Add to selection |
| Right drag / middle drag | Pan |
| Wheel | Zoom |
| W A S D / arrows | Pan |
| Space | Pause |
| 1 – 5 | Game speed |
| H | Halt selected |
| P | Political map / front line |
| B | Period borders (approximate, off by default) |
| Ctrl + A | Select all your divisions |
| Home | Fit theatre |
| Esc | Clear selection |

## Architecture in one picture

```
        Commands ──────────────┐
                               ▼
  ┌──────────┐          ┌─────────────┐         ┌──────────────┐
  │  Input   │          │    core/    │         │   render/    │
  │  (DOM)   │          │  World      │ ──read──▶  PixiJS      │
  └────┬─────┘          │  Systems    │         │  Camera      │
       │                │  GameClock  │         │  Layers      │
       │  selection     └──────┬──────┘         └──────┬───────┘
       ▼                       │ Events                │ owns the rAF loop
  ┌──────────┐                 ▼                       │
  │ViewStore │◀────── snapshot at 10 Hz ────────────────┘
  └────┬─────┘
       ▼
  ┌──────────┐
  │  React   │   HUD only — never re-renders on a game frame
  └──────────┘
```

Three rules hold the whole thing together:

1. **`core/` knows nothing about Pixi or React.** It is plain TypeScript that would run in Node.
2. **The world is mutated only by systems, only at a tick boundary, only via commands.**
3. **Rendering reads. It never writes.**

Full reasoning in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Roadmap in [docs/ROADMAP.md](docs/ROADMAP.md). Scenario authoring in [docs/SCENARIO_FORMAT.md](docs/SCENARIO_FORMAT.md).

## Layout

```
src/
  core/          simulation — no rendering, no React
    geo/         projections, GeoJSON types
    terrain/     terrain classes, raster grid, load-time rasteriser
    world/       World, Division, Battle, Faction, spatial index, hashing
    systems/     order, supply, movement, contact, combat, attrition, recovery
    pathfinding/ A* over the terrain grid
    supply/      coarse supply and control field
    weather/     season model
    commands/    the only way to mutate the world
    events/      the only way the world talks back
    scenario/    JSON schema + loader
    time/        fixed-timestep clock
    math/        vectors, seeded RNG
    engine/      GameEngine — owns world, systems, queue
  render/        PixiJS — camera, layers, symbols, theme
  input/         DOM input → commands + selection
  app/           React shell, view store, boot wiring
  ui/            HUD components, styles
scripts/         offline map-data pipeline
public/data/     geo layers + scenarios
```

## Tech

TypeScript (strict, `noUncheckedIndexedAccess`) · React 18 · PixiJS 8 · Vite 6. No state-management library, no ECS framework, no map library — each was considered and rejected in the architecture doc.

## Licence & data

Map data derived from [Natural Earth](https://www.naturalearthdata.com/) (public domain).
