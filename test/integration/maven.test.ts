import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createServer } from 'node:net';
import { ZipFile } from 'yazl';
import * as yauzl from 'yauzl';
import { DistributionStore } from '../../src/distributions';
import { MavenBuilder } from '../../src/maven';
import { findClassProviders, dependencyVersions } from '../../src/dependency-diagnostics';
import { ReloadScheduler } from '../../src/hot-reload';
import { InstanceManager } from '../../src/processes';
import type { InstanceRef } from '../../src/config';
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
async function port(): Promise<number> { const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const value = (server.address() as import('node:net').AddressInfo).port; await new Promise<void>(r => server.close(() => r())); return value; }
async function artifact(repo: string, group: string, name: string, version: string) {
  const folder = path.join(repo, group.replaceAll('.', '/'), name, version); await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `${name}-${version}.pom`), `<project><modelVersion>4.0.0</modelVersion><groupId>${group}</groupId><artifactId>${name}</artifactId><version>${version}</version></project>`);
  const zip = new ZipFile(); zip.addBuffer(Buffer.from('fixture'), `${name}.txt`); zip.addBuffer(Buffer.from('fixture-class-entry'), `fixture/${name.replaceAll('-', '_')}.class`); zip.end();
  await pipeline(zip.outputStream, createWriteStream(path.join(folder, `${name}-${version}.jar`)));
}
function entries(file: string): Promise<string[]> { return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (error, zip) => {
  if (error || !zip) { reject(error); return; } const values: string[] = [];
  zip.on('error', reject); zip.on('end', () => resolve(values)); zip.on('entry', entry => { values.push(entry.fileName); zip.readEntry(); }); zip.readEntry();
})); }
test('managed Maven builds a complete isolated WAR, includes provided libraries, excludes compile-scope Tomcat and deploys successfully', { skip: process.platform !== 'win32', timeout: 900000 }, async () => {
  const root = path.resolve('.integration-data'); const project = path.join(root, `maven espaço-${randomUUID()}`); const repository = path.join(root, 'maven-repository');
  const storage = path.join(root, 'storage'); const logs: string[] = [];
  const store = new DistributionStore(path.join(storage, 'distributions'), message => console.log(message));
  const java = { major: 8, release: (await store.javaVersions(8))[0] }; await store.ensureJava(java); await store.ensureMaven('3.9.16');
  await mkdir(path.join(project, '.mvn'), { recursive: true }); await mkdir(path.join(project, 'src/main/webapp'), { recursive: true }); await mkdir(path.join(project, 'src/main/java/fixture'), { recursive: true }); await mkdir(path.join(project, 'target'));
  await writeFile(path.join(project, 'target/keep.txt'), 'normal-target-is-preserved');
  await writeFile(path.join(project, 'src/main/webapp/index.html'), 'managed-maven-war');
  await writeFile(path.join(project, 'src/main/java/fixture/Hello.java'), 'package fixture; public class Hello { public static String value() { return "hello"; } }');
  await artifact(repository, 'fixture', 'provided-lib', '1'); await artifact(repository, 'fixture', 'extra-lib', '1'); await artifact(repository, 'org.apache.tomcat.embed', 'tomcat-embed-core', '0.0-fixture');
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY;
  let proxyXml = ''; let proxyAuth = false;
  if (proxy) { const u = new URL(proxy); proxyAuth = !!u.username; proxyXml = `<proxies><proxy><id>test-environment</id><active>true</active><protocol>http</protocol><host>${escape(u.hostname)}</host><port>${u.port || '80'}</port>${u.username ? `<username>${escape(decodeURIComponent(u.username))}</username><password>${escape(decodeURIComponent(u.password))}</password>` : ''}<nonProxyHosts>localhost|127.0.0.1</nonProxyHosts></proxy></proxies>`; }
  await writeFile(path.join(project, '.mvn/settings.xml'), `<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0"><localRepository>${escape(repository.replaceAll('\\', '/'))}</localRepository>${proxyXml}</settings>`);
  const pom = `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>fixture</groupId><artifactId>managed-app</artifactId><version>1</version><packaging>war</packaging><properties><maven.compiler.source>1.8</maven.compiler.source><maven.compiler.target>1.8</maven.compiler.target></properties><dependencies><dependency><groupId>fixture</groupId><artifactId>provided-lib</artifactId><version>1</version><scope>provided</scope></dependency><dependency><groupId>org.apache.tomcat.embed</groupId><artifactId>tomcat-embed-core</artifactId><version>0.0-fixture</version></dependency></dependencies><profiles><profile><id>local</id><build><directory>\${project.basedir}/target</directory><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><executions><execution><id>default-compile</id><configuration><outputDirectory>\${project.basedir}/target/classes</outputDirectory></configuration></execution></executions></plugin></plugins></build></profile></profiles></project>`;
  await writeFile(path.join(project, 'pom.xml'), pom);
  const ref: InstanceRef = { project, instance: { id: 'maven', name: 'Maven', tomcatVersion: '8.5.100', java, ports: { http: await port(), shutdown: await port() }, jvmArgs: ['-Xms32m', '-Xmx128m'], environment: {}, applications: [], build: { pom: 'pom.xml', context: '/', settings: '.mvn/settings.xml', profiles: ['local'], dependencies: [{ groupId: 'fixture', artifactId: 'extra-lib', version: '1' }], ...(proxyAuth ? { jvmArgs: ['-Djdk.http.auth.tunneling.disabledSchemes='] } : {}) } } };
  const builder = new MavenBuilder(storage, store, text => logs.push(text));
  const manager = new InstanceManager(storage, store, { state: () => {}, log: () => {}, secret: async () => undefined });
  try {
    const diagnosis = await builder.dependencyContext(ref);
    assert.equal(path.resolve(diagnosis.repository), path.resolve(repository));
    assert.match(diagnosis.pom, /provided-lib/);
    const providers = await findClassProviders(diagnosis.repository, ['fixture.extra_lib'], dependencyVersions(diagnosis.pom));
    assert.equal(providers.providers.get('fixture.extra_lib')?.[0].artifactId, 'extra-lib');
    const result = await builder.build(ref); const war = path.join(project, result.source); const files = await entries(war);
    assert.ok(files.includes('WEB-INF/lib/provided-lib-1.jar')); assert.ok(files.includes('WEB-INF/lib/extra-lib-1.jar')); assert.ok(files.includes('WEB-INF/classes/fixture/Hello.class'));
    assert.equal(files.some(file => file.includes('tomcat-embed-core')), false);
    assert.equal(await readFile(path.join(project, 'pom.xml'), 'utf8'), pom); assert.equal(await readFile(path.join(project, 'target/keep.txt'), 'utf8'), 'normal-target-is-preserved'); await assert.rejects(stat(path.join(project, 'target/classes')), /ENOENT/);
    ref.instance.applications = [{ source: result.source, context: '/' }]; await manager.start(ref);
    assert.equal(await (await fetch(`http://127.0.0.1:${ref.instance.ports.http}/`)).text(), 'managed-maven-war');
    const reloadErrors: unknown[] = []; let reloads = 0;
    const scheduler = new ReloadScheduler(() => false, error => reloadErrors.push(error));
    const reload = async () => { const next = await builder.build(ref); reloads++; await manager.stop(ref); ref.instance.applications = [{ source: next.source, context: '/' }]; await manager.start(ref); };
    const generation = manager.generation(ref);
    await writeFile(path.join(project, 'src/main/webapp/index.html'), 'managed-maven-updated');
    for (let i = 0; i < 5; i++) scheduler.schedule('app', 5, reload);
    await new Promise(resolve => setTimeout(resolve, 20)); await scheduler.flush('app');
    assert.equal(reloads, 1, reloadErrors.map(String).join('\n')); assert.notEqual(manager.generation(ref), generation);
    assert.equal(await (await fetch(`http://127.0.0.1:${ref.instance.ports.http}/`)).text(), 'managed-maven-updated');
    await writeFile(path.join(project, 'src/main/java/fixture/Hello.java'), 'intentionally invalid Java source');
    const successfulGeneration = manager.generation(ref);
    scheduler.schedule('app', 1, reload); await new Promise(resolve => setTimeout(resolve, 20)); await scheduler.flush('app'); scheduler.dispose();
    assert.equal(reloadErrors.length, 1); assert.match(String(reloadErrors[0]), /Maven build failed/);
    assert.equal(manager.generation(ref), successfulGeneration);
    assert.equal(await (await fetch(`http://127.0.0.1:${ref.instance.ports.http}/`)).text(), 'managed-maven-updated');
    assert.ok((await stat(war)).size > 0);
  } catch (error) { console.error(logs.join('').split(/\r?\n/).slice(-35).join('\n')); throw error; }
  finally { await manager.shutdown(); await manager.cleanup(ref); await rm(project, { recursive: true, force: true }); }
});
