import { build } from 'esbuild';
import { readdir, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const integration = process.argv[2] === 'integration';
const directory = integration ? 'test/integration' : 'test';
const files = (await readdir(directory)).filter(f => f.endsWith('.test.ts'));
await mkdir('out/tests', { recursive: true });
if (integration) await build({ absWorkingDir: process.cwd(), tsconfig: 'tsconfig.json', entryPoints: ['./test/integration/recovery-worker.ts'], outfile: 'out/tests/recovery-worker.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external' });
const outputs = [];
for (const file of files) {
  const output = `out/tests/${integration ? 'integration-' : ''}${file.replace(/\.ts$/, '.cjs')}`;
  await build({ absWorkingDir: process.cwd(), tsconfig: 'tsconfig.json', entryPoints: [`./${directory}/${file}`], outfile: output, bundle: true, platform: 'node', format: 'cjs', packages: 'external', sourcemap: 'inline' });
  outputs.push(output);
}
if (!outputs.length) throw new Error('No tests found');
const result = spawnSync(process.execPath, ['--test', ...outputs], { stdio: 'inherit', env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '1' } });
process.exit(result.status ?? 1);
