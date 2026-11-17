import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ZipFile } from 'yazl';
import { MissingClassDetector, findClassProviders, dependencyVersions, suggestedBuild, recentConsole } from '../src/dependency-diagnostics';
import { generateBuildPom } from '../src/maven-pom';
import { DOMParser } from '@xmldom/xmldom';

async function jar(root: string, artifact: string, version: string, entries: string[], group = 'example'): Promise<void> {
  const directory = path.join(root, ...group.split('.'), artifact, version); await mkdir(directory, { recursive: true });
  const zip = new ZipFile(); for (const entry of entries) zip.addBuffer(Buffer.from('class'), entry);
  const chunks: Buffer[] = []; zip.outputStream.on('data', b => chunks.push(b));
  const done = new Promise<void>(resolve => zip.outputStream.on('end', resolve)); zip.end(); await done;
  await writeFile(path.join(directory, `${artifact}-${version}.jar`), Buffer.concat(chunks));
}
test('missing classes are parsed across chunks, deduplicated and initialization errors are ignored', () => {
  const detector = new MissingClassDetector();
  assert.deepEqual(detector.push('Caused by: java.lang.NoClassDefFoundErr'), []);
  assert.deepEqual(detector.push('or: org/apache/http/conn/HttpClientConnectionManager\n'), ['org.apache.http.conn.HttpClientConnectionManager']);
  assert.deepEqual(detector.push('java.lang.ClassNotFoundException: org.apache.http.conn.HttpClientConnectionManager\n'), []);
  assert.deepEqual(detector.push('java.lang.NoClassDefFoundError: Could not initialize class example.Broken\n'), []);
  assert.deepEqual(detector.push('java.lang.ClassNotFoundException: example.Outer$Inner\n'), ['example.Outer$Inner']);
  assert.deepEqual(detector.push('java.lang.ClassNotFoundException: example.LastLine', true), ['example.LastLine']);
});
test('cached JAR search uses exact class entries and prefers the effective managed version', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tw-class-search-'));
  try {
    await jar(root, 'client', '1', ['example/Missing.class']); await jar(root, 'client', '2', ['example/Missing.class']);
    await jar(root, 'unrelated', '1', ['example/MissingOther.class']);
    await jar(root, 'tomcat-embed-core', '1', ['example/Missing.class'], 'org.apache.tomcat.embed');
    await mkdir(path.join(root, 'example/broken/1'), { recursive: true }); await writeFile(path.join(root, 'example/broken/1/broken-1.jar'), 'invalid zip');
    const versions = dependencyVersions('<project><dependencyManagement><dependencies><dependency><groupId>example</groupId><artifactId>client</artifactId><version>2</version></dependency></dependencies></dependencyManagement></project>');
    const found = await findClassProviders(root, ['example.Missing'], versions);
    assert.deepEqual(found.providers.get('example.Missing')!.map(p => [p.artifactId, p.version, p.managed]), [['client', '2', true], ['client', '1', false]]);
    assert.equal(found.unreadable, 1);
    const abort = new AbortController(); abort.abort(); await assert.rejects(findClassProviders(root, ['example.Missing'], versions, abort.signal), /cancel/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('dependency suggestions preserve settings and existing overrides and reject conflicting choices', () => {
  const build = { pom: 'pom.xml', context: '/', settings: 'C:/settings.xml', dependencies: [{ groupId: 'existing', artifactId: 'library', version: '1' }] };
  const suggestion = { groupId: 'example', artifactId: 'client', version: '2', managed: true };
  const updated = suggestedBuild(build, [suggestion]);
  assert.equal(updated.settings, build.settings); assert.equal(build.dependencies.length, 1);
  assert.deepEqual(updated.dependencies![1], { groupId: 'example', artifactId: 'client', version: '2', scope: 'compile' });
  assert.throws(() => suggestedBuild(build, [suggestion, { ...suggestion, version: '3' }]), /conflict/i);
  assert.throws(() => suggestedBuild({ ...build, excludeArtifacts: ['client'] }, [suggestion]), /excluded/i);
  assert.deepEqual(suggestedBuild(build, [{ ...suggestion, managed: false }]).dependencies![1], { groupId: 'example', artifactId: 'client', version: '2', scope: 'compile' });
  assert.equal(dependencyVersions('<project><dependencies><dependency><groupId>example</groupId><artifactId>client</artifactId><version>3</version></dependency></dependencies></project>').size, 0);
});

test('diagnosis can recover missing classes from the bounded persisted console after a reload', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tw-console-'));
  try {
    const file = path.join(root, 'console.log');
    assert.equal(await recentConsole(file), '');
    await writeFile(file, 'x'.repeat(2 * 1024 * 1024) + '\njava.lang.ClassNotFoundException: example.Missing\n');
    const tail = await recentConsole(file); assert.ok(Buffer.byteLength(tail) <= 1024 * 1024);
    assert.deepEqual(new MissingClassDetector().push(tail, true), ['example.Missing']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('classified or non-JAR managed dependencies cannot supply the main JAR version', () => {
  const entry = '<dependency><groupId>example</groupId><artifactId>client</artifactId><version>2</version>TYPE</dependency>';
  for (const type of ['<classifier>tests</classifier>', '<type>test-jar</type>', '<type>pom</type>']) {
    assert.equal(dependencyVersions(`<project><dependencyManagement><dependencies>${entry.replace('TYPE', type)}</dependencies></dependencyManagement></project>`).size, 0);
  }
});

test('a confirmed managed version replaces an older direct version in the generated POM', () => {
  const dependency = (version: string) => `<dependency><groupId>example</groupId><artifactId>client</artifactId><version>${version}</version></dependency>`;
  const source = `<project><modelVersion>4.0.0</modelVersion><packaging>war</packaging><dependencyManagement><dependencies>${dependency('2')}</dependencies></dependencyManagement><dependencies>${dependency('1')}</dependencies></project>`;
  const build = suggestedBuild({ pom: 'pom.xml', context: '/' }, [{ groupId: 'example', artifactId: 'client', version: '2', managed: true }]);
  const doc = new DOMParser().parseFromString(generateBuildPom(source, '/build', build));
  const direct = Array.from(doc.documentElement.childNodes).find(n => n.nodeName === 'dependencies') as Element;
  assert.equal(direct.getElementsByTagName('version')[0].textContent, '2');
});
