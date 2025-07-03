import { beforeEach, describe, expect, it } from "vitest";
import type { Patch } from "../contracts.js";
import { InMemoryStore } from "./inMemory.js";

describe("InMemoryStore", () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  describe("commit", () => {
    it("should commit first patch with version 1", async () => {
      const patch: Patch = [{ op: "replace", path: "/count", value: 1 }];
      const version = await store.commit("actor1", 0n, patch);

      expect(version).toBe(1n);
    });

    it("should commit subsequent patches with incremented versions", async () => {
      const patch1: Patch = [{ op: "replace", path: "/count", value: 1 }];
      const patch2: Patch = [{ op: "replace", path: "/count", value: 2 }];

      const version1 = await store.commit("actor1", 0n, patch1);
      const version2 = await store.commit("actor1", version1, patch2);

      expect(version1).toBe(1n);
      expect(version2).toBe(2n);
    });

    it("should throw on optimistic lock failure", async () => {
      const patch1: Patch = [{ op: "replace", path: "/count", value: 1 }];
      const patch2: Patch = [{ op: "replace", path: "/count", value: 2 }];

      await store.commit("actor1", 0n, patch1);

      await expect(store.commit("actor1", 0n, patch2)).rejects.toThrow(
        "Optimistic lock failure: expected version 0, got 1",
      );
    });

    it("should handle multiple actors independently", async () => {
      const patch: Patch = [{ op: "replace", path: "/count", value: 1 }];

      const version1 = await store.commit("actor1", 0n, patch);
      const version2 = await store.commit("actor2", 0n, patch);

      expect(version1).toBe(1n);
      expect(version2).toBe(1n);
    });

    it("should reject empty patches", async () => {
      const emptyPatch: Patch = [];

      await expect(store.commit("actor1", 0n, emptyPatch)).rejects.toThrow(
        "Empty patch: cannot commit an empty patch array",
      );
    });
  });

  describe("load", () => {
    it("should return empty result for non-existent actor", async () => {
      const result = await store.load("nonexistent", 0n);

      expect(result).toEqual({
        snapshot: null,
        patches: [],
      });
    });

    it("should return all patches for existing actor", async () => {
      const patch1: Patch = [{ op: "replace", path: "/count", value: 1 }];
      const patch2: Patch = [{ op: "replace", path: "/count", value: 2 }];

      await store.commit("actor1", 0n, patch1);
      await store.commit("actor1", 1n, patch2);

      const result = await store.load("actor1", 0n);

      expect(result.patches).toHaveLength(2);
      expect(result.patches[0]).toEqual({ version: 1n, patch: patch1 });
      expect(result.patches[1]).toEqual({ version: 2n, patch: patch2 });
    });

    it("should filter patches by fromVersion", async () => {
      const patch1: Patch = [{ op: "replace", path: "/count", value: 1 }];
      const patch2: Patch = [{ op: "replace", path: "/count", value: 2 }];
      const patch3: Patch = [{ op: "replace", path: "/count", value: 3 }];

      await store.commit("actor1", 0n, patch1);
      await store.commit("actor1", 1n, patch2);
      await store.commit("actor1", 2n, patch3);

      const result = await store.load("actor1", 1n);

      expect(result.patches).toHaveLength(2);
      expect(result.patches[0]).toEqual({ version: 2n, patch: patch2 });
      expect(result.patches[1]).toEqual({ version: 3n, patch: patch3 });
    });
  });

  describe("acquire/release", () => {
    it("should acquire lock for new actor", async () => {
      const acquired = await store.acquire("actor1", "owner1");
      expect(acquired).toBe(true);
    });

    it("should allow same owner to re-acquire", async () => {
      await store.acquire("actor1", "owner1");
      const reacquired = await store.acquire("actor1", "owner1");
      expect(reacquired).toBe(true);
    });

    it("should refuse lock for different owner", async () => {
      await store.acquire("actor1", "owner1");
      const refused = await store.acquire("actor1", "owner2");
      expect(refused).toBe(false);
    });

    it("should release lock and allow new owner", async () => {
      await store.acquire("actor1", "owner1");
      await store.release("actor1", "owner1");

      const acquired = await store.acquire("actor1", "owner2");
      expect(acquired).toBe(true);
    });

    it("should not release lock for wrong owner", async () => {
      await store.acquire("actor1", "owner1");
      await store.release("actor1", "owner2");

      const refused = await store.acquire("actor1", "owner2");
      expect(refused).toBe(false);
    });
  });

  describe("clear", () => {
    it("should clear all data and locks", async () => {
      const patch: Patch = [{ op: "replace", path: "/count", value: 1 }];

      await store.commit("actor1", 0n, patch);
      await store.acquire("actor1", "owner1");

      store.clear();

      const result = await store.load("actor1", 0n);
      expect(result.patches).toHaveLength(0);

      const acquired = await store.acquire("actor1", "owner2");
      expect(acquired).toBe(true);
    });
  });

  describe("deep-copy isolation", () => {
    it("should isolate loaded state from mutations", async () => {
      const initialState = { count: 0, nested: { value: "test" } };

      // Commit a snapshot
      await store.commitSnapshot("actor1", 1n, {
        schemaVersion: 1,
        state: initialState,
      });

      // Load the state
      const result = await store.load("actor1", 0n);

      // Mutate the loaded state
      if (result.snapshot?.state && typeof result.snapshot.state === "object") {
        const loadedState = result.snapshot.state.state as {
          count: number;
          nested: { value: string };
        };
        loadedState.count = 999;
        loadedState.nested.value = "mutated";
      }

      // Load again and verify original state is preserved
      const result2 = await store.load("actor1", 0n);
      expect(result2.snapshot?.state).toEqual({
        schemaVersion: 1,
        state: {
          count: 0,
          nested: { value: "test" },
        },
      });
    });

    it("should isolate committed snapshot from mutations", async () => {
      const state = { count: 0, nested: { value: "test" } };

      // Commit snapshot
      await store.commitSnapshot("actor1", 1n, {
        schemaVersion: 1,
        state: state,
      });

      // Mutate the original state object
      state.count = 999;
      state.nested.value = "mutated";

      // Load and verify stored state is unchanged
      const result = await store.load("actor1", 0n);
      expect(result.snapshot?.state).toEqual({
        schemaVersion: 1,
        state: {
          count: 0,
          nested: { value: "test" },
        },
      });
    });
  });
});
