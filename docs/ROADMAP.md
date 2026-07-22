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

---

## Milestone 2 — Contact and combat

**Goal: the front line becomes a real thing.** Two divisions that meet fight, and the loser gives ground.

- [ ] Spatial hash for proximity queries (replaces the linear scan)
- [ ] A* pathfinding over the terrain grid, so orders across water route around it instead of being abandoned
- [ ] `ContactSystem` — detect opposing divisions within engagement range
- [ ] `Battle` entity: attackers, defenders, terrain, frontage, duration
- [ ] `CombatSystem` — resolve per tick from strength, organisation, morale, supply, experience, terrain, river crossings, plus a **bounded** random factor
- [ ] Organisation as the primary combat currency; manpower losses follow
- [ ] Retreat: the loser withdraws along the least-contested vector
- [ ] Combat bubble rendering (HOI4-style) with attacker/defender readout
- [ ] Battle log in the HUD

**Design constraint:** randomness must never make a well-supplied veteran panzer division lose to a broken rifle division. Variance modulates *how fast* and *how expensive*, never *who wins*, outside narrow margins.

---

## Milestone 3 — Supply, attrition and the operational layer

**Goal: distance starts to hurt. Barbarossa's real enemy was logistics.**

- [ ] Supply sources (railheads, ports, depots) declared in scenario JSON
- [ ] Supply propagation over the terrain grid with range falloff and road weighting
- [ ] Encirclement detection — cut-off formations lose supply, then organisation, then cohere
- [ ] Attrition by terrain and supply state
- [ ] Weather and seasons — mud and winter as first-class modifiers
- [ ] Supply overlay map mode

---

## Milestone 4 — Command, AI and persistence

**Goal: play a campaign, not a skirmish.**

- [ ] Formation hierarchy: division → corps → army → army group
- [ ] Orders issued to a whole formation; front assignment
- [ ] Operational AI for the opposing side (a command producer, nothing more)
- [ ] Save / load — the World is already one serialisable object
- [ ] Replay playback from the command stream
- [ ] Victory conditions and objectives in scenario JSON

---

## Milestone 5 — Air, depth and presentation

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
