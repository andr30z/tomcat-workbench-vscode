import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DistributionStore } from '../../src/distributions';
import { InstanceManager } from '../../src/processes';
import { assertPortsAvailable } from '../../src/runtime';
import { cleanEnvironment, type InstanceRef } from '../../src/config';
import { jsonFile } from '../../src/files';
const exec = promisify(execFile);
async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function hitBreakpoint(java: string, classes: string, ref: InstanceRef): Promise<void> {
  const child = spawn(path.join(java, 'bin/java.exe'), ['--add-modules=jdk.jdi', '-cp', classes, 'DebugProbe', String(ref.instance.debug!.port)], { env: cleanEnvironment(process.env, {}), windowsHide: true });
  let output = ''; let errors = ''; let ready!: () => void; let rejectReady!: (error: Error) => void;
  const attached = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  const done = new Promise<number | null>(resolve => child.once('close', code => { if (!output.includes('ATTACHED')) rejectReady(new Error(`JDI attach failed: ${errors}`)); resolve(code); }));
  child.stdout.on('data', data => { output += data.toString(); if (output.includes('ATTACHED')) ready(); });
  child.stderr.on('data', data => errors += data.toString()); child.once('error', rejectReady);
  const timer = setTimeout(() => { rejectReady(new Error(`JDI timed out: ${errors}`)); child.kill(); }, 30000);
  try {
    await attached;
    const response = await fetch(`http://127.0.0.1:${ref.instance.ports.http}/`, { signal: AbortSignal.timeout(25000) });
    assert.equal(response.status, 200); assert.equal(await response.text(), ref.instance.id);
    assert.equal(await done, 0, errors); assert.match(output, /BREAKPOINT_HIT:doFilter/);
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); await done; }
}
test('managed Java 8 and 17 debug listeners attach, hit real request breakpoints, recover and remain absent during normal Start', { skip: process.platform !== 'win32', timeout: 600000 }, async () => {
  const root = path.resolve('.integration-data'); const project = path.join(root, `debug-${randomUUID()}`); await mkdir(project, { recursive: true });
  const storage = path.join(root, 'storage'); const store = new DistributionStore(path.join(storage, 'distributions'));
  const java17 = { major: 17, release: (await store.javaVersions(17))[0] }; const java8 = { major: 8, release: (await store.javaVersions(8))[0] };
  const home17 = await store.ensureJava(java17); await store.ensureJava(java8);
  const classes = path.join(project, 'probe'); await mkdir(classes);
  await exec(path.join(home17, 'bin/javac.exe'), ['--add-modules=jdk.jdi', '-d', classes, path.resolve('test/integration/DebugProbe.java')], { env: cleanEnvironment(process.env, {}), windowsHide: true, timeout: 30000 });
  const log: string[] = []; const manager = new InstanceManager(storage, store, { state: () => {}, log: (_ref, text) => log.push(text), secret: async () => undefined });
  const refs: InstanceRef[] = []; const used = new Set<number>();
  const port = async () => { let value = await freePort(); while (used.has(value)) value = await freePort(); used.add(value); return value; };
  try {
    for (const family of ['8.5', '11.0'] as const) {
      const tomcatVersion = (await store.tomcatVersions(family))[0]; await store.ensureTomcat(tomcatVersion);
      const id = `debug-${family.replace('.', '-')}`; await mkdir(path.join(project, id)); await writeFile(path.join(project, id, 'index.html'), id);
      refs.push({ project, instance: { id, name: id, tomcatVersion, java: family === '8.5' ? java8 : java17, ports: { http: await port(), shutdown: await port() }, debug: { port: await port() }, jvmArgs: ['-Xms32m', '-Xmx128m'], environment: {}, applications: [{ source: id, context: '/' }] } });
    }
    await Promise.all(refs.map(ref => manager.start(ref, { debug: true })));
    for (const ref of refs) {
      assert.equal(manager.debugPort(ref), ref.instance.debug!.port);
      assert.equal(manager.ownsDebugSession(manager.key(ref), manager.generation(ref)), true);
      const network = await exec(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/netstat.exe'), ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 10000 });
      const listeners = network.stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts => parts[0] === 'TCP' && parts[1]?.endsWith(`:${ref.instance.debug!.port}`) && parts[2]?.endsWith(':0'));
      assert.equal(listeners.length, 1); assert.equal(listeners[0][1], `127.0.0.1:${ref.instance.debug!.port}`);
      await hitBreakpoint(home17, classes, ref);
    }
    await manager.stop(refs[0]);
    const workerInput = path.join(project, 'recovery.json'); await writeFile(workerInput, JSON.stringify({ storage, ref: refs[0], debug: true }));
    await exec(process.execPath, [path.resolve('out/tests/recovery-worker.cjs'), workerInput], { windowsHide: true, timeout: 120000 });
    const changed = { ...refs[0], instance: { ...refs[0].instance, debug: { port: await port() } } };
    await manager.recover(changed); assert.equal(manager.debugPort(changed), refs[0].instance.debug!.port);
    await hitBreakpoint(home17, classes, refs[0]); const oldGeneration = manager.generation(changed)!; await manager.stop(changed);
    await manager.start(refs[0]); assert.equal(manager.debugPort(refs[0]), undefined);
    await manager.stop(refs[0], oldGeneration); assert.equal(manager.state(refs[0]), 'running');
    await assertPortsAvailable([refs[0].instance.debug!.port]);
    await manager.stop(refs[0]);
    const blocker = createServer(); await new Promise<void>(resolve => blocker.listen(refs[0].instance.debug!.port, '127.0.0.1', resolve));
    try { await assert.rejects(manager.start(refs[0], { debug: true }), /port.*in use/i); assert.equal(await jsonFile(path.join(manager.key(refs[0]), 'process.json')), undefined); }
    finally { await new Promise<void>(resolve => blocker.close(() => resolve())); }
  } catch (error) { console.error(log.slice(-20).join('')); throw error; }
  finally { await manager.shutdown(); for (const ref of refs) await manager.cleanup(ref); await rm(project, { recursive: true, force: true }); }
});
