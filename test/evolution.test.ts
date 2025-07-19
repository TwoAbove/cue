import { describe, expect, it } from "vitest";
import { createActorManager, defineActor } from "../src/index";
import { inMemoryPersistenceAdapter } from "../src/store/inMemory";

describe("State Evolution (Upcasting)", () => {
  it("should migrate state from a V1 schema to a V2 schema on hydration", async () => {
    const store = inMemoryPersistenceAdapter();
    const actorId = "evolution-hero-1";

    const CharacterV1 = defineActor("Character")
      .initialState(() => ({
        name: "Player",
        hitPoints: 100,
      }))
      .commands({
        takeDamage: (state, amount: number) => {
          state.hitPoints -= amount;
        },
      })
      .build();

    const managerV1 = createActorManager({ definition: CharacterV1, store });
    const actorV1 = managerV1.get(actorId);
    await actorV1.tell.takeDamage(25);
    await managerV1.terminate();

    const CharacterV2 = defineActor("Character")
      .initialState(() => ({ name: "Player", hitPoints: 100 }))
      .evolveTo((v1State: { name: string; hitPoints: number }) => ({
        name: v1State.name,
        health: { current: v1State.hitPoints, max: 100 },
        mana: { current: 50, max: 50 },
      }))
      .commands({
        takeDamage: (state, amount: number) => {
          state.health.current -= amount;
        },
      })
      .build();

    const managerV2 = createActorManager({ definition: CharacterV2, store });
    const actorV2 = managerV2.get(actorId);
    const { state, version } = await actorV2.inspect();

    expect(version).toBe(1n);
    expect(state.health).toEqual({ current: 75, max: 100 });
    expect(state.mana).toEqual({ current: 50, max: 50 });
    expect("hitPoints" in state).toBe(false);

    await managerV2.terminate();
  });

  it("should chain multiple evolutions in order (V1 -> V2 -> V3)", async () => {
    const store = inMemoryPersistenceAdapter();
    const actorId = "evolution-hero-2";

    const CharacterV1 = defineActor("CharacterMulti")
      .initialState(() => ({ name: "Player", hp: 100 }))
      .commands({
        addHp: (s, a: number) => {
          s.hp += a;
        },
      })
      .build();
    const managerV1 = createActorManager({ definition: CharacterV1, store });
    await managerV1.get(actorId).tell.addHp(20);
    await managerV1.terminate();

    const CharacterV3 = defineActor("CharacterMulti")
      .initialState(() => ({ name: "Player", hp: 100 }))
      .evolveTo((v1: { name: string; hp: number }) => ({
        name: v1.name,
        health: v1.hp,
      }))
      .evolveTo((v2: { name: string; health: number }) => ({
        name: v2.name,
        stats: { hp: v2.health, mp: 50 },
      }))
      .build();

    const managerV3 = createActorManager({ definition: CharacterV3, store });
    const { state } = await managerV3.get(actorId).inspect();

    expect(state.stats).toEqual({ hp: 120, mp: 50 });
    expect("health" in state).toBe(false);

    await managerV3.terminate();
  });

  it("should evolve state from a snapshot", async () => {
    const store = inMemoryPersistenceAdapter();
    const actorId = "evolution-snapshot-hero";

    const CharacterV1 = defineActor("CharacterSnapshot")
      .initialState(() => ({ level: 1, hp: 100 }))
      .persistence({ snapshotEvery: 1 })
      .commands({
        levelUp: (s) => {
          s.level++;
          s.hp += 10;
        },
      })
      .build();

    const managerV1 = createActorManager({ definition: CharacterV1, store });
    await managerV1.get(actorId).tell.levelUp();
    await managerV1.terminate();

    const CharacterV2 = defineActor("CharacterSnapshot")
      .initialState(() => ({ level: 1, hp: 100 }))
      .evolveTo((v1: { level: number; hp: number }) => ({
        level: v1.level,
        health: { current: v1.hp, max: v1.hp },
      }))
      .build();

    const managerV2 = createActorManager({ definition: CharacterV2, store });
    const { state } = await managerV2.get(actorId).inspect();

    expect(state.level).toBe(2);
    expect(state.health).toEqual({ current: 110, max: 110 });

    await managerV2.terminate();
  });

  it("should use the latest initial state for a new actor, not run evolutions", async () => {
    const store = inMemoryPersistenceAdapter();
    const CharacterV2 = defineActor("CharacterNew")
      .initialState(() => ({ name: "Player", hitPoints: 100 }))
      .evolveTo((v1State: { name: string; hitPoints: number }) => ({
        name: v1State.name,
        health: { current: v1State.hitPoints, max: 100 },
      }))
      .build();

    const manager = createActorManager({ definition: CharacterV2, store });
    const actor = manager.get("new-hero");
    const { state } = await actor.inspect();

    expect(state.health).toEqual({ current: 100, max: 100 });
    expect("hitPoints" in state).toBe(false);

    await manager.terminate();
  });
});
