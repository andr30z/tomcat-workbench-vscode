import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { appendFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { cleanEnvironment, resolveSecrets, type Instance, type InstanceRef, type State } from './config';
import { DistributionStore } from './distributions';
import { atomicJson, jsonFile, lease, assertRealChild } from './files';
import { assertPortsAvailable, deployApplications, javaArguments, prepareBase, runtimeDirectory } from './runtime';

const exec = promisify(execFile);
export interface ProcessIdentity { pid: number; executable: string; created: string; commandLine: string }
interface Ownership { pid: number; executable: string; created: string; token: string }
interface Journal extends Ownership { home: string; base: string; instance: Instance; project: string; debugPort?: number }
interface Running { journal: Journal; child?: ChildProcess; release: () => Promise<void>; timer?: NodeJS.Timeout; exiting: boolean; finishing?: Promise<void> }
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function escapeRegex(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function identityMatches(record: Ownership, actual?: ProcessIdentity): boolean {
  return !!actual && actual.pid === record.pid && actual.executable.toLowerCase() === record.executable.toLowerCase() && actual.created === record.created && new RegExp(`(?:^|[\\s"])${escapeRegex(`-Dtomcat.workbench.token=${record.token}`)}(?=$|[\\s"])`).test(actual.commandLine);
}
export function redactConsole(value: string, secrets: string[]): string {
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) value = value.replaceAll(secret, '[redacted]');
  return value;
}
export async function terminateChild(child: ChildProcess, timeout = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.removeListener('exit', exited); child.removeListener('error', failed); };
    const exited = () => { cleanup(); resolve(); }; const failed = (error: Error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => failed(new Error('Owned Java process did not terminate. Recovery data and lock were retained.')), timeout);
    child.once('exit', exited); child.once('error', failed);
    try { if (!child.kill()) failed(new Error('Unable to terminate owned Java process. Recovery data and lock were retained.')); } catch (e) { failed(e as Error); }
  });
}
export async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  if (process.platform !== 'win32') throw new Error('This release supports Windows only.');
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process id.');
  const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p){ [PSCustomObject]@{pid=$p.ProcessId;executable=$p.ExecutablePath;created=$p.CreationDate.ToUniversalTime().ToString('o');commandLine=$p.CommandLine} | ConvertTo-Json -Compress }`;
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  for (let attempt = 0; attempt < 3; attempt++) {
    const { stdout } = await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
    if (!stdout.trim()) return undefined;
    const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (result.executable && result.commandLine && result.created) return result;
    // Windows can retain a dying PID briefly after dropping its readable metadata.
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined; }
    await delay(100);
  }
  throw new Error('Windows could not verify process ownership. No process will be terminated.');
}
async function isListening(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '::1']) {
    const ok = await new Promise<boolean>(resolve => {
      const socket = createConnection({ port, host }); const finish = (result: boolean) => { socket.destroy(); resolve(result); };
      socket.setTimeout(200); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
    });
    if (ok) return true;
  }
  return false;
}
export interface ManagerEvents {
  state(ref: InstanceRef, state: State): void;
  log(ref: InstanceRef, message: string): void;
  secret(project: string, name: string): Promise<string | undefined>;
}
export class InstanceManager {
  private running = new Map<string, Running>();
  private states = new Map<string, State>();
  private busy = new Set<string>();
  constructor(readonly storage: string, readonly distributions: DistributionStore, readonly events: ManagerEvents) {}
  key(ref: InstanceRef): string { return runtimeDirectory(this.storage, ref.project, ref.instance.id); }
  state(ref: InstanceRef): State { return this.states.get(this.key(ref)) ?? 'stopped'; }
  debugPort(ref: InstanceRef): number | undefined { return this.running.get(this.key(ref))?.journal.debugPort; }
  generation(ref: InstanceRef): string | undefined { return this.running.get(this.key(ref))?.journal.token; }
  ownsDebugSession(key: string, generation: unknown): boolean {
    const run = this.running.get(key);
    return typeof generation === 'string' && !!run && !run.exiting && run.journal.token === generation && run.journal.debugPort !== undefined && this.states.get(key) === 'running';
  }
  private change(ref: InstanceRef, state: State) { this.states.set(this.key(ref), state); this.events.state(ref, state); }
  private async finished(ref: InstanceRef, run: Running, state: State) {
    if (run.finishing) return run.finishing;
    run.exiting = true;
    run.finishing = (async () => {
      if (run.timer) clearInterval(run.timer);
      await rm(path.join(run.journal.base, 'process.json'), { force: true });
      await run.release(); this.running.delete(this.key(ref)); this.change(ref, state);
    })();
    return run.finishing;
  }
  async recover(ref: InstanceRef): Promise<boolean> {
    const key = this.key(ref); if (this.running.has(key)) return true;
    const journal = await jsonFile<Journal>(path.join(key, 'process.json')); if (!journal) return false;
    const release = await lease(`${key}.lock`);
    try {
      if (journal.base !== key || journal.project.toLowerCase() !== ref.project.toLowerCase() || journal.instance.id !== ref.instance.id) throw new Error('Invalid recovery journal. Inspect local instance data before retrying.');
      if (!journal.created) throw new Error('Previous launch was interrupted before identity verification. Recovery data has been retained; verify the process manually before removing local data.');
      if (!identityMatches(journal, await processIdentity(journal.pid))) { await rm(path.join(key, 'process.json'), { force: true }); await release(); return false; }
      const run: Running = { journal, release, exiting: false }; this.running.set(key, run); this.change(ref, 'running');
      run.timer = setInterval(() => { void processIdentity(journal.pid).then(actual => { if (!identityMatches(journal, actual)) return this.finished(ref, run, 'stopped'); }).catch(e => this.events.log(ref, `Recovery monitoring: ${String(e)}\n`)); }, 5000);
      this.events.log(ref, 'Recovered an independently verified Tomcat process from the previous session.\n'); return true;
    } catch (e) { await release(); throw e; }
  }
  async start(ref: InstanceRef, options: { debug?: boolean } = {}): Promise<void> {
    const key = this.key(ref);
    if (this.busy.has(key)) throw new Error('Another instance operation is still running.');
    this.busy.add(key);
    let release: (() => Promise<void>) | undefined; let run: Running | undefined; let child: ChildProcess | undefined;
    try {
      if (this.running.has(key) || await this.recover(ref)) throw new Error('Instance is already running. Stop it before starting or changing configuration.');
      release = await lease(`${key}.lock`); this.change(ref, 'starting');
      const instance = structuredClone(ref.instance);
      const home = await this.distributions.ensureTomcat(instance.tomcatVersion); const java = await this.distributions.ensureJava(instance.java);
      const environment = await resolveSecrets(instance.environment, name => this.events.secret(ref.project, name));
      const secretValues: string[] = [];
      for (const value of Object.values(instance.environment)) for (const match of value.matchAll(/\$\{secret:([A-Za-z0-9_.-]+)\}/g)) { const v = await this.events.secret(ref.project, match[1]); if (v) secretValues.push(v); }
      const token = randomUUID(); const ports = await prepareBase(home, key, ref.project, instance, token);
      const debugPort = options.debug ? instance.debug?.port ?? 5005 : undefined;
      if (debugPort !== undefined && ports.includes(debugPort)) throw new Error(`Debug port ${debugPort} conflicts with a Tomcat connector or shutdown port.`);
      const args = javaArguments(home, key, instance, token, 'start', options.debug);
      await assertPortsAvailable([...ports, ...(debugPort !== undefined ? [debugPort] : [])]); await deployApplications(ref.project, key, instance.applications);
      const executable = path.join(java, 'bin/java.exe'); const env = cleanEnvironment(process.env, environment);
      Object.assign(env, { JAVA_HOME: java, CATALINA_HOME: home, CATALINA_BASE: key });
      child = spawn(executable, args, { cwd: key, env, windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let debugReady = debugPort === undefined;
      let outputFailure = ''; let exited = false; let spawnError: Error | undefined; let writeQueue = Promise.resolve();
      const attachOutput = (stream: NodeJS.ReadableStream) => {
        let pending = '';
        const flush = (line: string) => {
          if (/Listening for transport dt_socket at address:/.test(line)) debugReady = true;
          if (/BindException|Address already in use|Failed to initialize component|LifecycleException/.test(line)) outputFailure = 'Tomcat reported a startup error. Inspect the console and logs.';
          const safe = redactConsole(line, [...secretValues, token]); this.events.log(ref, safe);
          writeQueue = writeQueue.then(() => appendFile(path.join(key, 'logs/console.log'), safe)).catch(() => {});
        };
        stream.on('data', data => { pending += data.toString(); let index: number; while ((index = pending.indexOf('\n')) >= 0) { flush(pending.slice(0, index + 1)); pending = pending.slice(index + 1); } if (pending.length > 128 * 1024) { flush('[oversized console line omitted]\n'); pending = ''; } });
        stream.on('end', () => { if (pending) flush(pending); });
      };
      attachOutput(child.stdout!); attachOutput(child.stderr!);
      child.once('error', error => { spawnError = error; });
      child.once('exit', code => { exited = true; if (run) void this.finished(ref, run, this.state(ref) === 'stopping' || code === 0 ? 'stopped' : 'failed').catch(e => this.events.log(ref, `${String(e)}\n`)); });
      await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject); });
      const journal: Journal = { pid: child.pid!, executable, created: '', token, home, base: key, instance, project: ref.project, ...(debugPort !== undefined ? { debugPort } : {}) };
      run = { journal, child, release, exiting: false }; this.running.set(key, run); release = undefined;
      await atomicJson(path.join(key, 'process.json'), journal);
      const actual = await processIdentity(child.pid!);
      if (!actual || !new RegExp(`(?:^|[\\s"])-Dtomcat\\.workbench\\.token=${token}(?=$|[\\s"])`).test(actual.commandLine) || actual.executable.toLowerCase() !== executable.toLowerCase()) throw new Error('Unable to verify the launched Java process.');
      journal.created = actual.created;
      await atomicJson(path.join(key, 'process.json'), journal);
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (exited || outputFailure) throw new Error(outputFailure || 'Tomcat exited before it became ready. Inspect the console and logs.');
        if (debugReady && await isListening(instance.ports.http) && await isListening(instance.ports.shutdown)) { this.change(ref, 'running'); return; }
        await delay(250);
      }
      throw new Error('Tomcat did not become ready within 90 seconds. Inspect the console and logs.');
    } catch (error) {
      if (child) await terminateChild(child);
      if (run) await this.finished(ref, run, 'failed');
      if (this.state(ref) !== 'running') this.change(ref, 'failed');
      throw error;
    } finally { if (release) await release(); this.busy.delete(key); }
  }
  async stop(ref: InstanceRef, expectedGeneration?: string): Promise<void> {
    if (expectedGeneration !== undefined && this.generation(ref) !== expectedGeneration) return;
    const key = this.key(ref); if (this.busy.has(key)) throw new Error('Another instance operation is still running.'); this.busy.add(key);
    try {
      if (!this.running.has(key)) await this.recover(ref);
      const run = this.running.get(key); if (!run) { this.change(ref, 'stopped'); return; }
      const j = run.journal;
      if (!j.created) { if (!run.child) throw new Error('Unverified recovery process requires manual inspection.'); await terminateChild(run.child); await this.finished(ref, run, 'stopped'); return; }
      if (!identityMatches(j, await processIdentity(j.pid))) { await this.finished(ref, run, 'stopped'); return; }
      this.change(ref, 'stopping');
      try { await exec(j.executable, javaArguments(j.home, j.base, j.instance, j.token, 'stop'), { cwd: j.base, env: cleanEnvironment(process.env, {}), windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 }); }
      catch { this.events.log(ref, 'Graceful shutdown did not complete; checking process identity before fallback.\n'); }
      const deadline = Date.now() + 10_000;
      while (!run.exiting && Date.now() < deadline) {
        if (!identityMatches(j, await processIdentity(j.pid))) { await this.finished(ref, run, 'stopped'); return; }
        await delay(250);
      }
      if (!run.exiting && identityMatches(j, await processIdentity(j.pid))) {
        if (run.child) await terminateChild(run.child);
        else process.kill(j.pid);
        await delay(300);
        if (identityMatches(j, await processIdentity(j.pid))) throw new Error('Tomcat could not be stopped. Local data has been retained.');
        await this.finished(ref, run, 'stopped');
      }
      if (run.finishing) await run.finishing;
    } catch (e) { this.change(ref, this.running.has(key) ? 'running' : 'failed'); throw e; }
    finally { this.busy.delete(key); }
  }
  async withStopped<T>(ref: InstanceRef, operation: () => Promise<T>): Promise<T> {
    const key = this.key(ref);
    if (this.busy.has(key)) throw new Error('Another instance operation is still running.');
    this.busy.add(key);
    let release: (() => Promise<void>) | undefined;
    try {
      if (this.running.has(key) || await this.recover(ref)) throw new Error('Stop this instance before changing deployments or local data.');
      release = await lease(`${key}.lock`); return await operation();
    } finally { if (release) await release(); this.busy.delete(key); }
  }
  async cleanup(ref: InstanceRef): Promise<void> {
    await this.withStopped(ref, async () => {
      const base = this.key(ref);
      try { await assertRealChild(this.storage, base); await rm(base, { recursive: true, force: true }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    });
  }
  async shutdown(): Promise<void> {
    const outcomes = await Promise.allSettled([...this.running.values()].map(run => this.stop({ project: run.journal.project, instance: run.journal.instance })));
    const failures = outcomes.filter(o => o.status === 'rejected'); if (failures.length) throw new Error(`${failures.length} Tomcat instance(s) could not be stopped. Recovery data was retained.`);
  }
}
