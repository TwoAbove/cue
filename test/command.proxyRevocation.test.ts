/**
 * Commands can return references to draft state objects. These must remain usable
 * after the command completes, not throw "proxy revoked" errors during serialization
 * or when the caller accesses properties.
 */
import { describe, expect, it } from "vitest";
import { create, define, InMemoryPersistenceAdapter } from "../src";

interface Item {
  id: string;
  name: string;
  properties: Record<string, unknown>;
  updatedAt: Date;
}

interface TestState {
  items: Array<[string, Item]>;
}

const TestEntityWithBug = define("TestEntityWithBug")
  .initialState(
    (): TestState => ({
      items: [],
    }),
  )
  .commands({
    createItem: (state, payload: { id: string; name: string }) => {
      const items = new Map(state.items);
      const item: Item = {
        id: payload.id,
        name: payload.name,
        properties: {},
        updatedAt: new Date(),
      };
      items.set(payload.id, item);
      state.items = Array.from(items.entries());
      return { success: true, item };
    },

    updateItemBuggy: (state, payload: { id: string; name: string }) => {
      const items = new Map(state.items);
      const item = items.get(payload.id);
      if (!item) {
        return { error: "Item not found" };
      }
      item.name = payload.name;
      item.updatedAt = new Date();
      state.items = Array.from(items.entries());
      return { success: true, item };
    },

    updateItemFixed: (state, payload: { id: string; name: string }) => {
      const items = new Map(state.items);
      const item = items.get(payload.id);
      if (!item) {
        return { error: "Item not found" };
      }
      item.name = payload.name;
      item.updatedAt = new Date();
      state.items = Array.from(items.entries());
      return {
        success: true,
        item: {
          id: item.id,
          name: item.name,
          properties: { ...item.properties },
          updatedAt: item.updatedAt,
        },
      };
    },
  })
  .persistence({ snapshotEvery: 5 })
  .build();

describe("Command return value proxy revocation bug", () => {
  it("should succeed when returning draft reference from updateItem (demonstrates fix)", async () => {
    const manager = create({
      definition: TestEntityWithBug,
      store: new InMemoryPersistenceAdapter(),
    });

    const entity = manager.get("test-1");

    await entity.send.createItem({ id: "item-1", name: "First" });
    await entity.send.createItem({ id: "item-2", name: "Second" });
    await entity.send.createItem({ id: "item-3", name: "Third" });
    await entity.send.createItem({ id: "item-4", name: "Fourth" });
    await entity.send.createItem({ id: "item-5", name: "Fifth" });

    const result = await entity.send.updateItemBuggy({
      id: "item-1",
      name: "Updated",
    });

    expect(result).toEqual({
      success: true,
      item: expect.objectContaining({
        id: "item-1",
        name: "Updated",
      }),
    });

    await manager.stop();
  });

  it("should succeed when returning cloned entity from updateItem", async () => {
    const manager = create({
      definition: TestEntityWithBug,
      store: new InMemoryPersistenceAdapter(),
    });

    const entity = manager.get("test-2");

    await entity.send.createItem({ id: "item-1", name: "First" });
    await entity.send.createItem({ id: "item-2", name: "Second" });
    await entity.send.createItem({ id: "item-3", name: "Third" });
    await entity.send.createItem({ id: "item-4", name: "Fourth" });
    await entity.send.createItem({ id: "item-5", name: "Fifth" });

    const result = await entity.send.updateItemFixed({
      id: "item-1",
      name: "Updated",
    });

    expect(result).toEqual({
      success: true,
      item: expect.objectContaining({
        id: "item-1",
        name: "Updated",
      }),
    });

    await manager.stop();
  });

  it("should allow accessing returned item properties without throwing", async () => {
    const manager = create({
      definition: TestEntityWithBug,
    });

    const entity = manager.get("test-3");

    await entity.send.createItem({ id: "item-1", name: "First" });

    const result = await entity.send.updateItemBuggy({
      id: "item-1",
      name: "Updated",
    });

    expect(result.success).toBe(true);
    expect(result.item).toBeDefined();
    expect(result.item!.name).toBe("Updated");
    expect(result.item!.id).toBe("item-1");

    await manager.stop();
  });
});
