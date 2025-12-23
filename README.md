# Cue

**Durable stateful entities for TypeScript.**

Define entities with state, commands, and queries. Cue handles persistence, concurrency, and schema evolution—so you don't have to.

```typescript
import { define, create } from "@twoabove/cue";

const Counter = define("Counter")
  .initialState(() => ({ count: 0 }))
  .commands({
    increment: (s, by = 1) => {
      s.count += by;
    },
  })
  .queries({
    value: (s) => s.count,
  })
  .build();

const app = create({ definition: Counter });
const counter = app.get("my-counter");

await counter.send.increment(5);
console.log(await counter.read.value()); // 5
```

## Why Cue?

- **Durable.** State survives restarts. Plug in Postgres, SQLite, or Redis—or run in-memory for tests.
- **Safe.** One operation at a time, always. No race conditions, no corrupted state.
- **Evolvable.** Schema changes are type-checked and automatic. Add a field, rename a property—old entities migrate on load.
- **Streamable.** Long-running operations yield progress in real-time. Streams survive client disconnects—reconnect and resume where you left off.
- **Time-travel.** Query historical state at any point with full type safety.

## Installation

```bash
npm install @twoabove/cue immer
```

> **Note:** `immer` is a peer dependency and must be installed alongside cue.

## Quick Start

```typescript
import { create, define, memoryStore } from "@twoabove/cue";

// 1. Define your entity
const Character = define("Character")
  .initialState(() => ({
    level: 1,
    hp: 100,
    quests: new Set<string>(),
  }))
  .commands({
    takeDamage: (state, amount: number) => {
      state.hp -= amount;
      if (state.hp <= 0) {
        state.hp = 0;
        return "You have been defeated!";
      }
      return `Ouch! HP is now ${state.hp}.`;
    },
    levelUp: async (state) => {
      await new Promise((res) => setTimeout(res, 50));
      state.level++;
      state.hp += 10;
      return `Ding! Reached level ${state.level}!`;
    },
    // Streaming command using async generator
    startQuest: async function* (state, quest: string) {
      if (state.quests.has(quest)) {
        yield { status: "already_on_quest" };
        return "Quest already started.";
      }
      state.quests.add(quest);
      yield { status: "started", quest };
      await new Promise((res) => setTimeout(res, 100));
      yield { status: "completed", quest };
      state.quests.delete(quest);
      return "Quest complete!";
    },
  })
  .queries({
    getStats: (state) => ({
      level: state.level,
      hp: state.hp,
    }),
  })
  .build();

// 2. Create an entity manager
const manager = create({ definition: Character });

// 3. Get a reference to a specific entity by its unique ID
const playerOne = manager.get("player-one");

// 4. Interact with the entity
const damageResult = await playerOne.send.takeDamage(10);
console.log(damageResult); // "Ouch! HP is now 90."

const levelUpMessage = await playerOne.send.levelUp();
console.log(levelUpMessage); // "Ding! Reached level 2!"

// Read-only queries
const stats = await playerOne.read.getStats();
console.log(stats); // { level: 2, hp: 110 }

// Stream progress from long-running commands
console.log("Starting a new quest...");
for await (const update of playerOne.stream.startQuest("The Lost Amulet")) {
  console.log(`Quest update: ${update.status}`);
}
// > Quest update: started
// > Quest update: completed

// Snapshot for debugging
const snapshot = await playerOne.snapshot();
console.log(snapshot.state.quests); // Set(0) {}

// Shut down when done
await manager.stop();
```

## Core Concepts

### Defining Entities

Use the fluent builder to define your entity's shape and behavior:

- `.initialState(() => ({...}))`: Sets the default state for new entities.
- `.commands({...})`: Methods that can modify state (sync, async, or generators for streaming).
- `.queries({...})`: Read-only methods for safe state access.
- `.evolve((prevState) => ({...}))`: Migration function for schema changes.
- `.persistence({...})`: Configure snapshotting behavior.
- `.build()`: Finalize the definition.

### Entity References

Get a handle to interact with a specific entity:

```typescript
const ref = manager.get("entity-id");

await ref.send.someCommand(); // Execute a command (may modify state)
await ref.read.someQuery(); // Execute a query (read-only)
const run = ref.stream.streamingCommand(); // StreamRun with .id for reconnection
await ref.snapshot(); // Get current state and version
await ref.stateAt(version); // Get historical state at a specific event version
await ref.stop(); // Manually stop this entity
```

## Persistence

Provide a store to persist state changes:

```typescript
import { create, memoryStore } from "@twoabove/cue";

const manager = create({
  definition: Character,
  store: new memoryStore(), // or your custom PersistenceAdapter
});
```

Implement the `PersistenceAdapter` interface to plug in any database:

```typescript
interface PersistenceAdapter {
  getEvents(entityId: string, fromVersion: bigint): Promise<EventRecord[]>;
  commitEvent(entityId: string, version: bigint, data: string): Promise<void>;
  getLatestSnapshot(entityId: string): Promise<SnapshotRecord | null>;
  commitSnapshot(entityId: string, version: bigint, data: string): Promise<void>;
  clearEntity?(entityId: string): Promise<void>;
  subscribeEvents?(entityId: string, callback: () => void): () => void;
}
```

Enable snapshotting to avoid replaying long event histories:

```typescript
const Entity = define("Entity")
  // ...
  .persistence({ snapshotEvery: 100 }) // Snapshot every 100 versions
  .build();
```

## Durable Streams

When persistence is enabled, streams automatically record every yielded value. If a client disconnects mid-stream - browser refresh, network blip, mobile app backgrounded - the stream keeps running on the server. The client reconnects and picks up exactly where it left off. No lost data, no restarting from scratch.

```typescript
// Start a long-running operation
const run = ref.stream.generateReport(params);

// Return the stream ID to the client immediately
res.json({ streamId: run.id });

// Stream continues in the background, persisting each chunk
```

The client consumes live or reconnects later:

```typescript
// Consume live - iterator blocks until stream completes
{
  await using reader = manager.readStream(streamId);
  for await (const { seq, data } of reader) {
    render(data);
    lastSeq = seq;
  }
}

// After disconnect: resume from last position
{
  await using reader = manager.readStream(streamId, { after: lastSeq });
  for await (const { seq, data } of reader) {
    render(data);
  }
}
```

Check stream status without consuming:

```typescript
const status = await manager.streamStatus(streamId);
// { state: 'running', seq: 42n }
// { state: 'complete', seq: 100n, returnValue: { report: ... } }
// { state: 'error', seq: 50n, error: 'timeout' }
```

The `returnValue` field contains the generator's return value once complete.

**Note:** The entity is locked during stream execution (one operation at a time). Other commands to the same entity will queue until the stream finishes. This ensures consistency but means long streams block other operations on that entity.

This is essential for AI assistants, file processors, report generators - any operation that takes longer than a network timeout.

## Schema Evolution

Migrate entity state without downtime:

```typescript
// V1
const Character = define("Character").initialState(() => ({
  name: "Player",
  hitPoints: 100,
}));

// V2 with evolved schema
const Character = define("Character")
  .initialState(() => ({ name: "Player", hitPoints: 100 }))
  .evolve((v1) => ({
    name: v1.name,
    health: { current: v1.hitPoints, max: 100 },
    mana: 50, // new field
  }))
  .commands({
    takeDamage: (state, amount: number) => {
      state.health.current -= amount;
    },
  })
  .build();
```

When an old entity loads, Cue automatically runs upcasters to migrate its state.

## Temporal Scrubbing

Query historical state at any event version with full type safety:

```typescript
import { create, define, type HistoryOf, type VersionState } from "@twoabove/cue";

const Character = define("Character")
  .initialState(() => ({ hp: 100 }))
  .evolve((v1) => ({ health: { current: v1.hp, max: 100 } }))
  .evolve((v2) => ({ ...v2, mana: 50 }))
  .commands({
    damage: (s, amount: number) => {
      s.health.current -= amount;
    },
  })
  .build();

const app = create({ definition: Character, store: new memoryStore() });
const hero = app.get("hero-1");

// Make some changes
await hero.send.damage(10);
await hero.send.damage(5);

// Query historical state
const atV1 = await hero.stateAt(1n);
console.log(atV1.schemaVersion); // 3
console.log(atV1.state.health.current); // 90
```

### Type-Safe History

The return type of `stateAt()` is a discriminated union of all schema versions:

```typescript
// Extract the full history union
type CharacterHistory = HistoryOf<typeof Character>;
// | { schemaVersion: 1; state: { hp: number } }
// | { schemaVersion: 2; state: { health: { current: number; max: number } } }
// | { schemaVersion: 3; state: { health: { current: number; max: number }; mana: number } }

// Extract a specific version's state type
type CharacterV1 = VersionState<typeof Character, 1>; // { hp: number }
type CharacterV2 = VersionState<typeof Character, 2>; // { health: { current: number; max: number } }

// TypeScript narrows correctly in switch statements
function renderHistorical(h: CharacterHistory) {
  switch (h.schemaVersion) {
    case 1:
      return `HP: ${h.state.hp}`;
    case 2:
      return `Health: ${h.state.health.current}/${h.state.health.max}`;
    case 3:
      return `Health: ${h.state.health.current}, Mana: ${h.state.mana}`;
  }
}
```

This enables building debug UIs, audit logs, and replay systems with compile-time guarantees.

## Supervision

Handle errors declaratively:

```typescript
import { create, supervisor } from "@twoabove/cue";

const mySupervisor = supervisor({
  stop: (_state, err) => err.name === "CatastrophicError",
  reset: (_state, err) => err.name === "CorruptionError",
  resume: (_state, err) => err.name === "ValidationError",
  default: "resume",
});

const manager = create({
  definition: MyEntity,
  supervisor: mySupervisor,
});
```

Strategies:

- **resume**: Error bubbles up, entity stays healthy
- **reset**: Clear persisted history, reinitialize state
- **stop**: Entity enters failed state, rejects all future messages

## Passivation

Automatically evict idle entities to save memory:

```typescript
const manager = create({
  definition: MyEntity,
  store: myStore,
  passivation: {
    idleAfter: 5 * 60 * 1000, // Evict after 5 minutes
    sweepInterval: 60 * 1000, // Check every minute
  },
});
```

Entities rehydrate transparently when accessed again.

## Metrics

Hook into entity lifecycle events:

```typescript
const manager = create({
  definition: MyEntity,
  metrics: {
    onHydrate: (id) => console.log(`${id} hydrated`),
    onEvict: (id) => console.log(`${id} evicted`),
    onError: (id, error) => console.error(`${id} failed:`, error),
    onSnapshot: (id, version) => console.log(`${id} snapshot at v${version}`),
    onAfterCommit: (id, version, patch) => {
      /* ... */
    },
    onBeforeSnapshot: (id, version) => {
      /* ... */
    },
    onHydrateFallback: (id, reason) => {
      /* ... */
    },
  },
});
```

## Built-in Serialization

Cue uses SuperJSON under the hood, so `Date`, `Map`, `Set`, `BigInt`, and `RegExp` values survive serialization automatically.

## How It Works

Under the hood, Cue uses **event sourcing**. Every state change is recorded as a patch. Entities rebuild from their history on load, with periodic snapshots for efficiency.

But you don't need to think about events. Write mutations directly—Cue captures them automatically via Immer.

## On Persistence Complexity

Cue doesn't force a specific persistence provider. You implement `PersistenceAdapter` for whatever database you have. This flexibility adds some decision-making, but most applications won't need anything complicated.

**PostgreSQL handles more than you think:**

| Workload | PostgreSQL (single instance) |
| -------- | ---------------------------- |
| < 500 events/sec | Comfortable, no tuning needed |
| 500 - 2,000 events/sec | Add connection pooling |
| 2,000 - 5,000 events/sec | Tune indexes, batch writes, consider read replicas |
| > 5,000 events/sec | Time to think about Redis or sharding |

These are rough estimates for a typical cloud database. Your mileage varies with hardware, event size, and query patterns.

**Redis is powerful but often unnecessary.** Redis Streams map beautifully to Cue's event model - fast writes, blocking reads for live streaming, built-in consumer groups. But remember: Cue already keeps hot entities in memory. The EntityManager holds active entities, passivation evicts idle ones. Your database only sees hydration reads and event writes, not every state access.

For most applications - even busy ones - PostgreSQL with snapshotting enabled is plenty. Add Redis when you have evidence you need it, not before.

## API Reference

### `define(name)`

Creates a new entity definition builder.

```typescript
const Entity = define("Entity")
  .initialState(() => ({ ... }))
  .commands({ ... })
  .queries({ ... })
  .evolve((prev) => ({ ... }))
  .persistence({ snapshotEvery: 100 })
  .build();
```

### `create(config)`

Creates an entity manager.

```typescript
const manager = create({
  definition: Entity,        // Required: entity definition
  store: new memoryStore(),  // Optional: persistence adapter
  supervisor: mySupervisor,  // Optional: error handling
  passivation: { ... },      // Optional: idle eviction
  metrics: { ... },          // Optional: lifecycle hooks
});
```

### `EntityRef`

```typescript
const ref = manager.get("id");

ref.send.command(...args); // Execute command, returns Promise
ref.read.query(...args); // Execute query, returns Promise
ref.stream.command(...args); // Returns StreamRun<T> with .id, .seq, .isLive
ref.snapshot(); // Returns Promise<{ state, version }>
ref.stateAt(eventVersion); // Returns Promise<{ schemaVersion, state }>
ref.stop(); // Stop and release this entity
```

### `EntityManager`

```typescript
manager.get("id"); // Get or create entity reference
manager.readStream(streamId, { after? }); // Read durable stream by ID
manager.streamStatus(streamId); // Get stream state without consuming
manager.stop(); // Shut down all entities
```

### Type Utilities

```typescript
import { HistoryOf, VersionState, StateOf, StreamRun, StreamStatus } from "@twoabove/cue";

type History = HistoryOf<typeof Entity>; // Discriminated union of all versions
type V2State = VersionState<typeof Entity, 2>; // State type at schema version 2
type Current = StateOf<typeof Entity>; // Current state type
```

## License

MIT License
