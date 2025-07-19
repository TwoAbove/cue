# Cue 🎬

A simple and robust actor framework for building stateful applications in TypeScript.

Tired of state management turning into a chaotic drama? **Cue** is your application's poised **director**, bringing order and comfort to the stage. It orchestrates your application's state into standalone, persistent, and fault-tolerant **actors** that communicate through well-defined **messages**.

## Why Choose Cue?

Cue is a TypeScript actor framework that keeps your state tidy, your code short, and your runtime honest.

- **Durable state, minimal code**
  Immer gives you mutable-style updates that compile to immutable changes. You write `state.hp -= 10`; Cue stores the event, replays it, snapshots it, and keeps it consistent.
- **Opinionated, not rigid**
  A fluent builder guides you through commands, queries, and state evolution. You get type safety and almost no boilerplate.
- **Fault handling, not fault hiding**
  Declare how each actor should react to errors (`resume`, `reset`, or `stop`). Failures roll back automatically; your business logic stays clean.
- **Plug-and-play persistence**
  Implement one small interface (`PersistenceAdapter`) and swap Postgres, Redis, SQLite, or your own store without touching actor code.
- **Schema changes without downtime**
  Add `.evolveTo()` functions to migrate old state shapes in place. No scripts, no downtime, no data loss, with type safety.
- **Idle actors go to sleep**
  Passivation evicts unused actors and reloads them on demand, so memory use stays predictable.
- **Built-in superjson**
  `Date`, `Map`, `Set`, `BigInt`, and `RegExp` values survive serialization out of the box.
- **Streaming commands**
  Async generators let you `yield` progress updates to callers in real time.

## Installation

```bash
npm install <pending>
```

## A Five-Minute Introduction

Let's write a simple play starring a `Character` actor.

```typescript
// 1. Define the actor's script
import { createActorManager, defineActor } from "cue";

const Character = defineActor("Character")
  .initialState(() => ({
    level: 1,
    hp: 100,
    quests: new Set<string>(),
  }))
  .commands({
    // A simple, synchronous command
    takeDamage: (state, amount: number) => {
      // `state` is a mutable draft powered by Immer
      state.hp -= amount;
      if (state.hp <= 0) {
        state.hp = 0;
        return "You have been defeated!";
      }
      return `Ouch! HP is now ${state.hp}.`;
    },
    // An async command
    levelUp: async (state) => {
      // Simulate some async work
      await new Promise((res) => setTimeout(res, 50));
      state.level++;
      state.hp += 10;
      return `Ding! Reached level ${state.level}!`;
    },
    // A streaming command using an async generator
    startQuest: async function* (state, quest: string) {
      if (state.quests.has(quest)) {
        yield { status: "already_on_quest" };
        return "Quest already started.";
      }
      state.quests.add(quest);
      yield { status: "started", quest };
      // Simulate a long journey
      await new Promise((res) => setTimeout(res, 100));
      yield { status: "completed", quest };
      state.quests.delete(quest);
      return "Quest complete!";
    },
  })
  .queries({
    // A read-only query for safe state access
    getStats: (state) => ({
      level: state.level,
      hp: state.hp,
    }),
  })
  .build();

// 2. Create an actor manager
const manager = createActorManager({ definition: Character });

// 3. Get a reference to a specific actor by its unique ID
const playerOne = manager.get("player-one");

// 4. Send messages to the actor!
// 'tell' executes a command. It returns a promise with the command's result.
const damageResult = await playerOne.tell.takeDamage(10);
console.log(damageResult); // "Ouch! HP is now 90."

const levelUpMessage = await playerOne.tell.levelUp();
console.log(levelUpMessage); // "Ding! Reached level 2!"

// 'ask' executes a query for read-only access.
const stats = await playerOne.ask.getStats();
console.log(stats); // { level: 2, hp: 110 }

// 'stream' lets you iterate over progress from a streaming command.
console.log("Starting a new quest...");
const questStream = playerOne.stream.startQuest("The Lost Amulet");
for await (const update of questStream) {
  console.log(`Quest update: ${update.status}`);
}
// > Quest update: started
// > Quest update: completed

// 'inspect' gives a direct snapshot of the actor's current state and version.
const snapshot = await playerOne.inspect();
console.log(snapshot.state.quests); // Set(0) {}

// Don't forget to shut down the manager when your app closes!
await manager.terminate();
```

---

## Key Concepts

### The Script (`defineActor`)

The **script** is the blueprint for your actors, created with a fluent, builder-style API.

- `.initialState(() => ({...}))`: Sets the default state for new actors.
- `.commands({...})`: Defines methods that can alter state. These can be synchronous, async, or async generators (for streaming).
- `.queries({...})`: Defines read-only methods for safe, consistent state access.
- `.evolveTo((prevState) => ({...}))`: Defines a migration function to upgrade an actor's state from an older schema to a newer one.
- `.persistence({...})`: Configures persistence behavior like snapshotting.
- `.build()`: Finalizes the definition, making it ready to use.

### The Director (`createActorManager`)

The **director** is the central organizer for all actor instances of a given definition. Its primary job is to instantiate, retrieve, and manage the lifecycle of actors. You create one with `createActorManager` and get actor references from it via `manager.get("some-unique-id")`.

### The Performer (`ActorRef`)

The **performer** is your handle for interacting with a specific actor instance. It provides several clear "verbs" to communicate:

- `tell`: Execute a command that may modify state. If the command is a stream, `tell` drains it completely and returns only the final `return` value.
- `ask`: Execute a query to read state safely and consistently, without causing side effects.
- `stream`: Get an `AsyncIterable` from a streaming command to process `yield`ed progress updates.
- `inspect`: Instantly get a snapshot of the actor's current state and version for debugging.
- `terminate`: Manually shut down and release the actor from memory, making the reference unusable. Alternatively, let the manager handle it automatically with passivation.

## Advanced Features

### Persistence: An Actor Never Forgets

Cue offers persistence. By providing an object that implements the `PersistenceAdapter` interface, every state change is saved. When an actor is needed, it's rehydrated from its history, ensuring no data is ever lost.

To enable persistence, simply provide a `store` during manager creation.

```typescript
import { createActorManager } from "cue";
import type { PersistenceAdapter } from "cue";
import { myActorDef } from "./my-actor-def.js";

// Create a simple Postgres adapter. The PersistenceAdapter interface
// makes it easy to plug in any data store.
class MyPostgresAdapter implements PersistenceAdapter {
  constructor(private pool: any) {}

  async getEvents(
    actorId: string,
    fromVersion: bigint
  ): Promise<{ version: bigint; data: string; meta: string }[]> {
    const result = await this.pool.query(
      `
      SELECT version, event_data, meta_data
      FROM actor_events
      WHERE actor_id = $1 AND version > $2
      ORDER BY version ASC
    `,
      [actorId, fromVersion.toString()]
    );

    return result.rows.map((row) => ({
      version: BigInt(row.version),
      data: row.event_data,
      meta: row.meta_data,
    }));
  }

  async commitEvent(
    actorId: string,
    version: bigint,
    data: string,
    meta: string
  ): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO actor_events (actor_id, version, event_data, meta_data, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `,
      [actorId, version.toString(), data, meta]
    );
  }

  async getLatestSnapshot(
    actorId: string
  ): Promise<{ version: bigint; data: string } | null> {
    const result = await this.pool.query(
      `
      SELECT version, snapshot_data
      FROM actor_snapshots
      WHERE actor_id = $1
      ORDER BY version DESC
      LIMIT 1
    `,
      [actorId]
    );

    return result.rows[0]
      ? {
          version: BigInt(result.rows[0].version),
          data: result.rows[0].snapshot_data,
        }
      : null;
  }

  async commitSnapshot(
    actorId: string,
    version: bigint,
    data: string
  ): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO actor_snapshots (actor_id, version, snapshot_data, created_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (actor_id, version) DO UPDATE SET
        snapshot_data = EXCLUDED.snapshot_data,
        created_at = EXCLUDED.created_at
    `,
      [actorId, version.toString(), data]
    );
  }

  // Optional: Locking for distributed systems
  async acquire(
    actorId: string,
    ownerId: string,
    ttlMs: number
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
      INSERT INTO actor_locks (actor_id, owner, expires_at)
      VALUES ($1, $2, NOW() + INTERVAL '${ttlMs} milliseconds')
      ON CONFLICT (actor_id) DO UPDATE SET
        owner = EXCLUDED.owner,
        expires_at = EXCLUDED.expires_at
      WHERE actor_locks.expires_at < NOW() OR actor_locks.owner = EXCLUDED.owner
      RETURNING owner
    `,
      [actorId, ownerId]
    );

    return result.rows.length > 0;
  }

  async release(actorId: string, ownerId: string): Promise<void> {
    await this.pool.query(
      `
      DELETE FROM actor_locks WHERE actor_id = $1 AND owner = $2
    `,
      [actorId, ownerId]
    );
  }

  async clearActor(actorId: string): Promise<void> {
    // This should ideally be performed in a single database transaction.
    await this.pool.query("DELETE FROM actor_events WHERE actor_id = $1", [
      actorId,
    ]);
    await this.pool.query("DELETE FROM actor_snapshots WHERE actor_id = $1", [
      actorId,
    ]);
  }
}

const manager = createActorManager({
  definition: myActorDef,
  store: new MyPostgresAdapter(pool),
});
```

The database schema is equally simple:

```sql
-- Events table: stores all state changes as pre-serialized strings
CREATE TABLE actor_events (
  actor_id TEXT NOT NULL,
  version BIGINT NOT NULL,
  event_data TEXT NOT NULL,
  meta_data TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (actor_id, version)
);

-- Snapshots table: stores periodic state snapshots for faster loading
CREATE TABLE actor_snapshots (
  actor_id TEXT NOT NULL,
  version BIGINT NOT NULL,
  snapshot_data TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (actor_id, version)
);

-- Locks table: for distributed systems (optional, this can also be managed by something like Redis)
CREATE TABLE actor_locks (
  actor_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL
);
```

To prevent performance degradation from replaying long event histories, you can enable snapshotting. Cue will periodically save a full snapshot of an actor's state.

```typescript
defineActor("MyActor")
  //...
  .persistence({
    snapshotEvery: 100, // Create a state snapshot every 100 versions
  })
  .build();
```

### State Evolution: Your Schema's Second Act

As your application evolves, so will its state. Cue makes changing your actor's state schema easy with built-in support for upcasting.

Simply chain `.evolveTo()` calls in your actor definition. When an actor with an older state version is hydrated, Cue will automatically run your upcaster functions in order, migrating the state to the latest schema.

```typescript
// V1 of our Character actor
const Character = defineActor("Character").initialState(() => ({
  name: "Player",
  hitPoints: 100,
}));

// Let's say we saved some actors with the V1 schema. Now, we need to change it.

// V2 introduces a structured 'health' property
const Character = defineActor("Character")
  .initialState(() => ({
    // The V1 initial state is the starting point, just like before
    name: "Player",
    hitPoints: 100,
  }))
  // Evolve from the V1 state shape to the V2 shape
  .evolveTo((v1State) => ({
    name: v1State.name,
    health: {
      current: v1State.hitPoints,
      max: 100,
    },
    mana: 50, // We can also add new fields
  }))
  .commands({
    takeDamage: (state, amount: number) => {
      // Logic now uses the new state.health property
      state.health.current -= amount;
      state.hitPoints; // Type error: 'hitPoints' no longer exists
    },
  })
  .build();

// When manager.get("some-old-v1-actor-id") is called with the CharacterV2 definition,
// its state will be automatically migrated. No manual scripts needed!
```

### Supervision: Fault Tolerance

What happens when an error occurs in the middle of a state update? In many systems, this can leave your application in a corrupt, unpredictable state. Cue solves this with a two-layered approach to fault tolerance:

1. **Transactional Updates:** When a command fails, all its attempted state changes are automatically rolled back. Your actor's state remains untouched and consistent, just as it was before the command ran. This eliminates a whole class of bugs related to partial updates.

2. **Centralized Supervision:** With state consistency guaranteed, a **supervisor** decides the actor's fate. This decouples your business logic from your error recovery policy, letting you define clear, declarative strategies for different types of failures.

A supervisor can choose one of three strategies, each suited for a different class of error:

- **`resume`**: The actor's state is preserved, and the error is passed to the original caller.

  - **When to use it:** For transient or input-related errors. The actor's internal state is still valid, but the specific operation failed. The actor is healthy and ready for the next message.
  - **Example:** A `ValidationError` is thrown because a user tried to withdraw a negative amount from a bank account actor. The account's state is fine; the request was simply invalid.

- **`stop`**: The actor is terminated and will reject all future messages. The `ActorRef` becomes unusable.

  - **When to use it:** For catastrophic, unrecoverable errors where even restarting is not a solution. This is for when the environment or configuration for an actor is broken.
  - **Example:** An actor that relies on a specific API key fails because the key is missing or invalid. Restarting won't help, as the fundamental configuration is broken. Stopping the actor prevents it from running in a useless, error-prone state.

- **`reset`**: The actor's state is reset to its initial value, as if it were brand new. The caller receives a `ResetError`.

  - **Important!** If you are using a persistence store, this reset is also persisted. It effectively **wipes the actor's history and starts from a clean slate.** This is a powerful but destructive action that should be used only if something went **_really_** wrong. It's accomplished by calling the `clearActor` method on your `PersistenceAdapter`.
  - **When to use it:** When an actor's state is so corrupt that it's safer to start over entirely than to attempt recovery. It's the hard reset for a specific actor, used when you're willing to discard its accumulated data.
  - **Example:** A ShoppingCart actor fails during checkout because a bug has allowed an invalid item ID to be added to its state. Attempting to process the order throws an `InvalidCartStateError`. Instead of leaving the user with a broken cart they can't empty or check out, the supervisor's `reset` strategy clears the cart, allowing the user to start again. **The loss of cart data is preferable to a permanent error state.**

```typescript
import type { Supervisor } from "cue";

const mySupervisor: Supervisor = {
  strategy: (state, error) => {
    console.error(`Actor failed with state:`, state, `and error:`, error);
    if (error.name === "ValidationError") {
      // The operation was invalid, but the actor is fine.
      return "resume";
    }
    if (error.name === "CatastrophicConfigError") {
      // The actor cannot function.
      return "stop";
    }
    // For any other unexpected error, assume state may be corrupt.
    // WARNING: This will discard the actor's persisted data if a store is used.
    return "reset";
  },
};

const manager = createActorManager({
  definition: myActorDef,
  supervisor: mySupervisor,
});
```

#### How Do You Recover from a `stop`?

The `stop` strategy marks an actor instance as permanently failed, causing it to reject all subsequent messages sent to that specific `ActorRef`.

Recovery is a two-step process that happens outside the actor itself:

1. **Fix the Root Cause:** A `stop` implies a fundamental problem (e.g., a bug, invalid configuration, or an external service being down). This must be resolved externally. You might need to deploy new code, update environment variables, or restore a database connection.

2. **Get a New Actor Reference:** Once the underlying problem is fixed, you can obtain a new, valid actor reference by simply calling `manager.get("some-stopped-actor-id")` again. You don't need to restart your application. The `ActorManager` detects that the previous instance for this ID has failed and automatically creates a _new_ actor instance for you. This new instance will then rehydrate its state from the persistence store, and since you've fixed the root cause, it should run successfully.

Here's an example:

```typescript
const actorRef = manager.get("critical-actor");

try {
  await actorRef.tell.performCriticalTask();
} catch (error) {
  // Assume our supervisor has chosen 'stop' for this error
  console.error(
    "Actor 'critical-actor' was stopped. Fix the root cause before retrying."
  );
  // At this point, you would typically alert your monitoring system.
  // The 'actorRef' is now permanently failed.
}

// Later, after you've fixed the problem (e.g., deployed new code)

// You don't need a new manager. Just get a new reference for the same ID.
// The manager will create a new underlying actor instance automatically.
const newActorRef = manager.get("critical-actor");
// This will now succeed!
await newActorRef.tell.performCriticalTask();
```

### Passivation: Automatic Resource Management

To save memory, you can configure the manager to **passivate** (i.e., automatically shut down and evict) actors that have been idle for a certain period. When a message is next sent to the passivated actor, Cue will rehydrate it from your persistence store. Before an actor is passivated, Cue will also attempt to take a final snapshot of its state (if snapshotting is configured) to ensure efficient rehydration later.

_Note: A `store` is required for passivation to be useful._

```typescript
const manager = createActorManager({
  definition: myActorDef,
  store: myPersistenceAdapter,
  passivation: {
    idleAfter: 5 * 60 * 1000, // Evict after 5 minutes of inactivity
    sweepInterval: 60 * 1000, // Check for idle actors every minute (default)
  },
});
```

### Metrics: Observability

Gain insight into your actors' lifecycle by providing a `metrics` object with callback hooks. This is perfect for integrating with your favorite logging or monitoring service.

```typescript
import type { ActorMetrics, Patch } from "cue";

const myMetrics: ActorMetrics = {
  onHydrate: (id) => console.log(`[Metrics] Actor ${id} was hydrated.`),
  onEvict: (id) => console.log(`[Metrics] Actor ${id} was passivated.`),
  onError: (id, error) => console.error(`[Metrics] Actor ${id} failed:`, error),
  onBeforeSnapshot: (id, version) =>
    console.log(
      `[Metrics] Actor ${id} is about to create snapshot at version ${version}.`
    ),
  onSnapshot: (id, version) =>
    console.log(
      `[Metrics] Actor ${id} created snapshot at version ${version}.`
    ),
  onAfterCommit: (id, version, patch) => {
    console.log(
      `[Metrics] Actor ${id} committed version ${version} with ${patch.length} changes.`
    );
  },
};

const manager = createActorManager({
  definition: myActorDef,
  metrics: myMetrics,
});
```

<!--
### Performance and Benchmarking
If we actually need this, we'll add the section here.
Title Pun ideas: Backstage metrics, Spotlight on throughout, Director's cut.
-->

## License

MIT License © 2025 Seva Maltsev
