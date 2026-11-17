import * as vscode from 'vscode';
import path from 'node:path';
import { realpath, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DistributionStore } from './distributions';
import { type Family, type Instance, type InstanceRef, contextName, validateConfig } from './config';
import { InstanceManager } from './processes';
import { ProjectRepository } from './projects';
import { deployApplications, initializeTemplates } from './runtime';
import { configureNetwork } from './network';
import { DebugController, attachConfiguration, nextDebugPort } from './debug';
import { MavenBuilder, buildFingerprint } from './maven';
import { MissingClassDetector, findClassProviders, dependencyVersions, suggestedBuild, recentConsole, type ClassProvider } from './dependency-diagnostics';
import { DeferredDependencyActions, scheduleDependencyRecovery } from './dependency-actions';
import { ReloadScheduler, shouldReload, applyHotSwap, reloadSignature, permitsReload } from './hot-reload';

let manager: InstanceManager | undefined;
let disconnectDebuggers: (() => Promise<void>) | undefined;
let cancelBuilds: (() => Promise<void>) | undefined;
let stopReload: (() => void) | undefined;
class ServerNode extends vscode.TreeItem {
  constructor(readonly ref: InstanceRef, readonly state: string, debugPort?: number, attached = false) {
    super(ref.instance.name, vscode.TreeItemCollapsibleState.None);
    this.id = `${ref.project}:${ref.instance.id}`;
    this.description = `${state} · ${ref.instance.tomcatVersion} · :${ref.instance.ports.http} · ${path.basename(ref.project)}`;
    this.tooltip = `${ref.project}\nTomcat ${ref.instance.tomcatVersion}\n${ref.instance.java.release}\n${state}`;
    this.contextValue = state;
    if (state === 'running' && debugPort !== undefined) {
      this.contextValue = 'debug'; this.description += ` · debug :${debugPort}${attached ? ' (attached)' : ''}`;
    }
    this.iconPath = new vscode.ThemeIcon(state === 'running' ? 'server-process' : state === 'failed' ? 'error' : state === 'starting' || state === 'stopping' ? 'loading~spin' : 'server');
    this.command = { command: 'tomcatWorkbench.logs', title: 'Show Console', arguments: [this] };
  }
}
class ErrorNode extends vscode.TreeItem {
  constructor(project: string, error: unknown) { super(`Configuration error: ${path.basename(project)}`); this.description = String(error); this.iconPath = new vscode.ThemeIcon('error'); this.command = { command: 'tomcatWorkbench.configure', title: 'Fix Configuration', arguments: [project] }; }
}
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  configureNetwork(vscode.workspace.getConfiguration('http').get<string>('proxy') || undefined);
  const storage = context.globalStorageUri.fsPath; await mkdir(storage, { recursive: true });
  const repository = new ProjectRepository(storage);
  const events = new vscode.EventEmitter<void>(); const channels = new Map<string, vscode.OutputChannel>();
  const missingClasses = new Map<string, MissingClassDetector>();
  const diagnosisNotices = new Set<string>();
  const diagnosisTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const automaticStartupDiagnosis = new Set<string>();
  const recoveryScheduled = new Set<string>();
  const buildOperations = new Set<string>();
  const reloadRefs = new Map<string, InstanceRef>();
  const reloadSignatures = new Map<string, string>();
  const reloadEpochs = new Map<string, number>();
  const invalidateReload = (key: string) => { reloadScheduler.cancel(key); reloadEpochs.set(key, (reloadEpochs.get(key) ?? 0) + 1); };
  let reloadRefresh = 0;
  const reloadScheduler = new ReloadScheduler(key => buildOperations.has(key), (error, key) => {
    const ref = reloadRefs.get(key); if (ref) channel(ref).appendLine(`Hot reload failed: ${String(error)}`);
    if (!disposed) void vscode.window.showWarningMessage(`Tomcat hot reload: ${String(error)} The previous successful deployment is retained if the build failed.`);
  });
  stopReload = () => { reloadScheduler.dispose(); };
  const dependencyActions = new DeferredDependencyActions(key => buildOperations.has(key), error => { void vscode.window.showErrorMessage(`Tomcat dependency diagnosis: ${String(error)}`); });
  let disposed = false;
  context.subscriptions.push({ dispose: () => { disposed = true; stopReload?.(); dependencyActions.dispose(); for (const timer of diagnosisTimers.values()) clearTimeout(timer); diagnosisTimers.clear(); } });
  function scheduleRecovery(ref: InstanceRef, automatic: boolean): void {
    const noticeKey = `${ref.project}:${ref.instance.id}`;
    if (disposed || recoveryScheduled.has(noticeKey)) return;
    recoveryScheduled.add(noticeKey);
    const timer = diagnosisTimers.get(noticeKey); if (timer) clearTimeout(timer); diagnosisTimers.delete(noticeKey);
    channel(ref).appendLine(`Missing-class diagnosis scheduled${automatic ? ' automatically after Build and Run/Debug' : ''}. Dependency changes require confirmation.`);
    scheduleDependencyRecovery(dependencyActions, runtime.key(ref), automatic, async () => {
      if (disposed) return false;
      return await vscode.window.showWarningMessage(`Tomcat ${ref.instance.name}: missing Java classes detected. Search the local Maven repository for dependencies?`, { modal: true }, 'Diagnose Dependencies') === 'Diagnose Dependencies';
    }, async () => {
      if (disposed) return;
      channel(ref).appendLine('Opening missing-class dependency diagnosis.');
      await vscode.commands.executeCommand('tomcatWorkbench.diagnoseDependencies', new ServerNode(ref, runtime.state(ref)), automatic ? 'startup' : undefined);
    });
  }
  function observeLog(ref: InstanceRef, message: string): void {
    const key = `${ref.project}:${ref.instance.id}`;
    let detector = missingClasses.get(key); if (!detector) { detector = new MissingClassDetector(); missingClasses.set(key, detector); }
    // InstanceManager supplies complete console lines, including the final line
    // without a newline when a stream closes after a startup failure.
    const added = detector.push(message, true);
    if (disposed || !added.length || diagnosisNotices.has(key)) return;
    diagnosisNotices.add(key);
    const automatic = automaticStartupDiagnosis.has(runtime.key(ref));
    channel(ref).appendLine(`Missing Java classes detected: ${added.join(', ')}`);
    diagnosisTimers.set(key, setTimeout(() => {
      diagnosisTimers.delete(key);
      if (disposed) return;
      scheduleRecovery(ref, automatic);
    }, 1500));
  }
  const debugSessions = new Map<string, vscode.DebugSession>();
  async function detachDebug(key: string, generation?: string): Promise<void> {
    const session = debugSessions.get(key);
    if (generation && session?.configuration.tomcatWorkbenchGeneration !== generation) return;
    if (session) { debugSessions.delete(key); await vscode.debug.stopDebugging(session); events.fire(); }
  }
  disconnectDebuggers = async () => { await Promise.all([...debugSessions.keys()].map(key => detachDebug(key))); };
  const channel = (ref: InstanceRef) => {
    const key = `${ref.project}:${ref.instance.id}`; let output = channels.get(key);
    if (!output) { output = vscode.window.createOutputChannel(`Tomcat ${path.basename(ref.project)} / ${ref.instance.id}`); channels.set(key, output); context.subscriptions.push(output); }
    return output;
  };
  const secretKey = (project: string, name: string) => `tomcat.${createHash('sha256').update(project.toLowerCase()).digest('hex')}.${name}`;
  let reportProgress: ((message: string) => void) | undefined;
  const distributions = new DistributionStore(path.join(storage, 'distributions'), message => reportProgress?.(message));
  manager = new InstanceManager(storage, distributions, { state: (ref, state) => { events.fire(); if ((state === 'stopping' || state === 'stopped' || state === 'failed') && !buildOperations.has(runtime.key(ref))) invalidateReload(runtime.key(ref)); if (state === 'stopping' || state === 'failed' || state === 'stopped') automaticStartupDiagnosis.delete(runtime.key(ref)); if (state === 'starting') { const key = `${ref.project}:${ref.instance.id}`; missingClasses.delete(key); diagnosisNotices.delete(key); recoveryScheduled.delete(key); const timer = diagnosisTimers.get(key); if (timer) clearTimeout(timer); diagnosisTimers.delete(key); } if (state === 'stopped' || state === 'failed' || state === 'stopping') void detachDebug(runtime.key(ref)).catch(error => channel(ref).appendLine(`Debugger disconnect: ${String(error)}`)); }, log: (ref, message) => { channel(ref).append(message); observeLog(ref, message); }, secret: (project, name) => Promise.resolve(context.secrets.get(secretKey(project, name))) });
  const runtime = manager;
  async function requireJavaDebugger(): Promise<void> {
    const extension = vscode.extensions.getExtension('vscjava.vscode-java-debug');
    if (!extension) {
      const action = await vscode.window.showInformationMessage('Install Debugger for Java (Microsoft) to debug Tomcat.', 'Open Extension');
      if (action) await vscode.commands.executeCommand('extension.open', 'vscjava.vscode-java-debug');
      throw new Error('Debugger for Java is required. Install it, then run Tomcat: Debug again.');
    }
    if (!extension.isActive) await extension.activate();
  }
  const debuggerController = new DebugController(runtime, {
    available: requireJavaDebugger,
    confirmRestart: async ref => await vscode.window.showWarningMessage(`Restart ${ref.instance.name} in debug mode?`, { modal: true }, 'Restart in Debug') === 'Restart in Debug',
    attach: async (ref, key, port, generation) => {
      const existing = debugSessions.get(key);
      if (existing?.configuration.port === port && existing.configuration.tomcatWorkbenchGeneration === generation) return true;
      if (existing) await detachDebug(key);
      const folders = vscode.workspace.workspaceFolders ?? [];
      let folder: vscode.WorkspaceFolder | undefined;
      for (const candidate of folders) if (candidate.uri.scheme === 'file' && (await realpath(candidate.uri.fsPath)).toLowerCase() === ref.project.toLowerCase()) { folder = candidate; break; }
      if (!folder) throw new Error('The Tomcat project must be open in this workspace to debug.');
      return vscode.debug.startDebugging(folder, attachConfiguration(ref, key, port, generation));
    },
    detach: detachDebug
  });
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(session => {
      const key = session.configuration.tomcatWorkbenchKey;
      if (session.type === 'java' && typeof key === 'string') {
        if (!runtime.ownsDebugSession(key, session.configuration.tomcatWorkbenchGeneration)) { void Promise.resolve(vscode.debug.stopDebugging(session)).catch(() => {}); return; }
        debugSessions.set(key, session); events.fire();
      }
    }),
    vscode.debug.onDidTerminateDebugSession(session => { const key = session.configuration.tomcatWorkbenchKey; if (typeof key === 'string' && debugSessions.get(key)?.id === session.id) { debugSessions.delete(key); events.fire(); } })
  );
  const supported = () => process.platform === 'win32' && ['x64', 'arm64'].includes(process.arch) && !vscode.env.remoteName;
  const trust = () => {
    if (!supported()) throw new Error('Tomcat Workbench supports local VS Code Desktop on Windows x64/ARM64.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before downloading, executing or changing Tomcat instances.');
  };
  async function projects(): Promise<string[]> {
    const folders = vscode.workspace.workspaceFolders?.filter(f => f.uri.scheme === 'file') ?? [];
    return Promise.all(folders.map(f => realpath(f.uri.fsPath)));
  }
  async function refs(): Promise<InstanceRef[]> {
    const result: InstanceRef[] = [];
    for (const project of await projects()) for (const instance of (await repository.read(project)).instances) result.push({ project, instance });
    return result;
  }
  const provider: vscode.TreeDataProvider<vscode.TreeItem> = {
    onDidChangeTreeData: events.event,
    getTreeItem: item => item,
    getChildren: async () => {
      const result: vscode.TreeItem[] = [];
      for (const project of await projects()) {
        try { for (const instance of (await repository.read(project)).instances) { const ref = { project, instance }; result.push(new ServerNode(ref, runtime.state(ref), runtime.debugPort(ref), debugSessions.has(runtime.key(ref)))); } }
        catch (error) { result.push(new ErrorNode(project, error)); }
      }
      return result;
    }
  };
  context.subscriptions.push(events, vscode.window.createTreeView('tomcatWorkbench.servers', { treeDataProvider: provider, showCollapseAll: false }));
  async function chooseProject(): Promise<string | undefined> {
    const values = await projects(); if (!values.length) throw new Error('Open a local project folder first.');
    if (values.length === 1) return values[0];
    return (await vscode.window.showQuickPick(values.map(project => ({ label: path.basename(project), description: project, project })), { title: 'Choose project' }))?.project;
  }
  async function select(node?: ServerNode): Promise<InstanceRef | undefined> {
    // Resolve the current config rather than using a stale TreeItem snapshot.
    const values = await refs();
    if (node) return values.find(r => r.project === node.ref.project && r.instance.id === node.ref.instance.id);
    if (!values.length) throw new Error('No Tomcat instances. Run Tomcat: Create Instance.');
    return (await vscode.window.showQuickPick(values.map(ref => ({ label: ref.instance.name, description: `${path.basename(ref.project)} / ${ref.instance.tomcatVersion}`, ref })), { title: 'Choose Tomcat instance' }))?.ref;
  }
  async function progress<T>(title: string, operation: () => Promise<T>): Promise<T> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, async reporter => {
      reportProgress = message => reporter.report({ message });
      try { return await operation(); } finally { reportProgress = undefined; events.fire(); }
    });
  }
  function command(name: string, action: (...args: any[]) => Promise<unknown>, needsTrust = true) {
    context.subscriptions.push(vscode.commands.registerCommand(`tomcatWorkbench.${name}`, async (...args) => {
      let operationKey: string | undefined;
      try {
        if (needsTrust) trust();
        if (['start', 'stop', 'restart', 'debug', 'stopDebug', 'templates', 'deploy', 'undeploy', 'cleanup', 'remove'].includes(name)) {
          const ref = await select(args[0]); if (!ref || disposed) return;
          const key = runtime.key(ref); invalidateReload(key);
          if (name === 'stop') { const active = activeBuilds.get(key); if (active) { active.abort.abort(); await active.done; } }
          if (buildOperations.has(key)) throw new Error('Another build/deployment operation is running for this instance.');
          buildOperations.add(key); operationKey = key; args[0] = new ServerNode(ref, runtime.state(ref));
        }
        return await action(...args);
      }
      catch (error) {
        if (operationKey) { buildOperations.delete(operationKey); void dependencyActions.flush(operationKey); void reloadScheduler.flush(operationKey); operationKey = undefined; }
        await vscode.window.showErrorMessage(`Tomcat: ${error instanceof Error ? error.message : String(error)}`);
      }
      finally { if (operationKey) { buildOperations.delete(operationKey); void dependencyActions.flush(operationKey); void reloadScheduler.flush(operationKey); } events.fire(); }
    }));
  }
  async function recover() {
    if (!supported() || !vscode.workspace.isTrusted) return;
    for (const project of await projects()) {
      try { for (const instance of (await repository.read(project)).instances) await runtime.recover({ project, instance }); }
      catch (error) { void vscode.window.showWarningMessage(`Tomcat recovery (${path.basename(project)}): ${String(error)}`); }
    }
    events.fire();
  }
  command('refresh', recover, false);
  command('create', async () => {
    const project = await chooseProject(); if (!project) return;
    const config = await repository.read(project);
    const id = await vscode.window.showInputBox({ title: 'Instance id', prompt: 'Lowercase identifier unique in this project', value: 'tomcat', validateInput: value => !/^[a-z][a-z0-9_-]{0,63}$/.test(value) || config.instances.some(i => i.id === value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value) ? 'Use a unique lowercase id (letters, numbers, _ and -).' : undefined }); if (!id) return;
    const family = await vscode.window.showQuickPick(['8.5', '9.0', '10.1', '11.0'], { title: 'Tomcat family' }) as Family | undefined; if (!family) return;
    const versions = await progress('Loading Tomcat versions', () => distributions.tomcatVersions(family));
    const tomcatVersion = await vscode.window.showQuickPick(versions, { title: 'Exact Tomcat version' }); if (!tomcatVersion) return;
    const majors = family === '11.0' ? ['17', '21'] : family === '10.1' ? ['17', '21', '11'] : ['17', '21', '11', '8'];
    const major = await vscode.window.showQuickPick(majors, { title: 'Java major version (17 suggested)' }); if (!major) return;
    const releases = await progress('Loading Temurin releases', () => distributions.javaVersions(Number(major)));
    const release = await vscode.window.showQuickPick(releases, { title: 'Exact Temurin JDK release' }); if (!release) return;
    const used = new Set(config.instances.flatMap(i => [i.ports.http, i.ports.shutdown, ...(i.debug ? [i.debug.port] : [])]));
    let port = 8080; while (used.has(port) || used.has(port - 75)) port += 10;
    const http = await vscode.window.showInputBox({ title: 'HTTP port', value: String(port), validateInput: v => !/^\d+$/.test(v) || +v < 1024 || +v > 65535 || used.has(+v) ? 'Choose an unused port between 1024 and 65535.' : undefined }); if (!http) return;
    const shutdown = await vscode.window.showInputBox({ title: 'Local shutdown port', value: String(port - 75), validateInput: v => !/^\d+$/.test(v) || +v < 1024 || +v > 65535 || used.has(+v) || +v === +http ? 'Choose a distinct unused port between 1024 and 65535.' : undefined }); if (!shutdown) return;
    const instance: Instance = { id, name: id, tomcatVersion, java: { major: +major, release }, ports: { http: +http, shutdown: +shutdown }, jvmArgs: ['-Xms128m', '-Xmx512m'], environment: {}, applications: [] };
    await progress('Creating Tomcat instance', async () => {
      await distributions.ensureTomcat(tomcatVersion); await distributions.ensureJava(instance.java);
      await repository.update(project, cfg => { cfg.instances.push(instance); return cfg; });
    });
    void vscode.window.showInformationMessage('Tomcat instance created. Start it from Tomcat Servers.');
  });
  command('configure', async (node?: ServerNode | string) => {
    const project = typeof node === 'string' ? node : node?.ref.project ?? await chooseProject(); if (!project) return;
    const uri = vscode.Uri.file(repository.file(project));
    try { await vscode.window.showTextDocument(uri); }
    catch { if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before creating configuration.'); await repository.update(project, c => c); await vscode.window.showTextDocument(uri); }
  }, false);
  for (const action of ['start', 'stop', 'restart'] as const) command(action, async (node?: ServerNode) => {
    const ref = await select(node); if (!ref) return;
    await progress(`${action}: ${ref.instance.name}`, async () => {
      if (action === 'restart' && runtime.debugPort(ref) !== undefined) { await debuggerController.start(ref, true); return; }
      if (action !== 'start') { await detachDebug(runtime.key(ref)); await runtime.stop(ref); }
      if (action !== 'stop') await runtime.start(ref);
    });
  });
  command('debug', async (node?: ServerNode) => {
    const ref = await select(node); if (!ref) return;
    await ensureDebugOptions(ref);
    await progress(`Debug: ${ref.instance.name}`, () => debuggerController.start(ref));
  });
  async function ensureDebugOptions(ref: InstanceRef): Promise<void> {
    if (!ref.instance.debug && runtime.debugPort(ref) === undefined) await repository.update(ref.project, config => {
      const instance = config.instances.find(i => i.id === ref.instance.id); if (!instance) throw new Error('Instance was removed.');
      instance.debug ??= { port: nextDebugPort(config.instances) }; ref.instance = instance; return config;
    });
  }
  command('stopDebug', async (node?: ServerNode) => { const ref = await select(node); if (ref) await debuggerController.stopDebug(ref); });
  async function ensureBuildOptions(ref: InstanceRef): Promise<boolean> {
    if (ref.instance.build) return true;
    const file = await vscode.window.showOpenDialog({ title: 'Select the WAR module POM', defaultUri: vscode.Uri.file(path.join(ref.project, 'pom.xml')), canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { 'Maven POM': ['xml'] } });
    if (!file?.[0]) return false;
    const context = await vscode.window.showInputBox({ title: 'Context for the built WAR', value: ref.instance.applications[0]?.context ?? `/${ref.instance.id}`, validateInput: value => { try { contextName(value); return undefined; } catch (error) { return String(error); } } });
    if (!context) return false;
    await repository.update(ref.project, config => {
      const instance = config.instances.find(i => i.id === ref.instance.id); if (!instance) throw new Error('Instance was removed.');
      instance.build = { pom: path.relative(ref.project, file[0].fsPath).replaceAll('\\', '/'), context }; ref.instance = instance; return config;
    }); return true;
  }
  const activeBuilds = new Map<string, { abort: AbortController; done: Promise<void> }>();
  cancelBuilds = async () => { disposed = true; dependencyActions.dispose(); for (const timer of diagnosisTimers.values()) clearTimeout(timer); diagnosisTimers.clear(); const active = [...activeBuilds.values()]; for (const build of active) build.abort.abort(); await Promise.allSettled(active.map(build => build.done)); };
  for (const action of ['build', 'buildRun', 'buildDebug', 'previewBuildPom'] as const) command(action, async (node?: ServerNode, automatic?: { generation: string; mode: 'redeploy'; epoch: number; signature: string }) => {
    const ref = await select(node); if (!ref) return;
    const key = runtime.key(ref); if (buildOperations.has(key)) throw new Error('Another build operation is still running for this instance.');
    if (automatic && (disposed || ref.instance.hotReload?.mode !== automatic.mode || runtime.state(ref) !== 'running' || runtime.generation(ref) !== automatic.generation)) return;
    if (automatic && ((reloadEpochs.get(key) ?? 0) !== automatic.epoch || reloadSignature(ref.instance) !== automatic.signature)) return;
    if (!automatic) invalidateReload(key);
    const assertAutomatic = (instance: Instance, stopped: boolean) => {
      if (!automatic) return;
      if (!permitsReload(automatic, { trusted: !disposed && vscode.workspace.isTrusted, epoch: reloadEpochs.get(key) ?? 0, signature: reloadSignature(instance), enabled: instance.hotReload?.mode === automatic.mode, state: runtime.state(ref), generation: runtime.generation(ref) }, stopped)) throw new Error('Automatic reload cancelled: the runtime or configuration changed.');
    };
    buildOperations.add(key);
    let complete: (() => void) | undefined;
    let startupAttempted = false;
    try {
      if (!(await ensureBuildOptions(ref))) return;
      const output = channel(ref); const builder = new MavenBuilder(storage, distributions, message => output.append(message));
      if (action === 'buildDebug') { await requireJavaDebugger(); await ensureDebugOptions(ref); }
      output.show(true);
      if (ref.instance.libraries?.some(p => /[\\/](?:spring-|springfox-)/i.test(p))) output.appendLine('Shared Spring/Swagger server libraries remain active. A self-contained WAR should normally use its own application libraries; review legacy shared-library settings if class loading fails.');
      const abort = new AbortController();
      const done = new Promise<void>(resolve => complete = resolve); activeBuilds.set(key, { abort, done });
      if (action === 'previewBuildPom') { const xml = await progress('Resolving build POM', () => builder.preview(ref, abort.signal)); if (!abort.signal.aborted) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'xml', content: xml })); return; }
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Build WAR: ${ref.instance.name}`, cancellable: true }, async (reporter, cancellation) => {
        const subscription = cancellation.onCancellationRequested(() => abort.abort());
        reportProgress = message => reporter.report({ message });
        try { return await builder.build(ref, abort.signal); } finally { subscription.dispose(); reportProgress = undefined; }
      });
      if (abort.signal.aborted) throw new Error('Build operation cancelled.');
      if (action === 'build') { void vscode.window.showInformationMessage(`WAR ready: ${result.source}`); return; }
      const current = (await repository.read(ref.project)).instances.find(i => i.id === ref.instance.id);
      if (!current?.build || buildFingerprint(current.build) !== result.fingerprint) throw new Error('Build configuration changed while compiling. The WAR was retained, but not deployed.');
      assertAutomatic(current, false);
      ref.instance = current;
      await progress('Publishing built WAR', async () => {
        if (abort.signal.aborted) throw new Error('Build operation cancelled.');
        await detachDebug(key); assertAutomatic(ref.instance, false); await runtime.stop(ref, automatic?.generation);
        assertAutomatic(ref.instance, true);
        await runtime.withStopped(ref, () => repository.update(ref.project, async config => {
          const instance = config.instances.find(i => i.id === ref.instance.id);
          if (!instance?.build || buildFingerprint(instance.build) !== result.fingerprint) throw new Error('Build configuration changed. The previous deployments were retained.');
          assertAutomatic(instance, true);
          instance.applications = [...instance.applications.filter(app => contextName(app.context).toLowerCase() !== contextName(result.context).toLowerCase()), { source: result.source, context: result.context }];
          const validated = validateConfig(config); await deployApplications(ref.project, runtime.key(ref), instance.applications); ref.instance = instance; return validated;
        }));
        if (abort.signal.aborted) throw new Error('Build operation cancelled.');
        if (automatic) { const latest = (await repository.read(ref.project)).instances.find(i => i.id === ref.instance.id); if (!latest) throw new Error('Instance removed during automatic reload.'); assertAutomatic(latest, true); ref.instance = latest; }
        startupAttempted = true; automaticStartupDiagnosis.add(key);
        if (action === 'buildDebug') await debuggerController.start(ref); else await runtime.start(ref);
      });
    } finally {
      if (startupAttempted && missingClasses.get(`${ref.project}:${ref.instance.id}`)?.classes.size) scheduleRecovery(ref, true);
      complete?.(); activeBuilds.delete(key); buildOperations.delete(key); events.fire(); void dependencyActions.flush(key);
      void reloadScheduler.flush(key);
    }
  });
  command('diagnoseDependencies', async (node?: ServerNode, trigger?: 'startup') => {
    const ref = await select(node); if (!ref || disposed) return;
    const key = runtime.key(ref);
    if (buildOperations.has(key)) {
      dependencyActions.enqueue(key, async () => { if (!disposed) await vscode.commands.executeCommand('tomcatWorkbench.diagnoseDependencies', new ServerNode(ref, runtime.state(ref)), trigger); });
      return;
    }
    buildOperations.add(key);
    const abort = new AbortController(); let complete!: () => void;
    activeBuilds.set(key, { abort, done: new Promise<void>(resolve => complete = resolve) });
    let rebuild: string | undefined;
    try {
      if (!ref.instance.build) throw new Error('Configure a Maven WAR build for this instance before diagnosing dependencies.');
      const fingerprint = buildFingerprint(ref.instance.build!);
      const detector = new MissingClassDetector();
      const live = missingClasses.get(`${ref.project}:${ref.instance.id}`);
      if (live?.classes.size) for (const name of live.classes) detector.classes.add(name);
      else detector.push(await recentConsole(path.join(key, 'logs/console.log')), true);
      if (!detector.classes.size) { await vscode.window.showInformationMessage('No missing-class exceptions found in the current session or recent console log.'); return; }
      const output = channel(ref); output.show(true);
      output.appendLine(`Dependency diagnosis: ${[...detector.classes].join(', ')}`);
      const builder = new MavenBuilder(storage, distributions, message => output.append(message));
      const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Diagnosing missing Java dependencies', cancellable: true }, async (reporter, token) => {
        const subscription = token.onCancellationRequested(() => abort.abort());
        try {
          const model = await builder.dependencyContext(ref, abort.signal);
          return await findClassProviders(model.repository, [...detector.classes], dependencyVersions(model.pom), abort.signal, count => reporter.report({ message: `${count} cached JARs inspected` }));
        } finally { subscription.dispose(); }
      });
      // No child process remains during selection/confirmation; shutdown must not
      // wait for a user to dismiss those dialogs.
      complete(); activeBuilds.delete(key);
      if (abort.signal.aborted || disposed) return;
      output.appendLine(`Inspected ${found.scanned} cached JARs; ${found.unreadable} unreadable; scan limit reached: ${found.truncated}.`);
      const choices: ClassProvider[] = [];
      for (const [name, providers] of found.providers) {
        if (!providers.length) { output.appendLine(`No cached application JAR contains ${name}. It may be absent from the cache, supplied by the container, or unrelated to a missing dependency.`); continue; }
        const selected = await vscode.window.showQuickPick(providers.map(provider => ({ label: `${provider.groupId}:${provider.artifactId}:${provider.version}`, description: provider.managed ? 'Version managed by the project' : 'Explicit version override; review compatibility', detail: name, provider })), { title: `Dependency for ${name}`, placeHolder: 'Choose a cached provider; Escape skips this class', ignoreFocusOut: true });
        if (disposed) return;
        if (selected) choices.push(selected.provider);
      }
      if (!choices.length) { output.appendLine('No dependency selected; tomcat.json was not changed.'); await vscode.window.showInformationMessage('No dependency selected. See the Tomcat output for diagnosis details.', { modal: trigger === 'startup' }); return; }
      const updated = suggestedBuild(ref.instance.build!, choices);
      const lines = [...new Set(choices.map(c => `${c.groupId}:${c.artifactId}:${c.version}${c.managed ? ' (managed)' : ' (explicit override)'}`))].join('\n');
      const action = await vscode.window.showWarningMessage(`Add these dependencies to build.dependencies?\n\n${lines}\n\nThe original POM is preserved. Building and running restarts this Tomcat after a successful build.`, { modal: true }, 'Save Only', 'Build and Run', 'Build and Debug');
      if (!action || abort.signal.aborted || disposed) return;
      await repository.update(ref.project, config => {
        const instance = config.instances.find(i => i.id === ref.instance.id);
        if (!instance?.build || buildFingerprint(instance.build) !== fingerprint) throw new Error('Build configuration changed during diagnosis. Run diagnosis again before applying suggestions.');
        instance.build = updated; ref.instance = instance; return config;
      });
      output.appendLine(`Confirmed dependency overrides saved:\n${lines}`);
      if (action === 'Build and Run') rebuild = 'buildRun'; else if (action === 'Build and Debug') rebuild = 'buildDebug';
    } finally { complete(); activeBuilds.delete(key); buildOperations.delete(key); events.fire(); void dependencyActions.flush(key); void reloadScheduler.flush(key); }
    if (rebuild && !disposed && !abort.signal.aborted) await vscode.commands.executeCommand(`tomcatWorkbench.${rebuild}`, new ServerNode(ref, runtime.state(ref)));
  });
  async function hotSwap(ref: InstanceRef, expectedEpoch?: number): Promise<void> {
    const key = runtime.key(ref); if (buildOperations.has(key)) throw new Error('Another operation is running for this instance.');
    const session = debugSessions.get(key); const generation = runtime.generation(ref); const signature = reloadSignatures.get(key); const epoch = expectedEpoch ?? reloadEpochs.get(key) ?? 0;
    if ((reloadEpochs.get(key) ?? 0) !== epoch || disposed) return;
    if (!session || !generation || !runtime.ownsDebugSession(key, session.configuration.tomcatWorkbenchGeneration)) throw new Error('Start Tomcat: Debug and attach its Java debugger before HotSwap.');
    const java = vscode.extensions.getExtension('redhat.java'); if (!java) throw new Error('Install Language Support for Java by Red Hat and import the project before HotSwap.');
    buildOperations.add(key); const abort = new AbortController(); let complete!: () => void;
    activeBuilds.set(key, { abort, done: new Promise<void>(resolve => complete = resolve) });
    try {
      const count = await applyHotSwap({
        current: () => !disposed && vscode.workspace.isTrusted && (reloadEpochs.get(key) ?? 0) === epoch && runtime.state(ref) === 'running' && runtime.generation(ref) === generation && debugSessions.get(key)?.id === session.id && reloadSignatures.get(key) === signature && runtime.ownsDebugSession(key, session.configuration.tomcatWorkbenchGeneration),
        compile: async () => { if (!java.isActive) await java.activate(); if (abort.signal.aborted || disposed) throw new Error('HotSwap cancelled.'); return vscode.commands.executeCommand('java.execute.workspaceCommand', 'vscode.java.buildWorkspace', JSON.stringify({ isFullBuild: false, ...(ref.instance.debug?.projectName ? { projectName: ref.instance.debug.projectName } : {}) })); },
        redefine: async () => session.customRequest('redefineClasses')
      }, abort.signal);
      channel(ref).appendLine(count ? `HotSwap applied to ${count} classes without restarting Tomcat.` : 'HotSwap found no pending changed classes. The debugger may already have applied them.');
    } finally { complete(); activeBuilds.delete(key); buildOperations.delete(key); events.fire(); void reloadScheduler.flush(key); void dependencyActions.flush(key); }
  }
  command('hotSwap', async (node?: ServerNode) => { const ref = await select(node); if (ref && !disposed) await hotSwap(ref); });
  command('configureHotReload', async (node?: ServerNode) => {
    const ref = await select(node); if (!ref) return;
    const choice = await vscode.window.showQuickPick([{ label: 'Off', mode: undefined }, { label: 'HotSwap on Java save (debug only)', mode: 'hotswap' as const }, { label: 'Rebuild/redeploy on Java save (restarts Tomcat)', mode: 'redeploy' as const }], { title: `Hot reload: ${ref.instance.name}` });
    if (!choice) return;
    invalidateReload(runtime.key(ref));
    if (choice.mode === 'redeploy' && !await ensureBuildOptions(ref)) return;
    let delay = ref.instance.hotReload?.delayMs ?? 1000;
    if (choice.mode) {
      const input = await vscode.window.showInputBox({ title: 'Wait after the last Java save (milliseconds)', value: String(delay), validateInput: value => /^\d+$/.test(value) && Number(value) >= 200 && Number(value) <= 30000 ? undefined : 'Use 200 to 30000 milliseconds.' });
      if (input === undefined) return; delay = Number(input);
    }
    await repository.update(ref.project, config => { const instance = config.instances.find(i => i.id === ref.instance.id); if (!instance) throw new Error('Instance removed.'); if (choice.mode) instance.hotReload = { ...instance.hotReload, mode: choice.mode, delayMs: delay }; else delete instance.hotReload; return config; });
    await refreshReload();
  });
  async function refreshReload(): Promise<void> {
    const request = ++reloadRefresh;
    try {
      const current = await refs(); if (disposed || request !== reloadRefresh) return;
      const keys = new Set(current.map(ref => runtime.key(ref)));
      for (const key of reloadRefs.keys()) if (!keys.has(key)) { invalidateReload(key); reloadRefs.delete(key); reloadSignatures.delete(key); }
      for (const ref of current) {
        const key = runtime.key(ref); const signature = reloadSignature(ref.instance);
        if (reloadSignatures.get(key) !== signature) invalidateReload(key);
        reloadRefs.set(key, ref); reloadSignatures.set(key, signature);
      }
    } catch (error) { if (request !== reloadRefresh) return; reloadScheduler.cancelAll(); reloadRefs.clear(); reloadSignatures.clear(); if (!disposed) void vscode.window.showWarningMessage(`Hot reload configuration: ${String(error)}`); }
  }
  async function reloadSavedJava(uri: vscode.Uri): Promise<void> {
    if (disposed || !vscode.workspace.isTrusted || uri.scheme !== 'file' || !uri.fsPath.toLowerCase().endsWith('.java')) return;
    const candidates = [...reloadRefs].filter(([key, ref]) => ref.instance.hotReload && (runtime.state(ref) === 'running' || buildOperations.has(key))).map(([key, ref]) => ({ key, ref, epoch: reloadEpochs.get(key) ?? 0 }));
    if (!candidates.length) return;
    let file: string;
    try { file = await realpath(uri.fsPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (disposed || !vscode.workspace.isTrusted) return;
    for (const { key, ref, epoch } of candidates) {
      if ((reloadEpochs.get(key) ?? 0) !== epoch) continue;
      const project = ref.project; const relative = path.relative(project, file);
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) continue;
      if (!ref.instance.hotReload || !shouldReload(relative, ref.instance.hotReload) || (runtime.state(ref) !== 'running' && !buildOperations.has(key))) continue;
      channel(ref).appendLine(`Hot reload queued after Java save: ${relative}`);
      reloadScheduler.schedule(key, ref.instance.hotReload.delayMs ?? 1000, async () => {
        if (disposed || !vscode.workspace.isTrusted || (reloadEpochs.get(key) ?? 0) !== epoch) return;
        const instance = (await repository.read(project)).instances.find(i => i.id === ref.instance.id);
        if (disposed || !vscode.workspace.isTrusted || (reloadEpochs.get(key) ?? 0) !== epoch) return;
        if (!instance?.hotReload || !shouldReload(relative, instance.hotReload) || runtime.state(ref) !== 'running') return;
        const latest = { project, instance };
        if (instance.hotReload.mode === 'hotswap') { if (debugSessions.has(key)) await hotSwap(latest, epoch); else channel(latest).appendLine('HotSwap skipped: attach the managed Java debugger first.'); }
        else {
          const generation = runtime.generation(latest); if (!generation) return;
          channel(latest).appendLine('Rebuilding and restarting Tomcat after a Java save.');
          await vscode.commands.executeCommand(runtime.debugPort(latest) !== undefined ? 'tomcatWorkbench.buildDebug' : 'tomcatWorkbench.buildRun', new ServerNode(latest, runtime.state(latest)), { generation, mode: 'redeploy', epoch, signature: reloadSignature(instance) });
        }
      });
    }
  }
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
    void reloadSavedJava(document.uri).catch(error => { if (!disposed) void vscode.window.showWarningMessage(`Hot reload: ${String(error)}`); });
  }));
  command('logs', async (node?: ServerNode) => { const ref = await select(node); if (ref) channel(ref).show(true); }, false);
  command('logFiles', async (node?: ServerNode) => { const ref = await select(node); if (ref) { const logs = path.join(runtime.key(ref), 'logs'); await mkdir(logs, { recursive: true }); await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(logs)); } });
  command('open', async (node?: ServerNode) => {
    const ref = await select(node); if (!ref) return;
    if (runtime.state(ref) !== 'running') throw new Error('Start the instance first.');
    const contexts = ref.instance.applications.map(a => a.context);
    const selected = contexts.length ? await vscode.window.showQuickPick(contexts, { title: 'Open application' }) : '/';
    if (selected) await vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${ref.instance.ports.http}${selected}${selected.endsWith('/') ? '' : '/'}`));
  });
  async function stopForEdit(ref: InstanceRef): Promise<'debug' | 'normal' | undefined> {
    if (await runtime.recover(ref)) {
      if (await vscode.window.showWarningMessage('This operation stops and restarts the running Tomcat instance.', { modal: true }, 'Stop and continue') !== 'Stop and continue') throw new Error('Operation cancelled.');
      const mode = runtime.debugPort(ref) !== undefined ? 'debug' : 'normal';
      await detachDebug(runtime.key(ref)); await runtime.stop(ref); return mode;
    }
    return undefined;
  }
  command('templates', async (node?: ServerNode) => {
    const ref = await select(node); if (!ref) return;
    if (ref.instance.configDir && await vscode.window.showWarningMessage('Generate fresh native configuration? Existing files will be backed up next to the configuration folder.', { modal: true }, 'Generate') !== 'Generate') return;
    await progress('Preparing native configuration', async () => {
      const restart = await stopForEdit(ref);
      await runtime.withStopped(ref, async () => {
        const home = await distributions.ensureTomcat(ref.instance.tomcatVersion);
        const updated = { ...ref.instance, configDir: ref.instance.configDir ?? `.vscode/tomcat/${ref.instance.id}` };
        const folder = await initializeTemplates(home, ref.project, updated);
        await repository.update(ref.project, config => { const i = config.instances.find(i => i.id === updated.id); if (!i) throw new Error('Instance was removed.'); i.configDir = updated.configDir; return config; });
        ref.instance = updated; await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder, 'server.xml')));
      });
      if (restart === 'debug') await debuggerController.start(ref); else if (restart) await runtime.start(ref);
    });
  });
  async function editApplications(ref: InstanceRef, edit: (apps: Instance['applications']) => Instance['applications']) {
    await progress('Updating Tomcat applications', async () => {
      const restart = await stopForEdit(ref);
      await runtime.withStopped(ref, () => repository.update(ref.project, async config => {
        const instance = config.instances.find(i => i.id === ref.instance.id); if (!instance) throw new Error('Instance was removed.');
        instance.applications = edit(instance.applications); const validated = validateConfig(config);
        await deployApplications(ref.project, runtime.key(ref), instance.applications); ref.instance = instance; return validated;
      }));
      if (restart === 'debug') await debuggerController.start(ref); else if (restart) await runtime.start(ref);
    });
  }
  command('deploy', async (node?: ServerNode) => {
    const ref = await select(node); if (!ref) return;
    const kind = await vscode.window.showQuickPick(['WAR file', 'Application directory'], { title: 'Deployment source' }); if (!kind) return;
    const selected = await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(ref.project), canSelectFiles: kind === 'WAR file', canSelectFolders: kind !== 'WAR file', canSelectMany: false, ...(kind === 'WAR file' ? { filters: { 'Java Web Archive': ['war'] } } : {}) }); if (!selected?.[0]) return;
    const context = await vscode.window.showInputBox({ title: 'Context path', value: `/${path.basename(selected[0].fsPath).replace(/\.war$/i, '').replace(/[^A-Za-z0-9_-]/g, '-')}`, prompt: 'Use / for the root application', validateInput: value => { try { contextName(value); return undefined; } catch (e) { return String(e); } } }); if (!context) return;
    const source = path.relative(ref.project, selected[0].fsPath).replaceAll('\\', '/');
    await editApplications(ref, apps => [...apps.filter(a => contextName(a.context).toLowerCase() !== contextName(context).toLowerCase()), { source, context }]);
  });
  command('undeploy', async (node?: ServerNode) => { const ref = await select(node); if (!ref) return; const context = await vscode.window.showQuickPick(ref.instance.applications.map(a => a.context), { title: 'Remove deployment' }); if (context) await editApplications(ref, apps => apps.filter(a => a.context !== context)); });
  command('secret', async () => {
    const project = await chooseProject(); if (!project) return;
    const name = await vscode.window.showInputBox({ title: 'Secret name', prompt: 'Reference it in environment values with ${secret:name}', validateInput: v => /^[A-Za-z0-9_.-]+$/.test(v) ? undefined : 'Use letters, numbers, dots, hyphens or underscores.' }); if (!name) return;
    const value = await vscode.window.showInputBox({ title: `Value for ${name}`, password: true, ignoreFocusOut: true }); if (value === undefined) return;
    await context.secrets.store(secretKey(project, name), value);
  });
  command('cleanup', async (node?: ServerNode) => { const ref = await select(node); if (!ref) return; if (await vscode.window.showWarningMessage('Delete local logs, deployments, temporary files and configuration backups for this instance? Project files and downloaded distributions are kept.', { modal: true }, 'Delete local data') === 'Delete local data') await runtime.cleanup(ref); });
  command('remove', async (node?: ServerNode) => {
    const ref = await select(node); if (!ref) return;
    if (await vscode.window.showWarningMessage(`Remove ${ref.instance.name} from the project? Local logs and native templates are kept.`, { modal: true }, 'Remove') !== 'Remove') return;
    await detachDebug(runtime.key(ref)); await runtime.stop(ref);
    await runtime.withStopped(ref, () => repository.update(ref.project, config => ({ ...config, instances: config.instances.filter(i => i.id !== ref.instance.id) })));
  });
  const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/tomcat.json');
  const configChanged = () => { events.fire(); void refreshReload(); };
  context.subscriptions.push(watcher, watcher.onDidCreate(configChanged), watcher.onDidChange(configChanged), watcher.onDidDelete(configChanged), vscode.workspace.onDidChangeWorkspaceFolders(() => { configChanged(); void recover(); }), vscode.workspace.onDidGrantWorkspaceTrust(() => { void recover(); void refreshReload(); }));
  await refreshReload();
  await recover();
}
export async function deactivate(): Promise<void> { stopReload?.(); try { await cancelBuilds?.(); await disconnectDebuggers?.(); } finally { await manager?.shutdown(); } }
