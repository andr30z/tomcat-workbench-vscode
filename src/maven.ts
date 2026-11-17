import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, writeFile, rm, lstat, realpath, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { cleanEnvironment, resolveProjectPath, validateBuild, type BuildOptions, type InstanceRef, type JavaConfig } from './config';
import { lease, atomicJson, assertRealChild, registerLeaseChildren } from './files';
import { generateBuildPom, isolateEffectivePom } from './maven-pom';
export { generateBuildPom, isolateEffectivePom } from './maven-pom';
export const DEFAULT_MAVEN = '3.9.16';
const exec = promisify(execFile);
export interface MavenLaunch { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; registerChildren?: (pids: number[]) => Promise<void> }
export interface BuildResult { source: string; context: string; generatedPom: string; fingerprint: string }
export interface DependencyContext { pom: string; repository: string }
export function buildFingerprint(options: BuildOptions): string { return createHash('sha256').update(JSON.stringify(validateBuild(options))).digest('hex'); }
interface BuildDistributions { ensureJava(java: JavaConfig): Promise<string>; ensureMaven(version?: string): Promise<string> }
export async function mavenLaunch(home: string, java: string, project: string, pom: string, options: BuildOptions): Promise<MavenLaunch> {
  const boot = (await readdir(path.join(home, 'boot'))).filter(f => /^plexus-classworlds.*\.jar$/.test(f));
  if (boot.length !== 1) throw new Error('Managed Maven has no unique ClassWorlds bootstrap JAR.');
  const env = cleanEnvironment(process.env, {});
  for (const key of Object.keys(env)) if (/^(MAVEN_.*|M2_HOME)$/i.test(key)) delete env[key];
  Object.assign(env, { JAVA_HOME: java, MAVEN_HOME: home, M2_HOME: home });
  return { executable: path.join(java, 'bin/java.exe'), cwd: project, env, args: [
    ...(options.jvmArgs ?? []), '-Dfile.encoding=UTF-8', `-Dmaven.home=${home}`, `-Dclassworlds.conf=${path.join(home, 'bin/m2.conf')}`, `-Dmaven.multiModuleProjectDirectory=${project}`,
    '-classpath', path.join(home, 'boot', boot[0]), 'org.codehaus.plexus.classworlds.launcher.Launcher', '-B', '-Dstyle.color=never', '-f', pom,
    ...(options.profiles?.length ? ['-P', options.profiles.join(',')] : []), ...(options.settings ? ['-s', path.resolve(project, options.settings)] : []), ...(options.skipTests ? ['-DskipTests=true'] : []), options.goal ?? 'package'
  ] };
}
export async function executeMaven(launch: MavenLaunch, signal: AbortSignal | undefined, log: (message: string) => void): Promise<void> {
  if (signal?.aborted) throw new Error('Maven build cancelled.');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let cancelled = false; let timedOut = false;
    let registration = Promise.resolve(); let terminating: Promise<void> | undefined;
    child.once('spawn', () => { registration = launch.registerChildren?.([child.pid!]) ?? Promise.resolve(); void registration.catch(() => { abort(); }); });
    const abort = () => { cancelled = true; terminating ??= stopBuildTree(child, launch); void terminating.catch(() => {}); };
    const timer = setTimeout(() => { timedOut = true; abort(); }, 20 * 60_000);
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.stdout.on('data', data => log(data.toString())); child.stderr.on('data', data => log(data.toString()));
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      cleanup(); void (async () => {
        await registration; if (terminating) await terminating;
        if (timedOut) throw new Error('Maven build timed out after 20 minutes.');
        if (cancelled || signal?.aborted) throw new Error('Maven build cancelled.');
        if (code !== 0) throw new Error(`Maven build failed (exit ${code}). See the build output. No deployment was changed.`);
      })().then(resolve, reject);
    });
    if (signal?.aborted) abort();
  });
}
async function stopBuildTree(child: ChildProcess, launch: MavenLaunch): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      const script = `$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process); $ids=@(${child.pid}); for($i=0;$i -lt $ids.Count;$i++){ $ids+=@($all | Where-Object { $_.ParentProcessId -eq $ids[$i] } | ForEach-Object { [int]$_.ProcessId }) }; ConvertTo-Json -Compress -InputObject @($ids)`;
      const system = process.env.SystemRoot ?? 'C:\\Windows';
      const { stdout } = await exec(path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 });
      const pids = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as number[];
      await launch.registerChildren?.(pids);
      if (child.exitCode === null && child.signalCode === null) {
        try { await exec(path.join(system, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }); }
        catch (error) { if (child.exitCode === null && child.signalCode === null) throw error; }
      }
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const alive = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
        if (!alive.length) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('A Maven child process is still running.');
    }
    child.kill();
  } catch (cause) {
    const error = new Error('Unable to confirm cancellation of the Maven process tree. Build ownership was retained for inspection.', { cause });
    Object.assign(error, { preserveBuildLock: true }); throw error;
  }
}
async function safeDirectory(project: string, relative: string): Promise<string> {
  const target = resolveProjectPath(project, relative); const root = path.resolve(project);
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { const info = await lstat(current); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Generated build directories cannot be junctions, links or files.'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; await mkdir(current); }
  }
  await assertRealChild(project, target); return target;
}
export class MavenBuilder {
  constructor(private readonly storage: string, private readonly distributions: BuildDistributions, private readonly log: (message: string) => void = () => {}, private readonly execute = executeMaven) {}
  private async model(ref: InstanceRef) {
    if (!ref.instance.build) throw new Error('Configure build.pom and build.context for this instance.');
    const options = validateBuild(ref.instance.build); const pom = resolveProjectPath(ref.project, options.pom);
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(ref.instance.id)) throw new Error('Invalid instance id for build.');
    const root = await realpath(ref.project);
    for (const candidate of [pom]) {
      const relative = path.relative(root, await realpath(candidate));
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Build POM must remain inside the project, including junction targets.');
    }
    if (options.settings) {
      const settings = path.resolve(ref.project, options.settings);
      try { if (!(await stat(settings)).isFile()) throw new Error('Not a file'); await readFile(settings); }
      catch { throw new Error(`Maven settings file does not exist or is not a readable file: ${settings}`); }
    }
    await assertRealChild(ref.project, pom);
    const source = await readFile(pom, 'utf8');
    const output = resolveProjectPath(ref.project, `.tomcat-workbench/${ref.instance.id}/build`);
    return { options, pom, output, generated: generateBuildPom(source.replace(/^\uFEFF/, ''), output, options) };
  }
  async preview(ref: InstanceRef, signal?: AbortSignal): Promise<string> { return (await this.perform(ref, signal, true)) as string; }
  async build(ref: InstanceRef, signal?: AbortSignal): Promise<BuildResult> { return (await this.perform(ref, signal, false)) as BuildResult; }
  async dependencyContext(ref: InstanceRef, signal?: AbortSignal): Promise<DependencyContext> { return await this.perform(ref, signal, 'diagnostics') as DependencyContext; }
  private async perform(ref: InstanceRef, signal: AbortSignal | undefined, preview: boolean | 'diagnostics'): Promise<BuildResult | string | DependencyContext> {
    const model = await this.model(ref);
    const key = createHash('sha256').update(`${(await realpath(ref.project)).toLowerCase()}/${ref.instance.id}`).digest('hex');
    const lock = path.join(this.storage, 'build-locks', key); const release = await lease(lock);
    let temporary: string | undefined; let retainLock = false;
    const checkCancelled = () => { if (signal?.aborted) throw new Error('Maven build cancelled.'); };
    try {
      checkCancelled();
      const home = await this.distributions.ensureMaven(model.options.mavenVersion ?? DEFAULT_MAVEN); const java = await this.distributions.ensureJava(ref.instance.java);
      checkCancelled();
      const base = await safeDirectory(ref.project, `.tomcat-workbench/${ref.instance.id}`);
      await writeFile(path.join(path.dirname(base), '.gitignore'), '*\n');
      const metadata = await safeDirectory(ref.project, `.tomcat-workbench/${ref.instance.id}/models/${randomUUID()}`);
      const effective = path.join(metadata, 'effective-pom.xml');
      this.log('Resolving the effective Maven model (parents and active profiles).\n');
      const modelLaunch = await mavenLaunch(home, java, ref.project, model.pom, model.options);
      modelLaunch.args.pop(); modelLaunch.args.push(`-Doutput=${effective}`, 'org.apache.maven.plugins:maven-help-plugin:3.5.1:effective-pom');
      modelLaunch.registerChildren = pids => registerLeaseChildren(lock, pids);
      await this.execute(modelLaunch, signal, this.log); checkCancelled();
      const derived = generateBuildPom(isolateEffectivePom(await readFile(effective, 'utf8'), await realpath(path.dirname(model.pom)), model.output), model.output, model.options);
      const generatedPom = path.join(base, 'last-pom.xml'); await writeFile(generatedPom, derived);
      if (preview === 'diagnostics') {
        const repositoryFile = path.join(metadata, 'local-repository.txt');
        const launch = await mavenLaunch(home, java, ref.project, model.pom, model.options);
        launch.args.pop(); launch.args.push('-Dexpression=settings.localRepository', `-Doutput=${repositoryFile}`, 'org.apache.maven.plugins:maven-help-plugin:3.5.1:evaluate');
        launch.registerChildren = pids => registerLeaseChildren(lock, pids);
        await this.execute(launch, signal, this.log); checkCancelled();
        const repository = (await readFile(repositoryFile, 'utf8')).trim();
        if (!path.isAbsolute(repository) || !(await stat(repository)).isDirectory()) throw new Error('Maven did not return an existing absolute local repository directory.');
        return { pom: derived, repository };
      }
      if (preview) return derived;
      const output = await safeDirectory(ref.project, `.tomcat-workbench/${ref.instance.id}/build`);
      await assertRealChild(base, output); await rm(output, { recursive: true, force: true }); await mkdir(output);
      const candidate = path.join(path.dirname(model.pom), `.tomcat-workbench.${ref.instance.id}.${randomUUID()}.generated.pom.xml`);
      await writeFile(candidate, derived, { flag: 'wx' }); temporary = candidate;
      this.log(`Building WAR with managed Maven ${model.options.mavenVersion ?? DEFAULT_MAVEN}. Original POM and normal target are preserved.\n`);
      const launch = await mavenLaunch(home, java, ref.project, temporary, { ...model.options, profiles: [] });
      launch.registerChildren = pids => registerLeaseChildren(lock, pids);
      await this.execute(launch, signal, this.log); checkCancelled();
      const artifact = path.join(output, 'application.war'); await assertRealChild(output, artifact);
      const info = await stat(artifact); if (!info.isFile() || info.size === 0) throw new Error('Maven succeeded but no non-empty WAR was produced in the isolated output.');
      const artifacts = await safeDirectory(ref.project, `.tomcat-workbench/${ref.instance.id}/artifacts`);
      const snapshot = path.join(artifacts, `${Date.now()}-${randomUUID()}.war`); await copyFile(artifact, snapshot); checkCancelled();
      const result = { source: path.relative(ref.project, snapshot).replaceAll('\\', '/'), context: model.options.context, generatedPom, fingerprint: buildFingerprint(model.options) };
      await atomicJson(path.join(base, 'last-build.json'), { ...result, completedAt: new Date().toISOString() });
      this.log('WAR build succeeded. Artifact ready for deployment.\n'); return result;
    } catch (error) { retainLock = !!(error as { preserveBuildLock?: boolean }).preserveBuildLock; throw error; }
    finally { try { if (temporary && !retainLock) await rm(temporary, { force: true }); } finally { if (!retainLock) await release(); } }
  }
}
