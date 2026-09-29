import * as vscode from 'vscode';
import { Agent } from './agent';
import { SolutionIndex } from './indexer';
import { McpManager } from './mcpManager';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'codix.chat';
  private view?: vscode.WebviewView;
  private abort?: AbortController;

  constructor(private extUri: vscode.Uri, private agent: Agent, private index: SolutionIndex, private mcp?: McpManager) {
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
        case 'stop': this.abort?.abort(); return;
        case 'newChat': return this.newChat();
        case 'reindex': return vscode.commands.executeCommand('codix.reindex');
        case 'mcp': return vscode.commands.executeCommand('codix.mcpServers');
        case 'mcpPrompt': return vscode.commands.executeCommand('codix.mcpPrompt');
        case 'insert': {
          const ed = vscode.window.activeTextEditor;
          if (ed) await ed.edit((b) => b.replace(ed.selection, msg.code));
          return;
        }
        case 'copy': await vscode.env.clipboard.writeText(msg.code); return;
        case 'ready': this.postStatus(); return;
      }
    });
  }

  newChat() {
    this.abort?.abort();
    this.agent.reset();
    this.post({ type: 'clear' });
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

  private post(msg: unknown) { this.view?.webview.postMessage(msg); }

  private postStatus() {
    const mcp = this.mcp?.summary();
    this.post({ type: 'status', text: `${this.index.fileCount} files · ~${Math.round(this.index.totalTokens / 1000)}k tokens · ${this.index.projectList.length} projects${mcp ? ' · ' + mcp : ''}` });
  }

  private async send(text: string) {
    if (!text.trim()) return;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.post({ type: 'user', text });
    this.post({ type: 'assistantStart' });
    try {
      await this.agent.run(text, {
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
    <span><button id="mcpPrompt" title="Insert MCP prompt">/</button><button id="mcp" title="MCP servers">⚡</button><button id="reindex" title="Re-index solution">⟳</button><button id="new" title="New chat">＋</button></span></div>
  <div id="messages"><div class="empty">Ask anything about your solution, or ask for a change.<br><br>Try: “Explain how authentication flows through the solution” or “Add logging to every controller.”</div></div>
  <div id="inputRow">
    <textarea id="input" rows="3" placeholder="Ask about the solution… (Enter to send, Shift+Enter for newline)"></textarea>
    <button id="send">Send</button>
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
