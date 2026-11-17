import path from 'node:path';

export type Family = '8.5' | '9.0' | '10.1' | '11.0';
export interface JavaConfig { major: number; release: string }
export interface Application { source: string; context: string }
export interface DebugOptions { port: number; projectName?: string; sourcePaths?: string[] }
export interface MavenDependency { groupId: string; artifactId: string; version?: string; scope?: 'compile' | 'runtime' }
export interface HotReloadOptions { mode: 'hotswap' | 'redeploy'; delayMs?: number; watch?: string[]; exclude?: string[] }
export interface BuildOptions {
  pom: string; context: string; mavenVersion?: string; includeProvided?: boolean; skipTests?: boolean;
  goal?: 'package' | 'install'; profiles?: string[]; settings?: string; dependencies?: MavenDependency[];
  excludeArtifacts?: string[]; excludeProvidedGroups?: string[]; jvmArgs?: string[];
}
export interface Instance {
  id: string; name: string; tomcatVersion: string; java: JavaConfig;
  ports: { http: number; shutdown: number }; jvmArgs: string[];
  environment: Record<string, string>; applications: Application[];
  configDir?: string;
  libraries?: string[];
  debug?: DebugOptions;
  build?: BuildOptions;
  hotReload?: HotReloadOptions;
}
export interface ProjectConfig { version: 1; instances: Instance[] }
export interface InstanceRef { project: string; instance: Instance }
export type State = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
export const reservedEnvironment = /^(JAVA_HOME|JRE_HOME|JAVA_OPTS|CATALINA_.*|CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS|JSSE_OPTS|JPDA_.*)$/i;

export function familyOf(version: string): Family {
  if (/^8\.5\.\d+$/.test(version)) return '8.5';
  if (/^9\.0\.\d+$/.test(version)) return '9.0';
  if (/^10\.1\.\d+$/.test(version)) return '10.1';
  if (/^11\.0\.\d+$/.test(version)) return '11.0';
  throw new Error(`Tomcat version ${version} is not supported. Use an exact 8.5.x, 9.0.x, 10.1.x or 11.0.x release.`);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${label} must be a non-empty string.`);
  return value;
}
function port(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error('Ports must be integers between 1024 and 65535.');
  return Number(value);
}
export function contextName(context: string): string {
  if (context === '/') return 'ROOT';
  if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(context)) throw new Error('Invalid context: use / or /name (nested paths are allowed).');
  const result = context.slice(1).replaceAll('/', '#');
  if (/(^|#)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])($|#)/i.test(result) || result.toUpperCase() === 'ROOT') throw new Error('Invalid reserved context name. Use / for the root application.');
  return result;
}
function projectRelative(value: unknown, label: string): string {
  const result = text(value, label);
  if (path.win32.isAbsolute(result) || path.posix.isAbsolute(result) || result.split(/[\\/]/).some(p => p === '..' || p === '.tomcat-workbench')) throw new Error(`${label} must be a path inside the project, outside the generated build directory.`);
  return result;
}
export function validateBuild(value: unknown): BuildOptions {
  const raw = object(value, 'Build'); const pom = projectRelative(raw.pom, 'Build POM path');
  const context = text(raw.context, 'Build context'); contextName(context);
  if (raw.mavenVersion !== undefined && (typeof raw.mavenVersion !== 'string' || !/^3\.\d+\.\d+$/.test(raw.mavenVersion))) throw new Error('Maven build requires an exact Maven 3 version.');
  for (const key of ['includeProvided', 'skipTests']) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw new Error(`Build ${key} must be boolean.`);
  if (raw.goal !== undefined && !['package', 'install'].includes(String(raw.goal))) throw new Error('Build goal must be package or install.');
  for (const key of ['profiles', 'excludeArtifacts', 'excludeProvidedGroups', 'jvmArgs']) if (raw[key] !== undefined && (!Array.isArray(raw[key]) || (raw[key] as unknown[]).some(v => typeof v !== 'string' || !v || /[\0\r\n]/.test(v)))) throw new Error(`Build ${key} must be an array of strings.`);
  if ((raw.profiles as string[] | undefined)?.some(p => !/^!?[A-Za-z0-9_.-]+$/.test(p))) throw new Error('Invalid Maven build profile.');
  for (const key of ['excludeArtifacts', 'excludeProvidedGroups']) if ((raw[key] as string[] | undefined)?.some(p => !/^[A-Za-z0-9_.-]+$/.test(p))) throw new Error(`Invalid build ${key}.`);
  if ((raw.jvmArgs as string[] | undefined)?.some(a => !a.startsWith('-') || /^-(?:cp|classpath|jar)$|^--(?:class-path|module-path)(?:=|$)|^-D(?:maven\.|classworlds\.|java\.home|tomcat\.workbench\.)/.test(a))) throw new Error('Invalid or reserved Maven JVM argument.');
  if (raw.dependencies !== undefined && !Array.isArray(raw.dependencies)) throw new Error('Build dependencies must be an array.');
  const ids = new Set<string>();
  const dependencies = (raw.dependencies as unknown[] | undefined)?.map(value => {
    const d = object(value, 'Build dependency'); const groupId = text(d.groupId, 'Dependency groupId'); const artifactId = text(d.artifactId, 'Dependency artifactId');
    if (!/^[A-Za-z0-9_.-]+$/.test(groupId) || !/^[A-Za-z0-9_.-]+$/.test(artifactId) || ids.has(`${groupId}:${artifactId}`)) throw new Error('Invalid or duplicate build dependency.');
    ids.add(`${groupId}:${artifactId}`);
    if (d.scope !== undefined && !['compile', 'runtime'].includes(String(d.scope))) throw new Error('Build dependency scope must be compile or runtime.');
    return { groupId, artifactId, ...(d.version !== undefined ? { version: text(d.version, 'Dependency version') } : {}), ...(d.scope ? { scope: d.scope as 'compile' | 'runtime' } : {}) };
  });
  return { pom, context, ...(raw.mavenVersion ? { mavenVersion: raw.mavenVersion as string } : {}), ...(raw.includeProvided !== undefined ? { includeProvided: raw.includeProvided as boolean } : {}), ...(raw.skipTests !== undefined ? { skipTests: raw.skipTests as boolean } : {}), ...(raw.goal ? { goal: raw.goal as 'package' | 'install' } : {}), ...(raw.settings ? { settings: text(raw.settings, 'Build settings path') } : {}), ...(dependencies ? { dependencies } : {}), ...Object.fromEntries(['profiles', 'excludeArtifacts', 'excludeProvidedGroups', 'jvmArgs'].filter(k => raw[k] !== undefined).map(k => [k, raw[k]])) };
}
export function validateConfig(value: unknown): ProjectConfig {
  const root = object(value, 'Configuration');
  if (root.version !== 1 || !Array.isArray(root.instances)) throw new Error('Configuration requires version: 1 and an instances array.');
  const ids = new Set<string>(); const ports = new Set<number>();
  const instances = root.instances.map((raw, index): Instance => {
    const item = object(raw, `Instance ${index}`);
    const id = text(item.id, 'id');
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) throw new Error('Invalid instance id: use lowercase letters, numbers, hyphens or underscores.');
    if (ids.has(id)) throw new Error(`Duplicate instance id: ${id}`); ids.add(id);
    const tomcatVersion = text(item.tomcatVersion, 'Tomcat version'); const family = familyOf(tomcatVersion);
    const java = object(item.java, 'Java'); const major = Number(java.major); const release = text(java.release, 'Java release');
    if (![8, 11, 17, 21].includes(major) || !release.startsWith(`jdk${major === 8 ? '8u' : `-${major}.`}`) || !/^jdk[\w.+-]+$/.test(release)) throw new Error('Java release must be an exact Temurin release matching Java major (8, 11, 17 or 21).');
    const minimum = family === '11.0' ? 17 : family === '10.1' ? 11 : 8;
    if (major < minimum) throw new Error(`Tomcat ${family} requires Java ${minimum} or later.`);
    const p = object(item.ports, 'Ports'); const http = port(p.http); const shutdown = port(p.shutdown);
    let hotReload: HotReloadOptions | undefined;
    if (item.hotReload !== undefined) {
      const reload = object(item.hotReload, 'Hot reload');
      if (!['hotswap', 'redeploy'].includes(String(reload.mode))) throw new Error('Hot reload mode must be hotswap or redeploy.');
      if (reload.delayMs !== undefined && (!Number.isInteger(reload.delayMs) || Number(reload.delayMs) < 200 || Number(reload.delayMs) > 30000)) throw new Error('Hot reload delayMs must be between 200 and 30000.');
      for (const key of ['watch', 'exclude']) if (reload[key] !== undefined && (!Array.isArray(reload[key]) || (reload[key] as unknown[]).some(p => typeof p !== 'string' || !p || /[\0\r\n:\\[\]{}]/.test(p) || p.startsWith('/') || p.split('/').some(s => s === '..' || s === '.')))) throw new Error('Hot reload globs must be project-relative paths using /, *, ** or ?.');
      hotReload = { mode: reload.mode as HotReloadOptions['mode'], ...(reload.delayMs !== undefined ? { delayMs: reload.delayMs as number } : {}), ...(reload.watch !== undefined ? { watch: reload.watch as string[] } : {}), ...(reload.exclude !== undefined ? { exclude: reload.exclude as string[] } : {}) };
    }
    let debug: DebugOptions | undefined;
    if (item.debug !== undefined) {
      const rawDebug = object(item.debug, 'Debug'); const debugPort = port(rawDebug.port);
      const sourcePaths = rawDebug.sourcePaths;
      if (sourcePaths !== undefined && (!Array.isArray(sourcePaths) || sourcePaths.some(p => typeof p !== 'string' || !p.trim() || p.includes('\0') || path.win32.isAbsolute(p) || path.posix.isAbsolute(p) || p.split(/[\\/]/).includes('..')))) throw new Error('Debug source paths must be relative paths inside the project.');
      debug = { port: debugPort, ...(rawDebug.projectName !== undefined ? { projectName: text(rawDebug.projectName, 'Debug project name') } : {}), ...(sourcePaths !== undefined ? { sourcePaths: sourcePaths as string[] } : {}) };
    }
    for (const n of [http, shutdown, ...(debug ? [debug.port] : [])]) { if (ports.has(n)) throw new Error(`Duplicate port ${n} in this project.`); ports.add(n); }
    const jvmArgs = item.jvmArgs ?? [];
    if (!Array.isArray(jvmArgs) || jvmArgs.some(a => typeof a !== 'string' || !a.startsWith('-') || /[\r\n\0]/.test(a) || /^(?:-D(?:catalina\.|java\.io\.tmpdir|tomcat\.workbench\.|java\.util\.logging\.)|-(?:cp|classpath|jar)$|--(?:class-path|module-path)(?:=|$))/.test(a))) throw new Error('Invalid or reserved JVM argument. Supply each option as a separate array item.');
    const environment = object(item.environment ?? {}, 'Environment');
    const libraries = item.libraries ?? [];
    if (!Array.isArray(libraries) || libraries.some(lib => typeof lib !== 'string' || !lib.toLowerCase().endsWith('.jar') || lib.includes('\0'))) throw new Error('Libraries must be project-relative JAR paths.');
    for (const [key, v] of Object.entries(environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof v !== 'string' || v.includes('\0')) throw new Error(`Invalid environment variable ${key}.`);
      if (reservedEnvironment.test(key)) throw new Error(`Environment variable ${key} is reserved.`);
    }
    if (!Array.isArray(item.applications ?? [])) throw new Error('Applications must be an array.');
    const contexts = new Set<string>();
    const applications = ((item.applications ?? []) as unknown[]).map(a => {
      const app = object(a, 'Application'); const context = text(app.context, 'Context'); const name = contextName(context).toLowerCase();
      if (contexts.has(name)) throw new Error(`Duplicate application context ${context}.`); contexts.add(name);
      return { source: text(app.source, 'Application source'), context };
    });
    return { id, name: text(item.name, 'Name'), tomcatVersion, java: { major, release }, ports: { http, shutdown }, jvmArgs: jvmArgs as string[], environment: environment as Record<string, string>, applications, ...(item.build !== undefined ? { build: validateBuild(item.build) } : {}), ...(debug ? { debug } : {}), ...(hotReload ? { hotReload } : {}), ...(libraries.length ? { libraries: libraries as string[] } : {}), ...(item.configDir ? { configDir: text(item.configDir, 'Configuration directory') } : {}) };
  });
  return { version: 1, instances };
}
export function cleanEnvironment(inherited: NodeJS.ProcessEnv, overrides: Record<string, string>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) if (!reservedEnvironment.test(key)) result[key] = value;
  for (const [key, value] of Object.entries(overrides)) {
    if (reservedEnvironment.test(key)) throw new Error(`${key} is reserved.`);
    const existing = Object.keys(result).find(k => k.toLowerCase() === key.toLowerCase());
    if (existing) delete result[existing]; result[key] = value;
  }
  return result;
}
export function resolveProjectPath(project: string, relative: string): string {
  const impl = /^[A-Za-z]:[\\/]/.test(project) ? path.win32 : path;
  const result = impl.resolve(project, relative); const rel = impl.relative(project, result);
  if (rel === '..' || rel.startsWith(`..${impl.sep}`) || impl.isAbsolute(rel)) throw new Error('Paths must remain inside the project folder.');
  return result;
}
export async function resolveSecrets(env: Record<string, string>, get: (name: string) => Promise<string | undefined>): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    let expanded = value;
    for (const match of value.matchAll(/\$\{secret:([A-Za-z0-9_.-]+)\}/g)) {
      const secret = await get(match[1]); if (secret === undefined) throw new Error(`Missing secret ${match[1]}. Run Tomcat: Set Project Secret.`);
      expanded = expanded.replaceAll(match[0], secret);
    }
    result[key] = expanded;
  }
  return result;
}
