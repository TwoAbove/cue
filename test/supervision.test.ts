import { describe, expect, it, vi } from "vitest";
import type { Supervisor } from "../src/contracts";
import { createActorManager, defineActor, ResetError } from "../src/index";
import { inMemoryPersistenceAdapter } from "../src/store/inMemory";

const errorToThrow = new Error("Test Error");
const supervisorDef = defineActor("SupervisorTest")
  .initialState(() => ({ count: 0 }))
  .commands({
    inc: (s) => {
      s.count++;
      return s.count;
    },
    fail: () => {
      throw errorToThrow;
    },
  })
  .build();

describe("Supervision Strategies", () => {
  it("should 'resume' execution, preserving state but throwing to the caller", async () => {
    const supervisor: Supervisor = {
      strategy: vi.fn().mockReturnValue("resume"),
    };
    const manager = createActorManager({
      definition: supervisorDef,
      supervisor,
    });
    const actor = manager.get("resume-actor");
    await actor.tell.inc();

    await expect(actor.tell.fail()).rejects.toThrow(errorToThrow);
    expect(supervisor.strategy).toHaveBeenCalledWith(
      { count: 1 },
      errorToThrow,
    );

    const { state } = await actor.inspect();
    expect(state.count).toBe(1);
    await expect(actor.tell.inc()).resolves.toBe(2);
    expect((await actor.inspect()).state.count).toBe(2);

    await manager.terminate();
  });

  it("should 'stop' the actor, making it reject all subsequent messages", async () => {
    const supervisor: Supervisor = {
      strategy: vi.fn().mockReturnValue("stop"),
    };
    const manager = createActorManager({
      definition: supervisorDef,
      supervisor,
    });
    const actor = manager.get("stop-actor");

    await expect(actor.tell.fail()).rejects.toThrow(errorToThrow);

    await expect(actor.tell.inc()).rejects.toThrow(
      "Actor stop-actor is failed. Further messages are rejected.",
    );

    const newActorRef = manager.get("stop-actor");
    await expect(newActorRef.tell.inc()).resolves.toBe(1);
    expect((await newActorRef.inspect()).state.count).toBe(1);

    await manager.terminate();
  });

  describe("'reset' Strategy", () => {
    it("should 'reset' the actor's state to its initial value", async () => {
      const supervisor: Supervisor = {
        strategy: vi.fn().mockReturnValue("reset"),
      };
      const manager = createActorManager({
        definition: supervisorDef,
        supervisor,
      });
      const actor = manager.get("reset-actor");
      await actor.tell.inc();
      expect((await actor.inspect()).state.count).toBe(1);

      await expect(actor.tell.fail()).rejects.toThrow(ResetError);
      await expect(actor.tell.fail()).rejects.toThrow(
        "Actor reset after error: Test Error",
      );

      const { state } = await actor.inspect();
      expect(state.count).toBe(0);

      await manager.terminate();
    });

    it("should persist the reset, clearing prior events and snapshots", async () => {
      const store = inMemoryPersistenceAdapter();
      const supervisor: Supervisor = { strategy: () => "reset" };
      const manager = createActorManager({
        definition: supervisorDef,
        supervisor,
        store,
      });
      const actor = manager.get("reset-persist-actor");

      await actor.tell.inc();
      await actor.tell.inc();
      expect((await actor.inspect()).version).toBe(2n);

      await expect(actor.tell.fail()).rejects.toThrow(ResetError);

      const { state, version } = await actor.inspect();
      expect(state.count).toBe(0);
      expect(version).toBe(0n);

      await expect(actor.tell.inc()).resolves.toBe(1);
      expect((await actor.inspect()).state.count).toBe(1);
      expect((await actor.inspect()).version).toBe(1n);

      await manager.terminate();

      const manager2 = createActorManager({ definition: supervisorDef, store });
      const rehydratedActor = manager2.get("reset-persist-actor");
      const finalState = await rehydratedActor.inspect();
      expect(finalState.state.count).toBe(1);
      expect(finalState.version).toBe(1n);

      await manager2.terminate();
    });
  });
});
