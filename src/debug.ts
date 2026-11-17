import { resolveProjectPath, type Instance, type InstanceRef, type State } from './config';

export function nextDebugPort(instances: Instance[]): number {
  const used = new Set(instances.flatMap(i => [i.ports.http, i.ports.shutdown, ...(i.debug ? [i.debug.port] : [])]));
  for (let port = 5005; port <= 65535; port++) if (!used.has(port)) return port;
  throw new Error('No debug port available in this project.');
}
export function managedDebugArgument(instance: Instance): string {
  if (instance.jvmArgs.some(arg => /^-agentlib:jdwp(?:=|$)|^-Xrunjdwp(?::|$)|^-agentpath:.*jdwp/i.test(arg))) throw new Error('Remove manual JDWP options from jvmArgs before using Tomcat: Debug. Configure debug.port instead.');
  const port = instance.debug?.port ?? 5005;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === instance.ports.http || port === instance.ports.shutdown) throw new Error('Debug port must be a distinct port between 1024 and 65535.');
  return `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:${port}`;
}
export function attachConfiguration(ref: InstanceRef, key: string, actualPort: number, generation?: string) {
  return {
    type: 'java', request: 'attach', name: `Tomcat: ${ref.instance.name}`,
    hostName: '127.0.0.1', port: actualPort,
    ...(ref.instance.debug?.projectName ? { projectName: ref.instance.debug.projectName } : {}),
    ...(ref.instance.debug?.sourcePaths ? { sourcePaths: ref.instance.debug.sourcePaths.map(p => resolveProjectPath(ref.project, p)) } : {}),
    tomcatWorkbenchKey: key, ...(generation ? { tomcatWorkbenchGeneration: generation } : {})
  };
}
export interface DebugRuntime {
  key(ref: InstanceRef): string;
  recover(ref: InstanceRef): Promise<boolean>;
  debugPort(ref: InstanceRef): number | undefined;
  generation(ref: InstanceRef): string | undefined;
  state(ref: InstanceRef): State;
  start(ref: InstanceRef, options?: { debug?: boolean }): Promise<void>;
  stop(ref: InstanceRef, expectedGeneration?: string): Promise<void>;
}
export interface DebugHost {
  available(): Promise<void>;
  confirmRestart(ref: InstanceRef): Promise<boolean>;
  attach(ref: InstanceRef, key: string, port: number, generation: string): Promise<boolean>;
  detach(key: string, generation?: string): Promise<void>;
}
export class DebugController {
  private busy = new Set<string>();
  constructor(private readonly runtime: DebugRuntime, private readonly host: DebugHost) {}
  async start(ref: InstanceRef, restart = false): Promise<boolean> {
    const key = this.runtime.key(ref);
    if (this.busy.has(key)) throw new Error('Another debug operation is still running for this instance.');
    this.busy.add(key); let launched = false; let generation: string | undefined;
    try {
      await this.host.available();
      if (['starting', 'stopping'].includes(this.runtime.state(ref))) throw new Error('Another instance operation is still running.');
      const running = await this.runtime.recover(ref);
      const originalGeneration = this.runtime.generation(ref);
      let port = running ? this.runtime.debugPort(ref) : undefined;
      if (port === undefined || restart) {
        managedDebugArgument(ref.instance);
        if (running) {
          if (!restart && !(await this.host.confirmRestart(ref))) return false;
          if (this.runtime.generation(ref) !== originalGeneration) throw new Error('Tomcat changed while the debug restart was being confirmed.');
          await this.host.detach(key, originalGeneration); await this.runtime.stop(ref, originalGeneration);
        }
        await this.runtime.start(ref, { debug: true }); launched = true;
        port = this.runtime.debugPort(ref);
      }
      if (port === undefined) throw new Error('Tomcat has no managed debug listener.');
      generation = this.runtime.generation(ref);
      if (!generation) throw new Error('Tomcat ended before the debugger could attach.');
      if (this.runtime.debugPort(ref) !== port || this.runtime.state(ref) !== 'running') throw new Error('Tomcat changed before the debugger could attach.');
      if (!(await this.host.attach(ref, key, port, generation))) throw new Error('Unable to attach the Java debugger. Check Java project initialization and the Debug Console.');
      if (this.runtime.generation(ref) !== generation || this.runtime.debugPort(ref) !== port || this.runtime.state(ref) !== 'running') {
        await this.host.detach(key, generation); throw new Error('Tomcat changed or ended while the debugger was attaching. Retry Debug for the current instance.');
      }
      return true;
    } catch (error) {
      if (launched && generation && this.runtime.generation(ref) === generation) { try { await this.host.detach(key, generation); } finally { await this.runtime.stop(ref, generation); } }
      throw error;
    } finally { this.busy.delete(key); }
  }
  async stopDebug(ref: InstanceRef): Promise<void> {
    const key = this.runtime.key(ref);
    if (this.busy.has(key)) throw new Error('Another debug operation is still running for this instance.');
    this.busy.add(key);
    try { await this.host.detach(key, this.runtime.generation(ref)); }
    finally { this.busy.delete(key); }
  }
}
