import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { ZipFile } from 'yazl';
import { DistributionStore } from '../../src/distributions';
import { InstanceManager } from '../../src/processes';
import { DeferredDependencyActions, scheduleDependencyRecovery } from '../../src/dependency-actions';
import { MissingClassDetector, findClassProviders } from '../../src/dependency-diagnostics';
import { cleanEnvironment, type InstanceRef } from '../../src/config';
const exec = promisify(execFile);
async function port(): Promise<number> { const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const number = (server.address() as import('node:net').AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return number; }
async function archive(file: string, entries: Record<string, Buffer>): Promise<void> { const zip = new ZipFile(); for (const [name, data] of Object.entries(entries)) zip.addBuffer(data, name); zip.end(); await pipeline(zip.outputStream, createWriteStream(file)); }

test('missing dependencies remain diagnosable after real Tomcat startup failures in run and debug modes', { timeout: 180000 }, async () => {
  const root = path.resolve('.integration-data'); const project = path.join(root, `diagnosis-${randomUUID()}`); const storage = path.join(root, 'storage');
  const store = new DistributionStore(path.join(storage, 'distributions'));
  const java = { major: 8, release: (await store.javaVersions(8))[0] }; const home = await store.ensureJava(java); const tomcat = await store.ensureTomcat('8.5.100');
  await mkdir(path.join(project, 'src/fixture'), { recursive: true }); await mkdir(path.join(project, 'classes')); const repository = path.join(project, 'repository');
  const busy = new Set<string>(); const actions: string[] = []; const errors: unknown[] = [];
  const queue = new DeferredDependencyActions(key => busy.has(key), error => errors.push(error));
  const detectors = new Map<string, MissingClassDetector>();
  const manager = new InstanceManager(storage, store, { state: () => {}, secret: async () => undefined, log: (ref, message) => {
    const key = manager.key(ref); const detector = detectors.get(key)!;
    if (detector.push(message, true).length) scheduleDependencyRecovery(queue, key, true, async () => { throw new Error('Automatic startup recovery must not wait for a notification.'); }, async () => {
      assert.equal(busy.has(key), false);
      const found = await findClassProviders(repository, [...detector.classes], new Map());
      assert.equal(found.providers.get('fixture.Missing')?.[0].artifactId, 'missing'); actions.push(ref.instance.id);
    });
  } });
  try {
    await writeFile(path.join(project, 'src/fixture/Missing.java'), 'package fixture; public class Missing {}');
    await writeFile(path.join(project, 'src/fixture/Initializer.java'), 'package fixture; public class Initializer implements javax.servlet.ServletContainerInitializer { public void onStartup(java.util.Set<Class<?>> types, javax.servlet.ServletContext context) { new Missing(); } }');
    await exec(path.join(home, 'bin/javac.exe'), ['-cp', path.join(tomcat, 'lib/servlet-api.jar'), '-d', path.join(project, 'classes'), path.join(project, 'src/fixture/Missing.java'), path.join(project, 'src/fixture/Initializer.java')], { env: cleanEnvironment(process.env, {}), windowsHide: true, timeout: 30000 });
    const folder = path.join(repository, 'fixture/missing/1'); await mkdir(folder, { recursive: true });
    await archive(path.join(folder, 'missing-1.jar'), { 'fixture/Missing.class': await readFile(path.join(project, 'classes/fixture/Missing.class')) });
    const initializer = path.join(project, 'initializer.jar'); await archive(initializer, { 'fixture/Initializer.class': await readFile(path.join(project, 'classes/fixture/Initializer.class')), 'META-INF/services/javax.servlet.ServletContainerInitializer': Buffer.from('fixture.Initializer\n') });
    const war = path.join(project, 'broken.war'); await archive(war, { 'WEB-INF/lib/initializer.jar': await readFile(initializer) });
    for (const debug of [false, true]) {
      const ref: InstanceRef = { project, instance: { id: debug ? 'debug' : 'run', name: 'Missing fixture', tomcatVersion: '8.5.100', java, ports: { http: await port(), shutdown: await port() }, debug: { port: await port() }, jvmArgs: [], environment: {}, applications: [{ source: 'broken.war', context: '/' }], build: { pom: 'pom.xml', context: '/' } } };
      assert.equal(ref.instance.build!.dependencies, undefined);
      const key = manager.key(ref); detectors.set(key, new MissingClassDetector()); busy.add(key);
      try { await assert.rejects(manager.start(ref, { debug }), /startup error|before it became ready/i); }
      finally { busy.delete(key); await queue.flush(key); }
      assert.ok(actions.includes(ref.instance.id));
      assert.ok(detectors.get(key)!.classes.has('fixture.Missing'));
    }
    assert.deepEqual(errors, []);
  } finally { queue.dispose(); await manager.shutdown(); await rm(project, { recursive: true, force: true }); }
});
