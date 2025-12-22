import { ManagerShutdownError } from "../errors";
import type { Entity } from "../runtime/Entity";
import { RuntimeEntityManager } from "../runtime/EntityManager";
import { readStream, streamStatus } from "../stream/reader";
import type {
  AnyEntityDefinition,
  EntityManager,
  EntityManagerConfig,
  EntityRef,
  HistoryOf,
  ReadProxy,
  ReadStreamOptions,
  SendProxy,
  StateOf,
  StreamProxy,
  StreamReader,
  StreamStatus,
} from "../types/public";

export function create<TDef extends AnyEntityDefinition>(
  config: EntityManagerConfig<TDef>,
): EntityManager<TDef> {
  const manager = new RuntimeEntityManager(config);

  const entries = new Map<
    string,
    { ref: EntityRef<TDef>; entity: Entity<StateOf<TDef>> }
  >();

  function makeSendProxy(
    id: string,
    getEntity: () => Entity<StateOf<TDef>>,
    setEntity: (e: Entity<StateOf<TDef>>) => void,
  ): SendProxy<TDef> {
    return new Proxy(
      {},
      {
        get(_t, prop: string) {
          return async (...args: unknown[]) => {
            if (manager.isShutdown) {
              throw new ManagerShutdownError(
                "EntityManager is shut down. Cannot interact with entities.",
              );
            }
            let entity = getEntity();
            if (entity.isShutdown) {
              entity = manager.getEntity(id);
              setEntity(entity);
            }
            return entity.tell(prop as string, args);
          };
        },
      },
    ) as SendProxy<TDef>;
  }

  function makeReadProxy(
    id: string,
    getEntity: () => Entity<StateOf<TDef>>,
    setEntity: (e: Entity<StateOf<TDef>>) => void,
  ): ReadProxy<TDef> {
    return new Proxy(
      {},
      {
        get(_t, prop: string) {
          return async (...args: unknown[]) => {
            if (manager.isShutdown) {
              throw new ManagerShutdownError(
                "EntityManager is shut down. Cannot interact with entities.",
              );
            }
            let entity = getEntity();
            if (entity.isShutdown) {
              entity = manager.getEntity(id);
              setEntity(entity);
            }
            return entity.ask(prop as string, args);
          };
        },
      },
    ) as ReadProxy<TDef>;
  }

  function makeStreamProxy(
    id: string,
    getEntity: () => Entity<StateOf<TDef>>,
    setEntity: (e: Entity<StateOf<TDef>>) => void,
  ): StreamProxy<TDef> {
    return new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (...args: unknown[]): AsyncIterable<unknown> => {
            if (manager.isShutdown) {
              throw new ManagerShutdownError(
                "EntityManager is shut down. Cannot interact with entities.",
              );
            }
            let entity = getEntity();
            if (entity.isShutdown) {
              entity = manager.getEntity(id);
              setEntity(entity);
            }
            return entity.stream(prop as string, args);
          };
        },
      },
    ) as StreamProxy<TDef>;
  }

  return {
    get(id: string): EntityRef<TDef> {
      const existing = entries.get(id);
      if (
        existing &&
        !existing.entity.isFailed &&
        !existing.entity.isShutdown
      ) {
        return existing.ref;
      }

      let entity = manager.getEntity(id);
      let entry!: { ref: EntityRef<TDef>; entity: Entity<StateOf<TDef>> };

      const getEntity = () => entity;
      const setEntity = (e: Entity<StateOf<TDef>>) => {
        entity = e;
        entry.entity = e;
      };

      const ref: EntityRef<TDef> = {
        send: makeSendProxy(id, getEntity, setEntity),
        read: makeReadProxy(id, getEntity, setEntity),
        stream: makeStreamProxy(id, getEntity, setEntity),
        snapshot: async () => {
          if (manager.isShutdown) {
            throw new ManagerShutdownError(
              "EntityManager is shut down. Cannot interact with entities.",
            );
          }
          if (entity.isShutdown) {
            entity = manager.getEntity(id);
            setEntity(entity);
          }
          return entity.inspect();
        },
        stateAt: async (eventVersion: bigint) => {
          if (manager.isShutdown) {
            throw new ManagerShutdownError(
              "EntityManager is shut down. Cannot interact with entities.",
            );
          }
          if (entity.isShutdown) {
            entity = manager.getEntity(id);
            setEntity(entity);
          }
          return entity.stateAt(eventVersion) as Promise<HistoryOf<TDef>>;
        },
        stop: async () => {
          await entity.terminate();
          manager.removeEntity(id);
          entries.delete(id);
        },
      };

      entry = { ref, entity };
      entries.set(id, entry);
      return ref;
    },

    readStream<T = unknown>(
      streamId: string,
      options?: ReadStreamOptions,
    ): StreamReader<T> {
      if (!config.store) {
        throw new Error("readStream requires a persistence store");
      }
      return readStream<T>(config.store, streamId, options);
    },

    async streamStatus(streamId: string): Promise<StreamStatus | null> {
      if (!config.store) {
        throw new Error("streamStatus requires a persistence store");
      }
      return streamStatus(config.store, streamId);
    },

    stop: () => manager.terminate(),
  };
}
