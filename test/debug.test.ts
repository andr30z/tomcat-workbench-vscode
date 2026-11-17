import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DebugController, managedDebugArgument, attachConfiguration, nextDebugPort, type DebugHost, type DebugRuntime } from '../src/debug';
import { validateConfig, type InstanceRef } from '../src/config';

function ref(): InstanceRef { return { project: 'C:\\project', instance: { id: 'app', name: 'App', tomcatVersion: '8.5.100', java: { major: 8, release: 'jdk8u432-b06' }, ports: { http: 8080, shutdown: 8005 }, jvmArgs: [], environment: {}, applications: [], debug: { port: 5005 } } }; }
test('managed JDWP binds loopback with Java 8-compatible syntax and never suspends startup', () => {
  assert.equal(managedDebugArgument(ref().instance), '-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:5005');
  assert.throws(() => managedDebugArgument({ ...ref().instance, jvmArgs: ['-agentlib:jdwp=transport=dt_socket,address=6000'] }), /jvmArgs/i);
  assert.throws(() => managedDebugArgument({ ...ref().instance, jvmArgs: ['-Xrunjdwp:transport=dt_socket,address=6000'] }), /jvmArgs/i);
});
test('debug configuration persists, validates ports against every declared service and validates source paths', () => {
  const i = ref().instance;
  assert.equal(validateConfig({ version: 1, instances: [i] }).instances[0].debug?.port, 5005);
  for (const port of [8080, 8005, 0, 65536, 5005.5]) assert.throws(() => validateConfig({ version: 1, instances: [{ ...i, debug: { port } }] }), /port/i);
  assert.throws(() => validateConfig({ version: 1, instances: [i, { ...i, id: 'other', ports: { http: 9080, shutdown: 9005 } }] }), /port/i);
  assert.throws(() => validateConfig({ version: 1, instances: [{ ...i, debug: { port: 5005, sourcePaths: ['../outside'] } }] }), /source|path/i);
  assert.equal(nextDebugPort([{ ...i, debug: { port: 5005 } }, { ...i, ports: { http: 5006, shutdown: 9005 } }]), 5007);
});
test('attach uses loopback, instance ownership and project-relative source paths', () => {
  const value = ref(); value.instance.debug = { port: 6006, projectName: 'backend', sourcePaths: ['src/main/java'] };
  const config = attachConfiguration(value, 'owned-key', 7007);
  assert.equal(config.type, 'java'); assert.equal(config.request, 'attach'); assert.equal(config.hostName, '127.0.0.1');
  assert.equal(config.port, 7007); assert.equal(config.projectName, 'backend');
  assert.deepEqual(config.sourcePaths, ['C:\\project\\src\\main\\java']); assert.equal(config.tomcatWorkbenchKey, 'owned-key');
});
function fixture() {
  let running = false; let port: number | undefined; let launches = 0; let stops = 0; let generation: string | undefined;
  let available = true; let attachOK = true; let confirm = true; let attachedPort: number | undefined; let detaches = 0;
  const runtime: DebugRuntime = {
    key: () => 'key', recover: async () => running, debugPort: () => port,
    generation: () => generation, state: () => running ? 'running' : 'stopped',
    start: async (value, options) => { running = true; port = options?.debug ? value.instance.debug?.port ?? 5005 : undefined; generation = `run-${++launches}`; },
    stop: async (_value, expected) => { if (expected && expected !== generation) return; running = false; port = undefined; generation = undefined; stops++; }
  };
  const host: DebugHost = {
    available: async () => { if (!available) throw new Error('Debugger for Java missing'); },
    attach: async (_value, _key, value) => { attachedPort = value; return attachOK; },
    detach: async () => { detaches++; }, confirmRestart: async () => confirm
  };
  return { controller: new DebugController(runtime, host), runtime, host, setAvailable: (v: boolean) => available = v, setAttachOK: (v: boolean) => attachOK = v, setConfirm: (v: boolean) => confirm = v, state: () => ({ running, port, launches, stops, attachedPort, detaches }) };
}
test('missing Java debugger leaves a stopped server stopped', async () => {
  const f = fixture(); f.setAvailable(false); await assert.rejects(f.controller.start(ref()), /Debugger for Java/);
  assert.equal(f.state().launches, 0);
});
test('debug starts once, attaches to its actual port, and reattaches without restarting', async () => {
  const f = fixture(); await f.controller.start(ref());
  const changed = ref(); changed.instance.debug = { port: 6006 }; await f.controller.start(changed);
  assert.equal(f.state().launches, 1); assert.equal(f.state().attachedPort, 5005);
  await f.controller.stopDebug(ref()); assert.equal(f.state().running, true);
});
test('normal server is restarted only after the restart choice is accepted', async () => {
  const f = fixture(); await f.runtime.start(ref()); f.setConfirm(false);
  assert.equal(await f.controller.start(ref()), false); assert.equal(f.state().stops, 0);
  f.setConfirm(true); await f.controller.start(ref()); assert.equal(f.state().port, 5005); assert.equal(f.state().stops, 1);
});
test('failed attachment stops a newly launched JVM but preserves an existing debug server', async () => {
  const f = fixture(); f.setAttachOK(false); await assert.rejects(f.controller.start(ref()), /attach/i);
  assert.equal(f.state().running, false);
  f.setAttachOK(true); await f.controller.start(ref()); f.setAttachOK(false);
  await assert.rejects(f.controller.start(ref()), /attach/i); assert.equal(f.state().running, true);
});
test('explicit restart reconnects and uses the current configured debug port', async () => {
  const f = fixture(); await f.controller.start(ref()); const changed = ref(); changed.instance.debug = { port: 6006 };
  await f.controller.start(changed, true); assert.equal(f.state().launches, 2); assert.equal(f.state().attachedPort, 6006);
});
test('a delayed attachment cannot stop or attach to a replacement runtime', async () => {
  const f = fixture(); let entered!: () => void; let release!: (value: boolean) => void;
  const ready = new Promise<void>(resolve => entered = resolve);
  f.host.attach = async () => { entered(); return new Promise<boolean>(resolve => release = resolve); };
  const operation = f.controller.start(ref()); await ready;
  await f.runtime.stop(ref()); await f.runtime.start(ref()); release(true);
  await assert.rejects(operation, /changed|ended/i);
  assert.equal(f.state().running, true); assert.equal(f.state().port, undefined); assert.equal(f.state().stops, 1);
});
test('cleanup does not stop a runtime replaced while debugger detach is pending', async () => {
  const f = fixture(); f.setAttachOK(false); let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => entered = resolve);
  f.host.detach = async () => { entered(); await new Promise<void>(resolve => release = resolve); };
  const operation = f.controller.start(ref()); await ready;
  await f.runtime.stop(ref()); await f.runtime.start(ref()); release();
  await assert.rejects(operation, /attach/i); assert.equal(f.state().running, true); assert.equal(f.state().stops, 1);
});
