import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DOMParser } from '@xmldom/xmldom';
import { generateBuildPom, isolateEffectivePom, MavenBuilder, mavenLaunch, executeMaven, type BuildResult } from '../src/maven';
import { validateConfig, type InstanceRef } from '../src/config';

const pom = '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><parent><groupId>example</groupId><artifactId>parent</artifactId><version>1</version><relativePath>../pom.xml</relativePath></parent><artifactId>app</artifactId><packaging>war</packaging><properties><custom>kept</custom></properties><dependencies><dependency><groupId>example</groupId><artifactId>provided-lib</artifactId><version>1</version><scope>provided</scope></dependency></dependencies></project>';
function ref(project: string): InstanceRef { return { project, instance: { id: 'app', name: 'App', tomcatVersion: '8.5.100', java: { major: 8, release: 'jdk8u432-b06' }, ports: { http: 8080, shutdown: 8005 }, jvmArgs: [], environment: {}, applications: [], build: { pom: 'pom.xml', context: '/app' } } }; }
test('derived POM preserves the project model and adds isolated provided-WAR packaging', () => {
  const generated = generateBuildPom(pom, 'C:/project/.tomcat-workbench/app/build', { pom: 'pom.xml', context: '/app', dependencies: [{ groupId: 'org.apache.httpcomponents', artifactId: 'httpclient' }] });
  const doc = new DOMParser().parseFromString(generated);
  assert.equal(doc.getElementsByTagName('relativePath')[0].textContent, '../pom.xml');
  assert.equal(doc.getElementsByTagName('custom')[0].textContent, 'kept');
  const plugins = Array.from(doc.getElementsByTagName('plugin'));
  const dependency = plugins.find(p => p.getElementsByTagName('artifactId')[0].textContent === 'maven-dependency-plugin')!;
  assert.equal(dependency.getElementsByTagName('includeScope')[0].textContent, 'provided');
  assert.match(dependency.getElementsByTagName('excludeGroupIds')[0].textContent!, /org.apache.tomcat.embed/);
  const war = plugins.find(p => p.getElementsByTagName('artifactId')[0].textContent === 'maven-war-plugin')!;
  assert.equal(war.getElementsByTagName('targetPath')[0].textContent, 'WEB-INF/lib');
  assert.equal(doc.getElementsByTagName('directory')[0].textContent, 'C:/project/.tomcat-workbench/app/build');
  assert.ok(Array.from(doc.getElementsByTagName('dependency')).some(d => d.getElementsByTagName('artifactId')[0].textContent === 'httpclient'));
});
test('does not guess dependencies, rejects non-WAR/multi-module projects and keeps tests out of provided copying', () => {
  assert.throws(() => generateBuildPom(pom.replace('<packaging>war</packaging>', '<packaging>jar</packaging>'), '/build', { pom: 'pom.xml', context: '/' }), /WAR/i);
  assert.throws(() => generateBuildPom(pom.replace('</project>', '<modules><module>child</module></modules></project>'), '/build', { pom: 'pom.xml', context: '/' }), /module/i);
  const generated = generateBuildPom(pom, '/build', { pom: 'pom.xml', context: '/', includeProvided: false });
  const doc = new DOMParser().parseFromString(generated);
  assert.equal(doc.getElementsByTagName('includeScope').length, 0);
  assert.equal(doc.getElementsByTagName('dependency').length, 1);
});

test('a main JAR override does not replace a dependency with a classifier', () => {
  const source = pom.replace('<artifactId>provided-lib</artifactId>', '<artifactId>provided-lib</artifactId><classifier>tests</classifier><type>test-jar</type>');
  const generated = generateBuildPom(source, '/build', { pom: 'pom.xml', context: '/', dependencies: [{ groupId: 'example', artifactId: 'provided-lib', version: '1' }] });
  const doc = new DOMParser().parseFromString(generated);
  const rootDependencies = Array.from(doc.documentElement.childNodes).find(n => n.nodeName === 'dependencies')!;
  const values = Array.from(rootDependencies.childNodes).filter(n => n.nodeType === 1);
  assert.equal(values.length, 2);
  assert.match(values[0].toString(), /<classifier>tests<\/classifier>/);
  assert.match(values[1].toString(), /<scope>compile<\/scope>/);
});
test('build configuration validates project paths, exact Maven versions and dependency overrides', () => {
  const instance = ref('C:/project').instance;
  assert.equal(validateConfig({ version: 1, instances: [instance] }).instances[0].build?.context, '/app');
  for (const build of [{ ...instance.build, pom: '../outside/pom.xml' }, { ...instance.build, mavenVersion: 'latest' }, { ...instance.build, goal: 'deploy' }, { ...instance.build, dependencies: [{ groupId: 'group', artifactId: '../escape' }] }]) assert.throws(() => validateConfig({ version: 1, instances: [{ ...instance, build }] }), /build|Maven|path|dependency/i);
});
test('Maven uses managed Java/ClassWorlds, exact argument boundaries and explicit settings/profiles', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tw-maven-launch-'));
  try {
    await mkdir(path.join(root, 'boot')); await writeFile(path.join(root, 'boot/plexus-classworlds-2.8.0.jar'), 'fixture');
    const launch = await mavenLaunch(root, 'C:/Java 8', 'C:/projeto espaço', 'C:/projeto espaço/.generated.xml', { pom: 'pom.xml', context: '/', profiles: ['local'], settings: '.mvn/settings.xml', skipTests: true });
    assert.equal(launch.executable, path.join('C:/Java 8', 'bin/java.exe'));
    assert.ok(launch.args.includes('org.codehaus.plexus.classworlds.launcher.Launcher'));
    assert.ok(launch.args.includes('C:/projeto espaço/.generated.xml'));
    assert.ok(launch.args.includes('-DskipTests=true')); assert.equal(launch.args.at(-1), 'package');
    assert.equal(launch.args.includes('clean'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('build accepts external settings and passes the exact path as one Maven argument', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tw-settings-'));
  try {
    await mkdir(path.join(root, 'boot')); await writeFile(path.join(root, 'boot/plexus-classworlds.jar'), 'fixture');
    const instance = ref(root).instance;
    const settings = path.join(root, 'external settings.xml');
    instance.build!.settings = settings;
    assert.equal(validateConfig({ version: 1, instances: [instance] }).instances[0].build!.settings, settings);
    const launch = await mavenLaunch(root, root, path.join(root, 'project'), 'pom.xml', instance.build!);
    assert.equal(launch.args[launch.args.indexOf('-s') + 1], settings);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('successful build snapshots a WAR without changing the POM or normal target and failures preserve it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tw-maven-build-'));
  try {
    await writeFile(path.join(root, 'pom.xml'), pom); await mkdir(path.join(root, 'target')); await writeFile(path.join(root, 'target/keep.txt'), 'normal-output');
    const home = path.join(root, 'maven'); await mkdir(path.join(home, 'boot'), { recursive: true }); await writeFile(path.join(home, 'boot/plexus-classworlds.jar'), 'fixture');
    let fail = false;
    const settingsArguments: string[] = [];
    const builder = new MavenBuilder(path.join(root, 'storage'), { ensureMaven: async () => home, ensureJava: async () => root }, () => {}, async launch => {
      if (launch.args.includes('-s')) settingsArguments.push(launch.args[launch.args.indexOf('-s') + 1]);
      const metadata = launch.args.find(a => a.startsWith('-Doutput=')); if (metadata) { await writeFile(metadata.slice(9), pom); return; }
      if (fail) throw new Error('Maven compilation failed');
      const file = launch.args[launch.args.indexOf('-f') + 1]; assert.equal(path.dirname(file), root);
      await writeFile(path.join(root, '.tomcat-workbench/app/build/application.war'), 'successful-war');
    });
    const settings = path.join(tmpdir(), `tw-settings-${Date.now()}.xml`);
    await writeFile(settings, '<settings/>');
    const configured = ref(root); configured.instance.build!.settings = settings;
    let result: BuildResult;
    try { result = await builder.build(configured); } finally { await rm(settings, { force: true }); }
    assert.deepEqual(settingsArguments, [settings, settings]);
    await assert.rejects(builder.build(configured), /settings file.*readable file/i);
    configured.instance.build!.settings = root;
    await assert.rejects(builder.preview(configured), /settings file.*readable file/i);
    assert.equal(await readFile(path.join(root, result.source), 'utf8'), 'successful-war');
    assert.equal(await readFile(path.join(root, 'pom.xml'), 'utf8'), pom); assert.equal(await readFile(path.join(root, 'target/keep.txt'), 'utf8'), 'normal-output');
    fail = true; await assert.rejects(builder.build(ref(root)), /compilation failed/);
    assert.equal(await readFile(path.join(root, result.source), 'utf8'), 'successful-war');
    const files = await import('node:fs/promises').then(fs => fs.readdir(root)); assert.equal(files.some(f => f.endsWith('.generated.pom.xml')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('effective model isolation handles inherited execution paths and removes profiles before the final build', () => {
  const effective = pom.replace('</project>', '<build><directory>C:/project/alternate-target</directory><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><executions><execution><configuration><outputDirectory>C:/project/target/classes</outputDirectory></configuration></execution></executions></plugin></plugins></build><profiles><profile><id>local</id><build><directory>C:/project/target</directory></build></profile></profiles></project>');
  const doc = new DOMParser().parseFromString(isolateEffectivePom(effective, 'C:/project', 'C:/project/.tomcat-workbench/app/build'));
  assert.equal(doc.getElementsByTagName('profiles').length, 0); assert.equal(doc.getElementsByTagName('parent').length, 0);
  assert.equal(doc.getElementsByTagName('outputDirectory')[0].textContent, 'C:/project/.tomcat-workbench/app/build/classes');
});
test('final WAR filters container JARs even when their dependencies are compile scope', () => {
  const doc = new DOMParser().parseFromString(generateBuildPom(pom, '/build', { pom: 'pom.xml', context: '/' }));
  const excludes = doc.getElementsByTagName('packagingExcludes')[0].textContent!;
  assert.match(excludes, /tomcat-embed/); assert.match(excludes, /servlet-api/);
});
test('an unused Log4j2 entry in dependency management does not remove application Logback', () => {
  const managed = pom.replace('</project>', '<dependencyManagement><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-log4j2</artifactId><version>1.5.3.RELEASE</version></dependency></dependencies></dependencyManagement></project>');
  const doc = new DOMParser().parseFromString(generateBuildPom(managed, '/build', { pom: 'pom.xml', context: '/' }));
  assert.equal(doc.getElementsByTagName('packagingExcludes')[0].textContent!.includes('logback'), false);
});
test('changing module POM cannot bypass the lease for the same instance output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tw-build-lock-')); let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>(resolve => entered = resolve); const gate = new Promise<void>(resolve => release = resolve);
  try {
    await writeFile(path.join(root, 'pom.xml'), pom); await mkdir(path.join(root, 'other')); await writeFile(path.join(root, 'other/pom.xml'), pom);
    const home = path.join(root, 'maven'); await mkdir(path.join(home, 'boot'), { recursive: true }); await writeFile(path.join(home, 'boot/plexus-classworlds.jar'), 'fixture');
    const builder = new MavenBuilder(path.join(root, 'storage'), { ensureMaven: async () => home, ensureJava: async () => root }, () => {}, async launch => {
      const metadata = launch.args.find(a => a.startsWith('-Doutput=')); if (metadata) { await writeFile(metadata.slice(9), pom); return; }
      entered(); await gate; await writeFile(path.join(root, '.tomcat-workbench/app/build/application.war'), 'war');
    });
    const running = builder.build(ref(root)); await ready;
    const changed = ref(root); changed.instance.build!.pom = 'other/pom.xml'; await assert.rejects(builder.build(changed), /in use/i);
    release(); await running;
  } finally { release?.(); await rm(root, { recursive: true, force: true }); }
});
test('cancelling Maven terminates an owned forked process before returning', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const abort = new AbortController(); let output = ''; let fork: number | undefined;
  const program = 'const {spawn}=require("node:child_process");const p=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});p.once("spawn",()=>console.log("READY:"+p.pid));setInterval(()=>{},1000)';
  try {
    await assert.rejects(executeMaven({ executable: process.execPath, args: ['-e', program], cwd: process.cwd(), env: process.env }, abort.signal, text => { output += text; const match = output.match(/READY:(\d+)/); if (match && !fork) { fork = Number(match[1]); abort.abort(); } }), /cancel/i);
    assert.ok(fork); assert.throws(() => process.kill(fork!, 0), /ESRCH|No such process/i);
  } finally { if (fork) { try { process.kill(fork); } catch { /* Already stopped by cancellation. */ } } }
});
