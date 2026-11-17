import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeferredDependencyActions, scheduleDependencyRecovery } from '../src/dependency-actions';
import { MissingClassDetector } from '../src/dependency-diagnostics';
import { validateBuild } from '../src/config';

test('startup failure without dependency overrides offers diagnosis after Build Run/Debug releases its operation', async () => {
  for (const action of ['buildRun', 'buildDebug']) {
    const build = validateBuild({ pom: 'pom.xml', context: '/' }); assert.equal(build.dependencies, undefined);
    const busy = new Set([action]); const events: string[] = [];
    const queue = new DeferredDependencyActions(key => busy.has(key), error => { throw error; });
    const detector = new MissingClassDetector();
    assert.deepEqual(detector.push('Caused by: java.lang.NoClassDefFoundError: org/apache/http/conn/HttpClientConnectionManager\n'), ['org.apache.http.conn.HttpClientConnectionManager']);
    queue.enqueue(action, async () => { events.push('offer'); queue.enqueue(action, async () => { events.push('diagnose'); }); });
    await queue.flush(action); assert.deepEqual(events, []);
    busy.delete(action); await queue.flush(action);
    assert.deepEqual(events, ['offer', 'diagnose']);
  }
});
test('clicking a diagnosis offer while another build starts defers the diagnostic instead of losing it', async () => {
  let busy = false; const events: string[] = [];
  const queue = new DeferredDependencyActions(() => busy, error => { throw error; });
  queue.enqueue('app', async () => { events.push('offer'); busy = true; queue.enqueue('app', async () => { events.push('diagnose'); }); });
  await queue.flush('app'); assert.deepEqual(events, ['offer']);
  busy = false; await queue.flush('app'); assert.deepEqual(events, ['offer', 'diagnose']);
  queue.dispose(); queue.enqueue('app', async () => { events.push('unexpected'); }); await queue.flush('app');
  assert.deepEqual(events, ['offer', 'diagnose']);
});

test('diagnosis is requeued when a new build acquires the operation during asynchronous instance selection', async () => {
  let busy = false; const events: string[] = []; let selected!: () => void;
  const selection = new Promise<void>(resolve => selected = resolve);
  const queue = new DeferredDependencyActions(() => busy, error => { throw error; });
  queue.enqueue('app', async () => {
    await selection;
    if (busy) { queue.enqueue('app', async () => { events.push('diagnose'); }); return; }
    events.push('diagnose');
  });
  const selecting = queue.flush('app'); busy = true; selected(); await selecting;
  assert.deepEqual(events, []);
  busy = false; await queue.flush('app'); assert.deepEqual(events, ['diagnose']);
});

test('Build Run/Debug startup errors open diagnosis automatically without waiting for a notification click', async () => {
  for (const action of ['buildRun', 'buildDebug']) {
    let busy = true; const events: string[] = [];
    const queue = new DeferredDependencyActions(() => busy, error => { throw error; });
    scheduleDependencyRecovery(queue, action, true, async () => { events.push('notification'); return false; }, async () => { events.push('diagnosis'); });
    await queue.flush(action); assert.deepEqual(events, []);
    busy = false; await queue.flush(action); assert.deepEqual(events, ['diagnosis']);
  }
});
