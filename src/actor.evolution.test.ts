import { enableMapSet } from "immer";
import { beforeEach, describe, expect, it } from "vitest";
import { createActorManager, defineActor } from "./index.js";
import { inMemoryStore } from "./store/inMemory.js";

enableMapSet();

describe("Actor State Evolution", () => {
  let store: ReturnType<typeof inMemoryStore>;

  beforeEach(() => {
    store = inMemoryStore();
  });

  it("should handle state evolution from V1 to V2", async () => {
    // Define V1 actor
    const CharacterV1 = defineActor("Character")
      .initialState(() => ({
        level: 1,
        hp: 100,
        quests: new Set<string>(),
      }))
      .commands({
        levelUp: (state) => {
          state.level += 1;
          state.hp += 10;
        },
        addQuest: (state, questId: string) => {
          state.quests.add(questId);
        },
      })
      .build();

    // Create manager with V1 definition
    const managerV1 = createActorManager({ definition: CharacterV1, store });
    const actorV1 = managerV1.get("hero");

    // Make some changes to populate the store
    await actorV1.tell.levelUp();
    await actorV1.tell.addQuest("dragon-slayer");

    const stateV1 = await actorV1.inspect();
    expect(stateV1.state.level).toBe(2);
    expect(stateV1.state.hp).toBe(110);
    expect(stateV1.state.quests.has("dragon-slayer")).toBe(true);

    await managerV1.shutdown();

    // Define V2 actor with evolved state
    const CharacterV2 = defineActor("Character")
      .initialState(() => ({
        level: 1,
        hp: 100,
        quests: new Set<string>(),
      }))
      .evolveTo((prevState) => ({
        level: prevState.level,
        quests: new Set(prevState.quests), // Reconstruct Set from array
        health: {
          current: prevState.hp,
          max: 100 + (prevState.level - 1) * 10,
        },
      }))
      .commands({
        levelUp: (state) => {
          state.level += 1;
          state.health.max += 10;
        },
        takeDamage: (state, amount: number) => {
          state.health.current -= amount;
        },
        addQuest: (state, questId: string) => {
          state.quests.add(questId);
        },
      })
      .build();

    // Create manager with V2 definition using the same store
    const managerV2 = createActorManager({ definition: CharacterV2, store });
    const actorV2 = managerV2.get("hero");

    // Inspect the migrated state
    const stateV2 = await actorV2.inspect();
    expect(stateV2.state.level).toBe(2);
    expect(stateV2.state.health.current).toBe(110);
    expect(stateV2.state.health.max).toBe(110); // 100 + (2-1) * 10
    expect(stateV2.state.quests.has("dragon-slayer")).toBe(true);

    // Verify V2 commands work
    await actorV2.tell.takeDamage(25);
    const afterDamage = await actorV2.inspect();
    expect(afterDamage.state.health.current).toBe(85);

    await managerV2.shutdown();
  });

  it("should handle multiple state evolutions V1 -> V2 -> V3", async () => {
    // Define V1 actor
    const CharacterV1 = defineActor("Character")
      .initialState(() => ({
        level: 1,
        hp: 100,
        quests: new Set<string>(),
      }))
      .commands({
        levelUp: (state) => {
          state.level += 1;
          state.hp += 10;
        },
      })
      .build();

    // Create initial data
    const managerV1 = createActorManager({ definition: CharacterV1, store });
    const actorV1 = managerV1.get("hero");
    await actorV1.tell.levelUp();
    await actorV1.tell.levelUp();
    await managerV1.shutdown();

    // Define V3 actor with two evolutions
    const CharacterV3 = defineActor("Character")
      .initialState(() => ({
        level: 1,
        hp: 100,
        quests: new Set<string>(),
      }))
      // V1 -> V2: Rename hp to health
      .evolveTo((prevState) => ({
        level: prevState.level,
        quests: prevState.quests,
        health: {
          current: prevState.hp,
          max: 100 + (prevState.level - 1) * 10,
        },
      }))
      // V2 -> V3: Add mana
      .evolveTo((prevState) => ({
        ...prevState,
        mana: { current: 50, max: 50 },
      }))
      .commands({
        castSpell: (state, cost: number) => {
          state.mana.current -= cost;
        },
      })
      .build();

    // Create manager with V3 definition
    const managerV3 = createActorManager({ definition: CharacterV3, store });
    const actorV3 = managerV3.get("hero");

    // Verify the state was migrated through both evolutions
    const stateV3 = await actorV3.inspect();
    expect(stateV3.state.level).toBe(3);
    expect(stateV3.state.health.current).toBe(120);
    expect(stateV3.state.health.max).toBe(120);
    expect(stateV3.state.mana.current).toBe(50);
    expect(stateV3.state.mana.max).toBe(50);

    // Verify V3 commands work
    await actorV3.tell.castSpell(10);
    const afterSpell = await actorV3.inspect();
    expect(afterSpell.state.mana.current).toBe(40);

    await managerV3.shutdown();
  });

  it("should handle state evolution with snapshots", async () => {
    // Define V1 actor with persistence
    const CharacterV1 = defineActor("Character")
      .initialState(() => ({
        level: 1,
        hp: 100,
      }))
      .persistence({ snapshotEvery: 2 })
      .commands({
        levelUp: (state) => {
          state.level += 1;
          state.hp += 10;
        },
      })
      .build();

    // Create initial data and trigger snapshot
    const managerV1 = createActorManager({ definition: CharacterV1, store });
    const actorV1 = managerV1.get("hero");
    await actorV1.tell.levelUp();
    await actorV1.tell.levelUp(); // This should trigger a snapshot
    await managerV1.shutdown();

    // Define V2 actor with evolved state
    const CharacterV2 = defineActor("Character")
      .initialState(() => ({
        level: 1,
        hp: 100,
      }))
      .evolveTo((prevState) => ({
        level: prevState.level,
        health: {
          current: prevState.hp,
          max: prevState.hp,
        },
      }))
      .commands({
        takeDamage: (state, amount: number) => {
          state.health.current -= amount;
        },
      })
      .build();

    // Create manager with V2 definition
    const managerV2 = createActorManager({ definition: CharacterV2, store });
    const actorV2 = managerV2.get("hero");

    // Verify the state was migrated from snapshot
    const stateV2 = await actorV2.inspect();
    expect(stateV2.state.level).toBe(3);
    expect(stateV2.state.health.current).toBe(120);
    expect(stateV2.state.health.max).toBe(120);

    await managerV2.shutdown();
  });

  it("should work with no previous state (fresh actor)", async () => {
    // Define a V2 actor (with evolution) but no previous state exists
    const CharacterV2 = defineActor("Character")
      .initialState(() => ({
        level: 1,
        hp: 100,
      }))
      .evolveTo((prevState) => ({
        level: prevState.level,
        health: {
          current: prevState.hp,
          max: prevState.hp,
        },
      }))
      .commands({
        takeDamage: (state, amount: number) => {
          state.health.current -= amount;
        },
      })
      .build();

    // Create manager with V2 definition
    const manager = createActorManager({ definition: CharacterV2, store });
    const actor = manager.get("new-hero");

    // Verify the state uses the evolved initial state
    const state = await actor.inspect();
    expect(state.state.level).toBe(1);
    expect(state.state.health.current).toBe(100);
    expect(state.state.health.max).toBe(100);

    // Verify commands work
    await actor.tell.takeDamage(25);
    const afterDamage = await actor.inspect();
    expect(afterDamage.state.health.current).toBe(75);

    await manager.shutdown();
  });
});
