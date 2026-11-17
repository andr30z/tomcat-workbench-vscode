import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ZipFile } from 'yazl';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { DistributionStore, extractZip, verifyChecksum, parseTomcatVersions, javaArtifact, tomcatDownloadUrls } from '../src/distributions';

test('parses only stable Tomcat versions of the requested family', () => {
  assert.deepEqual(parseTomcatVersions('<a href="v10.1.9/">x</a><a href="v10.1.34/">x</a><a href="v10.1.34/">x</a><a href="v10.1.35-M1/">x</a><a href="v11.0.2/">x</a>', '10.1'), ['10.1.34', '10.1.9']);
});
test('Tomcat 8 archive catalog separates 8.5 from 8.0 and sorts versions numerically', () => {
  assert.deepEqual(parseTomcatVersions('<a href="v8.0.53/">x</a><a href="v8.5.99/">x</a><a href="v8.5.100/">x</a><a href="v8.5.100/">x</a><a href="v8.5.101-M1/">x</a>', '8.5'), ['8.5.100', '8.5.99']);
});
test('archived Tomcat 8.5 downloads bypass the current mirror even if it retains checksum metadata', () => {
  assert.deepEqual(tomcatDownloadUrls('8.5.100'), ['https://archive.apache.org/dist/tomcat/tomcat-8/v8.5.100/bin/apache-tomcat-8.5.100.zip']);
  assert.equal(tomcatDownloadUrls('9.0.98')[0], 'https://dlcdn.apache.org/tomcat/tomcat-9/v9.0.98/bin/apache-tomcat-9.0.98.zip');
});
test('exact Adoptium release lookup accepts its object response and rejects a different release', () => {
  const response = { release_name: 'jdk-17.0.13+11', binaries: [{ architecture: 'x64', image_type: 'jdk', package: { link: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.13%2B11/jdk.zip', checksum: 'a'.repeat(64) } }] };
  assert.equal(javaArtifact(response, 'jdk-17.0.13+11', 'x64').algorithm, 'sha256');
  assert.throws(() => javaArtifact(response, 'jdk-17.0.14+7', 'x64'), /No Windows JDK/i);
});
test('checksum mismatch is rejected before installing artifacts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tw-hash-'));
  try {
    const file = path.join(root, 'download.zip'); await writeFile(file, 'payload');
    await verifyChecksum(file, createHash('sha256').update('payload').digest('hex'), 'sha256');
    await assert.rejects(verifyChecksum(file, '0'.repeat(64), 'sha256'), /checksum/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('extracts real ZIP contents into the destination', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tw-zip-'));
  try {
    const zip = new ZipFile(); zip.addBuffer(Buffer.from('hello'), 'tomcat/conf/server.xml'); zip.end();
    await pipeline(zip.outputStream, createWriteStream(path.join(root, 'archive.zip')));
    await extractZip(path.join(root, 'archive.zip'), path.join(root, 'output'));
    assert.equal(await readFile(path.join(root, 'output/tomcat/conf/server.xml'), 'utf8'), 'hello');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('offline cache refuses unmarked or incomplete distributions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tw-cache-'));
  try {
    const store = new DistributionStore(root);
    assert.equal(await store.cachedTomcat('9.0.98'), undefined);
    await mkdir(path.join(root, 'tomcat/9.0.98'), { recursive: true });
    await writeFile(path.join(root, 'tomcat/9.0.98/.complete.json'), '{}');
    assert.equal(await store.cachedTomcat('9.0.98'), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('ZIP extraction rejects traversal and symbolic links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tw-unsafe-'));
  try {
    const zip = new ZipFile(); zip.addBuffer(Buffer.from('x'), 'aa/x'); zip.end();
    await pipeline(zip.outputStream, createWriteStream(path.join(root, 'safe.zip')));
    const contents = await readFile(path.join(root, 'safe.zip'));
    for (let pos = 0; (pos = contents.indexOf('aa/x', pos)) !== -1; pos += 4) contents.write('../x', pos);
    await writeFile(path.join(root, 'unsafe.zip'), contents);
    await assert.rejects(extractZip(path.join(root, 'unsafe.zip'), path.join(root, 'out')), /invalid|unsafe/i);
    const symlink = new ZipFile(); symlink.addBuffer(Buffer.from('../escape'), 'link', { mode: 0o120777 }); symlink.end();
    await pipeline(symlink.outputStream, createWriteStream(path.join(root, 'symlink.zip')));
    await assert.rejects(extractZip(path.join(root, 'symlink.zip'), path.join(root, 'out2')), /symbolic/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
