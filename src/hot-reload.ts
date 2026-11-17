import type { HotReloadOptions, Instance } from './config';
export function reloadSignature(instance: Instance): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, stable(value)])) : v;
  const { applications: _applications, name: _name, ...settings } = instance; return JSON.stringify(stable(settings));
}
export interface ReloadPermit { generation: string; epoch: number; signature: string }
export function permitsReload(expected: ReloadPermit, current: { generation?: string; epoch: number; signature: string; state: string; enabled: boolean; trusted: boolean }, stopped: boolean): boolean {
  return current.trusted && current.enabled && current.epoch === expected.epoch && current.signature === expected.signature && (stopped ? current.state === 'stopped' : current.state === 'running' && current.generation === expected.generation);
}

function matches(file: string, glob: string): boolean {
  let pattern = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; pattern += '(?:.*/)?'; } else pattern += '.*'; }
    else if (c === '*') pattern += '[^/]*'; else if (c === '?') pattern += '[^/]'; else pattern += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(pattern + '$', 'i').test(file);
}
export function shouldReload(relative: string, options: HotReloadOptions): boolean {
  const file = relative.replaceAll('\\', '/'); const parts = file.split('/');
  if (!file || file.startsWith('/') || parts.includes('..') || parts.some(p => /^(?:target|node_modules|dist|out|coverage|\.git|\.vscode|\.local|\.tomcat-workbench(?:\..*)?)$/i.test(p))) return false;
  if (!file.toLowerCase().endsWith('.java')) return false;
  return (options.watch ?? ['src/**']).some(glob => matches(file, glob)) && !(options.exclude ?? []).some(glob => matches(file, glob));
}
interface Pending { due: number; action: () => Promise<unknown> }
export class ReloadScheduler {
  private readonly pending = new Map<string, Pending>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<void>>();
  private disposed = false;
  constructor(private readonly busy: (key: string) => boolean, private readonly onError: (error: unknown, key: string) => void) {}
  schedule(key: string, delay: number, action: () => Promise<unknown>): void {
    if (this.disposed) return;
    this.pending.set(key, { due: Date.now() + delay, action }); this.arm(key);
  }
  private arm(key: string): void {
    const timer = this.timers.get(key); if (timer) clearTimeout(timer);
    const item = this.pending.get(key); if (!item || this.disposed) return;
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); void this.flush(key); }, Math.max(0, item.due - Date.now())));
  }
  flush(key: string): Promise<void> {
    const running = this.running.get(key); if (running) return running;
    const item = this.pending.get(key); if (!item || this.disposed || this.busy(key)) return Promise.resolve();
    if (item.due > Date.now()) { this.arm(key); return Promise.resolve(); }
    this.pending.delete(key); const timer = this.timers.get(key); if (timer) clearTimeout(timer); this.timers.delete(key);
    const operation = Promise.resolve().then(() => {
      if (this.disposed) return;
      if (this.busy(key)) { if (!this.pending.has(key)) this.pending.set(key, item); return; }
      return item.action();
    }).then(() => {}, error => { this.onError(error, key); }).finally(() => { this.running.delete(key); if (this.pending.has(key)) this.arm(key); });
    this.running.set(key, operation); return operation;
  }
  cancel(key: string): void { this.pending.delete(key); const timer = this.timers.get(key); if (timer) clearTimeout(timer); this.timers.delete(key); }
  cancelAll(): void { for (const key of this.pending.keys()) this.cancel(key); }
  dispose(): void { this.disposed = true; this.cancelAll(); }
}
export interface HotSwapHost { current(): boolean; compile(): Promise<unknown>; redefine(): Promise<{ errorMessage?: string; changedClasses?: unknown[] } | undefined> }
async function interruptible<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new Error('HotSwap cancelled.')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('HotSwap timed out.')); }, 90000);
    signal?.addEventListener('abort', abort, { once: true });
    operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal?.aborted) abort();
  });
}
export async function applyHotSwap(host: HotSwapHost, signal?: AbortSignal): Promise<number> {
  const check = () => { if (signal?.aborted) throw new Error('HotSwap cancelled.'); if (!host.current()) throw new Error('The owned debug session changed or ended.'); };
  check(); const status = await interruptible(host.compile(), signal); check();
  if (status !== 1) throw new Error('Java compilation did not succeed. Fix the Java Problems before HotSwap.');
  const result = await interruptible(host.redefine(), signal); check();
  if (result?.errorMessage) throw new Error(`HotSwap rejected: ${result.errorMessage}. Structural changes require Build and Debug.`);
  return result?.changedClasses?.length ?? 0;
}
