# Architecture

Every decision below is written as *what we chose*, *what we rejected*, and *why*. When a decision turns out to be wrong, amend the entry rather than deleting it — knowing why the previous answer failed is worth more than the answer.

---

## 1. Layering

```
core/  ──▶  nothing
render/ ─▶  core
input/  ─▶  core, render
app/    ─▶  core, render, input
ui/     ─▶  app
```

The dependency graph is a **tree, not a knot**. `core/` compiles and runs under plain Node with no DOM (one deliberate exception, §5). This is not purism: it means the simulation can be unit-tested without a browser, moved into a Web Worker when the AI needs a thread, and run headless on a server if this ever becomes multiplayer.

**Rejected:** a single `game/` folder with everything in it. It is faster for the first week and unbearable by the third month, because rendering concerns leak into combat maths and you can no longer answer "what happens on a tick?" without reading the renderer.

---

## 2. Fixed timestep

One tick = **15 game-minutes**, always. Speed controls change how many ticks run per real second (`SPEED_TABLE`), never the size of a tick.

Why this matters more than it looks: with a variable timestep, a player on a 144 Hz monitor gets different combat results than one on 30 fps, saves cannot be reproduced, and replays are impossible. Determinism is nearly free if designed in on day one and close to unaffordable to retrofit — every system written against variable `dt` has to be rewritten.

Consequences we accepted deliberately:
- The clock stores an integer `tick`; the date is **derived**, never stored, so it cannot drift.
- `advance()` caps ticks per frame so a backgrounded tab does not enter a death spiral on return.
- Rendering interpolates between `prevPosition` and `position` (`subTickAlpha`), so units glide at 60 fps while the sim steps 4×/game-hour.

---

## 3. Commands in, events out

Nothing mutates the world directly. Input pushes `Command` objects onto a queue; `OrderSystem` drains it at the start of each tick. The world talks back through an `EventBus`.

This buys, at essentially no cost today:
- **Replays** — the command stream *is* the replay file.
- **AI** — a future AI is just another command producer.
- **Multiplayer** — commands are the natural thing to send over a wire.
- **Debuggability** — "what did the player do?" lives in one place.

**Rejected:** letting the UI call `division.order = ...`. It works on day one and produces mid-tick mutation bugs that are near-impossible to reproduce.

---

## 3a. Randomness is simulation state

`Math.random()` is **banned inside `src/core/`** by an ESLint rule (`no-restricted-properties`), verified to actually fire. All randomness comes from `world.rng`, a seeded xoshiro128\*\* generator whose entire state is four uint32s.

This is not fastidiousness. `Math.random()`'s state is global, unseedable and unsaveable: the first combat roll that uses it makes every replay unreproducible, and there is no way to retrofit the fix except by rewriting every system that touched it. Combat — Milestone 2 — is the first system that wants randomness, which is why the generator had to land **before** it.

Consequences:
- The RNG state is saved, restored and **hashed** alongside unit positions (`worldHash.ts`).
- `rng.fork()` gives a subsystem an independent stream, so adding a call site in one system cannot shift another system's sequence — the classic cause of "my replay desyncs after I added a log line".
- `rng.variance(spread)` returns a triangular multiplier centred on 1. That is the shape combat should use: variance changes *how fast* and *how costly* a battle is, never *who was going to win*.

`hashWorld()` turns determinism from a claim into something a test fails on, and is exactly the primitive multiplayer needs later: peers compare hashes per tick and a mismatch localises a desync to the tick it happened.

---

## 4. Entities: ECS-lite, on purpose

Divisions are plain mutable records in a `Map<DivisionId, Division>`. Systems are objects with `update(ctx)`, run in a **declared order** (`createDefaultSystems`) — order *is* the dependency graph, so it lives in exactly one place.

**Rejected:** a real ECS (bitecs, miniplex). An ECS earns its complexity at tens of thousands of entities with volatile component sets. We have a few hundred divisions with a fixed shape. Adopting one now would buy archetype churn and indirection in exchange for nothing.

**Rejected:** classes with behaviour (`division.move()`). Data and behaviour split cleanly here because behaviour is *global* — movement depends on terrain, supply, neighbours. Methods on the entity would just reach back into the world anyway.

Branded id types (`DivisionId`) are strings at runtime and distinct at compile time, so a `FactionId` can never be passed where a division is expected.

---

## 5. Geography

**Projection.** Lambert Conformal Conic, standard parallels **47°N/59°N**, centred on 28°E. The Eastern Front spans 45–62°N, where Web Mercator inflates distance by >10% — a division near Leningrad would look twice the size of one near Odessa, and every distance would be a lie.

The standard parallels were **chosen by measurement, not by rule of thumb.** LCC scale is exact along the parallels and compressed between them, so widely spaced parallels systematically shrink everything in the middle. The original 44/62 understated *every* operational distance by ~1.2% (Brest–Minsk came out 335 km instead of 340). Surveying candidates against haversine ground truth:

| parallels | worst error, 38–66°N | worst error, 45–60°N *(where the fighting is)* |
|---|---|---|
| 44 / 62 | 2.04% | 1.24% |
| **47 / 59** | **2.68%** | **0.55%** |
| 48 / 58 | 2.84% | 0.57% |

47/59 more than halves the error where units actually operate, at the cost of accuracy at the extreme corners of the bounding box — empty sea and tundra. That trade is deliberate and is locked in by a test, so nobody widens the parallels again without seeing what it costs.

Both facts are enforced in `projection.test.ts`: round-trip to 1e-9 degrees, and operational distances within 0.6%.

World space is kilometres with **y increasing southwards**, matching screen conventions so the renderer never flips a sign.

**Map data.** Natural Earth GeoJSON, clipped to the theatre offline (`scripts/prepare-map-data.mjs`) with Sutherland–Hodgman polygon clipping and Douglas–Peucker simplification: 6.4 MB of world data becomes 147 KB of theatre.

**Rejected:** raster tile maps (Leaflet/MapLibre). They need network or a tile server, cannot be restyled to a 1941 staff map, and — decisively — a tile is a *picture*. Vector geometry doubles as gameplay data: the polygon that draws the coast defines where units cannot walk.

**Borders are cartography, not rules.** `BorderLayer` draws the political boundaries of 22 June 1941 and country names. Nothing in `core/` knows they exist: movement stays continuous, and a division crossing the Bug notices only the river. This is the distinction the project depends on — a border you can *see* is orientation, a border that *stops you* is a province system, and we are explicitly not building one. When territory ownership starts to matter (supply sources, victory conditions) it will be polygon data in the scenario, and it still will not constrain movement.

The lines are hand-authored, because **no open dataset covers 1940–41**: `historical-basemaps` ships 1938 (pre-Munich — Czechoslovakia intact, Poland independent, the Baltics free) and 1945 (post-war), both wrong for this scenario, and is GPL-3.0. Modern Natural Earth borders would draw a Ukraine and a Lithuania that did not exist as states. Accuracy is roughly 10–25 km and `borders.test.ts` checks the things hand-drawing gets wrong — vertices outside the theatre, implausible hops, and specific historical facts (Brest on the demarcation line, Warsaw German and Białystok Soviet, Vyborg beyond the 1940 Finnish border, Cluj Hungarian and Turda Romanian).

Pixi has no dashed strokes, so `BorderLayer` emits dashes itself with phase carried across vertices. A solid line reads as a river or a road; the dash is what makes it read as political.

**Terrain.** Rasterised at load into a `Uint8Array` at 4 km/cell (990 × 819) by painting GeoJSON into an offscreen 2D canvas, one solid grey per terrain class, then reading the pixels back. Sampling terrain becomes an O(1) array index rather than O(edges) point-in-polygon — and movement samples terrain for every division, every tick.

This is the one place `core/` touches a browser API. It is load-time asset preparation, not simulation, and it is isolated in `terrainBuilder.ts`; the `TerrainGrid` it produces is pure data that a test can construct by hand.

Rivers get a **separate mask**, because a river is a line you *cross*, not an area you stand in. That distinction is what lets Milestone 2 apply a river-crossing penalty to an attack without pretending the Dnieper is a kind of ground.

Verified against known geography: Moscow → Forest, Berlin → Plains, Baltic → Water, Pripyat → Marsh, Carpathians → Mountains.

---

## 6. Rendering

**Map layers draw once, in world coordinates.** The camera then moves and scales a single root container. Panning costs one transform, not a re-tessellation of hundreds of coastline polygons.

The exception is **stroke width**, which would be sub-pixel when zoomed out and fat when zoomed in. Strokes are re-issued only when zoom crosses a 12% hysteresis band — a redraw every few seconds of input, not every frame.

**Unit counters are counter-scaled** by `1/zoom` so they hold a constant pixel size, and views are **pooled** by division id and mutated in place. Allocating Pixi objects per frame is the classic way to make a strategy game stutter.

Counters are generated procedurally from `Branch` (APP-6 style). Placeholder in fidelity, not in structure: swapping in real sprites means replacing one function.

**We own the `requestAnimationFrame` loop** (`autoStart: false`, `sharedTicker: false`) and call `renderer.render()` explicitly. The loop belongs to whoever owns the simulation clock; borrowing Pixi's ticker makes "when does the world advance?" a question about Pixi's internals, and makes teardown depend on its lifecycle rather than one handle we hold.

---

## 7. React and the 60 fps problem

React must **never re-render on a game frame**. Reconciling a tree 60×/second while Pixi draws is how these projects end up at 20 fps.

- Pixi reads world state directly, every frame, with no React involvement.
- React subscribes to `ViewStore` via `useSyncExternalStore` and receives an **immutable snapshot at 10 Hz**.
- Interactions that must feel instant (clicking a unit) force an immediate publish.

**Selection lives in the ViewStore, not the World.** What the player has clicked is view state, not simulation state — putting it in the world means saved games remember your last click, and a replay would have to reproduce your mouse.

**Rejected:** Redux/Zustand/Jotai. The store is ~150 lines, has exactly one writer, and is driven by a game loop rather than by React. A general-purpose state library would add a dependency and an idiom without removing any code.

---

## 7a. Theatres

A **theatre** is the unit of map data: a bounding box, a source resolution and a directory under `public/data/geo/`. A scenario names one and declares its own projection over it.

There is deliberately no single world map. The Eastern Front spans 3000 km and is well served by 1:50m data at 4 km cells; Normandy is 400 km across and lives or dies on exactly where the coastline is, so it uses 1:10m at 2 km. One global map would be too coarse for one and too heavy for the other, and no single set of standard parallels serves both 30°N and 66°N.

`scripts/prepare-map-data.mjs` takes a theatre list and clips each independently (`npm run data:prepare -- normandy` for one). Three theatres total 275 KB.

Adding the second and third theatres cost **no engine changes**, which was the point — but it did surface two assumptions the Eastern Front had hidden:

- **The player commands a coalition, not a nationality.** Playing Germany, "same faction" and "same alliance" are the same set. Overlord is US + UK + Canada landing side by side, and Eighth Army is Australian, New Zealand, South African and Indian. Selection and orders now filter by alliance.
- **Terrain classes were Europe-shaped.** North Africa without desert and Normandy without bocage are not simplifications, they are wrong maps. Both were appended to the enum (never renumbered — the values are persisted) with no other code touched.

Adding bocage also exposed a latent bug in the terrain rasteriser. It had encoded each class as a distinct grey and decoded by value, so antialiasing along a polygon edge blended between classes that were far apart numerically — and bocage (8) meeting sea (0) put a fringe of hills and desert on the invasion beaches. Each layer is now rasterised as its own mask and thresholded at 50% coverage, so every edge pixel is a clean choice between the two classes that actually meet there.

---

## 7b. Combat

The brief asked for results driven by unit statistics, terrain, supply, organisation, morale and experience, plus a small random factor that never makes combat feel unfair. **That last clause drove the whole design.**

**Randomness modulates rate, not outcome.** Each tick applies a triangular multiplier of ±12% to damage. A battle runs for dozens of ticks, so the rolls average out and the stronger force wins reliably — variance decides whether it takes eighteen hours or thirty, and what it costs. There is no single roll that can lose a battle a well-supplied veteran division should win. A test asserts this across 25 seeds and demands **25 wins out of 25**, not "usually".

**Organisation is the currency, not manpower.** Divisions break long before they are destroyed: a formation that has lost cohesion stops being able to fight and falls back, having lost perhaps a tenth of its men. A full bar of organisation is worth about 13% of a division's strength, so *a single battle cannot annihilate anyone* — which is why encirclement (Milestone 3) will be so much deadlier than frontal assault, and why a broken army can be reconstituted.

**A battle is a relationship, not a place.** It owns no ground and no units, only ids. Divisions keep marching, taking losses and being ordered around while it exists. Battles form by transitive clustering — any two hostile divisions in range join the same engagement, and so does anyone in range of them — so a continuous front behaves like a front instead of a hundred separate duels. They are rebuilt from scratch each tick and inherit the id of the battle they most overlap, so the UI sees one continuous engagement rather than a new one every fifteen minutes.

**Attacking is a state, not an intent.** A side attacks when it has a live move order. That is what earns the other side its terrain bonus, and it is why sitting in a forest is worth doing.

**Retreat is a stance.** Without it a broken division walks 500 m, re-enters contact and is ground to nothing for no reason the player can see. `ContactSystem` refuses to enrol a retreating formation, so it actually escapes.

Every term in the power calculation is something the player can see in the unit panel. That is a deliberate constraint: a player who loses a battle should be able to point at the number that lost it.

---

## 7c. Pathfinding and the spatial index

Two pieces of infrastructure that Milestone 1 deliberately deferred, added when combat made them necessary.

**A\* over the terrain grid**, with a line-of-sight fast path. Most orders are unobstructed, and a LOS walk is orders of magnitude cheaper than a grid search, so A\* only runs when the direct route is genuinely blocked — that is what makes it affordable to path a hundred divisions on one click (measured: 57 orders in 4 ms). Cost is *time*, not distance, so a route prefers open ground over a short slog through marsh. Scratch buffers are allocated once and reused through a generation stamp; allocating per call would be 10 MB of churn per division per order. Ties break on cell index, never insertion order, so paths are byte-identical between runs.

Raw grid paths are staircases of hundreds of cells, so the result is string-pulled down to the handful of corners the terrain actually forces.

`MovementSystem` was not touched by any of this — exactly as this document promised in Milestone 1. It already only knew how to walk a list of points; pathfinding changed who produces the list.

**The spatial index** replaces the linear scan. Contact detection asks "who is near this?" for every division every tick: at 400 divisions that is 15 million distance tests per simulated day, growing quadratically. It is rebuilt from scratch each tick rather than maintained incrementally — with a few hundred moving entities the rebuild is microseconds and it cannot drift out of sync, which an incremental index eventually does.

---

## 7d. Supply, encirclement and weather

**Supply is deliberately coarser than terrain** — 16 km cells against 4 km, ~51k cells instead of 821k. You are never asking "can this truck reach that hedgerow", you are asking "is this corps in supply". Finer resolution would be sixteen times the work for an answer nobody can act on.

**Encirclement is not special-cased.** Supply floods outward from depots by Dijkstra and simply cannot enter cells the enemy dominates. A pocket whose every land route is enemy-held stops being reached, and its divisions starve. That *is* what a Kessel is, and getting it as a consequence rather than as a rule means it works for shapes nobody anticipated.

**Supply is read from the slack left in the line, not from distance travelled.** While a route still has 150 km of reach in hand the formation at the end wants for nothing; below that it goes short, hitting zero at the limit. The obvious alternative — supply proportional to remaining range — taxes a division 70 km behind its own railhead at 18%, which is nonsense, and has to be normalised against some nominal range so scenarios with shorter depots could never reach full supply anywhere.

**Supply lags.** A division carries days of stores, so being cut off is a strangulation rather than a switch — and a spearhead can outrun its trucks briefly and get away with it, which is the decision the whole campaign turns on.

**Attrition is what makes encirclement lethal.** Combat cannot destroy a division (organisation breaks first), so starvation in a pocket is the only reliable way to remove one from the map — exactly how 1941 actually worked.

### Hubs had to become capturable

The first version had fixed depots, and measuring it exposed a fundamental error rather than a tuning problem. A general German advance on Barbarossa:

| | day 0 | day 30 | day 60 | day 90 |
|---|---|---|---|---|
| avg. supply | 0.98 | 0.04 | 0.07 | 0.95 |
| German divisions | 57 | 57 | **7** | **1** |

The Wehrmacht destroyed itself in two months without the Red Army doing much of anything, because supply physically could not follow an advance past its start-line depots. Rail heads moved forward in 1941; they have to here. With capturable hubs:

| | day 0 | day 30 | day 60 | day 75 |
|---|---|---|---|---|
| avg. supply | 0.98 | 0.48 | 0.60 | 0.60 |
| German divisions | 57 | 57 | 46 | **44** |
| advance | 23.7°E | 30.4°E | 35.4°E | **38.1°E** |

with hubs falling as the front passes them — Lviv 24 Jun, Vilnius 26 Jun, Kyiv 6 Jul, Minsk 21 Jul, Smolensk 19 Aug. **This is the clearest case in the project of a measurement changing a design rather than confirming one.**

### Cost

The flood is the most expensive thing in the simulation: 5.7 ms per pass, amortised to **1.36 ms/tick** against 0.10 ms for everything else. It runs once a game-hour, not every tick — supply fronts move at the speed of armies. Reusing the scratch buffers instead of allocating per alliance per pass took it from 2.46 to 1.36 ms/tick; the same generation-buffer technique as the pathfinder, for the same reason. `RECOMPUTE_INTERVAL` is the knob if it ever needs to be cheaper.

**Weather is derived from the date**, never stored — the same rule as the clock, so it cannot drift. Climate is per scenario, because October means opposite things in Smolensk and the Western Desert.

---

## 7e. The enemy plays, pursuit kills, and the map is painted

Three changes driven directly by the first real playtest ("the enemy retreats in slow motion and we drive over them; there is no front line; the borders are wrong").

**The AI is just another command producer.** `AiSystem` pushes into the same queue the player uses — the payoff of the Milestone 1 command-pattern decision, collected on schedule. It never touches a division directly, consumes no randomness, and visits divisions in sorted order, so it is a pure deterministic function of world state and replays don't even need to record it. Doctrine is minimal and defensive: stand when engaged (dropping any move order, because a side with orders counts as *attacking* and forfeits the terrain bonus), block approaching enemies at a standoff, counterattack only from clear local superiority, and hold quiet sectors. A claim limit stops defenders dogpiling one spearhead — which is what makes a *front* emerge instead of a scrum.

**Exclusion from battle must not mean immunity.** Retreating divisions are excluded from battles by design, but the first version made that literal invulnerability: you could drive a panzer division through a routing enemy and neither noticed. Now a router caught within 10 km of a formed enemy takes one-sided overrun losses. Pursuit is where beaten armies actually died, and now it is worth doing. Rout speed also stopped double-taxing the stance — a fleeing mob is not slow, it is incoherent, and the organisation factor already models that.

**The political map is computed, not drawn.** Control of each 16 km cell seeds from a nearest-presence Voronoi over starting units and depots, then updates two ways: *domination* (your troops clearly outweigh everyone else's there) and the *logistics sweep* (nobody stands there and exactly one side's supply reaches it — which paints the ground behind an advance and, for free, keeps pockets their defender's colour until they die). The tinted wash is HOI4-style; the boundary between tints IS the front line, and it can never disagree with the game state, which hand-authored border lines by construction could — and did. The hand-drawn 1941 treaty lines survive as an optional overlay (`B`), clearly labelled approximate, hidden by default.

A latent bug surfaced here: supply throughput sampled terrain by integer cell ratio, correct only when the supply cell divides evenly by the terrain cell. The shipped scenarios divided evenly *by accident*; the 10 km test world did not, and a third of its map baked as impassable to supply. Overlap is now computed in world coordinates.

---

## 7f. Provinces

The political map is a **province mesh**, not a fuzzy per-cell control field and not hand-drawn lines. This is the HOI4 backbone, but generated to fit our theatres rather than imported — a pasted screenshot of HOI4's map is not usable data, and its whole-world Mercator grid would not match our three regional projections anyway.

**Generation** (`provinceGenerator.ts`): scatter seeds on a jittered grid over passable terrain, then grow every seed at once with a multi-source breadth-first flood. Each land cell joins whichever front reaches it first — a Manhattan-metric Voronoi, chunky and contiguous, in one O(cells) pass. Water is left unassigned so the sea is nobody's ground. Jitter comes from a local RNG, not `world.rng`, so the mesh is reproducible AND generating it never perturbs the simulation stream. Measured: 4282 provinces for the Eastern Front in 84 ms at load, one time.

**Geometry is immutable; ownership is simulation state.** `ProvinceMap` splits the two: the shapes never change (regenerating would invalidate every save), only the `owner` array moves, and that array is hashed and saved with everything else. `provinces[k].id === k` is an invariant — empty seeds are compacted out and neighbour ids remapped — so every consumer can index directly.

**Ownership** (`provinceSystem.ts`) changes two ways: **seizure** (your divisions in a province clearly outweigh everyone else's — the front physically moving) and the **logistics sweep** (nobody stands there, but exactly one side's supply reaches it and it touches ground that side holds — which paints the rear behind an advance and keeps a pocket its defender's colour until they die, since supply cannot enter a Kessel). Initial ownership seeds by nearest force or depot with no range cap: depots sit at national centres (Moscow, Berlin, Bucharest), so the whole theatre fills from the start and the boundary between the two clusters falls naturally along the historical front. Verified: Berlin/Warsaw/Bucharest axis, Moscow/Kyiv/Leningrad/Brest Soviet — no hand-authored nationality data anywhere.

**Rendering** (`provinceLayer.ts`): one texture at terrain resolution, cell → province → owner → colour. The boundary between two owners is drawn bold and opaque — that IS the front line, no separate geometry, and it can never disagree with the game state the way drawn borders did. Faint internal province seams give the familiar HOI4 mosaic.

This retired the per-cell control field and its overlay entirely; the hand-drawn treaty borders survive only behind `B`, labelled approximate.

**What this is NOT, yet.** Provinces are the political and territorial backbone, but movement is still continuous and units can still pass between each other — province-graph movement (a division pinned in a province it is fighting for, blocked from slipping past a held enemy province) is the next step. This commit is the foundation the "full province system" decision asked for; the gameplay layer builds on it.

---

## 8. Scenarios are data

A scenario is one JSON file: projection, map bounds, terrain resolution, map layers, factions, stat templates and the order of battle. Adding *Case Blue* must mean writing JSON and **zero TypeScript** — that requirement is why the projection and the theatre bounds are scenario-declared rather than global constants.

`formatVersion` is checked at load so an old file fails loudly instead of misbehaving subtly. Divisions reference reusable `templates`, and override only what differs.

See [SCENARIO_FORMAT.md](SCENARIO_FORMAT.md).

---

## 9. Testing

`npm test` runs 44 tests in **plain Node with no DOM**. That environment is itself an assertion: if a test in `core/` ever needs jsdom, a browser dependency has leaked into the simulation.

The suite is weighted towards claims that are expensive to discover being wrong:

- **Determinism** — identical command streams produce identical world hashes; a run stepped in one batch matches one stepped in thirty (the frame-rate independence claim); different seeds diverge; the hash is insensitive to insertion order but sensitive to a single extra tick.
- **Projection** — round-trip precision and measured scale error against haversine ground truth.
- **Movement** — terrain effects, never entering water, waypoint queues, supply effects, and a regression test for the shore livelock described below.
- **RNG** — reproducibility, state round-trip through JSON, uniformity, fork independence.

The suite has already paid for itself: it caught a livelock where a division ordered across a lake ground against the shore indefinitely, bleeding organisation, while coast-sliding reported "success" every tick so nothing ever flagged the order impossible. Fixed by tracking progress toward the objective rather than movement per se.

---

## 10. Known limits (deliberate, for now)

| Limit | Why it's fine today | When to fix |
|---|---|---|
| `divisionsNear` is a linear scan | ~400 divisions, only on click | Milestone 2, when contact detection runs every tick — spatial hash |
| Movement is straight-line, no pathfinding | Units slide along coastlines; an order across a lake is abandoned after 2 game-hours of zero progress rather than grinding forever | Milestone 2 — A* over the terrain grid; `MovementSystem` already only walks a waypoint list, so it will not change |
| No save/load | Nothing to save yet | Milestone 4 — the World is one serialisable object by construction |
| Supply is a static number | No combat consumes it | Milestone 3 — supply system before movement in the tick order |
| Terrain overlays are hand-drawn polygons | Coarse but operationally honest | Replace with a landcover raster; no code changes needed |
