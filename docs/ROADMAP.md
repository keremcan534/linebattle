# Roadmap

Each milestone is a **playable build**, not a layer of plumbing. If a milestone does not change what the player can do, it is the wrong milestone.

---

## ✅ Milestone 1 — Map, camera, units, movement

**Shipped.** The theatre exists and you can march across it.

- [x] Vite + TypeScript (strict) + React + PixiJS 8 project skeleton
- [x] Offline Natural Earth pipeline (clip, simplify, 6.4 MB → 147 KB)
- [x] Lambert Conformal Conic projection, verified to 1e-9 round-trip
- [x] Map rendering: coastlines, lakes, two-tier rivers, LOD city labels
- [x] Terrain raster, 4 km/cell, seven classes + river crossing mask
- [x] Camera: pan, zoom-to-cursor, bounds clamping, fit-to-theatre
- [x] Procedural APP-6 counters with strength and organisation bars
- [x] Selection: click, shift-click, box-select
- [x] Movement orders with queued waypoints, terrain-modified speed, coast sliding
- [x] Fixed 15-minute tick, five speed settings, render interpolation
- [x] JSON scenario loading — Barbarossa, 112 divisions
- [x] HUD: date, speed controls, cursor readout, selection panel

---

## ✅ Milestone 1.5 — Determinism foundation

**Shipped.** Done *before* combat, because it cannot be retrofitted afterwards.

- [x] Seeded xoshiro128\*\* RNG as part of world state, saveable and hashable
- [x] `Math.random` banned in `core/` by ESLint (rule verified to fire)
- [x] `hashWorld()` — a checksum of the whole simulation, and the primitive multiplayer desync detection will use
- [x] Vitest suite running in plain Node with no DOM: 44 tests
- [x] Determinism tests: same stream → same hash; batch-size independence; seed divergence; order insensitivity
- [x] Projection standard parallels re-tuned by measurement (1.24% → 0.55% error where the fighting is)
- [x] Fixed a movement livelock: divisions ordered across water ground against the shore forever
- [x] Political layer: hand-authored 22 June 1941 borders and country labels, dashed rendering, `B` to toggle — drawn but never enforced, so the map stays province-free

---

## ✅ Milestone 1.6 — Multiple theatres

**Shipped.** Proof that the scenario format carries its weight: two new campaigns, no engine changes.

- [x] `prepare-map-data.mjs` takes a theatre list; each gets its own bbox, source resolution and output directory
- [x] Three theatres — Eastern Front (1:50m, 4 km), Normandy (1:10m, 2 km), Mediterranean (1:50m, 4 km), 275 KB total
- [x] **Operation Overlord**, 6 June 1944 — 36 divisions, five beaches, three airborne
- [x] **Second El Alamein**, 23 October 1942 — 28 divisions between the sea and the Qattara Depression
- [x] `Desert` and `Bocage` terrain classes (bocage measured at 10.7 km/day against 35.6 in the open)
- [x] Scenario picker driven by `scenarios/index.json`
- [x] Player commands their alliance, not their nationality
- [x] Fixed terrain rasteriser antialiasing that fringed the invasion beaches with phantom classes
- [x] Loader snaps and warns about divisions deployed on impassable ground
- [x] 41 static scenario tests — dangling references, out-of-bounds deployment, projection sanity, unused templates

---

## ✅ Milestone 2 — Contact and combat

**Shipped.** The front line is a real thing: divisions that meet fight, and the loser gives ground.

- [x] Spatial hash for proximity queries (replaces the linear scan)
- [x] A* pathfinding over the terrain grid, with a line-of-sight fast path — orders across water route around instead of being abandoned
- [x] `ContactSystem` — transitive clustering, so a sector is one engagement rather than a hundred duels
- [x] `Battle` entity: sides, who is attacking, terrain, duration, progress
- [x] `CombatSystem` — strength, organisation, morale, supply, experience, terrain, river crossings, plus a bounded random factor
- [x] Organisation as the primary combat currency; manpower losses follow at a fraction of the rate
- [x] Retreat as a stance, so a broken division actually escapes instead of being re-engaged
- [x] Combat bubble rendering with a progress dial and power readout
- [x] Engagement list in the HUD, worst first, click to fly the camera there
- [x] Determinism verified *with* combat consuming the RNG

**The design constraint held.** Randomness must never make a well-supplied veteran division lose to a broken one — a test runs 25 seeds and requires 25 wins out of 25, while a second test requires that battle *durations* still vary. Variance changes how fast and how expensive, never who wins.

Measured on Barbarossa: 44 battles over a simulated week, **0.097 ms per tick**, identical world hash across runs.

---

## ✅ Milestone 3 — Supply, attrition and weather

**Shipped.** Distance hurts. Barbarossa's real enemy was logistics, and now it is here too.

- [x] Supply sources — railheads, ports, depots — declared in scenario JSON
- [x] Supply propagation by Dijkstra over a 16 km field, terrain-weighted, blocked by enemy control
- [x] **Capturable hubs**, so an advance can carry its logistics forward
- [x] Encirclement as a consequence of the flood, not a special case
- [x] Attrition by terrain, weather and starvation — the only reliable way to destroy a division
- [x] Weather and seasons: rasputitsa, deep winter, desert summer, derived from the date
- [x] Supply map mode (`M`), drawn as one texture rather than 51k rectangles
- [x] Encirclement and season surfaced in the HUD

Fixed capacity was the interesting failure: it starved 56 of 57 German divisions to death inside two months with barely a shot fired. See the architecture doc — a measurement that changed a design.

---

## ✅ Milestone 3.5 — The enemy fights back

**Shipped**, pulled forward from Milestone 4 after the first real playtest.

- [x] Enemy AI as a pure command producer: blocks, stands, counterattacks from superiority, spreads across threats
- [x] Overrun: a caught router takes one-sided losses — retreat is no longer immunity, pursuit is worth doing
- [x] Computed political control map, HOI4-style tinted wash; its boundary IS the front line (`P` to toggle)
- [x] Hand-drawn treaty borders demoted to an optional, clearly-approximate overlay, hidden by default
- [x] Fixed supply-grid misalignment when cell sizes don't divide evenly

Measured on Barbarossa with the AI playing the Soviets: 37 divisions moving to block on day one, 74 battles and 19 divisions destroyed over 45 days (pursuit and pockets kill; frontal battle still cannot), frontier length growing 407 → 1286 cells as the line bends east. Deterministic, 1.55 ms/tick.

---

## 🚧 Milestone 4 — Provinces

**In progress**, chosen after playtesting: the political and territorial backbone HOI4 gets its front-line behaviour from, generated to fit our theatres rather than imported.

- [x] Province mesh generated per theatre by multi-source Voronoi flood (4282 provinces on the Eastern Front, 84 ms at load)
- [x] Ownership as simulation state — seizure by presence, logistics sweep behind an advance, hashed and saved
- [x] Ownership from real Natural Earth national territory, remapped to 1941 owners — the front falls on true borders, neutrals (Turkey, Sweden) stay neutral, province edges align to frontiers
- [x] HOI4-style province rendering: crisp coloured territory, the owner boundary drawn as the front line, faint province mosaic
- [x] Retired the per-cell control field the provinces replaced
- [ ] **Province-graph movement**: a division pinned while fighting for a province, blocked from slipping past a held enemy province — the fix that makes it PLAY like a front, not just look like one
- [ ] Formation hierarchy: division → corps → army; "draw the plan, the divisions execute it" orders
- [ ] AI offensives with objectives (the current AI only defends)
- [ ] Save / load — the World is already one serialisable object
- [ ] Replay playback from the command stream
- [ ] Victory conditions and objectives in scenario JSON

---

## Milestone 5 — Persistence, air and presentation

- [ ] Save / load — the World is already one serialisable object
- [ ] Replay playback from the command stream
- [ ] Air wings, missions, and air support modifying ground combat
- [ ] Artillery and support brigades attaching to divisions
- [ ] Historical unit sprites replacing procedural counters
- [ ] Front-line rendering (the continuous coloured line of the map videos)
- [ ] Time-lapse export
- [ ] Additional scenarios: Case Blue, Bagration, Fall Gelb

---

## Not on the roadmap

Deliberate exclusions, recorded so they are not re-litigated:

- **Province or tile systems.** The entire point is continuous movement.
- **Production, research, politics.** This is an *operational* game, not a grand-strategy one. Divisions arrive because the scenario says so.
- **3D.** A staff map is flat.
- **Multiplayer**, until determinism has been proven by replays surviving Milestone 4.
