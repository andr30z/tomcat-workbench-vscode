import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectRepository } from '../src/projects';
import { lease } from '../src/files';
import { runtimeDirectory } from '../src/runtime';

test('persists validated project configuration atomically and retains last valid file on error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tw-project-'));
  try {
    const repo = new ProjectRepository(path.join(root, 'storage'));
    assert.deepEqual(await repo.read(root), { version: 1, instances: [] });
    await repo.update(root, config => { config.instances.push({ id: 'demo', name: 'Demo', tomcatVersion: '9.0.98', java: { major: 17, release: 'jdk-17.0.13+11' }, ports: { http: 8080, shutdown: 8005 }, jvmArgs: [], environment: {}, applications: [] }); return config; });
    const previous = await readFile(path.join(root, '.vscode/tomcat.json'), 'utf8');
    await assert.rejects(repo.update(root, config => { config.instances[0].ports.http = 0; return config; }), /port/i);
    assert.equal(await readFile(path.join(root, '.vscode/tomcat.json'), 'utf8'), previous);
    assert.equal((await repo.read(root)).instances.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('an instance named project-config cannot collide with configuration updates', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tw-namespaces-')); const storage = path.join(root, 'storage');
  try {
    const release = await lease(`${runtimeDirectory(storage, root, 'project-config')}.lock`);
    try { await new ProjectRepository(storage).update(root, config => config); }
    finally { await release(); }
    assert.equal(JSON.parse(await readFile(path.join(root, '.vscode/tomcat.json'), 'utf8')).version, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
