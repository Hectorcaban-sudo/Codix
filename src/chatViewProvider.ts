import * as vscode from 'vscode';
import { Agent } from './agent';
import { SolutionIndex } from './indexer';
import { McpManager } from './mcpManager';
import { SessionStore, StoredSession } from './sessionStore';
import { Mention, parseMentions } from './mentions';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'codix.chat';
  private view?: vscode.WebviewView;
  private abort?: AbortController;
  private session: StoredSession | undefined;

  constructor(
    private extUri: vscode.Uri,
    private agent: Agent,
    private index: SolutionIndex,
    private sessions: SessionStore,
    private mcp?: McpManager
  ) {
    index.onDidChange(() => this.postStatus());
    mcp?.onDidChange(() => this.postStatus());
  }

  prefill(text: string) {
    vscode.commands.executeCommand('codix.chat.focus');
    this.post({ type: 'prefill', text });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'send': return this.send(msg.text);
        case 'mentionQuery': return this.suggestMentions(msg.prefix ?? '', msg.filter ?? '');
        case 'pickMention': return this.pickMention(msg.kind);
        case 'stop': this.abort?.abort(); return;
        case 'newChat': return this.newChat();
        case 'history': return this.pickSession();
        case 'reindex': return vscode.commands.executeCommand('codix.reindex');
        case 'mcp': return vscode.commands.executeCommand('codix.mcpServers');
        case 'mcpPrompt': return vscode.commands.executeCommand('codix.mcpPrompt');
        case 'insert': {
          const ed = vscode.window.activeTextEditor;
          if (ed) await ed.edit((b) => b.replace(ed.selection, msg.code));
          return;
        }
        case 'copy': await vscode.env.clipboard.writeText(msg.code); return;
        case 'ready':
          await this.ensureSession();
          this.postStatus();
          return;
      }
    });
  }

  async newChat() {
    this.abort?.abort();
    this.agent.reset();
    this.session = await this.sessions.create();
    this.post({ type: 'clear' });
  }

  async pickSession() {
    const items = this.sessions.list().map((s) => ({
      label: s.title,
      description: new Date(s.updatedAt).toLocaleString(),
      session: s
    }));
    if (!items.length) {
      vscode.window.showInformationMessage('No saved Codix chats yet.');
      return;
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Open a previous Codix chat' });
    if (!pick) return;
    this.abort?.abort();
    this.session = pick.session;
    this.agent.loadHistory(pick.session.messages);
    await this.sessions.save(pick.session);
    await vscode.commands.executeCommand('codix.chat.focus');
    this.post({
      type: 'restore',
      messages: pick.session.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, text: m.content ?? '' }))
    });
  }

  async askAboutSelection() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    const sel = ed.selection;
    const code = ed.document.getText(sel);
    this.agent.pin([rel.replace(/\\/g, '/')]);
    await vscode.commands.executeCommand('codix.chat.focus');
    this.post({ type: 'prefill', text: `In ${rel} lines ${sel.start.line + 1}-${sel.end.line + 1}:\n\`\`\`\n${code}\n\`\`\`\n` });
  }

  private async ensureSession() {
    if (this.session) return;
    const id = this.sessions.activeId();
    this.session = (id && this.sessions.get(id)) || (await this.sessions.create());
    this.agent.loadHistory(this.session.messages);
  }

  private async persist() {
    if (!this.session) return;
    const msgs = this.agent.getHistory();
    const firstUser = msgs.find((m) => m.role === 'user' && m.content);
    this.session.messages = msgs;
    this.session.title = (firstUser?.content ?? 'New chat').replace(/\s+/g, ' ').slice(0, 72);
    this.session.updatedAt = Date.now();
    await this.sessions.save(this.session);
  }

  private post(msg: unknown) { this.view?.webview.postMessage(msg); }

  private postStatus() {
    const mcp = this.mcp?.summary();
    this.post({ type: 'status', text: `${this.index.fileCount} files · ~${Math.round(this.index.totalTokens / 1000)}k tokens · ${this.index.projectList.length} projects${mcp ? ' · ' + mcp : ''}` });
  }

  private async suggestMentions(prefix: string, filter: string) {
    const q = (filter || '').toLowerCase();
    const items: { insert: string; label: string; detail: string }[] = [];
    const add = (insert: string, label: string, detail: string) => {
      if (!q || insert.toLowerCase().includes(q) || label.toLowerCase().includes(q) || detail.toLowerCase().includes(q)) {
        items.push({ insert, label, detail });
      }
    };

    if (!prefix) {
      add('@workspace', '@workspace', 'Entire indexed solution');
      add('@file', '@file', 'Active editor, or pick a file');
      add('@folder', '@folder', 'All files under a folder');
      add('@selection', '@selection', 'Current editor selection');
      const active = vscode.window.activeTextEditor
        ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri).replace(/\\/g, '/')
        : undefined;
      if (active) add(`@file:${active}`, `@file ${active}`, 'Active editor');
      this.post({ type: 'mentionSuggestions', items: items.slice(0, 40) });
      return;
    }
    if (prefix === 'workspace' || 'workspace'.startsWith(prefix)) {
      add('@workspace', '@workspace', 'Entire indexed solution');
    }
    if (prefix === 'selection' || 'selection'.startsWith(prefix)) {
      add('@selection', '@selection', 'Current editor selection');
    }
    if (!prefix || prefix === 'file' || 'file'.startsWith(prefix) || prefix.includes('/')) {
      const active = vscode.window.activeTextEditor
        ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri).replace(/\\/g, '/')
        : undefined;
      if (active) add(`@file:${active}`, `@file ${active}`, 'Active editor');
      for (const f of this.index.allFiles.slice(0, 400)) {
        add(`@file:${f.rel}`, `@file ${f.rel}`, f.skippedReason ?? 'File');
        if (items.length > 80) break;
      }
    }
    if (!prefix || prefix === 'folder' || 'folder'.startsWith(prefix)) {
      for (const folder of this.index.folders().slice(0, 80)) {
        add(`@folder:${folder}`, `@folder ${folder}`, 'Folder');
        if (items.length > 80) break;
      }
    }
    this.post({ type: 'mentionSuggestions', items: items.slice(0, 40) });
  }

  private async pickMention(kind?: string) {
    if (kind === 'folder') {
      const folders = this.index.folders();
      const pick = await vscode.window.showQuickPick(
        folders.map((f) => ({ label: f, description: `${this.index.filesUnder(f).length} files` })),
        { placeHolder: 'Attach a folder' }
      );
      if (pick) this.post({ type: 'insertMention', text: `@folder:${pick.label} ` });
      return;
    }
    const files = this.index.allFiles;
    const pick = await vscode.window.showQuickPick(
      files.map((f) => ({ label: f.rel, description: f.skippedReason })),
      { placeHolder: 'Attach a file' }
    );
    if (pick) this.post({ type: 'insertMention', text: `@file:${pick.label} ` });
  }

  private async resolveMentions(text: string): Promise<{ text: string; mentions: Mention[] }> {
    const mentions = parseMentions(text);
    let out = text;
    const resolved: Mention[] = [];
    for (const m of mentions) {
      if (m.kind === 'file' && !m.path) {
        const ed = vscode.window.activeTextEditor;
        if (!ed) continue;
        const rel = vscode.workspace.asRelativePath(ed.document.uri).replace(/\\/g, '/');
        out = out.replace(m.raw, `@file:${rel}`);
        resolved.push({ ...m, path: rel, raw: `@file:${rel}` });
      } else if (m.kind === 'folder' && !m.path) {
        const picked = await vscode.window.showQuickPick(
          this.index.folders().map((f) => ({ label: f })),
          { placeHolder: 'Which folder should @folder refer to?' }
        );
        if (picked) {
          out = out.replace(m.raw, `@folder:${picked.label}`);
          resolved.push({ ...m, path: picked.label, raw: `@folder:${picked.label}` });
        }
      } else if (m.kind === 'selection') {
        const ed = vscode.window.activeTextEditor;
        if (ed && !ed.selection.isEmpty) {
          const rel = vscode.workspace.asRelativePath(ed.document.uri).replace(/\\/g, '/');
          const sel = ed.selection;
          const code = ed.document.getText(sel);
          this.agent.pin([rel]);
          out += `\n\n<attached_selection path="${rel}" lines="${sel.start.line + 1}-${sel.end.line + 1}">\n${code}\n</attached_selection>`;
        }
        resolved.push(m);
      } else {
        resolved.push(m);
      }
    }
    return { text: out, mentions: resolved };
  }

  private async send(text: string) {
    if (!text.trim()) return;
    await this.ensureSession();
    const resolved = await this.resolveMentions(text);
    this.agent.applyMentions(resolved.mentions);
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.post({ type: 'user', text: resolved.text });
    this.post({ type: 'assistantStart' });
    try {
      await this.agent.run(resolved.text, {
        onStepStart: () => {},
        onToken: (t) => this.post({ type: 'token', text: t }),
        onToolStart: (name, args) => this.post({ type: 'toolStart', name: prettyTool(name), args: summarizeArgs(name, args) }),
        onToolEnd: (name, result) => this.post({ type: 'toolEnd', name, result: result.slice(0, 3000) }),
        onContextInfo: (info) => this.post({ type: 'contextInfo', text: info })
      }, abort.signal);
    } catch (e: any) {
      this.post({ type: 'error', text: e?.message ?? String(e) });
    } finally {
      this.post({ type: 'assistantEnd' });
      await this.persist();
    }
  }

  private html(webview: vscode.Webview): string {
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'main.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'main.css'));
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head>
<body>
  <div id="toolbar"><span id="status">Indexing…</span>
    <span>
      <button id="mention" title="Insert @ mention">@</button>
      <button id="history" title="Chat history">☰</button>
      <button id="mcpPrompt" title="Insert MCP prompt">/</button>
      <button id="mcp" title="MCP servers">⚡</button>
      <button id="reindex" title="Re-index solution">⟳</button>
      <button id="new" title="New chat">＋</button>
    </span></div>
  <div id="messages"><div class="empty">Ask about the solution. Use @ mentions like GitHub Chat:<br><br><code>@file What does this file do?</code><br><code>@folder:src How is this package structured?</code><br><code>@workspace Where is authentication handled?</code></div></div>
  <div id="composer">
    <div id="mentions" hidden></div>
    <div id="inputRow">
    <textarea id="input" rows="3" placeholder="@file What does this file do?  (@ workspace, file, folder, selection)"></textarea>
    <button id="send">Send</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }
}

function summarizeArgs(name: string, raw: string): string {
  try {
    const a = JSON.parse(raw || '{}');
    if (a.path) return a.path + (a.start_line ? `:${a.start_line}-${a.end_line ?? ''}` : '');
    if (a.query) return `"${a.query}"${a.file_glob ? ` in ${a.file_glob}` : ''}`;
    if (a.command) return a.command;
    if (a.glob) return a.glob;
    if (a.uri) return a.uri;
    const s = JSON.stringify(a);
    return s === '{}' ? '' : s.slice(0, 120);
  } catch { return ''; }
}

function prettyTool(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[2]} (MCP: ${m[1]})` : name;
}
