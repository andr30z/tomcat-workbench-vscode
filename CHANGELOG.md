# Changelog

## 0.9.0

- Restore the 0.7.0 redeploy behavior: rebuild the WAR and restart Tomcat, preserving normal/debug mode.
- Remove live Manager publish and Build and Publish.
- Trigger both hot reload modes only from .java documents saved in VS Code, including Save All and Auto Save.
- Ignore non-Java saves and filesystem change/create/delete events; preserve debounce, output exclusions, ownership and stale-operation guards.

## 0.8.0

- Publish rebuilt WARs to running Tomcat without restarting its JVM; preserve debug connections and other application contexts.
- Add Build and Publish; Build and Run/Debug and hot reload reuse the live path when possible.
- Provision an instance-private, loopback-only Manager with generated local credentials, preserving project/native users and shared distributions.
- Snapshot the deployed WAR for rollback, validate running-context status and bind publication to the original JVM generation.
- Require an explicit restart for changed Java/server/shared-library configuration and for older JVMs without the private publisher.

## 0.7.0

- Add per-instance Configure Hot Reload and Apply HotSwap commands; reload remains off until configured.
- Debounce project changes and apply Java HotSwap to the owned debug session after a successful Java language-server build.
- Optionally rebuild/redeploy through managed Maven, preserve debug mode, and retain the last deployment on build errors.
- Ignore generated artifacts, serialize manual/automatic changes and cancel stale work after stop, configuration changes or shutdown.
- Add real Java 8/17 method replacement and debounced Maven redeploy/failure-preservation integration coverage.

## 0.5.2

- Open dependency diagnosis automatically after missing-class errors during Build and Run/Debug, without requiring a notification click.
- Flush detected startup failures into recovery when the command finishes and deduplicate timer/finally triggers.
- Log detection, scheduling and diagnosis opening; retain explicit confirmation before editing tomcat.json.
- Keep dependency selection open on focus changes and make manual-start recovery offers modal.

## 0.5.1

- Keep missing-dependency diagnosis available after Build and Run/Debug startup failures even without build.dependencies.
- Defer notifications and selected/manual diagnosis until the active build/start finishes, including concurrent instance-selection races.
- Detect final console lines without a newline; cancel pending diagnosis actions on extension shutdown.
- Preserve the log-based 0.5.0 behavior without static WAR preflight.

## 0.5.0

- Detect missing Java classes in Tomcat logs and offer dependency diagnosis.
- Search the Maven local repository selected by the configured settings for exact class providers, preferring the effective managed version.
- Confirm dependency overrides before saving or rebuilding/running/debugging; preserve the original POM and guard concurrent configuration changes.
- Add cancellable scans, persisted log recovery and container/tool exclusions. No missing artifacts are guessed or downloaded by the class search.

## 0.4.1

- Allow absolute external Maven settings.xml paths in build.settings, including paths with spaces.
- Validate the settings file before provisioning and use it for both effective-model resolution and WAR packaging.

## 0.4.0

- Add managed Maven provisioning and Build WAR / Build and Run / Build and Debug / Preview Build POM.
- Resolve the effective Maven model and build a derived local POM without changing the original project POM or conventional target output.
- Automatically package declared provided dependencies with container/tool exclusions and optional explicit dependency overrides.
- Publish immutable WAR snapshots only on successful builds; preserve previous deployments on compilation errors.
- Add build cancellation/process-tree cleanup, output leases across windows and effective-model isolation regressions.

## 0.3.0

- Add Tomcat: Debug with managed loopback JDWP and automatic Debugger for Java attachment.
- Configure debug ports and optional Java project/source paths per instance without launch.json.
- Disconnect debug independently from Tomcat; preserve debug across restart/deploy and recover the actual port after host failure.
- Protect delayed debugger connections and cleanup with runtime generation ownership.
- Add live Java 8/17 JDI breakpoint and recovery integration checks.

## 0.2.0

- Add archived Tomcat 8.5 releases to instance creation, project validation and native configuration support.
- Verify Tomcat 8.5 with managed Java 8 alongside the other three families.
- Document legacy support and keep Java 8 as the minimum managed runtime for Tomcat 8.5.

## 0.1.0

- Managed exact Tomcat 9/10.1/11 and Temurin JDK releases on Windows.
- Project configuration, independent instances, native XML templates and shared JARs.
- Lifecycle controls, verified recovery, logs, secrets and WAR/directory deployment.
- Local VSIX packaging and automated unit/integration checks.
