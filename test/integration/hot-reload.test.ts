import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { DistributionStore } from '../../src/distributions';
import { InstanceManager } from '../../src/processes';
import { cleanEnvironment, type InstanceRef } from '../../src/config';
const exec = promisify(execFile);
async function port(): Promise<number> { const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const number = (server.address() as import('node:net').AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return number; }
test('real Java 8/17 HotSwap updates an HTTP method without replacing the Tomcat JVM', { timeout: 180000 }, async () => {
  const root = path.resolve('.integration-data'); const project = path.join(root, `hotswap-${randomUUID()}`); const storage = path.join(root, 'storage');
  const store = new DistributionStore(path.join(storage, 'distributions')); const java17 = { major: 17, release: (await store.javaVersions(17))[0] }; const java8 = { major: 8, release: (await store.javaVersions(8))[0] };
  const home17 = await store.ensureJava(java17); const home8 = await store.ensureJava(java8); const tomcat = await store.ensureTomcat('8.5.100');
  const manager = new InstanceManager(storage, store, { state: () => {}, log: () => {}, secret: async () => undefined });
  await mkdir(project, { recursive: true }); const probe = path.join(project, 'probe'); await mkdir(probe);
  try {
    await exec(path.join(home17, 'bin/javac.exe'), ['--add-modules=jdk.jdi', '-d', probe, path.resolve('test/integration/HotSwapProbe.java')], { windowsHide: true, env: cleanEnvironment(process.env, {}), timeout: 30000 });
    for (const java of [java8, java17]) {
      const app = `app-${java.major}`; const classes = path.join(project, app, 'WEB-INF/classes'); const source = path.join(project, `Greeting${java.major}.java`); const next = path.join(project, `next-${java.major}`); await mkdir(classes, { recursive: true }); await mkdir(next);
      const code = (value: string) => `public class Greeting${java.major} extends javax.servlet.http.HttpServlet { protected void doGet(javax.servlet.http.HttpServletRequest request, javax.servlet.http.HttpServletResponse response) throws java.io.IOException { response.getWriter().write("${value}"); } }`;
      await writeFile(source, code('before'));
      await exec(path.join(home8, 'bin/javac.exe'), ['-g', '-cp', path.join(tomcat, 'lib/servlet-api.jar'), '-d', classes, source], { windowsHide: true, env: cleanEnvironment(process.env, {}), timeout: 30000 });
      await writeFile(path.join(project, app, 'WEB-INF/web.xml'), `<web-app xmlns="http://xmlns.jcp.org/xml/ns/javaee" version="3.1"><servlet><servlet-name>greeting</servlet-name><servlet-class>Greeting${java.major}</servlet-class></servlet><servlet-mapping><servlet-name>greeting</servlet-name><url-pattern>/</url-pattern></servlet-mapping></web-app>`);
      const ref: InstanceRef = { project, instance: { id: `java${java.major}`, name: 'HotSwap', tomcatVersion: '8.5.100', java, ports: { http: await port(), shutdown: await port() }, debug: { port: await port() }, jvmArgs: [], environment: {}, applications: [{ source: app, context: '/' }] } };
      await manager.start(ref, { debug: true }); const generation = manager.generation(ref); const url = `http://127.0.0.1:${ref.instance.ports.http}/`;
      assert.equal(await (await fetch(url)).text(), 'before');
      await writeFile(source, code('after'));
      await exec(path.join(home8, 'bin/javac.exe'), ['-g', '-cp', path.join(tomcat, 'lib/servlet-api.jar'), '-d', next, source], { windowsHide: true, env: cleanEnvironment(process.env, {}), timeout: 30000 });
      const result = await exec(path.join(home17, 'bin/java.exe'), ['--add-modules=jdk.jdi', '-cp', probe, 'HotSwapProbe', String(ref.instance.debug!.port), `Greeting${java.major}`, path.join(next, `Greeting${java.major}.class`)], { windowsHide: true, env: cleanEnvironment(process.env, {}), timeout: 30000 });
      assert.match(result.stdout, /REDEFINED/); assert.equal(manager.generation(ref), generation); assert.equal(await (await fetch(url)).text(), 'after');
      await manager.stop(ref);
    }
  } finally { await manager.shutdown(); await rm(project, { recursive: true, force: true }); }
});
