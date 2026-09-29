import * as vscode from 'vscode';
import * as cp from 'child_process';
import { SolutionIndex } from './indexer';
import { ToolSchema } from './llmClient';
import { AgentConfig } from './config';

export const PROPOSED_SCHEME = 'codix-proposed';

/** Holds proposed file contents so they can be shown in a diff editor. */
export class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  private store = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  onDidChange = this.emitter.event;
  set(uri: vscode.Uri, content: string) { this.store.set(uri.toString(), content); this.emitter.fire(uri); }
  delete(uri: vscode.Uri) { this.store.delete(uri.toString()); }
  provideTextDocumentContent(uri: vscode.Uri) { return this.store.get(uri.toString()) ?? ''; }
}

export interface ToolContext {
  index: SolutionIndex;
  cfg: AgentConfig;
  proposed: ProposedContentProvider;
  log: (msg: string) => void;
  signal?: AbortSignal;
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in the solution, optionally filtered by a glob like "src/**/*.cs".',
      parameters: { type: 'object', properties: { glob: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the solution. Use start_line/end_line (1-based) for big files.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search all solution files for text or a regex. Returns path:line: text.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          is_regex: { type: 'boolean' },
          file_glob: { type: 'string', description: 'Optional glob to restrict files, e.g. "**/*.cs"' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit an existing file by replacing an exact snippet. old_text must match exactly once (include enough surrounding lines to be unique). For several edits in one file, pass them in "edits".',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: { old_text: { type: 'string' }, new_text: { type: 'string' } },
              required: ['old_text', 'new_text']
            }
          },
          explanation: { type: 'string' }
        },
        required: ['path', 'edits']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or fully overwrite an existing one.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' }, explanation: { type: 'string' } },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_diagnostics',
      description: 'Get current compiler/linter errors and warnings from VS Code, optionally for one file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the workspace root (e.g. "dotnet build", "npm test"). The user must approve it.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
    }
  }
];

export function toolSchemas(cfg: AgentConfig): ToolSchema[] {
  return TOOL_SCHEMAS.filter((t) => t.function.name !== 'run_command' || cfg.allowTerminalCommands);
}

function rootUri(): vscode.Uri {
  const f = vscode.workspace.workspaceFolders?.[0];
  if (!f) throw new Error('No workspace folder is open.');
  return f.uri;
}

function resolvePath(ctx: ToolContext, p: string): vscode.Uri {
  const existing = ctx.index.get(p);
  if (existing) return existing.uri;
  const clean = p.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (clean.split('/').includes('..')) throw new Error('Paths outside the workspace are not allowed.');
  // Support "FolderName/…" in multi-root workspaces.
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (clean.startsWith(f.name + '/') && (vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
      return vscode.Uri.joinPath(f.uri, clean.slice(f.name.length + 1));
    }
  }
  return vscode.Uri.joinPath(rootUri(), clean);
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  try { return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); } catch { return undefined; }
}

async function confirmChange(ctx: ToolContext, uri: vscode.Uri, newContent: string, explanation: string, isNew: boolean): Promise<boolean> {
  if (ctx.cfg.autoApplyEdits) return true;
  const proposedUri = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: uri.path, query: String(Date.now()) });
  ctx.proposed.set(proposedUri, newContent);
  const rel = vscode.workspace.asRelativePath(uri);
  const left = isNew ? vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: uri.path + '.empty' }) : uri;
  await vscode.commands.executeCommand('vscode.diff', left, proposedUri, `${rel} ↔ Proposed${isNew ? ' (new file)' : ''}`, { preview: true });
  const choice = await vscode.window.showInformationMessage(
    `Codix wants to ${isNew ? 'create' : 'edit'} ${rel}${explanation ? `: ${explanation}` : ''}`,
    { modal: false },
    'Accept',
    'Reject'
  );
  ctx.proposed.delete(proposedUri);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  return choice === 'Accept';
}

async function applyContent(uri: vscode.Uri, content: string, isNew: boolean) {
  if (isNew) {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  } else {
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
  }
  await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: true });
}

function normalizeEol(s: string) { return s.replace(/\r\n/g, '\n'); }

export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  let args: any;
  try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return `Error: arguments were not valid JSON: ${rawArgs.slice(0, 300)}`; }

  try {
    switch (name) {
      case 'list_files': {
        let files = ctx.index.allFiles;
        if (args.glob) {
          const { simpleGlob } = await import('./indexer');
          const rx = simpleGlob(args.glob);
          files = files.filter((f) => rx.test(f.rel));
        }
        const lines = files.map((f) => `${f.rel}${f.skippedReason ? ` [${f.skippedReason}]` : ''}`).sort();
        return lines.length > 2000 ? lines.slice(0, 2000).join('\n') + `\n... ${lines.length - 2000} more` : lines.join('\n') || 'No files.';
      }

      case 'read_file': {
        const uri = resolvePath(ctx, args.path);
        const text = await readText(uri);
        if (text === undefined) return `Error: file not found: ${args.path}`;
        const lines = text.split(/\r?\n/);
        const start = Math.max(1, args.start_line ?? 1);
        const end = Math.min(lines.length, args.end_line ?? lines.length);
        const slice = lines.slice(start - 1, end).map((l, i) => `${start + i}| ${l}`).join('\n');
        return `${args.path} (lines ${start}-${end} of ${lines.length})\n${slice}`;
      }

      case 'search_code':
        return ctx.index.search(args.query, !!args.is_regex, args.file_glob);

      case 'edit_file': {
        const uri = resolvePath(ctx, args.path);
        const original = await readText(uri);
        if (original === undefined) return `Error: file not found: ${args.path}. Use write_file to create it.`;
        const crlf = original.includes('\r\n');
        let text = normalizeEol(original);
        for (const [i, e] of (args.edits ?? []).entries()) {
          const oldT = normalizeEol(e.old_text ?? '');
          const count = oldT ? text.split(oldT).length - 1 : 0;
          if (count === 0) return `Error: edit ${i + 1}: old_text not found in ${args.path}. Re-read the file and copy the text exactly.`;
          if (count > 1) return `Error: edit ${i + 1}: old_text matches ${count} places in ${args.path}. Include more surrounding lines.`;
          text = text.replace(oldT, () => normalizeEol(e.new_text ?? ''));
        }
        if (crlf) text = text.replace(/\n/g, '\r\n');
        if (!(await confirmChange(ctx, uri, text, args.explanation ?? '', false))) return 'User rejected the edit. Ask what they want changed.';
        await applyContent(uri, text, false);
        return `Applied ${args.edits.length} edit(s) to ${args.path}.`;
      }

      case 'write_file': {
        const uri = resolvePath(ctx, args.path);
        const exists = (await readText(uri)) !== undefined;
        if (!(await confirmChange(ctx, uri, args.content, args.explanation ?? '', !exists))) return 'User rejected the change.';
        await applyContent(uri, args.content, !exists);
        return `${exists ? 'Overwrote' : 'Created'} ${args.path}.`;
      }

      case 'get_diagnostics': {
        const all = args.path ? [[resolvePath(ctx, args.path), vscode.languages.getDiagnostics(resolvePath(ctx, args.path))] as const] : vscode.languages.getDiagnostics();
        const out: string[] = [];
        for (const [uri, diags] of all) {
          for (const d of diags) {
            if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
            out.push(`${vscode.workspace.asRelativePath(uri)}:${d.range.start.line + 1}: ${vscode.DiagnosticSeverity[d.severity]}: ${d.message}`);
          }
        }
        return out.length ? out.slice(0, 300).join('\n') : 'No errors or warnings.';
      }

      case 'run_command': {
        if (!ctx.cfg.allowTerminalCommands) return 'Error: running commands is disabled (codix.allowTerminalCommands).';
        const ok = await vscode.window.showWarningMessage(`Codix wants to run:\n${args.command}`, { modal: true }, 'Run');
        if (ok !== 'Run') return 'User declined to run the command.';
        return await new Promise<string>((resolve) => {
          const child = cp.exec(args.command, { cwd: rootUri().fsPath, timeout: 10 * 60_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
            const out = `${stdout}\n${stderr}`.trim();
            const tail = out.length > 20000 ? '...(truncated)\n' + out.slice(-20000) : out;
            resolve(`Exit code: ${err ? (err as any).code ?? 1 : 0}\n${tail}`);
          });
          ctx.signal?.addEventListener('abort', () => child.kill());
        });
      }

      default:
        return `Error: unknown tool ${name}`;
    }
  } catch (e: any) {
    return `Error: ${e?.message ?? e}`;
  }
}
