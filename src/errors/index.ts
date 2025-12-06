export class ResetError extends Error {
  constructor(original: Error) {
    super(`Entity reset after error: ${original.message}`);
    this.cause = original;
    this.name = "ResetError";
  }
}

export class DefinitionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefinitionMismatchError";
  }
}

export class OutOfOrderEventsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutOfOrderEventsError";
  }
}

export class CommitError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "CommitError";
  }
}

export class HydrationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "HydrationError";
  }
}

export class StoppedEntityError extends Error {
  constructor(entityId: string) {
    super(
      `Entity ${entityId} is stopped/failed. Further messages are rejected.`,
    );
    this.name = "StoppedEntityError";
  }
}

export class ManagerShutdownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagerShutdownError";
  }
}
