import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { DistributionStore } from '../../src/distributions';
import { InstanceManager, processIdentity, identityMatches } from '../../src/processes';
import { jsonFile } from '../../src/files';
import { configureNetwork } from '../../src/network';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type Family, type InstanceRef } from '../../src/config';

async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
test('runs four managed Tomcat families including 8.5 on Java 8 simultaneously, redeploys independently and stops verified Java processes', { skip: process.platform !== 'win32', timeout: 600_000 }, async () => {
  const root = path.resolve('.integration-data'); const project = path.join(root, `projeto espaço-${randomUUID()}`); await mkdir(project, { recursive: true });
  const storage = path.join(root, 'storage');
  const store = new DistributionStore(path.join(storage, 'distributions'), message => console.log(message));
  const java = { major: 17, release: (await store.javaVersions(17))[0] };
  await store.ensureJava(java);
  const java8 = { major: 8, release: (await store.javaVersions(8))[0] };
  await store.ensureJava(java8);
  const refs: InstanceRef[] = []; const ports = new Set<number>();
  const nextPort = async () => { let p = await freePort(); while (ports.has(p)) p = await freePort(); ports.add(p); return p; };
  for (const family of ['9.0', '10.1', '11.0', '8.5'] as Family[]) {
    const version = (await store.tomcatVersions(family))[0]; await store.ensureTomcat(version);
    const id = `tomcat-${family.replace('.', '-')}`;
    await mkdir(path.join(project, id)); await writeFile(path.join(project, id, 'index.html'), `hello-${id}`);
    refs.push({ project, instance: { id, name: id, tomcatVersion: version, java: family === '8.5' ? java8 : java, ports: { http: await nextPort(), shutdown: await nextPort() }, jvmArgs: ['-Xms32m', '-Xmx128m'], environment: {}, applications: [{ source: id, context: '/' }] } });
  }
  const log: string[] = [];
  // Invalid proxy proves launch/restart only consume cached artifacts.
  configureNetwork('http://127.0.0.1:9');
  const manager = new InstanceManager(storage, store, { state: (ref, state) => console.log(ref.instance.id, state), log: (ref, text) => log.push(`${ref.instance.id}: ${text}`), secret: async () => undefined });
  const inherited = new Map(['JAVA_HOME', 'JRE_HOME', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'CATALINA_HOME', 'PATH'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { JAVA_HOME: 'C:\\not-installed\\java', JRE_HOME: 'C:\\not-installed\\jre', JAVA_TOOL_OPTIONS: '-invalid-inherited-option', _JAVA_OPTIONS: '-invalid-inherited-option', CATALINA_HOME: 'C:\\not-installed\\tomcat', PATH: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') });
  const oldHome = process.env.JAVA_HOME;
  try {
    await Promise.all(refs.map(ref => manager.start(ref)));
    for (const ref of refs) {
      const response = await fetch(`http://127.0.0.1:${ref.instance.ports.http}/`);
      assert.equal(response.status, 200); assert.equal(await response.text(), `hello-${ref.instance.id}`);
      const journal = await jsonFile<any>(path.join(manager.key(ref), 'process.json'));
      assert.ok(identityMatches(journal, await processIdentity(journal.pid)));
      assert.ok(journal.executable.startsWith(storage));
    }
    await assert.rejects(manager.cleanup(refs[0]), /stop/i);
    await manager.stop(refs[0]);
    await writeFile(path.join(project, refs[0].instance.id, 'index.html'), 'updated-only-first');
    await manager.start(refs[0]);
    assert.equal(await (await fetch(`http://127.0.0.1:${refs[0].instance.ports.http}/`)).text(), 'updated-only-first');
    assert.equal(await (await fetch(`http://127.0.0.1:${refs[1].instance.ports.http}/`)).text(), 'hello-tomcat-10-1');
    await manager.stop(refs[0]);
    const workerInput = path.join(project, 'recovery-input.json'); await writeFile(workerInput, JSON.stringify({ storage, ref: refs[0] }));
    const worker = await promisify(execFile)(process.execPath, [path.resolve('out/tests/recovery-worker.cjs'), workerInput], { windowsHide: true, timeout: 120_000 });
    assert.match(worker.stdout, /STARTED/);
    assert.equal(await manager.recover(refs[0]), true);
    const otherWindow = new InstanceManager(storage, store, { state: () => {}, log: () => {}, secret: async () => undefined });
    await assert.rejects(otherWindow.recover(refs[0]), /in use/i);
    const pid = (await jsonFile<any>(path.join(manager.key(refs[0]), 'process.json'))).pid;
    await manager.shutdown();
    assert.equal(await processIdentity(pid), undefined);
    assert.equal(process.env.JAVA_HOME, oldHome);
    assert.equal(await jsonFile(path.join(manager.key(refs[0]), 'process.json')), undefined);
    for (const ref of refs) await manager.cleanup(ref);
  } catch (error) { console.error(log.slice(-25).join('')); throw error; }
  finally {
    configureNetwork();
    try { await manager.shutdown(); await rm(project, { recursive: true, force: true }); }
    finally { for (const [key, value] of inherited) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  }
});
