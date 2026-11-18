# Tomcat Workbench

Run independent Apache Tomcat versions in VS Code, with a dedicated Java runtime for each instance, without installing Java, Tomcat, Maven, Gradle, or Docker on your computer.

**For Maven WAR development, start with `Tomcat: Build and Debug` or `Tomcat: Build and Run`.** These commands compile the project, deploy the WAR, and start or restart Tomcat. Builds use the extension-managed Maven and JDK while preserving your original POM.

Supports **VS Code Desktop 1.96+ on Windows x64 or ARM64**, with Tomcat **8.5, 9.0, 10.1, and 11.0**. ARM64 binaries depend on Temurin availability for the selected release. VS Code Web, SSH, WSL, and Dev Containers are not supported in this version.

## Install and get started

1. In VS Code, run **Extensions: Install from VSIX...** and select `tomcat-workbench-0.9.0.vsix`. Use the same procedure to update an earlier version; reload VS Code if prompted.
2. Open a local folder and trust the workspace.
3. Run **Tomcat: Create Instance**. Choose the Tomcat family, exact release, JDK, and ports.
4. Choose your main workflow: **[Build and Debug](#build-and-debug)** for development with breakpoints, or **[Build and Run](#build-and-run)** to run without a debugger. Open the Command Palette with **Ctrl+Shift+P**, or use the instance's context menu in the **Tomcat Servers** panel.
5. On the first run, select the `pom.xml` of a module with `packaging=war` and enter a context path, such as `/backend`. Use `/` to deploy at the root. The extension saves this selection in the `build` section of `.vscode/tomcat.json`.
6. Follow the build and startup output in the instance console. Then run **Tomcat: Open Application** to open its URL. For `/backend` on port 8080, the base URL is `http://localhost:8080/backend/`; append your application's endpoint path as needed.

Creating an instance downloads the required official distributions, so initial provisioning requires network access. Later runs use the local cache without querying the catalog. Downloads are verified with SHA-512 for Tomcat or SHA-256 for Temurin and require neither installers nor administrator privileges.

## Main workflow

### Build and Debug

**Use `Tomcat: Build and Debug` when developing with breakpoints, variable inspection, and step-by-step execution.**

1. Install Microsoft's **Debugger for Java** and open the project's source code in the workspace.
2. Run **Tomcat: Build and Debug** and select the instance.
3. Wait for compilation, WAR deployment, and the automatic debugger connection.
4. Open the application and send a request that reaches your breakpoint.
5. After changing the project, run **Build and Debug** again to build and deploy a new WAR. To update when saving Java files, configure [hot reload](#hot-reload).

The command builds **before** stopping the current server. If Maven fails, the previous deployment and server remain available. After a successful build, the extension restarts Tomcat in debug mode and connects the debugger through JDWP on loopback. You do not need to create `launch.json` or configure JDWP arguments manually.

### Build and Run

**Use `Tomcat: Build and Run` to compile and run the application without connecting a debugger.**

1. Run **Tomcat: Build and Run** and select the instance.
2. Wait for the Maven build and WAR deployment.
3. Open the application with **Tomcat: Open Application** and follow the logs in the **Tomcat Servers** panel.
4. Run the command again whenever you need to rebuild and redeploy the application.

As with the debug workflow, a compilation failure preserves the previous running application. After a successful build, the command restarts the instance in normal mode, without enabling JDWP.

### Which command should I use?

| Command | Builds the project? | Purpose |
| --- | --- | --- |
| **Tomcat: Build and Debug** | **Yes** | **Development workflow with build, deployment, and an attached debugger.** |
| **Tomcat: Build and Run** | **Yes** | **Build and deploy in normal execution mode.** |
| Tomcat: Build WAR | Yes | Generate the WAR without changing the running server. |
| Tomcat: Preview Build POM | No | Inspect the derived POM used for the build. |
| Tomcat: Start | No | Start the instance with its configured artifacts. |
| Tomcat: Debug | No | Start or attach the debugger using the configured artifacts. |
| Tomcat: Deploy Application | No | Deploy an existing WAR or a directory from the project. |

**Start and Debug do not rebuild the project.** To generate an up-to-date WAR from source, choose **Build and Run** or **Build and Debug**. Use **Deploy Application** for artifacts that are already built.

The main workflow supports Maven WAR modules. If the project uses Nexus, a proxy, or a private repository, configure `build.settings` before the first build; see [Maven build and automatic deployment](#maven-build-and-automatic-deployment). A successful build does not guarantee successful application startup: if startup fails, inspect the console and dependency diagnosis output.

## Project configuration

The extension creates `.vscode/tomcat.json`, which can be committed to version control. The editor provides JSON schema validation and completion. The following example illustrates pinned versions; use the wizard to select available releases:

```json
{
  "version": 1,
  "instances": [{
    "id": "backend",
    "name": "Local backend",
    "tomcatVersion": "10.1.34",
    "java": { "major": 17, "release": "jdk-17.0.13+11" },
    "ports": { "http": 8080, "shutdown": 8005 },
    "debug": { "port": 5005 },
    "jvmArgs": ["-Xms128m", "-Xmx512m", "-Dapp.profile=local"],
    "environment": { "APP_ENV": "development" },
    "build": { "pom": "pom.xml", "context": "/backend" },
    "applications": []
  }]
}
```

- `id` identifies the local runtime data. Changing it creates another instance. Names and ports are editable.
- Tomcat and the JDK are pinned to full release versions and are never upgraded automatically. The extension runs Tomcat 8.5 and 9 with Java 8+, Tomcat 10.1 with Java 11+, and Tomcat 11 with Java 17+. Temurin 8, 11, 17, and 21 are offered; Java 7 is not managed.
- Tomcat 8.5 is available in **Create Instance**, with releases from the official Apache archive. This family reached end of support on March 31, 2024; its final release is 8.5.100. [Official reference](https://tomcat.apache.org/whichversion.html)
- Each `jvmArgs` entry is one complete argument, without shell quoting, even if it contains spaces. Properties used for directories, logging, and process identity are reserved.
- `environment` applies only to the instance process. Inherited variables that override Java or Tomcat are removed. `JAVA_HOME`, `JRE_HOME`, `JAVA_OPTS`, `CATALINA_*`, global Java options, and classpath cannot override the extension's runtime management.
- `libraries` copies JARs with distinct filenames into the instance's private `lib` directory. Removing a library from the list takes effect after restarting the server.
- Paths are relative to the project. Deployment sources and configuration must remain inside the project; symbolic links and junctions are not supported for those files.
- Ports must be distinct across all instances in the project and range from 1024 to 65535. Conflicts with other processes produce an error; ports are never silently replaced.

In the build workflow, `applications` receives the published WAR snapshot after compilation. You do not need to fill it in manually. To use an existing artifact with Start/Debug, select it through **Deploy Application**.

Changes to Java, ports, JVM arguments, environment variables, and shared libraries require a new instance startup. Application hot reload is optional and runs only when Java files are saved; it does not apply server configuration changes.

## Advanced native configuration

Run **Tomcat: Initialize Native Configuration** to generate configuration files for the selected version in `.vscode/tomcat/<id>` and register `configDir`. The directory contains `server.xml`, `web.xml`, `context.xml`, users, logging, and context configuration. You may include certificates and supporting files, but do not commit private keys or credentials.

Templates use `${http.port}`, `${shutdown.port}`, and `${shutdown.token}`. The first two must match `ports` in the JSON configuration; conflicting values prevent startup. The shutdown token is generated locally and is never written into shared XML templates.

Native XML supports TLS, additional connectors, JNDI resources, and contexts. This version manages **one Host per instance, with `appBase="webapps"`**, and an HTTP connector on the declared port. The shutdown listener must remain on loopback. Other connectors also start on loopback, but you can change them explicitly in XML. Additional ports are checked before startup.

Templates include a Tomcat family marker. Switching between 8.5, 9, 10.1, and 11 requires generating matching templates or restoring the previous version; XML is not converted automatically. Regenerating templates preserves the previous directory in an adjacent backup. Changing an exact release also backs up the previous runtime configuration under `backups` in the local instance data.

Java starts directly through the official Tomcat Bootstrap. `setenv.bat`, external scripts, and Windows services are not executed; configure arguments and environment variables in JSON. XML containing DOCTYPE declarations or external entities is rejected.

## Maven build and automatic deployment

**Build and Debug** and **Build and Run** follow the same sequence: resolve the Maven model, generate a derived POM, compile and package the WAR, deploy the snapshot, and restart the instance in the selected mode. Deployment starts only after a successful build. Select the WAR module POM and context on the first run; subsequent runs reuse the saved configuration.

The extension downloads and verifies its own **Maven 3.9.16**, uses the instance's JDK, and does not require `mvn` on PATH. Maven and JDK distributions are cached. Dependency resolution respects the project's repositories and profiles and the user's default `settings.xml`. Global settings from another Maven installation are not inherited.

Minimal configuration per instance:

```json
"build": {
  "pom": "pom.xml",
  "context": "/backend"
}
```

The Maven Help Plugin reads the original POM to obtain the effective model, including inheritance and active profiles. A derived POM is generated beside it to preserve relative path resolution; this temporary file is removed afterward. Conventional output, including inherited profile/execution paths under the build directory, is redirected to `.tomcat-workbench/<id>/build`. The extension cleans only this verified directory, without running inherited Maven `clean` rules. Custom plugins still execute project code and may have their own side effects: the build requires a trusted workspace and is not a sandbox.

By default, `compile` and `runtime` dependencies follow normal Maven packaging, while `provided` dependencies are automatically included in `WEB-INF/lib`, excluding embedded Tomcat, container APIs, and tools such as Lombok/QueryDSL APT. Test dependencies are not copied. When the project uses `spring-boot-starter-log4j2`, the local WAR excludes known competing bindings: `slf4j-jdk14`, Logback, and the `log4j-to-slf4j` bridge. Builds pin the Help 3.5.1, Compiler 3.11.0, Dependency 3.6.1, and WAR 3.4.0 plugins, which support Java 8.

Additional options:

```json
"build": {
  "pom": "pom.xml",
  "context": "/backend",
  "mavenVersion": "3.9.16",
  "includeProvided": true,
  "skipTests": false,
  "goal": "package",
  "profiles": ["local"],
  "settings": "C:/Users/your-user/.m2/settings.xml",
  "dependencies": [
    { "groupId": "org.apache.httpcomponents", "artifactId": "httpclient" }
  ]
}
```

`dependencies` adds or adjusts dependencies only in the derived POM. Versions may come from the original dependency management or be specified explicitly. The extension does not guess libraries missing from the entire Maven dependency tree. `excludeArtifacts` removes additional artifact IDs from the WAR; `excludeProvidedGroups` limits only the extra copying of `provided` groups. `jvmArgs` supplies additional Maven JVM options. Profiles can be activated by name or disabled with `!name`.

`build.settings` points to the XML file, not its directory. It accepts an absolute path, including one outside the project, or a path relative to the project root, such as `.mvn/settings.xml`. On Windows, use `/` or escape backslashes, as in `C:\Users\your-user\.m2\settings.xml`. The same file is passed with `-s` during model resolution and the build, respecting Maven mirrors, servers/credentials, proxies, profiles, and `localRepository`. The extension neither copies nor edits it. Without this field, Maven uses its default settings. Missing files or paths pointing to directories produce an error before the build.

The default goal is `package`. The optional `install` goal also installs the development artifact and its derived POM into the local Maven repository. Tests run by default; `skipTests: true` skips test execution for the local build. Initial resolution requires repository access; later runs use available caches. Configure Maven process proxies/certificates through settings or appropriate JVM arguments; the extension's download proxy configuration is separate.

A successful build creates an immutable WAR copy in `.tomcat-workbench/<id>/artifacts`. **Build and Run/Debug** updates deployment only after success and restarts the instance. Compilation failures preserve the previous deployment and server. Commands can be cancelled and have a 20-minute limit per Maven invocation. On Windows, cancellation terminates the captured process tree. Active builds are cancelled when the extension deactivates. Locks also record Maven process IDs so another window cannot clean output still in use after an extension host failure.

The last derived POM is saved as `last-pom.xml`, and the result as `last-build.json`, under the instance's `.tomcat-workbench` directory. Old snapshots are retained so deployments referencing them remain valid; remove them manually when no longer needed. The directory includes a local `.gitignore`. An abrupt host interruption may leave a temporary POM beside the original; verify that no build is running before removing it.

This version supports Maven modules with `packaging=war`. For multi-module projects, select a WAR module POM inside the open folder; building the entire reactor is not yet supported. Local dependencies on other modules must already be available in the Maven repository.

### Hot reload

Run **Tomcat: Configure Hot Reload** to choose **Off**, **HotSwap**, or **Rebuild and redeploy** per instance. Set the delay after the last Java save from 200 to 30000 ms; the default is 1000 ms. The feature is off until configured and runs only while the instance is active. In both modes, only saving `.java` documents in VS Code triggers hot reload, including Save All and Auto Save. Saving XML, HTML, CSS, JavaScript, properties, or `pom.xml` does not trigger it, even with broad watch patterns. External disk changes and file creation/deletion events do not trigger it either. Java saves during an operation are grouped into one follow-up update.

Example at the instance level, alongside `build` and `debug`:

```json
"hotReload": {
  "mode": "hotswap",
  "delayMs": 1000,
  "watch": ["src/**"],
  "exclude": ["src/test/**"]
}
```

**HotSwap:** start **Build and Debug** or **Debug**, wait for the debugger to attach, and save a Java file. The extension requests an incremental build from VS Code's Java language support and sends changed classes to that instance's debug session without restarting Tomcat. You can also run **Tomcat: Apply HotSwap**, whether or not automatic mode is enabled. This requires **Language Support for Java by Red Hat**, **Debugger for Java**, and a project imported into Java language support with a valid classpath. This compilation uses Java language support's compiler and classpath, rather than extension-managed Maven. A project that builds only through derived-POM adaptations may need its Java project import adjusted before using HotSwap.

Method-body changes are the usual supported case. Adding or removing members, changing signatures, or changing class hierarchy may be rejected by the JVM. The extension logs the failure and suggests **Build and Debug**; it does not restart automatically after rejection. Changes to XML, resources, POMs, HTML/CSS/JS, and deleted classes require a rebuild/redeploy; HotSwap monitors only `.java` saves. HotSwap does not update the WAR on disk: a later restart uses the last WAR/deployment unless you run another build. The extension does not change global `java.debug.settings.hotCodeReplace` or `java.autobuild.enabled` settings. If another debugger mechanism has already applied the change, the extension's request may find no pending changed classes.

**Rebuild/redeploy:** use `"mode": "redeploy"` and configure `build`. After saving a watched Java file, the extension builds a new WAR with managed Maven and restarts this Tomcat instance, preserving its previous normal/debug mode. HTTP sessions and in-memory state may be lost. Compilation failures preserve the server and last successful deployment. To update static resources or configuration without saving Java, run Build and Run/Debug manually. This version does not provide incremental copying or Manager-based publishing.

`watch` and `exclude` accept project-relative paths with `/`, `*`, `**`, and `?`. The default is `src/**`; specify module paths explicitly for Maven modules in subdirectories. The following directories are always ignored: `target`, `.tomcat-workbench`, `.git`, `.vscode`, `.local`, `node_modules`, `dist`, `out`, and `coverage`, as well as the extension's temporary POMs. A file excluded by these internal filters cannot be enabled through `watch`.

**Stop** cancels active and pending work. Configuration changes and instance removal invalidate old tasks. Deployment, template, start, and restart operations do not run concurrently with reload for the same instance. Turning Hot Reload off cancels pending work and prevents automatic publication/restarts that have not yet started. Diagnosis and results appear in the instance console. Rollback is not guaranteed for application startup errors after a successful build.

Debugger references: [Hot Code Replace and its limitations](https://github.com/microsoft/vscode-java-debug/wiki/Hot-Code-Replace), [the debugger's incremental build implementation](https://github.com/microsoft/vscode-java-debug/blob/main/src/build.ts).

### Missing dependency diagnosis

Log monitoring stays active even without `build.dependencies`. If Build and Run/Debug detects missing classes during startup, diagnosis opens automatically after the operation is released, without requiring a notification click. If another build starts while you select the instance or accept a recovery offer, diagnosis waits and opens afterward. The manual command also waits for an ongoing build. Removing a dependency may make startup fail again, but does not disable detection or require restoring configuration manually. Suggested additions still require confirmation.

When `ClassNotFoundException` or `NoClassDefFoundError` appears in Tomcat logs, Build and Run/Debug opens **Diagnose Dependencies** automatically after the startup attempt. Manual Start/Debug runs show a modal recovery offer. The console records detection, scheduling, and opening. Choose the provider and confirm the change to save the library in `build.dependencies`; cancelling leaves the file unchanged. You can also run **Tomcat: Diagnose Missing Dependencies** from the Command Palette or the instance menu. After reloading VS Code, the command reads the last 1 MiB of the persisted console when there are no exceptions in the current session.

Diagnosis resolves the effective model and evaluates `settings.localRepository` using the instance's Maven/JDK and configured `build.settings`. It then searches for the exact class inside JARs already present in that repository. Versions from `dependencyManagement` appear first. Select a compatible provider for each class; Escape skips the class. The extension displays the coordinates and asks you to confirm **Save Only**, **Build and Run**, or **Build and Debug**. The selected version is pinned explicitly in `build.dependencies`, even when it matches a managed version, so the next build uses the selected JAR. The original POM is preserved.

The search is cancellable, skips links, classified JARs, Tomcat components/container APIs, and tools, and inspects up to 30,000 JARs. Read failures and scan limits appear in the console. Class discovery does not download artifacts or add every entry in dependency management. Model resolution may download Maven plugins and POMs. If the class is absent from the cache, consult the application's maintainers; coordinates are never invented. Static initialization errors and version incompatibilities require their own investigation. This workflow analyzes runtime errors; it does not perform static bytecode analysis before deployment.

**Migrating legacy configuration:** `libraries` entries and native XML remain active. For a self-contained WAR, remove shared Spring/Swagger libraries and restore the default classloader to avoid duplication with `WEB-INF/lib`. JNDI resources and libraries that belong to the server, such as a datasource's JDBC driver, remain environment configuration.

## Debugging the application

1. Install Microsoft's **Debugger for Java** and open the application's source code in the workspace. The Extension Pack for Java also includes this debugger.
2. To compile current source before debugging, run **Tomcat: Build and Debug**. If the artifact is already up to date and deployed, use **Tomcat: Debug** to start or attach the session without another build.
3. The extension starts the JVM with JDWP on `127.0.0.1` and automatically attaches the Java debugger. You do not need `launch.json` or JDWP options in `jvmArgs`.
4. Set breakpoints in source corresponding to the deployed WAR/directory and send a request to the application. The artifact must match the open source and contain debugging information.

When using **Tomcat: Debug**, a server already running in normal mode prompts for a restart in debug mode. If it is already in debug mode, the command reconnects without restarting it. **Stop Debug (Disconnect)** and VS Code's disconnect button end only the debugger session; Tomcat continues running with its loopback JDWP port. Use **Tomcat: Stop** to shut down the server. To return to execution without JDWP, use **Stop** followed by **Start**.

The first Debug command assigns a port that does not conflict with the project's declared ports, starting at 5005, and saves it in `tomcat.json`. Port availability on Windows is checked before launching the JVM. You can configure each instance:

```json
"debug": {
  "port": 5005,
  "projectName": "backend",
  "sourcePaths": ["src/main/java"]
}
```

Only `port` is required when the `debug` section is present. `projectName` and `sourcePaths` help resolve sources when several Java projects are open. Directories are relative to the project. The debug port must differ from HTTP, shutdown, and other instances' debug ports. Port changes take effect after restarting; reconnecting to a recovered JVM uses its actual port.

**Start** still launches without debug even when `debug` is configured. **Restart** and deployment operations that restart a debug server preserve that mode and reconnect the debugger. If attaching fails after a new debug startup, the extension terminates the JVM it just launched; a pre-existing debug instance is preserved.

Remove manual JDWP arguments such as `-agentlib:jdwp` or `-Xrunjdwp` from `jvmArgs` before using integrated debugging. The JVM starts with `suspend=n`: this version attaches after Tomcat startup and does not suspend initialization to catch breakpoints before attachment. **Build and Debug** compiles before startup; updates on save depend on optional [hot reload](#hot-reload) configuration. HotSwap remains subject to Java debugger and JVM limitations.

## Secrets

Run **Tomcat: Set Project Secret** and reference the secret name in `environment` values, such as `${secret:database}`. Each computer stores its own values in VS Code SecretStorage. Missing secrets prevent startup.

The extension redacts these known values from the console it writes to `logs/console.log`. Logs generated by the application or Tomcat itself may contain sensitive data; the extension does not control what the application logs.

## Operation, recovery, and local data

The panel and Command Palette provide start, stop, restart, console, log directory, browser, deploy, undeploy, and instance removal actions. Deploy and undeploy use a staging area and run with the server stopped. If it is running, the interface offers to stop and restart it. Source files are not removed.

Distributions and instances live in VS Code's `globalStorage`, under `local-development.tomcat-workbench`. Each project path and instance ID has separate directories for configuration, applications, libraries, logs, work, and temporary files. Binaries are shared by release version and are not edited.

Locks prevent two windows from operating on the same instance simultaneously. Normal extension shutdown stops the servers. After a VS Code failure, recovery checks the PID, executable, creation time, and ownership argument before adopting an existing process. No helper service installation is required.

If a failure occurs before recording lock ownership or verifying process identity, the extension retains the data and requires manual inspection. Close all VS Code windows, inspect the process recorded in `process.json`, and remove orphaned locks only after confirming that no operation still uses them. A reused PID may require this conservative procedure.

**Tomcat: Remove Local Instance Data** deletes runtime data for a stopped instance while preserving project configuration and distributions. **Remove Instance** removes the project declaration and preserves logs and templates. To uninstall completely, stop all instances, uninstall the extension, and remove its `globalStorage` directory. Handle certificates and secrets according to your local policy.

## Network

Downloads use official providers: `archive.apache.org`, `dlcdn.apache.org`, `api.adoptium.net`, and GitHub/Adoptium assets. The extension respects VS Code's `http.proxy` setting or environment proxy variables. TLS verification remains enabled; configure a corporate CA through Node's `NODE_EXTRA_CA_CERTS` mechanism before launching VS Code when necessary. Manual offline distribution import is deferred to a future version.

## Development and validation

Node.js 22+ is required **only to develop the extension**.

```powershell
npm install
npm run check
npm test
npm run build
npm run test:integration
npm run package
```

`npm test` runs local tests without downloads. `test:integration` downloads real distributions into `.integration-data`, starts all four Tomcat families on Windows, including Tomcat 8.5 with Java 8, verifies isolation and deployment over HTTP, and shuts down the processes. It also compiles a JDI client to verify breakpoints and uses managed Maven to build/deploy a WAR, verify `provided` dependency inclusion and container exclusions, preserve the normal target directory, and retain deployment after compilation failure. Binaries are cached for subsequent runs. These are not automated tests of the VS Code graphical interface.

Press F5 in this repository to open an Extension Development Host and test the interface against a separate project folder. The VSIX uses the local publisher `local-development`; Marketplace publication is not included.

Independence from installed tools is not a security boundary: the server, build, and application run with the Windows user's permissions. Application compatibility, including migration from `javax` to `jakarta`, remains the project's responsibility. Gradle builds, containers, other operating systems, and remote execution are outside this version's scope.
