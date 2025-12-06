import { ManagerShutdownError } from "../errors";
import type {
  AnyEntityDefinition,
  EntityManagerConfig,
  StateOf,
} from "../types/public";
import { newId } from "../utils/id";
import { Entity } from "./Entity";
import { PassivationManager } from "./Passivation";

export class RuntimeEntityManager<TDef extends AnyEntityDefinition> {
  private entities = new Map<string, Entity<StateOf<TDef>>>();
  private managerId = newId();
  private passivation?: PassivationManager;
  public isShutdown = false;

  constructor(private config: EntityManagerConfig<TDef>) {
    if (config.passivation) {
      this.passivation = new PassivationManager(
        this.entities,
        this.evictEntity,
        config.passivation.idleAfter,
        config.passivation.sweepInterval ?? 60_000,
        () => Date.now(),
      );
    }
  }

  getEntity(id: string): Entity<StateOf<TDef>> {
    if (this.isShutdown) {
      throw new ManagerShutdownError(
        "EntityManager is shut down. Cannot create new entities.",
      );
    }
    let entity = this.entities.get(id);
    if (!entity || entity.isFailed) {
      entity = new Entity(
        id,
        this.config.definition,
        this.managerId,
        this.config.store,
        this.config.supervisor,
        this.config.metrics,
      );
      this.entities.set(id, entity);
    }
    return entity;
  }

  removeEntity(id: string) {
    this.entities.delete(id);
  }

  private evictEntity = async (id: string) => {
    const entity = this.entities.get(id);
    if (entity) {
      await entity.maybeSnapshot(true);
      await entity.terminate();
      this.entities.delete(id);
      this.config.metrics?.onEvict?.(id);
    }
  };

  async terminate() {
    this.isShutdown = true;
    this.passivation?.stop();
    await Promise.allSettled(
      [...this.entities.values()].map((e) => e.terminate()),
    );
    this.entities.clear();
  }
}
