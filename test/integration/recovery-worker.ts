import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DistributionStore } from '../../src/distributions';
import { InstanceManager } from '../../src/processes';
async function main() {
  const { storage, ref, debug } = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const store = new DistributionStore(path.join(storage, 'distributions'));
  const manager = new InstanceManager(storage, store, { state: () => {}, log: () => {}, secret: async () => undefined });
  await manager.start(ref, { debug: debug === true });
  // Deliberately simulate a crashed extension host without calling shutdown.
  console.log('STARTED'); setTimeout(() => process.exit(0), 100);
}
void main().catch(error => { console.error(error); process.exit(1); });
