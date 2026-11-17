/** Keep dependency prompts/actions out of an instance's build/start critical section. */
export class DeferredDependencyActions {
  private readonly pending = new Map<string, () => Promise<unknown>>();
  private readonly running = new Map<string, Promise<void>>();
  private disposed = false;
  constructor(private readonly busy: (key: string) => boolean, private readonly onError: (error: unknown) => void) {}
  enqueue(key: string, action: () => Promise<unknown>): void {
    if (this.disposed) return;
    this.pending.set(key, action); void this.flush(key).catch(() => {});
  }
  flush(key: string): Promise<void> {
    const running = this.running.get(key); if (running) return running;
    if (this.disposed || this.busy(key) || !this.pending.has(key)) return Promise.resolve();
    const operation = Promise.resolve().then(async () => {
      while (!this.disposed && !this.busy(key)) {
        const action = this.pending.get(key); if (!action) break;
        this.pending.delete(key); await action();
      }
    }).catch(error => { this.onError(error); }).finally(() => {
      this.running.delete(key);
      if (!this.disposed && !this.busy(key) && this.pending.has(key)) void this.flush(key).catch(() => {});
    });
    this.running.set(key, operation); return operation;
  }
  dispose(): void { this.disposed = true; this.pending.clear(); }
}

export function scheduleDependencyRecovery(queue: DeferredDependencyActions, key: string, automatic: boolean, confirm: () => Promise<boolean>, diagnose: () => Promise<unknown>): void {
  queue.enqueue(key, async () => {
    if (automatic) { await diagnose(); return; }
    if (await confirm()) queue.enqueue(key, diagnose);
  });
}
