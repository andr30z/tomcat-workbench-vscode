import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, familyOf, cleanEnvironment, resolveProjectPath, contextName } from '../src/config';

const instance = () => ({ id: 'demo', name: 'Demo', tomcatVersion: '10.1.34', java: { major: 17, release: 'jdk-17.0.13+11' }, ports: { http: 8080, shutdown: 8005 }, jvmArgs: ['-Xmx512m'], environment: {}, applications: [] });
test('accepts exact Tomcat 8.5 versions with managed Java 8 while rejecting Tomcat 8.0', () => {
  const config = validateConfig({ version: 1, instances: [{ ...instance(), tomcatVersion: '8.5.100', java: { major: 8, release: 'jdk8u432-b06' } }] });
  assert.equal(familyOf(config.instances[0].tomcatVersion), '8.5');
  assert.equal(config.instances[0].java.major, 8);
  assert.throws(() => familyOf('8.0.53'), /supported/i);
});
test('validates pinned versions and rejects duplicate identities and conflicting ports', () => {
  assert.equal(validateConfig({ version: 1, instances: [instance()] }).instances[0].id, 'demo');
  assert.throws(() => validateConfig({ version: 1, instances: [instance(), instance()] }), /duplicat/i);
  assert.throws(() => validateConfig({ version: 1, instances: [{ ...instance(), ports: { http: 8080, shutdown: 8080 } }] }), /port/i);
  assert.throws(() => validateConfig({ version: 1, instances: [{ ...instance(), tomcatVersion: 'latest' }] }), /version/i);
  assert.throws(() => validateConfig({ version: 1, instances: [{ ...instance(), id: '../escape' }] }), /id/i);
});
test('blocks Java incompatible with Tomcat and unsupported families', () => {
  assert.throws(() => validateConfig({ version: 1, instances: [{ ...instance(), tomcatVersion: '11.0.2', java: { major: 11, release: 'jdk-11.0.25+9' } }] }), /Java 17/i);
  assert.throws(() => familyOf('10.0.27'), /supported/i);
  assert.throws(() => validateConfig({ version: 1, instances: [{ ...instance(), java: { major: 17, release: 'jdk-21.0.5+11' } }] }), /release/i);
});
test('cleans inherited Java and Tomcat overrides case-insensitively', () => {
  const env = cleanEnvironment({ Path: 'system', java_home: 'bad', JRE_HOME: 'bad', JAVA_TOOL_OPTIONS: 'bad', _JAVA_OPTIONS: 'bad', JDK_JAVA_OPTIONS: 'bad', CATALINA_HOME: 'bad', JAVA_OPTS: 'bad', CLASSPATH: 'bad' }, { APP_ENV: 'dev' });
  assert.deepEqual(env, { Path: 'system', APP_ENV: 'dev' });
  assert.throws(() => cleanEnvironment({}, { JAVA_HOME: 'bad' }), /reserved/i);
});
test('prevents project path escapes and unsafe deployment contexts', () => {
  assert.equal(resolveProjectPath('C:\\projeto', 'app.war'), 'C:\\projeto\\app.war');
  assert.throws(() => resolveProjectPath('C:\\projeto', '..\\outside'), /inside/i);
  assert.equal(contextName('/'), 'ROOT');
  assert.equal(contextName('/hello/world'), 'hello#world');
  assert.throws(() => contextName('/../escape'), /context/i);
  assert.throws(() => contextName('/CON'), /context/i);
});
