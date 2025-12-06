import { ResetError } from "../errors";
import type { Supervisor } from "../types/public";

export async function Supervise<T>(
  task: () => Promise<T>,
  state: unknown,
  supervisor: Supervisor,
  onReset: () => Promise<void>, // side-effect; we will throw here
  onStop: () => never,
): Promise<T> {
  try {
    return await task();
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    const strategy = supervisor.strategy(state, error);

    switch (strategy) {
      case "resume":
        throw error;
      case "reset":
        await onReset();
        throw new ResetError(error);
      case "stop":
        onStop(); // this should throw
    }
  }
}
