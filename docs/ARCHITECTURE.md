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
