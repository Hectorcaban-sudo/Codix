import * as vscode from 'vscode';
import * as path from 'path';
import { AgentConfig } from './config';

export interface IndexedFile {
  rel: string;          // workspace-relative path with forward slashes
  uri: vscode.Uri;
  size: number;
  content?: string;     // undefined if too large or binary
  tokens: number;
  skippedReason?: string;
}

export interface ProjectInfo {
  name: string;
  path: string;
  kind: string;
}

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.pdf', '.zip', '.gz', '.7z', '.tar',
  '.dll', '.exe', '.pdb', '.so', '.dylib', '.class', '.jar', '.nupkg', '.snk', '.pfx', '.p12',
  '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.mov', '.wav', '.db', '.sqlite', '.bin', '.obj'
]);

const PRIORITY_FILES = /(\.sln|\.slnx|\.csproj|\.vbproj|\.fsproj|\.props|\.targets|package\.json|tsconfig\.json|pom\.xml|build\.gradle|pyproject\.toml|requirements\.txt|go\.mod|Cargo\.toml|README\.md|appsettings\.json|Program\.cs|Startup\.cs)$/i;

export const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);

/**
 * Indexes every text file in the workspace ("the whole solution") into memory,
 * keeps it fresh with a file watcher, and builds context for the model.
 */
export class SolutionIndex implements vscode.Disposable {
  private files = new Map<string, IndexedFile>();
  private projects: ProjectInfo[] = [];
  private watcher?: vscode.FileSystemWatcher;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private building?: Promise<void>;

  constructor(private getCfg: () => AgentConfig) {}

  get fileCount() { return this.files.size; }
  get totalTokens() { let t = 0; for (const f of this.files.values()) t += f.tokens; return t; }
  get allFiles() { return [...this.files.values()]; }
  get projectList() { return this.projects; }

  async build(progress?: vscode.Progress<{ message?: string }>): Promise<void> {
    if (this.building) return this.building;
    this.building = this.doBuild(progress).finally(() => (this.building = undefined));
    return this.building;
  }

  async ready() { if (this.building) await this.building; }

  private async doBuild(progress?: vscode.Progress<{ message?: string }>) {
    const cfg = this.getCfg();
    this.files.clear();
    const include = cfg.includeGlobs.length === 1 ? cfg.includeGlobs[0] : `{${cfg.includeGlobs.join(',')}}`;
    const exclude = cfg.excludeGlobs.length ? `{${cfg.excludeGlobs.join(',')}}` : undefined;
    const uris = await vscode.workspace.findFiles(include, exclude, cfg.maxFiles);
    const ignore = await this.loadGitignore();

    let done = 0;
    const batch = 64;
    for (let i = 0; i < uris.length; i += batch) {
      await Promise.all(uris.slice(i, i + batch).map((u) => this.indexUri(u, ignore)));
      done += Math.min(batch, uris.length - i);
      progress?.report({ message: `${done}/${uris.length} files` });
    }
    await this.parseProjects();
    this.startWatching();
    this._onDidChange.fire();
  }

  private async loadGitignore(): Promise<(rel: string) => boolean> {
    const patterns: RegExp[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.gitignore'))).toString();
        for (let line of raw.split(/\r?\n/)) {
          line = line.trim();
          if (!line || line.startsWith('#') || line.startsWith('!')) continue;
          const anchored = line.startsWith('/');
          const p = line.replace(/^\//, '').replace(/\/$/, '');
          const rx = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*').replace(/\?/g, '[^/]');
          patterns.push(new RegExp(anchored ? `^${rx}(/|$)` : `(^|/)${rx}(/|$)`));
        }
      } catch { /* no .gitignore */ }
    }
    return (rel) => patterns.some((r) => r.test(rel));
  }

  private relPath(uri: vscode.Uri): string {
    const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    return vscode.workspace.asRelativePath(uri, multi).replace(/\\/g, '/');
  }

  private async indexUri(uri: vscode.Uri, ignore?: (rel: string) => boolean) {
    const cfg = this.getCfg();
    const rel = this.relPath(uri);
    if (ignore?.(rel)) return;
    const ext = path.extname(uri.fsPath).toLowerCase();
    let size = 0;
    try { size = (await vscode.workspace.fs.stat(uri)).size; } catch { return; }

    const entry: IndexedFile = { rel, uri, size, tokens: 0 };
    if (BINARY_EXT.has(ext)) {
      entry.skippedReason = 'binary';
    } else if (size > cfg.maxFileSizeKb * 1024) {
      entry.skippedReason = `large (${Math.round(size / 1024)} KB)`;
    } else {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.subarray(0, 8000).includes(0)) {
          entry.skippedReason = 'binary';
        } else {
          entry.content = Buffer.from(bytes).toString('utf8');
          entry.tokens = estimateTokens(entry.content);
        }
      } catch { entry.skippedReason = 'unreadable'; }
    }
    this.files.set(rel, entry);
  }

  private startWatching() {
    if (this.watcher) return;
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const cfg = this.getCfg();
    const excluded = (u: vscode.Uri) => {
      const rel = this.relPath(u);
      return cfg.excludeGlobs.some((g) => simpleGlob(g).test(rel));
    };
    const upsert = async (u: vscode.Uri) => { if (!excluded(u)) { await this.indexUri(u); this._onDidChange.fire(); } };
    this.watcher.onDidCreate(upsert);
    this.watcher.onDidChange(upsert);
    this.watcher.onDidDelete((u) => { this.files.delete(this.relPath(u)); this._onDidChange.fire(); });
  }

  /** Reads .sln / project files to describe the solution structure. */
  private async parseProjects() {
    this.projects = [];
    for (const f of this.files.values()) {
      if (!f.content) continue;
      if (f.rel.endsWith('.sln')) {
        const rx = /Project\("\{[^}]+\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)"/g;
        let m: RegExpExecArray | null;
        while ((m = rx.exec(f.content))) {
          if (/\.(cs|vb|fs|vcx|sql|njs|py)proj$/i.test(m[2])) {
            const dir = path.posix.dirname(f.rel);
            this.projects.push({ name: m[1], path: path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, m[2].replace(/\\/g, '/'))), kind: path.extname(m[2]) });
          }
        }
      } else if (/\/?package\.json$/.test(f.rel) && !f.rel.includes('node_modules')) {
        try { this.projects.push({ name: JSON.parse(f.content).name ?? f.rel, path: f.rel, kind: 'npm' }); } catch { /* ignore */ }
      } else if (/(pyproject\.toml|go\.mod|Cargo\.toml|pom\.xml)$/.test(f.rel)) {
        this.projects.push({ name: path.posix.dirname(f.rel) || '(root)', path: f.rel, kind: path.basename(f.rel) });
      }
    }
    // Standalone project files not referenced by a .sln
    const known = new Set(this.projects.map((p) => p.path));
    for (const f of this.files.values()) {
      if (/\.(cs|vb|fs)proj$/i.test(f.rel) && !known.has(f.rel)) {
        this.projects.push({ name: path.posix.basename(f.rel).replace(/\.\w+proj$/, ''), path: f.rel, kind: path.extname(f.rel) });
      }
    }
  }

  /** Directory tree of every indexed file. */
  tree(maxLines = 4000): string {
    const paths = [...this.files.keys()].sort();
    const lines: string[] = [];
    let prev: string[] = [];
    for (const p of paths) {
      const parts = p.split('/');
      let i = 0;
      while (i < prev.length && i < parts.length - 1 && prev[i] === parts[i]) i++;
      for (let d = i; d < parts.length - 1; d++) lines.push(`${'  '.repeat(d)}${parts[d]}/`);
      const f = this.files.get(p)!;
      lines.push(`${'  '.repeat(parts.length - 1)}${parts[parts.length - 1]}${f.skippedReason ? `  [${f.skippedReason}]` : ''}`);
      prev = parts;
      if (lines.length >= maxLines) { lines.push(`... (${paths.length} files total, tree truncated)`); break; }
    }
    return lines.join('\n');
  }

  overview(): string {
    const proj = this.projects.length
      ? this.projects.map((p) => `- ${p.name} (${p.kind}) → ${p.path}`).join('\n')
      : '(no project files detected)';
    return `Files indexed: ${this.files.size}, ~${this.totalTokens.toLocaleString()} tokens of source.\n\nProjects:\n${proj}\n\nFile tree:\n${this.tree()}`;
  }

  /**
   * Builds the preloaded "whole solution" context. If the solution fits in
   * the budget, every file is included verbatim. Otherwise files are ranked
   * (project/config files, open editors, relevance to the question) and
   * packed until the budget is hit; the rest stay available through tools.
   */
  buildSolutionContext(budgetTokens: number, query: string, pinned: string[] = []): { text: string; included: number; omitted: number } {
    const all = [...this.files.values()].filter((f) => f.content !== undefined);
    const terms = tokenizeQuery(query);
    const openDocs = new Set(vscode.window.visibleTextEditors.map((e) => this.relPath(e.document.uri)));
    const pinnedSet = new Set(pinned);

    const score = (f: IndexedFile) => {
      let s = 0;
      if (pinnedSet.has(f.rel)) s += 10000;
      if (openDocs.has(f.rel)) s += 1000;
      if (PRIORITY_FILES.test(f.rel)) s += 500;
      if (terms.length) {
        const lowerPath = f.rel.toLowerCase();
        const lower = f.content!.toLowerCase();
        for (const t of terms) {
          if (lowerPath.includes(t)) s += 200;
          const hits = countOccurrences(lower, t);
          s += Math.min(hits, 50) * 4;
        }
      }
      s -= f.tokens / 2000; // slight preference for smaller files
      return s;
    };

    const total = all.reduce((a, f) => a + f.tokens, 0);
    const ordered = total <= budgetTokens ? all.sort((a, b) => a.rel.localeCompare(b.rel)) : all.sort((a, b) => score(b) - score(a));

    const parts: string[] = [];
    let used = 0;
    let included = 0;
    for (const f of ordered) {
      const block = `<file path="${f.rel}">\n${f.content}\n</file>`;
      const t = f.tokens + 15;
      if (used + t > budgetTokens) continue;
      parts.push(block);
      used += t;
      included++;
    }
    return { text: parts.join('\n\n'), included, omitted: all.length - included };
  }

  get(rel: string): IndexedFile | undefined {
    const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
    return this.files.get(norm) ?? [...this.files.values()].find((f) => f.rel.endsWith('/' + norm));
  }

  search(pattern: string, isRegex: boolean, fileGlob?: string, maxResults = 200): string {
    let rx: RegExp;
    try {
      rx = new RegExp(isRegex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch (e: any) {
      return `Invalid regex: ${e.message}`;
    }
    const globRx = fileGlob ? simpleGlob(fileGlob) : undefined;
    const out: string[] = [];
    for (const f of this.files.values()) {
      if (!f.content || (globRx && !globRx.test(f.rel))) continue;
      const lines = f.content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (rx.test(lines[i])) {
          out.push(`${f.rel}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
          if (out.length >= maxResults) return out.join('\n') + `\n... (truncated at ${maxResults} matches)`;
        }
      }
    }
    return out.length ? out.join('\n') : 'No matches.';
  }

  dispose() { this.watcher?.dispose(); this._onDidChange.dispose(); }
}

function tokenizeQuery(q: string): string[] {
  const stop = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'what', 'how', 'does', 'where', 'from', 'into', 'are', 'can', 'you', 'make', 'add', 'fix', 'code', 'file', 'please', 'should', 'would', 'about']);
  const words = q.split(/[^A-Za-z0-9_]+/).flatMap((w) => [w, ...w.split(/(?=[A-Z])/)]);
  return [...new Set(words.map((w) => w.toLowerCase()).filter((w) => w.length >= 3 && !stop.has(w)))].slice(0, 30);
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; if (n > 50) break; }
  return n;
}

export function simpleGlob(glob: string): RegExp {
  const rx = glob
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\{([^}]+)\}/g, (_, g) => `(${g.split(',').join('|')})`)
    .replace(/\*\*\//g, '§§')
    .replace(/\*\*/g, '§')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/§§/g, '(.*/)?')
    .replace(/§/g, '.*');
  return new RegExp(`^${rx}$`, 'i');
}
