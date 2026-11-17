import { readdir, open } from 'node:fs/promises';
import path from 'node:path';
import * as yauzl from 'yauzl';
import { DOMParser } from '@xmldom/xmldom';
import { validateBuild, type BuildOptions } from './config';
import { containerArtifacts } from './maven-pom';

export class MissingClassDetector {
  private tail = '';
  readonly classes = new Set<string>();
  push(chunk: string, flush = false): string[] {
    const text = this.tail + chunk; const end = flush ? text.length : text.lastIndexOf('\n') + 1;
    this.tail = text.slice(end).slice(-8192);
    const added: string[] = [];
    for (const match of text.slice(0, end).matchAll(/(?:NoClassDefFoundError|ClassNotFoundException):\s*([A-Za-z_$][\w$]*(?:[./][A-Za-z_$][\w$]*)+)(?=[\s:;\r\n]|$)/g)) {
      const name = match[1].replaceAll('/', '.');
      if (!this.classes.has(name) && this.classes.size < 100) { this.classes.add(name); added.push(name); }
    }
    return added;
  }
}
export interface ClassProvider { groupId: string; artifactId: string; version: string; managed: boolean }
function elements(node: Element, tag: string): Element[] { return Array.from(node.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).localName === tag); }
export function dependencyVersions(xml: string): Map<string, string> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid dependency model XML.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml'); const root = doc.documentElement as unknown as Element;
  const versions = new Map<string, string>();
  for (const parent of elements(root, 'dependencyManagement')) for (const dependencies of elements(parent, 'dependencies')) for (const d of elements(dependencies, 'dependency')) {
    if ((elements(d, 'type')[0]?.textContent?.trim() ?? 'jar') !== 'jar' || elements(d, 'classifier')[0]?.textContent?.trim()) continue;
    const group = elements(d, 'groupId')[0]?.textContent?.trim(); const artifact = elements(d, 'artifactId')[0]?.textContent?.trim(); const version = elements(d, 'version')[0]?.textContent?.trim();
    if (group && artifact && version && !version.includes('${')) versions.set(`${group}:${artifact}`, version);
  }
  return versions;
}
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('Dependency diagnosis cancelled.'); }
function excluded(group: string, artifact: string): boolean {
  return containerArtifacts.includes(artifact) || /^(?:org\.apache\.tomcat(?:\.|$)|javax\.(?:servlet|el|websocket)(?:\.|$)|jakarta\.(?:servlet|el|websocket)(?:\.|$))/.test(group) || /^(?:tomcat-|lombok$|querydsl-apt$|spring-boot-starter-tomcat$)/.test(artifact);
}
async function classesInJar(file: string, wanted: Set<string>, signal?: AbortSignal): Promise<Set<string>> {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(error); return; }
      const found = new Set<string>(); let finished = false;
      const finish = (error?: Error) => { if (finished) return; finished = true; signal?.removeEventListener('abort', abort); zip.close(); if (error) reject(error); else resolve(found); };
      const abort = () => finish(new Error('Dependency diagnosis cancelled.'));
      signal?.addEventListener('abort', abort, { once: true });
      zip.on('error', finish); zip.on('end', () => finish());
      zip.on('entry', entry => { if (wanted.has(entry.fileName)) found.add(entry.fileName); if (found.size === wanted.size) finish(); else zip.readEntry(); });
      if (signal?.aborted) abort(); else zip.readEntry();
    });
  });
}
export async function findClassProviders(repository: string, classes: string[], versions: Map<string, string>, signal?: AbortSignal, progress?: (jars: number) => void): Promise<{ providers: Map<string, ClassProvider[]>; scanned: number; unreadable: number; truncated: boolean }> {
  cancelled(signal);
  const providers = new Map(classes.map(name => [name, [] as ClassProvider[]]));
  const wanted = new Set(classes.map(name => `${name.replaceAll('.', '/')}.class`));
  const result = { providers, scanned: 0, unreadable: 0, truncated: false };
  async function visit(directory: string, depth: number): Promise<void> {
    cancelled(signal); if (depth > 24 || result.truncated) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      cancelled(signal); if (result.truncated) break;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(file, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jar')) continue;
      const parts = path.relative(repository, file).split(path.sep); if (parts.length < 4) continue;
      const version = parts.at(-2)!; const artifactId = parts.at(-3)!; const groupId = parts.slice(0, -3).join('.');
      if (entry.name !== `${artifactId}-${version}.jar` || excluded(groupId, artifactId)) continue;
      if (result.scanned >= 30000) { result.truncated = true; break; }
      result.scanned++; if (result.scanned % 100 === 0) progress?.(result.scanned);
      try {
        for (const name of await classesInJar(file, wanted, signal)) providers.get(name.slice(0, -6).replaceAll('/', '.'))!.push({ groupId, artifactId, version, managed: versions.get(`${groupId}:${artifactId}`) === version });
      } catch (error) { cancelled(signal); result.unreadable++; }
    }
  }
  await visit(repository, 0);
  for (const values of providers.values()) values.sort((a, b) => Number(b.managed) - Number(a.managed) || `${a.groupId}:${a.artifactId}:${a.version}`.localeCompare(`${b.groupId}:${b.artifactId}:${b.version}`));
  return result;
}
export function suggestedBuild(build: BuildOptions, choices: ClassProvider[]): BuildOptions {
  const selected = new Map<string, ClassProvider>();
  for (const choice of choices) {
    if (excluded(choice.groupId, choice.artifactId)) throw new Error('Container/tool dependencies cannot be added by diagnosis.');
    if (build.excludeArtifacts?.includes(choice.artifactId)) throw new Error(`Dependency ${choice.artifactId} is explicitly excluded from the WAR. Review build.excludeArtifacts.`);
    const key = `${choice.groupId}:${choice.artifactId}`; const previous = selected.get(key);
    if (previous && previous.version !== choice.version) throw new Error(`Conflicting dependency suggestions for ${key}.`);
    selected.set(key, choice);
  }
  const dependencies = (build.dependencies ?? []).map(d => ({ ...d }));
  for (const [key, choice] of selected) {
    const index = dependencies.findIndex(d => `${d.groupId}:${d.artifactId}` === key);
    const dependency = { groupId: choice.groupId, artifactId: choice.artifactId, version: choice.version, scope: 'compile' as const };
    if (index < 0) dependencies.push(dependency); else dependencies[index] = dependency;
  }
  return validateBuild({ ...build, dependencies });
}
export async function recentConsole(file: string): Promise<string> {
  let handle;
  try { handle = await open(file, 'r'); const size = (await handle.stat()).size; const length = Math.min(size, 1024 * 1024); const buffer = Buffer.alloc(length); await handle.read(buffer, 0, length, size - length); return buffer.toString('utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  finally { await handle?.close(); }
}
