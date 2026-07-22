# Linebattle

A browser-based **real-time operational strategy game** on a continuous real-world map — the historical map animations where flagged formations creep across Europe day by day, except you command the armies.

No provinces. No tiles. A division holds a position in kilometres and marches across real terrain.

**Milestone 1 is playable now:** the Eastern Front in June 1941, 112 divisions, click to select, right-click to march.

```bash
npm install
npm run data:prepare   # once — downloads and clips Natural Earth map data
npm run dev
```

---

## What exists today (Milestone 1)

| | |
|---|---|
| **Map** | Natural Earth vector coastlines, lakes, rivers and cities, Lambert Conformal Conic projection, ~150 KB of clipped data |
| **Terrain** | 990 × 819 grid at 4 km/cell — water, plains, forest, marsh, hills, mountains, urban — rasterised from GeoJSON at load |
| **Camera** | Free pan and zoom, 0.02–4 px/km, level-of-detail city labels |
| **Units** | 112 divisions, procedural APP-6 counters, strength and organisation bars |
| **Movement** | Continuous, terrain-modified, coastline-aware, with waypoint queues |
| **Simulation** | Fixed 15-minute tick, deterministic, decoupled from frame rate |
| **Scenarios** | Pure JSON — order of battle, stats, projection and map layers are all data |

Combat is **not** implemented yet. That is Milestone 2, by design.

## Controls

| Input | Action |
|---|---|
| Left click | Select division |
| Left drag | Box-select your divisions |
| Shift + click | Add to selection |
| Right click | Move order |
| Shift + right click | Queue a waypoint |
| Right drag / middle drag | Pan |
| Wheel | Zoom |
| W A S D / arrows | Pan |
| Space | Pause |
| 1 – 5 | Game speed |
| H | Halt selected |
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
    world/       World, Division, Faction, ids
    systems/     OrderSystem, MovementSystem, RecoverySystem
    commands/    the only way to mutate the world
    events/      the only way the world talks back
    scenario/    JSON schema + loader
    time/        fixed-timestep clock
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
