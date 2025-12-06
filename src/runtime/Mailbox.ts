export class Mailbox {
  private queue: Promise<unknown> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const taskPromise = this.queue.then(task);
    this.queue = taskPromise.catch(() => {}); // prevent unhandled promise rejection
    return taskPromise;
  }
}
