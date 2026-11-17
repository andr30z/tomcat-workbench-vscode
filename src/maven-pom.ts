import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { BuildOptions } from './config';

const containerGroups = ['org.apache.tomcat.embed', 'org.apache.tomcat'];
export const containerArtifacts = ['tomcat-embed-core', 'tomcat-embed-el', 'tomcat-embed-websocket', 'javax.servlet-api', 'servlet-api', 'javax.servlet.jsp-api', 'jsp-api', 'javax.el-api', 'el-api', 'javax.websocket-api', 'websocket-api', 'jakarta.servlet-api', 'jakarta.servlet.jsp-api', 'jakarta.el-api', 'jakarta.websocket-api'];
const tools = ['lombok', 'querydsl-apt', 'spring-boot-starter-tomcat', ...containerArtifacts];
function children(element: Element, name: string): Element[] { return Array.from(element.childNodes).filter((n): n is Element => n.nodeType === 1 && ((n as Element).localName ?? n.nodeName) === name); }
function child(element: Element, name: string): Element {
  const existing = children(element, name)[0]; if (existing) return existing;
  const added = element.ownerDocument!.createElementNS(element.namespaceURI, name); element.appendChild(added); return added;
}
function set(element: Element, name: string, value: string): Element { const node = child(element, name); node.textContent = value; return node; }
function plugin(plugins: Element, artifact: string, version: string): Element {
  const found = children(plugins, 'plugin').find(p => children(p, 'artifactId')[0]?.textContent === artifact && (!children(p, 'groupId')[0] || children(p, 'groupId')[0].textContent === 'org.apache.maven.plugins'));
  const node = found ?? plugins.ownerDocument!.createElementNS(plugins.namespaceURI, 'plugin');
  if (!found) plugins.appendChild(node);
  set(node, 'groupId', 'org.apache.maven.plugins'); set(node, 'artifactId', artifact); set(node, 'version', version); return node;
}
function removeComments(node: Node) { if (!node.hasChildNodes()) return; for (const c of Array.from(node.childNodes)) { if (c.nodeType === 8) node.removeChild(c); else removeComments(c); } }
export function isolateEffectivePom(xml: string, originalDirectory: string, directory: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DOCTYPE is not supported in effective POM XML.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document;
  if (!doc?.documentElement || doc.documentElement.localName !== 'project') throw new Error('Maven produced invalid effective POM XML.');
  const root = doc.documentElement; const build = children(root, 'build')[0];
  const normalize = (p: string) => p.replaceAll('\\', '/').replace(/\/$/, '');
  const output = normalize(directory); const original = normalize(originalDirectory);
  const mappings: [string, string][] = [[`${original}/target`, output]];
  for (const [tag, destination] of [['directory', ''], ['outputDirectory', '/classes'], ['testOutputDirectory', '/test-classes']] as const) {
    const old = build && children(build, tag)[0]?.textContent?.trim(); if (old) mappings.push([normalize(old), output + destination]);
  }
  const reporting = children(root, 'reporting')[0]; const report = reporting && children(reporting, 'outputDirectory')[0]?.textContent?.trim(); if (report) mappings.push([normalize(report), `${output}/site`]);
  mappings.sort((a, b) => b[0].length - a[0].length);
  const visit = (node: Node) => {
    if (!node.hasChildNodes()) return;
    for (const c of Array.from(node.childNodes)) {
      if (c.nodeType === 3 && c.nodeValue?.trim()) {
        const value = normalize(c.nodeValue.trim());
        const mapping = mappings.find(([old]) => value.toLowerCase() === old.toLowerCase() || value.toLowerCase().startsWith(`${old.toLowerCase()}/`));
        if (mapping) c.textContent = mapping[1] + value.slice(mapping[0].length);
      } else visit(c);
    }
  };
  for (const node of [...children(root, 'build'), ...children(root, 'reporting')]) visit(node);
  for (const tag of ['parent', 'profiles']) for (const node of children(root, tag)) root.removeChild(node);
  removeComments(doc);
  return new XMLSerializer().serializeToString(doc as unknown as Parameters<XMLSerializer['serializeToString']>[0]);
}
export function generateBuildPom(xml: string, directory: string, options: BuildOptions): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('External entities / DOCTYPE are not supported in a build POM.');
  const errors: string[] = [];
  const parsed = new DOMParser({ errorHandler: { warning: e => errors.push(e), error: e => errors.push(e), fatalError: e => errors.push(e) } }).parseFromString(xml, 'application/xml');
  if (errors.length || !parsed?.documentElement || parsed.documentElement.localName !== 'project') throw new Error(`Invalid Maven POM XML: ${errors.join('; ')}`);
  const doc = parsed as unknown as Document; removeComments(doc);
  const root = doc.documentElement;
  if (children(root, 'packaging')[0]?.textContent?.trim() !== 'war') throw new Error('Build requires a single WAR module. Select its pom.xml.');
  if (root.getElementsByTagName('module').length) throw new Error('Multi-module builds are not supported yet. Select a WAR module POM within this workspace.');
  const build = child(root, 'build'); const output = directory.replaceAll('\\', '/');
  set(build, 'directory', output); set(build, 'outputDirectory', `${output}/classes`); set(build, 'testOutputDirectory', `${output}/test-classes`); set(build, 'finalName', 'application');
  set(child(root, 'reporting'), 'outputDirectory', `${output}/site`);
  for (const override of options.dependencies ?? []) {
    const dependencies = child(root, 'dependencies');
    let dependency = children(dependencies, 'dependency').find(d => children(d, 'groupId')[0]?.textContent === override.groupId && children(d, 'artifactId')[0]?.textContent === override.artifactId && !children(d, 'classifier')[0]?.textContent?.trim() && (children(d, 'type')[0]?.textContent?.trim() ?? 'jar') === 'jar');
    if (!dependency) { dependency = doc.createElementNS(root.namespaceURI, 'dependency'); dependencies.appendChild(dependency); }
    set(dependency, 'groupId', override.groupId); set(dependency, 'artifactId', override.artifactId); set(dependency, 'scope', override.scope ?? 'compile');
    if (override.version) set(dependency, 'version', override.version);
  }
  const plugins = child(build, 'plugins');
  const compiler = plugin(plugins, 'maven-compiler-plugin', '3.11.0');
  set(child(compiler, 'configuration'), 'generatedSourcesDirectory', `${output}/generated-sources/annotations`);
  const war = plugin(plugins, 'maven-war-plugin', '3.4.0'); const warConfig = child(war, 'configuration');
  set(warConfig, 'warName', 'application'); set(warConfig, 'outputDirectory', output); set(warConfig, 'webappDirectory', `${output}/application`); set(warConfig, 'workDirectory', `${output}/war-work`); set(warConfig, 'failOnMissingWebXml', 'false');
  const excludes = [...containerArtifacts, ...(options.excludeArtifacts ?? []), 'lombok', 'querydsl-apt'].map(a => `WEB-INF/lib/${a}-*.jar`);
  excludes.push('WEB-INF/lib/tomcat-*.jar');
  const log4j = children(root, 'dependencies').flatMap(d => children(d, 'dependency')).some(d => children(d, 'groupId')[0]?.textContent === 'org.springframework.boot' && children(d, 'artifactId')[0]?.textContent === 'spring-boot-starter-log4j2');
  if (log4j) excludes.push('WEB-INF/lib/slf4j-jdk14-*.jar', 'WEB-INF/lib/logback-*.jar', 'WEB-INF/lib/log4j-to-slf4j-*.jar');
  const previous = children(warConfig, 'packagingExcludes')[0]?.textContent?.trim();
  set(warConfig, 'packagingExcludes', [previous, ...excludes].filter(Boolean).join(','));
  if (options.includeProvided !== false) {
    const dependency = plugin(plugins, 'maven-dependency-plugin', '3.6.1');
    const execution = doc.createElementNS(root.namespaceURI, 'execution'); child(dependency, 'executions').appendChild(execution);
    set(execution, 'id', 'tomcat-workbench-provided'); set(execution, 'phase', 'prepare-package'); set(child(execution, 'goals'), 'goal', 'copy-dependencies');
    const config = child(execution, 'configuration'); set(config, 'includeScope', 'provided'); set(config, 'includeTypes', 'jar'); set(config, 'excludeTransitive', 'false');
    set(config, 'excludeGroupIds', [...containerGroups, ...(options.excludeProvidedGroups ?? [])].join(','));
    set(config, 'excludeArtifactIds', [...tools, ...(options.excludeArtifacts ?? []), ...(log4j ? ['slf4j-jdk14', 'logback-classic', 'logback-core', 'log4j-to-slf4j'] : [])].join(','));
    set(config, 'outputDirectory', `${output}/workbench-provided`);
    const resource = doc.createElementNS(root.namespaceURI, 'resource'); child(warConfig, 'webResources').appendChild(resource);
    set(resource, 'directory', `${output}/workbench-provided`); set(resource, 'targetPath', 'WEB-INF/lib'); set(resource, 'filtering', 'false'); set(child(resource, 'includes'), 'include', '*.jar');
  }
  return new XMLSerializer().serializeToString(parsed);
}
