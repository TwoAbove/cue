import { describe, expect, it } from "vitest";
import { create, define, InMemoryPersistenceAdapter } from "@/api";

describe("Query return values", () => {
  it("returns usable Map created from state", async () => {
    const Def = define("MapQuery")
      .initialState(() => ({
        items: [
          ["key1", { name: "Item 1" }],
          ["key2", { name: "Item 2" }],
        ] as Array<[string, { name: string }]>,
      }))
      .queries({
        getItemsAsMap: (state) => new Map(state.items),
      })
      .build();

    const manager = create({
      definition: Def,
      store: new InMemoryPersistenceAdapter(),
    });

    const actor = manager.get("test-1");
    const itemsMap = await actor.read.getItemsAsMap();

    for (const [_key, value] of itemsMap.entries()) {
      expect(typeof value.name).toBe("string");
    }
    expect(itemsMap.get("key1")?.name).toBe("Item 1");

    await manager.stop();
  });

  it("returns usable Set created from state", async () => {
    const Def = define("SetQuery")
      .initialState(() => ({
        tags: [
          { id: 1, name: "tag1" },
          { id: 2, name: "tag2" },
        ],
      }))
      .queries({
        getTagsAsSet: (state) => new Set(state.tags),
      })
      .build();

    const manager = create({
      definition: Def,
      store: new InMemoryPersistenceAdapter(),
    });

    const actor = manager.get("test-1");
    const tagsSet = await actor.read.getTagsAsSet();

    const tags = [...tagsSet];
    expect(tags[0].name).toBe("tag1");
    expect(tags[1].name).toBe("tag2");

    await manager.stop();
  });

  it("returns usable nested objects from state", async () => {
    const Def = define("NestedQuery")
      .initialState(() => ({
        data: {
          users: [
            { id: 1, profile: { name: "Alice", email: "alice@example.com" } },
            { id: 2, profile: { name: "Bob", email: "bob@example.com" } },
          ],
        },
      }))
      .queries({
        getUsers: (state) => state.data.users,
      })
      .build();

    const manager = create({
      definition: Def,
      store: new InMemoryPersistenceAdapter(),
    });

    const actor = manager.get("test-1");
    const users = await actor.read.getUsers();

    expect(users[0].profile.email).toBe("alice@example.com");
    expect(users[1].profile.name).toBe("Bob");

    await manager.stop();
  });

  it("returns spreadable objects from state", async () => {
    const Def = define("SpreadQuery")
      .initialState(() => ({
        config: { theme: "dark", language: "en", debug: false },
      }))
      .queries({
        getConfig: (state) => state.config,
      })
      .build();

    const manager = create({
      definition: Def,
      store: new InMemoryPersistenceAdapter(),
    });

    const actor = manager.get("test-1");
    const config = await actor.read.getConfig();

    const copy = { ...config };
    expect(copy.theme).toBe("dark");
    expect(copy.language).toBe("en");

    await manager.stop();
  });

  it("returns data accessible after delay", async () => {
    const Def = define("DelayedAccess")
      .initialState(() => ({
        items: [
          ["a", { value: 1 }],
          ["b", { value: 2 }],
        ] as Array<[string, { value: number }]>,
      }))
      .queries({
        getItems: (state) => new Map(state.items),
      })
      .build();

    const manager = create({
      definition: Def,
      store: new InMemoryPersistenceAdapter(),
    });

    const actor = manager.get("test-1");
    const itemsMap = await actor.read.getItems();

    await new Promise((resolve) => setTimeout(resolve, 10));

    const entries = [...itemsMap.entries()];
    expect(entries[0][1].value).toBe(1);
    expect(entries[1][1].value).toBe(2);

    await manager.stop();
  });
});
