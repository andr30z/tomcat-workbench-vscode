import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, lstat, realpath, writeFile } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import path from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { familyOf, contextName, resolveProjectPath, type Instance, type Application } from './config';
import { atomicJson, jsonFile, renameRetry } from './files';
import { managedDebugArgument } from './debug';

export function runtimeDirectory(storage: string, project: string, id: string): string {
  return path.join(storage, 'instances', createHash('sha256').update(path.resolve(project).toLowerCase()).digest('hex').slice(0, 24), id);
}
function parseXml(xml: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DOCTYPE / external entities are not allowed in Tomcat XML.');
  const errors: string[] = [];
  const doc = new DOMParser({ errorHandler: { warning: e => errors.push(e), error: e => errors.push(e), fatalError: e => errors.push(e) } }).parseFromString(xml, 'application/xml');
  if (errors.length || !doc?.documentElement || doc.documentElement.nodeName !== 'Server') throw new Error(`Invalid server.xml XML: ${errors.join('; ') || 'expected Server root'}`);
  return doc as unknown as Document;
}
function serialize(doc: Document): string { return new XMLSerializer().serializeToString(doc as unknown as Parameters<XMLSerializer['serializeToString']>[0]); }
function nativeTemplate(xml: string): string {
  const doc = parseXml(xml); const server = doc.documentElement;
  server.setAttribute('port', '${shutdown.port}'); server.setAttribute('address', '127.0.0.1'); server.setAttribute('shutdown', '${shutdown.token}');
  const connectors = Array.from(doc.getElementsByTagName('Connector'));
  const http = connectors.find(c => /HTTP|Http11/i.test(c.getAttribute('protocol') ?? 'HTTP/1.1'));
  if (!http) throw new Error('No HTTP connector found in Tomcat distribution.');
  http.setAttribute('port', '${http.port}');
  for (const connector of connectors) connector.setAttribute('address', '127.0.0.1');
  for (const host of Array.from(doc.getElementsByTagName('Host'))) host.setAttribute('appBase', 'webapps');
  return serialize(doc);
}
export function inspectServer(xml: string, instance: Instance): number[] {
  const doc = parseXml(xml); const server = doc.documentElement;
  if (Number(server.getAttribute('port')) !== instance.ports.shutdown) throw new Error('Shutdown port conflicts with tomcat.json. Use ${shutdown.port} in your XML.');
  if (!['127.0.0.1', 'localhost', '::1'].includes(server.getAttribute('address') ?? '')) throw new Error('Shutdown listener must use a loopback address.');
  const connectors = Array.from(doc.getElementsByTagName('Connector'));
  if (!connectors.some(c => /HTTP|Http11/i.test(c.getAttribute('protocol') ?? 'HTTP/1.1') && Number(c.getAttribute('port')) === instance.ports.http)) throw new Error('HTTP port conflicts with tomcat.json. Use ${http.port} in your XML.');
  const ports = [instance.ports.shutdown];
  for (const connector of connectors) {
    const raw = connector.getAttribute('port') ?? '';
    const port = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1024 || port > 65535 || ports.includes(port)) throw new Error('Invalid or conflicting connector port in server.xml.');
    ports.push(port);
  }
  const hosts = Array.from(doc.getElementsByTagName('Host'));
  if (hosts.length !== 1 || hosts[0].getAttribute('appBase') !== 'webapps') throw new Error('Managed instances require one Host with appBase="webapps". Configure application Context XML for advanced deployment.');
  return ports;
}
async function copySafe(source: string, destination: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Symbolic links / junctions are not supported in managed configuration or applications: ${source}`);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const item of await readdir(source)) await copySafe(path.join(source, item), path.join(destination, item));
  } else if (info.isFile()) await cp(source, destination);
  else throw new Error(`Unsupported application/configuration file: ${source}`);
}
async function projectDirectory(project: string, relative: string): Promise<string> {
  const candidate = resolveProjectPath(project, relative);
  const realRoot = await realpath(project); const realTarget = await realpath(candidate);
  const rel = path.relative(realRoot, realTarget);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Configuration and applications must remain inside the project, including junction targets.');
  return candidate;
}
export async function initializeTemplates(home: string, project: string, instance: Instance): Promise<string> {
  if (!instance.configDir) throw new Error('Set configDir in tomcat.json before initializing templates.');
  const destination = resolveProjectPath(project, instance.configDir);
  const protectedFolder = path.join(project, '.vscode');
  const protectedRelative = path.relative(destination, protectedFolder);
  if (destination === path.resolve(project) || !protectedRelative || (!protectedRelative.startsWith('..') && !path.isAbsolute(protectedRelative))) throw new Error('Configuration directory must be a dedicated child directory and cannot contain .vscode or tomcat.json.');
  // Check each existing ancestor before writing to avoid project junction escapes.
  let ancestor = path.dirname(destination);
  while (ancestor !== path.dirname(ancestor)) {
    try { await projectDirectory(project, path.relative(project, ancestor)); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; ancestor = path.dirname(ancestor); }
  }
  let exists = false;
  try {
    await lstat(destination); await projectDirectory(project, instance.configDir); exists = true;
    if (!(await jsonFile(path.join(destination, '.tomcat-template.json'))) && (await readdir(destination)).length) throw new Error('Refusing to replace a non-empty directory that is not managed native configuration. Choose a dedicated configDir.');
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const stage = `${destination}.staging-${randomUUID()}`; const backup = `${destination}.backup-${Date.now()}`;
  try {
    await copySafe(path.join(home, 'conf'), stage);
    await writeFile(path.join(stage, 'server.xml'), nativeTemplate(await readFile(path.join(stage, 'server.xml'), 'utf8')));
    await atomicJson(path.join(stage, '.tomcat-template.json'), { family: familyOf(instance.tomcatVersion), version: instance.tomcatVersion });
    if (exists) await renameRetry(destination, backup);
    try { await renameRetry(stage, destination); } catch (e) { if (exists) await renameRetry(backup, destination); throw e; }
  } finally { await rm(stage, { recursive: true, force: true }); }
  return destination;
}
export async function prepareBase(home: string, base: string, project: string, instance: Instance, token: string): Promise<number[]> {
  await mkdir(base, { recursive: true });
  const previous = await jsonFile<{ tomcatVersion: string }>(path.join(base, 'instance.json'));
  if (previous && previous.tomcatVersion !== instance.tomcatVersion) {
    const backup = path.join(base, 'backups', `${Date.now()}-${previous.tomcatVersion}`);
    await mkdir(backup, { recursive: true });
    await cp(path.join(base, 'conf'), path.join(backup, 'conf'), { recursive: true });
    await atomicJson(path.join(backup, 'instance.json'), previous);
  }
  const staging = path.join(base, `conf-${randomUUID()}`);
  const libraryStage = path.join(base, `lib-${randomUUID()}`);
  try {
    await mkdir(libraryStage);
    const names = new Set<string>();
    for (const lib of instance.libraries ?? []) {
      const source = await projectDirectory(project, lib); const name = path.basename(source);
      if (!name.toLowerCase().endsWith('.jar') || !(await lstat(source)).isFile() || names.has(name.toLowerCase())) throw new Error('Shared libraries must be JAR files with distinct names.');
      names.add(name.toLowerCase()); await copySafe(source, path.join(libraryStage, name));
    }
    await copySafe(path.join(home, 'conf'), staging);
    let server = nativeTemplate(await readFile(path.join(staging, 'server.xml'), 'utf8'));
    if (instance.configDir) {
      const custom = await projectDirectory(project, instance.configDir);
      const marker = await jsonFile<{ family: string }>(path.join(custom, '.tomcat-template.json'));
      if (marker?.family !== familyOf(instance.tomcatVersion)) throw new Error('Native configuration family differs from Tomcat (or marker is missing). Run Initialize Native Configuration to generate matching templates with a backup.');
      await copySafe(custom, staging); server = await readFile(path.join(staging, 'server.xml'), 'utf8');
    }
    server = server.replaceAll('${http.port}', String(instance.ports.http)).replaceAll('${shutdown.port}', String(instance.ports.shutdown)).replaceAll('${shutdown.token}', token);
    const ports = inspectServer(server, instance);
    const doc = parseXml(server); doc.documentElement.setAttribute('shutdown', token);
    await writeFile(path.join(staging, 'server.xml'), serialize(doc));
    await rm(path.join(base, 'conf'), { recursive: true, force: true }); await rename(staging, path.join(base, 'conf'));
    await rm(path.join(base, 'lib'), { recursive: true, force: true }); await renameRetry(libraryStage, path.join(base, 'lib'));
    for (const dir of ['logs', 'temp', 'work', 'webapps', 'lib']) await mkdir(path.join(base, dir), { recursive: true });
    await atomicJson(path.join(base, 'instance.json'), { tomcatVersion: instance.tomcatVersion, java: instance.java });
    return ports;
  } finally { await rm(staging, { recursive: true, force: true }); await rm(libraryStage, { recursive: true, force: true }); }
}
export async function deployApplications(project: string, base: string, applications: Application[]): Promise<void> {
  await mkdir(base, { recursive: true });
  const stage = path.join(base, `deploy-${randomUUID()}`); const webapps = path.join(base, 'webapps'); const old = path.join(base, `webapps-${randomUUID()}`);
  await mkdir(stage);
  try {
    for (const app of applications) {
      const source = await projectDirectory(project, app.source); const info = await lstat(source); const name = contextName(app.context);
      if (!info.isDirectory() && (!info.isFile() || !source.toLowerCase().endsWith('.war'))) throw new Error('Deployment source must be a WAR file or directory.');
      await copySafe(source, path.join(stage, `${name}${info.isFile() ? '.war' : ''}`));
    }
    let moved = false;
    try { await rename(webapps, old); moved = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    try { await rename(stage, webapps); } catch (e) { if (moved) await rename(old, webapps); throw e; }
    await rm(old, { recursive: true, force: true });
    await rm(path.join(base, 'work'), { recursive: true, force: true }); await mkdir(path.join(base, 'work'));
  } finally { await rm(stage, { recursive: true, force: true }); }
}
export function javaArguments(home: string, base: string, instance: Instance, token: string, action: 'start' | 'stop', debug = false): string[] {
  return [
    ...(action === 'start' ? instance.jvmArgs : []),
    ...(action === 'start' && debug ? [managedDebugArgument(instance)] : []),
    ...(instance.java.major >= 9 ? ['--add-opens=java.base/java.lang=ALL-UNNAMED', '--add-opens=java.base/java.lang.reflect=ALL-UNNAMED', '--add-opens=java.base/java.io=ALL-UNNAMED', '--add-opens=java.base/java.util=ALL-UNNAMED', '--add-opens=java.base/java.util.concurrent=ALL-UNNAMED', '--add-opens=java.rmi/sun.rmi.transport=ALL-UNNAMED'] : []),
    `-Dtomcat.workbench.token=${token}`, `-Dcatalina.home=${home}`, `-Dcatalina.base=${base}`, `-Djava.io.tmpdir=${path.join(base, 'temp')}`,
    '-Djava.util.logging.manager=org.apache.juli.ClassLoaderLogManager', `-Djava.util.logging.config.file=${path.join(base, 'conf/logging.properties')}`,
    '-classpath', `${path.join(home, 'bin/bootstrap.jar')}${path.delimiter}${path.join(home, 'bin/tomcat-juli.jar')}`, 'org.apache.catalina.startup.Bootstrap', action
  ];
}
export async function assertPortsAvailable(ports: number[]): Promise<void> {
  for (const port of ports) {
    for (const host of ['127.0.0.1', '::1']) {
      const listening = await new Promise<boolean>(resolve => {
        const socket = createConnection({ host, port });
        const done = (value: boolean) => { socket.destroy(); resolve(value); };
        socket.setTimeout(350); socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.once('timeout', () => done(false));
      });
      if (listening) throw new Error(`Port ${port} is in use. Update the instance ports before starting.`);
    }
    await new Promise<void>((resolve, reject) => {
      const server = createServer(); server.once('error', () => reject(new Error(`Port ${port} is in use or unavailable. Update the instance ports before starting.`)));
      // Wildcard binding catches listeners on IPv4 and IPv6 on Windows.
      server.listen({ port, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()));
    });
  }
}
