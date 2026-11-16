/** Runtime-owned leases. Releasing one surface never resumes another surface's work. */
export class InteractionGate {
  private readonly leases = new Set<object>();
  private readonly listeners = new Set<(blocked: boolean) => void>();
  get blocked(): boolean { return this.leases.size > 0; }
  acquire(): () => void {
    const token = {};
    this.leases.add(token);
    this.notify();
    return () => { if (this.leases.delete(token)) this.notify(); };
  }
  subscribe(listener: (blocked: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(): void { for (const listener of this.listeners) listener(this.blocked); }
  dispose(): void { this.leases.clear(); this.notify(); this.listeners.clear(); }
}
