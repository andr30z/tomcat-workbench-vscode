import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityMatches, redactConsole, terminateChild } from '../src/processes';
import { spawn } from 'node:child_process';

test('recovery requires executable, creation time and exact ownership argument', () => {
  const record = { pid: 123, executable: 'C:\\Java\\bin\\java.exe', created: '2026-01-01', token: 'unique-token' };
  const actual = { pid: 123, executable: 'C:\\Java\\bin\\java.exe', created: '2026-01-01', commandLine: '"C:\\Java\\bin\\java.exe" -Dtomcat.workbench.token=unique-token org.apache.catalina.startup.Bootstrap start' };
  assert.equal(identityMatches(record, actual), true);
  assert.equal(identityMatches(record, { ...actual, created: '2026-01-02' }), false);
  assert.equal(identityMatches(record, { ...actual, executable: 'C:\\unrelated.exe' }), false);
  assert.equal(identityMatches(record, { ...actual, commandLine: '-Dtomcat.workbench.token=unique-token-other' }), false);
  assert.equal(identityMatches(record, undefined), false);
});
test('console redaction hides known secrets and ownership tokens', () => {
  assert.equal(redactConsole('password=abc123 token=private-token', ['abc123', 'private-token']), 'password=[redacted] token=[redacted]');
});
test('termination returns only after the owned child has exited', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  try { await terminateChild(child); assert.ok(child.exitCode !== null || child.signalCode !== null); }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
});
