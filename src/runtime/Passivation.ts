import type { Entity } from "./Entity";

export class PassivationManager {
  private sweeper?: ReturnType<typeof setInterval> | undefined;

  constructor(
    // biome-ignore lint/suspicious/noExplicitAny: Entity can have any state
    private entities: Map<string, Entity<any>>,
    private onEvict: (id: string) => Promise<void> | void,
    private idleAfterMs: number,
    sweepIntervalMs: number,
    private now: () => number = () => Date.now(),
  ) {
    this.sweeper = setInterval(() => {
      // Run the sweep as an async task; swallow errors but complete its awaits.
      (async () => {
        await this.sweep();
      })().catch(() => {});
    }, sweepIntervalMs);
    // `unref` doesn't exist in some environments (e.g., browsers)
    this.sweeper.unref?.();
  }

  private async sweep() {
    const now = this.now();
    const pending: Array<Promise<void> | void> = [];
    for (const [id, entity] of this.entities.entries()) {
      if (entity.isFailed) continue;
      if (now - entity.lastActivity > this.idleAfterMs) {
        pending.push(this.onEvict(id));
      }
    }
    // Ensure evictions complete (important for fake-timer tests)
    await Promise.allSettled(pending);
  }

  stop() {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }
}
