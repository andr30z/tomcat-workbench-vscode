import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { prepareBase, initializeTemplates, deployApplications, inspectServer, javaArguments, assertPortsAvailable, runtimeDirectory } from '../src/runtime';
import { lease } from '../src/files';
import { resolveSecrets, type Instance } from '../src/config';

const instance = (): Instance => ({ id: 'demo', name: 'Demo', tomcatVersion: '10.1.34', java: { major: 17, release: 'jdk-17.0.13+11' }, ports: { http: 18080, shutdown: 18005 }, jvmArgs: ['-Xmx512m'], environment: {}, applications: [] });
const xml = '<Server port="8005" shutdown="SHUTDOWN"><Service name="Catalina"><Connector port="8080" protocol="HTTP/1.1"/><Engine name="Catalina" defaultHost="localhost"><Host name="localhost" appBase="webapps"/></Engine></Service></Server>';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'tw-espaço-'));
  const home = path.join(root, 'home'); const project = path.join(root, 'projeto'); const base = path.join(root, 'base');
  await mkdir(path.join(home, 'conf'), { recursive: true }); await mkdir(project);
  await writeFile(path.join(home, 'conf/server.xml'), xml); await writeFile(path.join(home, 'conf/web.xml'), '<web-app/>');
  return { root, home, project, base };
}
test('prepares isolated configuration, ports, directories and local shutdown token', async () => {
  const f = await fixture();
  try {
    const ports = await prepareBase(f.home, f.base, f.project, instance(), 'private-token');
    assert.deepEqual(ports, [18005, 18080]);
    const server = await readFile(path.join(f.base, 'conf/server.xml'), 'utf8');
    assert.match(server, /shutdown="private-token"/); assert.match(server, /address="127.0.0.1"/);
    assert.equal(await readFile(path.join(f.home, 'conf/server.xml'), 'utf8'), xml);
    assert.ok((await readdir(f.base)).includes('temp'));
    await prepareBase(f.home, f.base, f.project, { ...instance(), tomcatVersion: '10.1.35' }, 'another-token');
    assert.equal((await readdir(path.join(f.base, 'backups'))).length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('copies project-provided shared JARs into the instance without modifying their sources', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.project, 'drivers')); await writeFile(path.join(f.project, 'drivers/database.jar'), 'driver');
    await prepareBase(f.home, f.base, f.project, { ...instance(), libraries: ['drivers/database.jar'] }, 'token');
    assert.equal(await readFile(path.join(f.base, 'lib/database.jar'), 'utf8'), 'driver');
    await prepareBase(f.home, f.base, f.project, instance(), 'token');
    assert.deepEqual(await readdir(path.join(f.base, 'lib')), []);
    assert.equal(await readFile(path.join(f.project, 'drivers/database.jar'), 'utf8'), 'driver');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('native templates preserve edits but reject managed conflicts and family changes', async () => {
  const f = await fixture();
  try {
    const i = { ...instance(), configDir: '.vscode/tomcat/demo' };
    await initializeTemplates(f.home, f.project, i);
    const file = path.join(f.project, i.configDir, 'server.xml');
    assert.match(await readFile(file, 'utf8'), /\$\{http.port\}/);
    await prepareBase(f.home, f.base, f.project, i, 'token');
    await writeFile(file, (await readFile(file, 'utf8')).replace('${http.port}', '19090'));
    await assert.rejects(prepareBase(f.home, f.base, f.project, i, 'token'), /conflict/i);
    await assert.rejects(prepareBase(f.home, f.base, f.project, { ...i, tomcatVersion: '11.0.2' }, 'token'), /family/i);
    assert.match(await readFile(file, 'utf8'), /19090/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('native templates cannot replace the project control directory', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.project, '.vscode')); await writeFile(path.join(f.project, '.vscode/tomcat.json'), 'important-config');
    await assert.rejects(initializeTemplates(f.home, f.project, { ...instance(), configDir: '.vscode' }), /dedicated|contain/i);
    assert.equal(await readFile(path.join(f.project, '.vscode/tomcat.json'), 'utf8'), 'important-config');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('only one contender reclaims an abandoned lease', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tw-stale-')); const lock = path.join(root, 'lock');
  try {
    await mkdir(lock); await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, claim: 'dead-owner' }));
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => lease(lock)));
    const winners = results.filter((r): r is PromiseFulfilledResult<() => Promise<void>> => r.status === 'fulfilled');
    assert.equal(winners.length, 1);
    for (const winner of winners) await winner.value();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a live Maven child prevents reclaiming a lease after its extension host exits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tw-child-lock-')); const lock = path.join(root, 'lock');
  try { await mkdir(lock); await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, claim: 'old-host', children: [process.pid] })); await assert.rejects(lease(lock), /in use/i); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test('rejects malformed XML, external entities and conflicting connector ports', () => {
  assert.throws(() => inspectServer('<Server>', instance()), /XML/i);
  assert.throws(() => inspectServer('<!DOCTYPE Server SYSTEM "file:///secret"><Server/>', instance()), /DOCTYPE/i);
  assert.throws(() => inspectServer(xml, instance()), /conflict/i);
});
test('deploys real WARs/directories and removes obsolete deployments without touching source', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.project, 'hello.war'), 'war-data');
    await mkdir(path.join(f.project, 'exploded')); await writeFile(path.join(f.project, 'exploded/index.html'), 'hello');
    const i = { ...instance(), applications: [{ source: 'hello.war', context: '/hello' }, { source: 'exploded', context: '/' }] };
    await deployApplications(f.project, f.base, i.applications);
    assert.equal(await readFile(path.join(f.base, 'webapps/hello.war'), 'utf8'), 'war-data');
    assert.equal(await readFile(path.join(f.base, 'webapps/ROOT/index.html'), 'utf8'), 'hello');
    await assert.rejects(deployApplications(f.project, f.base, [{ source: 'missing.war', context: '/bad' }]), /ENOENT/);
    assert.equal(await readFile(path.join(f.base, 'webapps/hello.war'), 'utf8'), 'war-data');
    await deployApplications(f.project, f.base, []);
    assert.deepEqual(await readdir(path.join(f.base, 'webapps')), []);
    assert.equal(await readFile(path.join(f.project, 'hello.war'), 'utf8'), 'war-data');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('builds shell-free bootstrap arguments and isolates Java paths', () => {
  const args = javaArguments('C:\\Tomcat Home', 'C:\\base á', instance(), 'ownership-token', 'start');
  assert.ok(args.includes('-Dcatalina.base=C:\\base á'));
  assert.ok(args.includes('-Dtomcat.workbench.token=ownership-token'));
  assert.equal(args.at(-1), 'start'); assert.ok(args.includes('-Xmx512m'));
  assert.notEqual(runtimeDirectory('store', 'C:\\a', 'demo'), runtimeDirectory('store', 'C:\\b', 'demo'));
});
test('Tomcat 8.5 on Java 8 uses Bootstrap without unsupported module options', () => {
  const args = javaArguments('C:\\Tomcat 8.5', 'C:\\base', { ...instance(), tomcatVersion: '8.5.100', java: { major: 8, release: 'jdk8u432-b06' } }, 'token', 'start');
  assert.equal(args.some(arg => arg.startsWith('--add-opens')), false);
  assert.ok(args.includes('org.apache.catalina.startup.Bootstrap'));
  assert.equal(args.at(-1), 'start');
});
test('port validation detects occupied ports and never changes configured values', async () => {
  const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as import('node:net').AddressInfo).port;
  try { await assert.rejects(assertPortsAvailable([port]), /port.*in use/i); }
  finally { await new Promise<void>(r => server.close(() => r())); }
});
test('exclusive leases reject another operation and release cleanly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tw-lock-'));
  try { const unlock = await lease(path.join(root, 'lock')); await assert.rejects(lease(path.join(root, 'lock')), /in use/i); await unlock(); const again = await lease(path.join(root, 'lock')); await again(); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test('missing secrets fail before launch and supplied secrets expand only locally', async () => {
  await assert.rejects(resolveSecrets({ PASSWORD: '${secret:db}' }, async () => undefined), /Missing secret db/);
  assert.deepEqual(await resolveSecrets({ PASSWORD: '${secret:db}', ENV: 'dev' }, async () => 'private'), { PASSWORD: 'private', ENV: 'dev' });
});
