import { mkdir, open, readFile, rename, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export async function renameRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; }
    catch (e) {
      if (attempt >= 7 || !['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await new Promise(resolve => setTimeout(resolve, Math.min(100 * 2 ** attempt, 1000)));
    }
  }
}
export async function atomicJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { const handle = await open(temp, 'wx'); try { await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`); } finally { await handle.close(); } await renameRetry(temp, file); }
  finally { await rm(temp, { force: true }); }
}
export async function jsonFile<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
export async function assertRealChild(root: string, target: string): Promise<void> {
  const parent = await realpath(root); const child = await realpath(target); const relative = path.relative(parent, child);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Refusing to modify a path outside the managed directory.');
}
export async function lease(directory: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(directory), { recursive: true });
  const claim = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(directory); await atomicJson(path.join(directory, 'owner.json'), { pid: process.pid, claim });
      return async () => { const owner = await jsonFile<{ claim: string }>(path.join(directory, 'owner.json')); if (owner?.claim === claim) await rm(directory, { recursive: true, force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const reclamation = `${directory}.reclaim`;
      try { await mkdir(reclamation); }
      catch { throw new Error('This instance or distribution is in use by another operation / VS Code window.'); }
      try {
        const owner = await jsonFile<{ pid: number; children?: number[] }>(path.join(directory, 'owner.json'));
        if (!owner) throw new Error(`Lock initialization is incomplete. Close all VS Code windows before removing the orphan lock: ${directory}`);
        let alive = false;
        for (const pid of [owner.pid, ...(owner.children ?? [])]) {
          try { process.kill(pid, 0); alive = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') alive = true; }
        }
        if (alive) throw new Error('This instance or distribution is in use by another operation / VS Code window.');
        await rm(directory, { recursive: true, force: true });
      } finally { await rm(reclamation, { recursive: true, force: true }); }
    }
  }
  throw new Error('Unable to acquire operation lock.');
}
export async function registerLeaseChildren(directory: string, pids: number[]): Promise<void> {
  const file = path.join(directory, 'owner.json'); const owner = await jsonFile<{ pid: number; claim: string; children?: number[] }>(file);
  if (!owner || owner.pid !== process.pid) throw new Error('Build lease ownership changed.');
  await atomicJson(file, { ...owner, children: [...new Set([...(owner.children ?? []), ...pids.filter(p => Number.isSafeInteger(p) && p > 0)])] });
}
