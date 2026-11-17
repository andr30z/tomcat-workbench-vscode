# Tomcat Workbench implementation ledger

## 0.9.0: Restore restart-based redeploy; Java saves only

User requested reverting live Manager publish to the restart-based redeploy from 0.7.0, and restricting automatic hot reload to saved Java files. Restored all 14 source files and package/README/schema baseline from the original 0.7.0 VSIX source map, then implemented the trigger change. Removed publisher provisioning/client/API, Build and Publish and its tests. Reverted the Maven integration to stop/start after a successful rebuild and verify a new JVM generation. Backups of the 0.8.0 source are in ignored .local/before-restart-redeploy-*; Git and .vscode tasks were retained.

Automatic source reload now subscribes only to workspace.onDidSaveTextDocument, requires a local .java path in either mode, canonicalizes it and enforces project containment and existing watch/exclude/output filters. Resource/POM saves and raw disk change/create/delete events do not queue reloads. Save All/Auto Save are supported because they save Java documents. Candidate epochs are captured before realpath so a save cannot migrate to a replacement runtime while path resolution is pending. The config-only filesystem watcher still refreshes settings without triggering reload. Debounce/serialization/ownership/shutdown protections remain.

Verification: 70 local tests and all five live integrations passed, including Java 8/17 HotSwap, actual Maven rebuild/restart with changed JVM generation, failed-build preservation, debug/dependency recovery and four Tomcat families. Strict TypeScript build and 9-file VSIX 0.9.0 packaging passed. UI save-event flows remain manual verification. No user application configuration or runtime was modified by this rollback.

## 0.8.0: Live WAR publish and local Git initialization

Added Build and Publish and a live path for Build Run/Debug and hot reload redeploy. Existing suitable JVMs publish through a private official Manager context with a context-local MemoryRealm, generated credentials and loopback Valve. No project user accounts or shared distributions are changed. The HTTP client connects directly to loopback, follows no redirects, bounds responses/requests and redacts credentials. A running instance created before this release needs one explicit Restart to provision the Manager. Switching a normal JVM to debug still requires restart; already-active JDWP sessions are retained.

Publish verifies process identity/generation, compatible JVM/server/shared-library configuration, source WAR and Manager status. It snapshots the currently deployed WAR before mutation, updates only the requested context and records the new artifact in the runtime journal. Failed publication attempts restore that private snapshot; failed recovery retains it with an explicit diagnostic. Per-application native Context descriptors and directory publication are deliberately rejected before mutation. Long project configuration updates detect external edits rather than overwriting them; a successful runtime publication followed by failed config persistence is reported distinctly. Dependency recovery is reset for each context-publication attempt.

Review fixes: use deployed bytes rather than a mutable project WAR for rollback; restrict live sources to WAR files; capture the JVM generation before compilation. Live testing found Tomcat Manager opens the local file pathname without URI percent-decoding: the WAR parameter now retains raw native spaces/accents/percent signs until URLSearchParams supplies the single HTTP query encoding layer.

Verification: 74 local tests and all six live integrations passed. Tests cover managed Tomcat 8.5/9/10.1/11, a retained real JDI connection, an unchanged ServletContext marker in another app, same-path WAR overwrite rollback, stale/cancelled publishes, server-config rejection, spaces/accents/percent paths and managed Maven live publish with the same JVM generation. Strict compilation and VSIX 0.8.0 packaging passed. Full VS Code UI/adapter interaction and corporate application startup remain manual verification. No user application was started or configured by this work.

On the user's explicit request, initialized .git in this workspace on 2026-11-17. Verified generated packages/builds/caches/private local data are ignored. No commit, remote configuration or GitHub push was performed; the user will publish manually.

## 0.7.0: Hot reload

Added opt-in per-instance HotSwap/redeploy configuration, Configure Hot Reload and Apply HotSwap commands, project file watchers, constrained globs/output exclusions and a debounced scheduler with one follow-up after changes during work. HotSwap requests an incremental Red Hat Java language-server build (success status 1 required) and redefineClasses on the exact owned debug session. It checks session generation, configuration signature, trust and cancellation before redefining and never changes global Java debugger preferences. Redeploy reuses managed Maven Build Run/Debug, preserving mode and checking generation/signature/epoch before stopping, publishing and starting. Manual lifecycle/deploy/template commands share the instance operation guard; Stop invalidates pending reloads and cancels/awaits active builds. Disabling/changing configuration, removal and shutdown invalidate stale tasks.

Independent review corrections: cancel old work after Stop/Start; retain the captured epoch across async configuration reads; recheck automatic publication after debugger disconnect/stop and before restart; serialize manual mutation paths; prevent the scheduler losing a reload when a manual operation acquires the guard just before execution. Configuration signatures exclude deployment snapshots to avoid suppressing a legitimate follow-up build.

Verification: 70 local tests passed. All five live integrations passed, including real Java 8/17 JDI replacement of an HTTP servlet method without changing JVM generation, actual managed Maven debounced rebuild/redeploy after five change events, and a later invalid compilation preserving HTTP content and generation. Existing debug/dependency-recovery/four-family lifecycle tests also passed. Strict compilation and VSIX 0.7.0 packaging passed. The VS Code watcher/command UI, Java project import and Red Hat/Microsoft adapter exchange require manual end-to-end validation; live JDI tests verify the JVM replacement capability, not the adapter UI. Corporate project configuration/runtime was not modified or restarted. Static WAR preflight remains rolled back; exploded static-resource copying is not part of this release.

## 0.5.2: Open startup dependency recovery automatically

User's 2026-11-17 log still reports missing org.apache.http.conn.HttpClientConnectionManager; installed 0.5.1 source matched the workspace and build.dependencies was absent. User confirmed no notification appeared. The prior recovery path required accepting a nonmodal notification before diagnosis could run; log inspection alone does not establish why the UI notification was not displayed. Build and Run/Debug now mark the startup for automatic recovery, schedule diagnosis directly after detecting missing classes and flush it in command-finally after releasing the operation. Timer/finally scheduling is deduplicated. Detection, scheduling, opening and no-selection outcomes are written to the output channel. Manual-start offers are modal; provider selection retains focus; all configuration mutations retain explicit modal confirmation. No corporate configuration was modified and static WAR analysis remains rolled back.

Review shutdown race fixed: the diagnosis command rechecks disposal after asynchronous instance selection. Verification: 63 local tests and all four live integrations passed; the startup-failure fixture now uses automatic recovery and rejects any attempt to wait for a notification. Strict compilation and VSIX 0.5.2 packaging passed. Actual VS Code UI display and the corporate application's successful startup require user-environment confirmation.

## 0.5.1: Preserve diagnosis after startup failures

User confirmed that removing build.dependencies allows the Maven build to finish but the application fails during Tomcat startup. Root cause in the recovery UI: a missing-class notification could be accepted while Build and Run/Debug still owned the operation, causing diagnosis to reject busy and consume the once-per-start offer. DeferredDependencyActions now queues prompts and selected/manual diagnosis until operation release, including a new build racing asynchronous instance selection. Complete final console lines without a newline are detected; shutdown drops queued actions. Log-based diagnosis remains independent of configured dependency overrides; static WAR preflight stays rolled back.

Review identified the asynchronous selection race, addressed by requeueing after select when busy. Unit regressions cover Run/Debug without dependency overrides, choosing while another build starts, delayed instance selection and shutdown. A real ServletContainerInitializer fixture fails with NoClassDefFoundError in managed Tomcat normal and JDWP modes, then the queued diagnosis locates the exact Maven provider after release. Verification: 62 local tests and all four live integration tests passed; strict compilation and VSIX 0.5.1 packaging passed. UI dialogs remain manually verified; corporate application and user configuration were not modified for this fix.

## 0.5.0: Missing dependency diagnosis

Implemented streamed missing-class detection, notification and Diagnose Missing Dependencies command, bounded persisted-log recovery, exact cached JAR entry search and Maven-selected local repository evaluation with the instance settings/JDK. Project-managed versions rank first; confirmed coordinates are pinned in build.dependencies and can trigger existing Build and Run/Debug. Diagnosis preserves source POM and deployment, guards concurrent configuration edits, supports cancellation and does not wait for selection dialogs during shutdown.

Independent review findings addressed: require an existing build rather than writing configuration before confirmation, ignore classified/non-JAR dependencyManagement entries, and pin the selected version even when a different direct version exists. Main-JAR overrides preserve classified dependencies. Verification: 59 local tests passed; the complete three-test live suite passed (custom Maven repository, build/deploy, Java 8/17 breakpoints, four Tomcat families). The extended Maven integration was rerun successfully with exact class-provider discovery in that custom repository. Strict compilation and VSIX 0.5.0 packaging passed. Graphical VS Code confirmation flows and corporate application startup remain unverified; no user-profile installation or corporate application execution occurred.

## 0.4.0: Managed Maven build

Implemented the user-approved derived-POM build flow; see docs/maven-build-plan.md for defaults, review findings and verification. Commands: Build WAR, Build and Run, Build and Debug, Preview Build POM. Managed Maven/JDK, effective-model adaptation, provided dependencies, isolated conventional outputs, immutable WAR snapshots, cancellation/process-tree cleanup and deploy-only-after-success are included. Original application POM is preserved.

Independent review findings were addressed with model/output/locking/cancellation regressions. Local suite passed 51 tests; three live integrations passed, including actual Maven packaging and HTTP deployment, Java 8/17 JDWP breakpoints and simultaneous Tomcat 8.5/9/10.1/11 lifecycle. UI interaction, arbitrary custom Maven plugin side effects and corporate application startup remain outside automated verification. A fresh VSIX 0.4.0 is generated; no Marketplace publication or user-profile installation is performed.

## 0.3.0: Integrated DEBUG

User requested integrated DEBUG after discussing manual Java debugger attachment. Added Tomcat: Debug and Stop Debug (Disconnect), per-instance debug.port plus optional projectName/sourcePaths, automatic Java debugger attachment without launch.json, and project-aware allocation from port 5005. Missing Debugger for Java is reported before launching or restarting a server. Normal Start ignores managed debug configuration. JVM startup is not suspended; startup-before-attach breakpoints remain outside this feature.

Managed JDWP binds explicitly to 127.0.0.1 on Java 8 and later. Restart/deploy/template regeneration preserve debug mode; Stop disconnects the owned debug session and stops Tomcat, while Stop Debug only disconnects. Journals retain the effective debug port so recovery and reattachment are independent of subsequently edited configuration.

Independent review identified delayed-attach cleanup potentially stopping a replacement JVM. Regression tests reproduced the race; sessions now carry the runtime generation, attachment is checked against the live generation, stale sessions are disconnected, and cleanup uses an atomic expected-generation check in InstanceManager.stop. A second regression covers replacement during asynchronous detach. Stop Debug also acquires its own operation guard.

Verification: npm test passed 40/40; strict TypeScript build and VSIX packaging passed (tomcat-workbench-0.3.0.vsix). Both live integration tests passed. A JDI client compiled with the managed JDK connected to actual Tomcat JVMs using Java 8 and 17, hit ApplicationFilterChain.doFilter breakpoints during HTTP requests, resumed and disconnected. netstat confirmed listeners bind only 127.0.0.1. Tests also verify occupied debug ports, recovered effective debug port, stale-generation stop protection and no JDWP during normal Start. The existing four-family simultaneous/offline/deploy/recovery integration also passed. Graphical VS Code interaction remains a manual verification; no installation into the user's VS Code profile was performed.

## 0.2.0: Tomcat 8.5

User requested archived Tomcat 8.5 in addition to the existing families. Added exact 8.5.x validation, schema/editor support and the creation-wizard option; managed Java remains 8/11/17/21 (no Java 7 provisioning). Downloads for 8.5 use the official Apache archive directly, because the current mirror can retain checksum metadata while returning 404 for the ZIP. Existing native template family checks and independent runtime configuration also apply to 8.5.

Verification: regression test first rejected 8.5.100 as unsupported; local suite now passes 30/30. Strict TypeScript compilation and VSIX packaging passed for tomcat-workbench-0.2.0.vsix. Integration expanded to four concurrent families, using managed Temurin Java 8 for Tomcat 8.5 and Java 17 for the others. README and changelog document the archived family and update installation instructions.

Live integration passed: Tomcat 8.5.100 on managed Temurin jdk8u512-b09 served its application simultaneously with Tomcat 9/10.1/11. Checks included poisoned inherited Java/Tomcat configuration, cached/offline execution, independent redeployment, host-crash recovery, exclusive access and shutdown of all four JVMs.

## Initial implementation (0.1.0)

Approved scope: Windows desktop, Tomcat 9/10.1/11, pinned managed Temurin JDKs, project configuration, isolated instances, native configuration, console/logs and offline deploy. No Docker, builds, debug, remote or automatic migration.

Execution: inline using executing-plans, test-driven-development and verification-before-completion. Workspace was empty and has no Git repository; no worktree or commits are applicable.

Tasks: configuration and schema; distribution provisioning; native configuration and deployment; process lifecycle; VS Code UI; documentation, integration verification and VSIX.

Ruling: launch the managed java.exe directly with the standard Tomcat Bootstrap arguments rather than through catalina.bat. This avoids cmd.exe interpolation of configurable arguments, gives an exact Java PID for ownership checks and preserves paths with spaces/accents. Standard logging and version-specific JVM options are supplied explicitly. Custom setenv.bat is not executed; its options belong in jvmArgs/environment.

Ruling: default to one local runtime per canonical project path and instance id, guarded by an exclusive filesystem lease across VS Code windows. Configuration templates are tagged with their Tomcat family; changing family requires explicitly generating fresh templates, preserving a backup.

Ruling: retain application-specific configuration as user-managed XML and use placeholders for managed ports. Reject contradictory values rather than silently rewriting custom configuration. Runtime shutdown tokens are generated locally and never committed.

Tasks 1-5 implemented. Automated local suite covers validation, archive safety, project writes, secrets, native configuration, shared libraries, deployment transactions, port checks, ownership and exclusive leases.

Independent review findings addressed: serialize stale lease reclamation; separate configuration lock namespace; wait for owned child exit before clearing recovery data; protect project control directories and stage native templates before replacement. Conservatively report incomplete orphan locks rather than deleting unverified ownership. PID reuse may require manual lock inspection.

Live integration: actual Tomcat 9.0.124, 10.1.62 and 11.0.29 with managed Temurin jdk-17.0.21+9 ran simultaneously, served separate HTTP applications, redeployed one without affecting another, and stopped verified JVMs. Extended checks cover cached/offline startup and recovery after a worker host exits unexpectedly.

Environment findings: npm user proxy configuration initially returned 407; command-local proxy overrides resolved installation without editing user settings. tsx/os.userInfo and esbuild ancestor scans were blocked by the Windows sandbox; test compilation uses esbuild and the Node test runner with approved execution outside the sandbox. Network access supports environment/VS Code proxies with TLS verification always enabled. The live Adoptium exact-release endpoint returns an object, not an array; regression coverage added. Transient Windows file scanning locks require bounded rename retries.

Recovery regression initially failed because Java shared the worker's Windows process group. Managed Java now starts detached with windowsHide, while keeping captured output and ownership tracking; the simulated host-crash recovery and second-window exclusion pass. Local integration also poisons inherited Java/Tomcat variables and removes installed Java binaries from PATH to verify independence.

Production dependency audit found an advisory in undici 6.27.0; upgraded to patched 6.29.1. npm audit --omit=dev reports zero vulnerabilities. No Marketplace publication or installation into the user's VS Code profile was performed.

Completion evidence: npm test passed 26/26; npm run package ran strict TypeScript compilation and bundled a 9-file VSIX (655834 bytes); npm run test:integration passed the three-family simultaneous HTTP/deploy/stop, offline-cache and host-crash recovery checks with poisoned inherited Java/Tomcat configuration. Production dependency audit passed with zero vulnerabilities. GUI interaction and Windows ARM64 remain manual/unverified; Windows x64 lifecycle was exercised with actual official distributions. Source, tests, documentation and VSIX are retained in this workspace; no Git repository was present to commit or merge.
