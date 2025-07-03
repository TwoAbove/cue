import { describe, expect, it, vi } from "vitest";
import { createActorManager, defineActor } from "./";
import { inMemoryStore } from "./store/inMemory.js";

const def = defineActor("PersistCheck")
  .initialState(() => ({ n: 0 }))
  .commands({
    inc: (s) => {
      s.n++;
    },
  })
  .build();

describe("contracts-level persistence smoke-test", () => {
  it("persists CREATE + UPDATE", async () => {
    const store = inMemoryStore();
    const commitSpy = vi.spyOn(store, "commit");

    const mgr = createActorManager({ definition: def, store });
    const a = mgr.get("id");
    await a.tell.inc();

    // Should have called commit once: CREATE is implicit at version 0 -> 1
    expect(commitSpy).toHaveBeenCalledTimes(1);

    // Call should be for the inc command (version 0 -> 1)
    expect(commitSpy).toHaveBeenCalledWith(
      "id",
      0n,
      expect.any(Array),
      expect.objectContaining({ handler: "inc" }),
    );

    await mgr.shutdown();
  });
});
