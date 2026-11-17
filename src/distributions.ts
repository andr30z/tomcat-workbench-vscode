import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import * as yauzl from 'yauzl';
import { familyOf, type Family, type JavaConfig } from './config';
import { atomicJson, jsonFile, lease, renameRetry } from './files';
import { networkFetch } from './network';

export interface Progress { (message: string): void }
export interface Artifact { url: string; checksum: string; algorithm: 'sha256' | 'sha512' }
interface JavaRelease { release_name: string; binaries: { architecture: string; image_type: string; package: { link: string; checksum: string } }[] }
export function javaArtifact(release: JavaRelease, name: string, architecture: string): Artifact {
  const pkg = release.release_name === name ? release.binaries?.find(b => b.architecture === architecture && b.image_type === 'jdk')?.package : undefined;
  if (!pkg || new URL(pkg.link).hostname !== 'github.com') throw new Error(`No Windows JDK found for ${name} (${architecture}).`);
  return { url: pkg.link, checksum: pkg.checksum, algorithm: 'sha256' };
}
const LIMIT = 2 * 1024 * 1024 * 1024;
export async function fetchText(url: string): Promise<string> {
  const response = await networkFetch(url, 60_000);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const text = await response.text(); if (text.length > 16 * 1024 * 1024) throw new Error('Metadata response too large.'); return text;
}
export function parseTomcatVersions(html: string, family: Family): string[] {
  const values = [...html.matchAll(/href="v(\d+\.\d+\.\d+)\//g)].map(m => m[1]).filter(v => v.startsWith(`${family}.`));
  return [...new Set(values)].sort((a, b) => Number(b.split('.')[2]) - Number(a.split('.')[2]));
}
export function tomcatDownloadUrls(version: string): string[] {
  const family = familyOf(version); const major = version.split('.')[0];
  const hosts = family === '8.5' ? ['https://archive.apache.org/dist'] : ['https://dlcdn.apache.org', 'https://archive.apache.org/dist'];
  return hosts.map(host => `${host}/tomcat/tomcat-${major}/v${version}/bin/apache-tomcat-${version}.zip`);
}
export async function verifyChecksum(file: string, expected: string, algorithm: 'sha256' | 'sha512'): Promise<void> {
  if (!new RegExp(`^[a-f0-9]{${algorithm === 'sha256' ? 64 : 128}}$`, 'i').test(expected)) throw new Error('Invalid checksum metadata.');
  const hash = createHash(algorithm); for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex').toLowerCase() !== expected.toLowerCase()) throw new Error('Checksum mismatch. Download discarded; retry provisioning.');
}
export async function download(url: string, file: string): Promise<void> {
  if (!url.startsWith('https://')) throw new Error('Distribution downloads require HTTPS.');
  const response = await networkFetch(url, 600_000);
  if (!response.ok || !response.body || !response.url.startsWith('https://')) throw new Error(`Download failed (${response.status}): ${url}`);
  let size = 0;
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; callback(size > LIMIT ? new Error('Download exceeds size limit.') : null, chunk); } }), createWriteStream(file, { flags: 'wx' }));
}
export function extractZip(file: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) { reject(error); return; }
      let bytes = 0; let count = 0; let failed = false;
      const fail = (e: unknown) => { if (!failed) { failed = true; zip.close(); reject(e); } };
      zip.on('error', fail); zip.on('end', () => { if (!failed) resolve(); });
      zip.on('entry', (entry: yauzl.Entry) => { void (async () => {
        const name = entry.fileName;
        const segments = name.split('/');
        if (name.includes('\\') || name.startsWith('/') || segments.some(s => s === '..' || s.includes(':') || /[. ]$/.test(s) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(s)) || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new Error('Unsafe ZIP entry path or symbolic link.');
        if (++count > 100_000 || (bytes += entry.uncompressedSize) > LIMIT * 4) throw new Error('ZIP exceeds extraction limits.');
        const output = path.resolve(destination, name); const relative = path.relative(path.resolve(destination), output);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe ZIP entry path.');
        if (name.endsWith('/')) await mkdir(output, { recursive: true });
        else {
          await mkdir(path.dirname(output), { recursive: true });
          const input = await new Promise<Readable>((res, rej) => zip.openReadStream(entry, (e, stream) => e || !stream ? rej(e) : res(stream)));
          await pipeline(input, createWriteStream(output, { flags: 'wx' }));
        }
        if (!failed) zip.readEntry();
      })().catch(fail); });
      zip.readEntry();
    });
  });
}
export class DistributionStore {
  constructor(readonly root: string, readonly progress: Progress = () => {}, readonly architecture = process.arch === 'arm64' ? 'aarch64' : 'x64') {}
  private location(kind: string, version: string): string { return path.join(this.root, kind, version); }
  private async cached(kind: string, version: string, required: string[]): Promise<string | undefined> {
    const home = this.location(kind, version);
    try {
      const marker = await jsonFile<{ version: string; architecture?: string }>(path.join(home, '.complete.json'));
      if (marker?.version !== version || (kind === 'java' && marker.architecture !== this.architecture)) return undefined;
      for (const file of required) if (!(await stat(path.join(home, file))).isFile()) return undefined;
      return home;
    } catch { return undefined; }
  }
  cachedTomcat(version: string): Promise<string | undefined> { familyOf(version); return this.cached('tomcat', version, ['bin/bootstrap.jar', 'bin/tomcat-juli.jar', 'conf/server.xml', 'bin/catalina.bat']); }
  cachedJava(java: JavaConfig): Promise<string | undefined> { return this.cached('java', `${java.release}-${this.architecture}`, ['bin/java.exe', 'release']); }
  cachedMaven(version: string): Promise<string | undefined> {
    if (!/^3\.\d+\.\d+$/.test(version)) throw new Error('Use an exact Maven 3 version.');
    return this.cached('maven', version, ['bin/mvn.cmd', 'bin/m2.conf', `lib/maven-core-${version}.jar`]);
  }
  async ensureMaven(version = '3.9.16'): Promise<string> {
    const cached = await this.cachedMaven(version); if (cached) return cached;
    return this.install('maven', version, async () => {
      for (const host of ['https://archive.apache.org/dist', 'https://dlcdn.apache.org']) {
        const url = `${host}/maven/maven-3/${version}/binaries/apache-maven-${version}-bin.zip`;
        try { const checksum = (await fetchText(`${url}.sha512`)).match(/\b[a-fA-F0-9]{128}\b/)?.[0]; if (checksum) return { url, checksum, algorithm: 'sha512' }; } catch { /* Try another official source. */ }
      }
      throw new Error(`Unable to resolve Maven ${version}. Check your network connection.`);
    }, ['bin/mvn.cmd', 'bin/m2.conf', `lib/maven-core-${version}.jar`]);
  }
  async tomcatVersions(family: Family): Promise<string[]> {
    try {
      const html = await fetchText(`https://archive.apache.org/dist/tomcat/tomcat-${family.split('.')[0]}/`);
      const versions = parseTomcatVersions(html, family); if (!versions.length) throw new Error('No Tomcat versions found.'); return versions;
    } catch (error) {
      const versions = await readdir(path.join(this.root, 'tomcat')).catch(() => []);
      const cached = []; for (const v of versions) if (v.startsWith(`${family}.`) && await this.cachedTomcat(v)) cached.push(v);
      if (cached.length) return cached.sort((a, b) => Number(b.split('.')[2]) - Number(a.split('.')[2])); throw error;
    }
  }
  async javaReleases(major: number): Promise<JavaRelease[]> {
    const query = `architecture=${this.architecture}&heap_size=normal&image_type=jdk&jvm_impl=hotspot&os=windows&project=jdk&vendor=eclipse`;
    const response = JSON.parse(await fetchText(`https://api.adoptium.net/v3/assets/feature_releases/${major}/ga?${query}&page_size=20&sort_order=DESC`));
    if (!Array.isArray(response)) throw new Error('Invalid Adoptium catalog.'); return response;
  }
  async javaVersions(major: number): Promise<string[]> {
    try { return (await this.javaReleases(major)).map(r => r.release_name); }
    catch (error) {
      const dirs = await readdir(path.join(this.root, 'java')).catch(() => []); const result = [];
      for (const dir of dirs) { const release = dir.replace(new RegExp(`-${this.architecture}$`), ''); if (release.startsWith(major === 8 ? 'jdk8u' : `jdk-${major}.`) && await this.cachedJava({ major, release })) result.push(release); }
      if (result.length) return result; throw error;
    }
  }
  async ensureTomcat(version: string): Promise<string> {
    familyOf(version); const cached = await this.cachedTomcat(version); if (cached) return cached;
    return this.install('tomcat', version, async () => {
      for (const url of tomcatDownloadUrls(version)) {
        try { const checksum = (await fetchText(`${url}.sha512`)).match(/\b[a-fA-F0-9]{128}\b/)?.[0]; if (checksum) return { url, checksum, algorithm: 'sha512' }; } catch { /* Try the official archive. */ }
      }
      throw new Error(`Unable to resolve Tomcat ${version}. Check your network connection.`);
    }, ['bin/bootstrap.jar', 'conf/server.xml']);
  }
  async ensureJava(java: JavaConfig): Promise<string> {
    const cached = await this.cachedJava(java); if (cached) return cached;
    return this.install('java', `${java.release}-${this.architecture}`, async () => {
      const query = `architecture=${this.architecture}&heap_size=normal&image_type=jdk&jvm_impl=hotspot&os=windows&project=jdk`;
      const release: JavaRelease = JSON.parse(await fetchText(`https://api.adoptium.net/v3/assets/release_name/eclipse/${encodeURIComponent(java.release)}?${query}`));
      return javaArtifact(release, java.release, this.architecture);
    }, ['bin/java.exe', 'release']);
  }
  private async install(kind: string, version: string, artifact: () => Promise<Artifact>, required: string[]): Promise<string> {
    const destination = this.location(kind, version); const release = await lease(`${destination}.lock`);
    const stage = `${destination}.staging`;
    try {
      const cached = await this.cached(kind, version, required); if (cached) return cached;
      await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true });
      this.progress(`Resolving ${kind} ${version}`); const info = await artifact();
      this.progress(`Downloading ${kind} ${version}`); const archive = path.join(stage, 'download.zip');
      await download(info.url, archive); await verifyChecksum(archive, info.checksum, info.algorithm);
      this.progress(`Extracting ${kind} ${version}`); const extracted = path.join(stage, 'extracted'); await extractZip(archive, extracted);
      const dirs = await readdir(extracted, { withFileTypes: true }); const entries = dirs.filter(d => d.isDirectory());
      if (entries.length !== 1 || dirs.length !== 1) throw new Error('Unexpected distribution ZIP structure.');
      const home = path.join(extracted, entries[0].name);
      for (const file of required) if (!(await stat(path.join(home, file))).isFile()) throw new Error(`Incomplete distribution: ${file}`);
      await atomicJson(path.join(home, '.complete.json'), { version, architecture: this.architecture, ...info });
      await rm(destination, { recursive: true, force: true }); await renameRetry(home, destination); return destination;
    } finally { await rm(stage, { recursive: true, force: true }); await release(); }
  }
}
