import { describe, expect, it } from "vitest";
import { CommitError } from "@/errors";
import { InMemoryPersistenceAdapter } from "@/persistence/adapters/inMemory";

describe("InMemoryPersistenceAdapter", () => {
  it("enforces optimistic versioning", async () => {
    const store = new InMemoryPersistenceAdapter();
    const id = "x";
    // First commit at version 1
    await store.commitEvent(id, 1n, "{}");
    // Second commit must be version 2; using 1 should error
    await expect(store.commitEvent(id, 1n, "{}")).rejects.toBeInstanceOf(
      CommitError,
    );
  });

  it("preserves events after snapshotting", async () => {
    const store = new InMemoryPersistenceAdapter();
    const id = "y";
    await store.commitEvent(id, 1n, "{}");
    await store.commitEvent(id, 2n, "{}");
    await store.commitSnapshot(id, 2n, '{"snap":true}');
    const events = await store.getEvents(id, 0n);
    // events are preserved for temporal queries
    expect(events.length).toBe(2);
  });
});
