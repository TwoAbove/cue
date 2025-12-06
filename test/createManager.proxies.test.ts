import { describe, expect, it } from "vitest";
import { create, define, InMemoryPersistenceAdapter } from "@/api";
import { ManagerShutdownError } from "@/errors";

const Def = define("Mgr")
  .initialState(() => ({ n: 0 }))
  .commands({
    inc: (s) => ++s.n,
  })
  .queries({ get: (s) => s.n })
  .build();

describe("create proxies", () => {
  it("reuses refs while entity is healthy; throws after manager stop", async () => {
    const manager = create({
      definition: Def,
      store: new InMemoryPersistenceAdapter(),
    });
    const ref1 = manager.get("id");
    const ref2 = manager.get("id");
    expect(ref1).toBe(ref2);

    await expect(ref1.send.inc()).resolves.toBe(1);
    await manager.stop();

    await expect(ref1.send.inc()).rejects.toBeInstanceOf(ManagerShutdownError);
    await expect(ref1.read.get()).rejects.toBeInstanceOf(ManagerShutdownError);
    await expect(ref1.snapshot()).rejects.toBeInstanceOf(ManagerShutdownError);
  });
});
