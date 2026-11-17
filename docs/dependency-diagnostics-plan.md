# Missing dependency diagnosis

Approved scope: detect ClassNotFoundException and NoClassDefFoundError in Tomcat logs; search cached Maven JARs for the exact missing class; suggest coordinates, prefer the project's effective managed version, and request confirmation before changing build.dependencies or rebuilding. Never add every dependencyManagement entry or download guessed artifacts.

Implementation: a bounded streaming exception parser and cancellable repository ZIP scan, Maven evaluation of settings.localRepository using the selected settings/JDK, a Diagnose Missing Dependencies command plus notification, fresh configuration checks before writes, and existing Build and Run/Debug commands for rebuilding. Scan only normal artifact JARs, skip links and container/tool artifacts; report ambiguity and missing/cache-only results. Preserve the original POM and current deployment during diagnosis.

Verification: parser chunk boundaries and false positives, exact ZIP entries and coordinates, managed version ranking, exclusions and corrupt archives, cancellation, settings-selected repository, confirmation/update guards, existing unit and live Maven/debug/lifecycle suites, and VSIX packaging.

Completed: 59 unit tests, all three live integrations and an extended custom-repository class-provider/build/deploy integration passed. Review corrections pin the selected exact version, distinguish main JARs from classified/type-managed entries, and prevent any diagnosis configuration write before confirmation. Dialog interactions require manual VS Code verification. VSIX 0.5.0 generated.
