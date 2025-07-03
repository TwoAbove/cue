# Cue 🎬

A simple and robust actor framework for building stateful applications in TypeScript.

Tired of state management turning into a chaotic drama? **Cue** is your application's poised director, bringing order and comfort to the stage. It orchestrates your application's state into standalone, persistent, and fault-tolerant actors that communicate through well-defined messages.

## Why Choose Cue?

- **Effortless State, Seriously.** Powered by Immer, state updates are as simple and safe as direct mutation. Cue handles the complex plumbing, so you don't have to.
- **Actor Model Made Easy.** Each actor has a private mailbox, processing commands sequentially. This ensures a clear, single-threaded, and replayable flow without manual locking.
- **Fault-Tolerant by Design.** Gracefully handle errors with declarative supervision strategies (`resume`, `restart`, `stop`) without cluttering your business logic.
- **Full Type-Safety Out of the Box.** Enjoy TypeScript's powerful type hints and error checking. Commands, queries, and their payloads have clear, reliable type boundaries.
- **Robust Pluggable Persistence.** Actors can remember their state, gracefully surviving restarts. With a simple `PatchStore` interface, you can plug in any database you need.
- **Seamless State Evolution.** Your application will change, and so will your state. Cue's upcasting mechanism lets you evolve actor state schemas over time with simple, pure functions—no complex data migrations required.
- **Automatic Resource Management.** Built-in passivation automatically frees up memory for idle actors, keeping your application lean and scalable.
- **Smart Serialization.** Automatically serialize and deserialize complex types like `Date`, `Map`, `Set`, `BigInt`, and `RegExp` right out of the box, powered by SuperJSON.
- **Expressive Streaming APIs.** Easily handle long-running tasks and communicate real-time progress to callers through convenient streaming commands.

## Installation

```bash
npm install cue
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
await manager.shutdown();
```

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
- `shutdown`: Manually shut down and release the actor from memory. Alternatively, let the manager handle it automatically with passivation.

## Advanced Features

### Persistence: An Actor Never Forgets

Cue offers first-class persistence. By providing an object that implements the `PatchStore` interface, every state change is saved. When an actor is needed, it's rehydrated from its history, ensuring no data is ever lost.

To enable persistence, simply provide a `store` during manager creation.

```typescript
import { createActorManager } from "cue";
import type { PatchStore } from "cue";
import { myActorDef } from "./my-actor-def.js";

// You can implement the PatchStore interface for any database (e.g., Postgres, Redis, etc.)
class MyPostgresAdapter implements PatchStore {
  // ... implementation for commit, load, commitSnapshot, acquire, release, etc.
}

const manager = createActorManager({
  definition: myActorDef,
  store: new MyPostgresAdapter(process.env.DATABASE_URL),
});
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

As your application evolves, so will its state. Cue makes changing your actor's state schema a non-event with built-in support for upcasting.

Simply chain `.evolveTo()` calls in your actor definition. When an actor with an older state version is hydrated, Cue will automatically run your upcaster functions in order, seamlessly migrating the state to the latest schema.

```typescript
// V1 of our Character actor
const CharacterV1 = defineActor("Character").initialState(() => ({
  name: "Player",
  hitPoints: 100,
}));

// Let's say we saved some actors with the V1 schema. Now, we need to change it.

// V2 introduces a structured 'health' property
const CharacterV2 = defineActor("Character")
  .initialState(() => ({
    // The V1 initial state is the starting point
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
    },
  })
  .build();

// When manager.get("some-old-v1-actor-id") is called with the CharacterV2 definition,
// its state will be automatically migrated. No manual scripts needed!
```

### Supervision: Fault Tolerance

Actors can fail. The **supervisor** lets you define a clear, declarative strategy for handling errors without littering your business logic with try/catch blocks.

- **`resume`**: Ignores the error, keeping the actor's state as it was. The caller receives the error.
- **`restart`**: Resets the actor to its initial state and continues. The caller receives a `RestartedError`.
- **`stop`**: Shuts down the actor. It will enter a "failed" state and reject all future messages.

```typescript
import type { Supervisor } from "cue";

const mySupervisor: Supervisor = {
  strategy: (state, error) => {
    console.error(`Actor failed with state:`, state, `and error:`, error);
    if (error.name === "ValidationError") {
      return "resume"; // Ignore validation errors, but let caller know
    }
    return "restart"; // Restart on any other error
  },
};

const manager = createActorManager({
  definition: myActorDef,
  supervisor: mySupervisor,
});
```

### Passivation: Automatic Resource Management

To save memory, you can configure the manager to **passivate** (i.e., automatically shut down and evict) actors that have been idle for a certain period. When a message is next sent to the passivated actor, Cue will seamlessly rehydrate it from your persistence store.

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

## License

MIT License © 2025 Seva Maltsev
