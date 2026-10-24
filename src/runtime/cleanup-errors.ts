/** Attempts every owned cleanup before reporting failures to its caller. */
export class CleanupErrors {
  private readonly failures: unknown[] = [];

  run(cleanup: () => void): void {
    try { cleanup(); }
    catch (error) { this.failures.push(error); }
  }

  async runAsync(cleanup: () => void | Promise<void>): Promise<void> {
    try { await cleanup(); }
    catch (error) { this.failures.push(error); }
  }

  error(message: string): AggregateError | undefined {
    return this.failures.length ? new AggregateError(this.failures, message) : undefined;
  }
}
