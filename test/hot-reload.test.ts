import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config';
import { ReloadScheduler, shouldReload, applyHotSwap, reloadSignature, permitsReload } from '../src/hot-reload';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const instance = { id: 'app', name: 'App', tomcatVersion: '8.5.100', java: { major: 8, release: 'jdk8u432-b06' }, ports: { http: 8080, shutdown: 8005 }, jvmArgs: [], environment: {}, applications: [] };

test('hot reload persists per instance and validates delay, mode and project-relative watch globs', () => {
  const config = (hotReload: unknown) => validateConfig({ version: 1, instances: [{ ...instance, hotReload }] });
  assert.equal(config({ mode: 'redeploy', delayMs: 500 }).instances[0].hotReload?.mode, 'redeploy');
  for (const value of [{ mode: 'unknown' }, { mode: 'hotswap', delayMs: 0 }, { mode: 'redeploy', watch: ['../outside/**'] }, { mode: 'redeploy', watch: ['C:/outside/**'] }]) assert.throws(() => config(value), /reload|glob|delay|mode/i);
});
test('reload filters accept Java saves only in both modes, even with broad watch patterns', () => {
  const options = { mode: 'redeploy' as const };
  assert.equal(shouldReload('src/main/java/example/App.java', options), true);
  assert.equal(shouldReload('pom.xml', options), false);
  for (const mode of ['hotswap', 'redeploy'] as const) {
    for (const file of ['pom.xml', 'src/main/resources/app.xml', 'src/main/resources/app.properties', 'src/main/webapp/index.html', 'src/main/webapp/app.js', 'src/main/webapp/app.css']) assert.equal(shouldReload(file, { mode, watch: ['**'] }), false);
    assert.equal(shouldReload('src/main/java/App.java', { mode, watch: ['**'] }), true);
  }
  for (const file of ['target/classes/App.class', '.tomcat-workbench/app/build/a.war', '.vscode/tomcat.json', '.git/index', 'node_modules/a/src/App.java', '.tomcat-workbench.app.123.generated.pom.xml']) assert.equal(shouldReload(file, { ...options, watch: ['**'] }), false);
  assert.equal(shouldReload('src/test/App.java', { ...options, exclude: ['src/test/**'] }), false);
  assert.equal(shouldReload('src/main/resources/a.xml', { mode: 'hotswap' }), false);
});
test('reload scheduler coalesces bursts and keeps one follow-up while an instance is busy', async () => {
  let busy = true; let count = 0;
  const scheduler = new ReloadScheduler(() => busy, error => { throw error; });
  for (let i = 0; i < 5; i++) scheduler.schedule('app', 15, async () => { count++; });
  await pause(35); assert.equal(count, 0); busy = false; await scheduler.flush('app'); assert.equal(count, 1);
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => release = resolve); const ready = new Promise<void>(resolve => entered = resolve);
  scheduler.schedule('app', 1, async () => { count++; entered(); await gate; }); await ready;
  for (let i = 0; i < 5; i++) scheduler.schedule('app', 1, async () => { count++; });
  release(); await pause(35); assert.equal(count, 3);
  scheduler.schedule('app', 20, async () => { count++; }); scheduler.cancel('app'); await pause(30); assert.equal(count, 3); scheduler.dispose();
});
test('HotSwap never redefines after compile failure or after the owned runtime changes', async () => {
  let current = true; let redefined = false;
  const host = { current: () => current, compile: async () => 2, redefine: async () => { redefined = true; return { changedClasses: ['example.App'] }; } };
  await assert.rejects(applyHotSwap(host), /compil/i); assert.equal(redefined, false);
  await assert.rejects(applyHotSwap({ ...host, compile: async () => { current = false; return 1; } }), /changed|ended/i); assert.equal(redefined, false);
  current = true; assert.equal(await applyHotSwap({ ...host, compile: async () => 1 }), 1);
  await assert.rejects(applyHotSwap({ ...host, compile: async () => 1, redefine: async () => ({ errorMessage: 'schema changed' }) }), /schema changed/);
});

test('reload permits reject Stop/Start replacements and disabling reload during publication', () => {
  const signature = reloadSignature(instance); const expected = { generation: 'one', epoch: 1, signature };
  const running = { generation: 'one', epoch: 1, signature, enabled: true, trusted: true, state: 'running' };
  assert.equal(permitsReload(expected, running, false), true);
  assert.equal(permitsReload(expected, { ...running, generation: 'two' }, false), false);
  const stopped = { ...running, state: 'stopped', generation: undefined };
  assert.equal(permitsReload(expected, stopped, true), true);
  for (const changed of [{ ...stopped, epoch: 2 }, { ...stopped, enabled: false }, { ...stopped, trusted: false }, { ...stopped, signature: 'new' }]) assert.equal(permitsReload(expected, changed, true), false);
  assert.equal(reloadSignature({ ...instance, applications: [{ source: 'new.war', context: '/' }] }), signature);
});

test('HotSwap cancellation during compilation prevents any subsequent redefine', async () => {
  const abort = new AbortController(); let resolveCompile!: (value: number) => void; let redefined = false;
  const compilation = new Promise<number>(resolve => resolveCompile = resolve);
  const pending = applyHotSwap({ current: () => true, compile: () => compilation, redefine: async () => { redefined = true; return {}; } }, abort.signal);
  abort.abort(); await assert.rejects(pending, /cancel/i); resolveCompile(1); await pause(0); assert.equal(redefined, false);
});

test('a manual operation acquiring the guard before a scheduled task starts does not lose the reload', async () => {
  let busy = false; let count = 0; const scheduler = new ReloadScheduler(() => busy, error => { throw error; });
  scheduler.schedule('app', 0, async () => { count++; });
  const pending = scheduler.flush('app'); busy = true; await pending; assert.equal(count, 0);
  busy = false; await scheduler.flush('app'); assert.equal(count, 1); scheduler.dispose();
});
