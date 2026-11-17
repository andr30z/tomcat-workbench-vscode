import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { validateConfig, type ProjectConfig } from './config';
import { atomicJson, lease } from './files';
import { runtimeDirectory } from './runtime';
export class ProjectRepository {
  constructor(private readonly storage: string) {}
  file(project: string): string { return path.join(project, '.vscode/tomcat.json'); }
  async read(project: string): Promise<ProjectConfig> {
    try { return validateConfig(JSON.parse(await readFile(this.file(project), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, instances: [] }; throw error; }
  }
  async update(project: string, transform: (config: ProjectConfig) => ProjectConfig | Promise<ProjectConfig>): Promise<void> {
    const release = await lease(path.join(this.storage, 'config-locks', path.basename(path.dirname(runtimeDirectory(this.storage, project, '_')))));
    try {
      const current = await this.read(project); const result = validateConfig(await transform(current));
      // Never follow a .vscode junction outside the project while writing configuration.
      const target = path.join(project, '.vscode');
      try { const relative = path.relative(await realpath(project), await realpath(target)); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('.vscode must remain inside the project.'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      await atomicJson(this.file(project), result);
    } finally { await release(); }
  }
}
