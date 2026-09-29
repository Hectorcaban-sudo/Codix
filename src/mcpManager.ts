import * as vscode from 'vscode';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema
} from '@modelcontextprotocol/sdk/types.js';
import { Agent as UndiciAgent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { RequestOptions, getConfig, interpolate } from './config';
import { ToolSchema } from './llmClient';
import { buildTlsOptions, explainTlsError, interpolateHeaders } from './tls';

export interface McpServerConfig {
  name: string;
  type?: 'stdio' | 'streamable-http' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** TLS/header options for remote servers, same shape as solutionAgent.requestOptions. */
  requestOptions?: Partial<RequestOptions>;
  /** Reuse solutionAgent.requestOptions (headers + certs) for this server. */
  useGlobalRequestOptions?: boolean;
  disabled?: boolean;
  /** true = never ask; or a list of tool names that never need approval. */
  autoApprove?: boolean | string[];
  timeoutMs?: number;
  source?: string;
}

interface McpTool { name: string; description?: string; inputSchema: any; }
interface McpResource { uri: string; name?: string; description?: string; mimeType?: string; }
interface McpPrompt { name: string; description?: string; arguments?: { name: string; description?: string; required?: boolean }[]; }

type Status = 'connecting' | 'connected' | 'error' | 'disabled';

interface ServerState {
  cfg: McpServerConfig;
  status: Status;
  error?: string;
  client?: Client;
  transport?: Transport;
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
}

const MAX_TOOL_NAME = 64;
const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * MCP client host. Loads server definitions from settings, .vscode/mcp.json and
 * .continue/mcpServers/*.json, connects over stdio / Streamable HTTP / SSE, and
 * exposes their tools, resources and prompts to the agent.
 */
export class McpManager implements vscode.Disposable {
  private servers = new Map<string, ServerState>();
  private toolIndex = new Map<string, { server: string; tool: string }>();
  private sessionApprovals = new Set<string>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  readonly output = vscode.window.createOutputChannel('Solution Agent MCP');

  constructor(private context: vscode.ExtensionContext) {}

  // ---------- configuration ----------

  private normalize(name: string, raw: any, source: string): McpServerConfig {
    const cfg: McpServerConfig = { ...raw, name: raw.name ?? name, source };
    if (!cfg.type) cfg.type = cfg.command ? 'stdio' : 'streamable-http';
    if (cfg.type === 'http') cfg.type = 'streamable-http';
    return cfg;
  }

  private fromContainer(json: any, source: string): McpServerConfig[] {
    const container = json?.servers ?? json?.mcpServers ?? json;
    if (Array.isArray(container)) return container.map((s, i) => this.normalize(s.name ?? `server${i}`, s, source));
    if (container && typeof container === 'object') {
      return Object.entries(container)
        .filter(([, v]) => v && typeof v === 'object' && ((v as any).command || (v as any).url))
        .map(([k, v]) => this.normalize(k, v, source));
    }
    return [];
  }

  async loadConfigs(): Promise<McpServerConfig[]> {
    const out: McpServerConfig[] = [];
    const setting = vscode.workspace.getConfiguration('solutionAgent').get<any>('mcpServers');
    out.push(...this.fromContainer(setting ?? [], 'settings'));

    const loadWs = vscode.workspace.getConfiguration('solutionAgent').get<boolean>('mcpLoadWorkspaceConfigs') ?? true;
    if (loadWs && vscode.workspace.isTrusted) {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const candidates = [vscode.Uri.joinPath(folder.uri, '.vscode', 'mcp.json')];
        try {
          const dir = vscode.Uri.joinPath(folder.uri, '.continue', 'mcpServers');
          for (const [n, t] of await vscode.workspace.fs.readDirectory(dir)) {
            if (t === vscode.FileType.File && n.endsWith('.json')) candidates.push(vscode.Uri.joinPath(dir, n));
          }
        } catch { /* no .continue folder */ }
        for (const uri of candidates) {
          try {
            const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
            const json = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')); // tolerate // comments
            const rel = vscode.workspace.asRelativePath(uri);
            const servers = this.fromContainer(json, rel);
            if (servers.length && (await this.confirmWorkspaceConfig(rel, text))) out.push(...servers);
          } catch { /* missing or invalid */ }
        }
      }
    }
    // Later definitions with the same name win (workspace overrides settings).
    const byName = new Map<string, McpServerConfig>();
    for (const s of out) byName.set(s.name, s);
    return [...byName.values()];
  }

  /** Workspace MCP configs can launch processes, so ask once per file content. */
  private async confirmWorkspaceConfig(rel: string, text: string): Promise<boolean> {
    const key = `mcpTrusted:${rel}`;
    const hash = require('crypto').createHash('sha256').update(text).digest('hex');
    const stored = this.context.workspaceState.get<string>(key);
    if (stored === hash) return true;
    if (stored === `deny:${hash}`) return false;
    const pick = await vscode.window.showWarningMessage(
      `This workspace defines MCP servers in ${rel}. They can run commands on your machine. Start them?`,
      'Allow', 'Deny', 'View File'
    );
    if (pick === 'View File') {
      const f = vscode.workspace.workspaceFolders?.[0];
      if (f) await vscode.window.showTextDocument(vscode.Uri.joinPath(f.uri, rel));
      return false;
    }
    await this.context.workspaceState.update(key, pick === 'Allow' ? hash : `deny:${hash}`);
    return pick === 'Allow';
  }

  // ---------- connection ----------

  async connectAll(): Promise<void> {
    await this.disconnectAll();
    const configs = await this.loadConfigs();
    for (const cfg of configs) {
      this.servers.set(cfg.name, { cfg, status: cfg.disabled ? 'disabled' : 'connecting', tools: [], resources: [], prompts: [] });
    }
    this._onDidChange.fire();
    await Promise.all(configs.filter((c) => !c.disabled).map((c) => this.connect(c.name)));
    this.rebuildToolIndex();
    this._onDidChange.fire();
  }

  async restart(name: string) {
    const s = this.servers.get(name);
    if (!s) return;
    await this.closeServer(s);
    s.cfg.disabled = false;
    await this.connect(name);
    this.rebuildToolIndex();
    this._onDidChange.fire();
  }

  private async resolveValue(v: string): Promise<string> {
    // ${input:id} (VS Code mcp.json style): prompt once, keep in SecretStorage.
    const inputs = [...v.matchAll(/\$\{input:([^}]+)\}/g)].map((m) => m[1]);
    for (const id of inputs) {
      const key = `solutionAgent.mcpInput.${id}`;
      let val = await this.context.secrets.get(key);
      if (val === undefined) {
        val = await vscode.window.showInputBox({ prompt: `MCP value for "${id}"`, password: true, ignoreFocusOut: true });
        if (val === undefined) throw new Error(`No value provided for \${input:${id}}`);
        await this.context.secrets.store(key, val);
      }
      v = v.split(`\${input:${id}}`).join(val);
    }
    const apiKey = await this.context.secrets.get('solutionAgent.apiKey');
    return interpolate(v, apiKey);
  }

  private async resolveRecord(r?: Record<string, string>): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r ?? {})) out[k] = await this.resolveValue(String(v));
    return out;
  }

  private async makeFetch(cfg: McpServerConfig) {
    const ro: Partial<RequestOptions> = { ...(cfg.useGlobalRequestOptions ? getConfig().requestOptions : {}), ...(cfg.requestOptions ?? {}) };
    const apiKey = await this.context.secrets.get('solutionAgent.apiKey');
    const tlsOpts = buildTlsOptions(ro, apiKey);
    const headers = {
      ...interpolateHeaders(ro.headers, apiKey),
      ...(await this.resolveRecord(cfg.headers))
    };
    const proxy = ro.proxy || process.env.HTTPS_PROXY || process.env.https_proxy;
    const connect = { ...tlsOpts };
    const dispatcher = proxy && cfg.url?.startsWith('https') ? new ProxyAgent({ uri: proxy, requestTls: connect }) : new UndiciAgent({ connect });
    return (url: string | URL, init?: any) => {
      const h = new Headers(init?.headers);
      for (const [k, v] of Object.entries(headers)) if (!h.has(k)) h.set(k, v);
      return undiciFetch(url as any, { ...init, headers: h, dispatcher }) as any;
    };
  }

  private async createTransport(cfg: McpServerConfig, forceSse = false): Promise<Transport> {
    if (cfg.type === 'stdio') {
      if (!cfg.command) throw new Error('stdio server needs "command"');
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      Object.assign(env, await this.resolveRecord(cfg.env));
      const args: string[] = [];
      for (const a of cfg.args ?? []) args.push(await this.resolveValue(a));
      const t = new StdioClientTransport({
        command: await this.resolveValue(cfg.command),
        args,
        env,
        cwd: cfg.cwd ? path.resolve(ws ?? '', await this.resolveValue(cfg.cwd)) : ws,
        stderr: 'pipe'
      });
      t.stderr?.on('data', (d: Buffer) => this.output.append(`[${cfg.name}] ${d.toString()}`));
      return t;
    }
    if (!cfg.url) throw new Error('remote server needs "url"');
    const url = new URL(await this.resolveValue(cfg.url));
    const fetch = await this.makeFetch(cfg);
    return cfg.type === 'sse' || forceSse
      ? new SSEClientTransport(url, { fetch } as any)
      : new StreamableHTTPClientTransport(url, { fetch } as any);
  }

  private async connect(name: string): Promise<void> {
    const s = this.servers.get(name)!;
    s.status = 'connecting';
    s.error = undefined;
    this._onDidChange.fire();
    const attempt = async (forceSse: boolean) => {
      const client = new Client({ name: 'solution-agent', version: '0.2.0' }, { capabilities: {} });
      const transport = await this.createTransport(s.cfg, forceSse);
      await withTimeout(client.connect(transport), s.cfg.timeoutMs ?? 30000, `connect to ${name}`);
      return { client, transport };
    };
    try {
      let conn;
      try {
        conn = await attempt(false);
      } catch (e) {
        // Older remote servers only speak the legacy SSE transport.
        if (s.cfg.type !== 'streamable-http') throw e;
        this.output.appendLine(`[${name}] Streamable HTTP failed (${explainTlsError(e).message}); trying SSE`);
        try {
          conn = await attempt(true);
        } catch {
          throw e; // report the original (more specific) error
        }
      }
      s.client = conn.client;
      s.transport = conn.transport;
      s.transport.onclose = () => {
        if (s.status === 'connected') { s.status = 'error'; s.error = 'Connection closed'; this.rebuildToolIndex(); this._onDidChange.fire(); }
      };
      await this.refreshLists(s);
      s.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { await this.refreshLists(s); this.rebuildToolIndex(); this._onDidChange.fire(); });
      s.client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => { await this.refreshLists(s); this._onDidChange.fire(); });
      s.client.setNotificationHandler(PromptListChangedNotificationSchema, async () => { await this.refreshLists(s); this._onDidChange.fire(); });
      s.status = 'connected';
      this.output.appendLine(`[${name}] connected: ${s.tools.length} tools, ${s.resources.length} resources, ${s.prompts.length} prompts`);
    } catch (e: any) {
      s.status = 'error';
      s.error = explainTlsError(e).message;
      this.output.appendLine(`[${name}] failed: ${s.error}`);
    }
  }

  private async refreshLists(s: ServerState) {
    const caps = s.client!.getServerCapabilities() ?? {};
    s.tools = caps.tools ? await paginate((cursor) => s.client!.listTools({ cursor }), 'tools') : [];
    s.resources = caps.resources ? await paginate((cursor) => s.client!.listResources({ cursor }), 'resources').catch(() => []) : [];
    s.prompts = caps.prompts ? await paginate((cursor) => s.client!.listPrompts({ cursor }), 'prompts').catch(() => []) : [];
  }

  private async closeServer(s: ServerState) {
    try { await s.client?.close(); } catch { /* ignore */ }
    s.client = undefined;
    s.transport = undefined;
    s.tools = []; s.resources = []; s.prompts = [];
  }

  async disconnectAll() {
    await Promise.all([...this.servers.values()].map((s) => this.closeServer(s)));
    this.servers.clear();
    this.toolIndex.clear();
  }

  // ---------- tools exposed to the agent ----------

  private rebuildToolIndex() {
    this.toolIndex.clear();
    for (const s of this.servers.values()) {
      if (s.status !== 'connected') continue;
      for (const t of s.tools) {
        let name = `mcp__${sanitize(s.cfg.name)}__${sanitize(t.name)}`;
        if (name.length > MAX_TOOL_NAME) name = name.slice(0, MAX_TOOL_NAME - 7) + '_' + hash6(name);
        this.toolIndex.set(name, { server: s.cfg.name, tool: t.name });
      }
    }
  }

  get hasResources() { return [...this.servers.values()].some((s) => s.status === 'connected' && s.resources.length); }

  toolSchemas(): ToolSchema[] {
    const out: ToolSchema[] = [];
    for (const [fq, { server, tool }] of this.toolIndex) {
      const t = this.servers.get(server)!.tools.find((x) => x.name === tool)!;
      const params = cleanSchema(t.inputSchema);
      out.push({ type: 'function', function: { name: fq, description: `[MCP: ${server}] ${t.description ?? tool}`.slice(0, 1024), parameters: params } });
    }
    if (this.hasResources) {
      out.push(
        { type: 'function', function: { name: 'mcp_list_resources', description: 'List resources (docs, data, records) exposed by connected MCP servers.', parameters: { type: 'object', properties: { server: { type: 'string' } } } } },
        { type: 'function', function: { name: 'mcp_read_resource', description: 'Read an MCP resource by server name and URI.', parameters: { type: 'object', properties: { server: { type: 'string' }, uri: { type: 'string' } }, required: ['server', 'uri'] } } }
      );
    }
    return out;
  }

  handles(toolName: string) {
    return this.toolIndex.has(toolName) || toolName === 'mcp_list_resources' || toolName === 'mcp_read_resource';
  }

  /** One-line summary per tool, for the system prompt. */
  describe(): string {
    const lines: string[] = [];
    for (const s of this.servers.values()) {
      if (s.status !== 'connected') continue;
      lines.push(`- ${s.cfg.name}: ${s.tools.length} tools${s.resources.length ? `, ${s.resources.length} resources` : ''}`);
    }
    return lines.join('\n');
  }

  private async approve(server: string, tool: string, args: any): Promise<boolean> {
    const s = this.servers.get(server)!;
    const mode = vscode.workspace.getConfiguration('solutionAgent').get<string>('mcpToolApproval') ?? 'ask';
    if (mode === 'auto') return true;
    const aa = s.cfg.autoApprove;
    if (aa === true || (Array.isArray(aa) && aa.includes(tool))) return true;
    const key = `${server}/${tool}`;
    if (this.sessionApprovals.has(key)) return true;
    const argText = JSON.stringify(args, null, 2);
    const pick = await vscode.window.showWarningMessage(
      `Allow MCP tool "${tool}" from server "${server}"?`,
      { modal: true, detail: `Arguments:\n${argText.length > 1500 ? argText.slice(0, 1500) + '…' : argText}` },
      'Allow', 'Allow for this session'
    );
    if (pick === 'Allow for this session') this.sessionApprovals.add(key);
    return !!pick;
  }

  async callTool(toolName: string, rawArgs: string, signal?: AbortSignal): Promise<string> {
    let args: any;
    try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return `Error: arguments were not valid JSON: ${rawArgs.slice(0, 300)}`; }

    if (toolName === 'mcp_list_resources') {
      const lines: string[] = [];
      for (const s of this.servers.values()) {
        if (s.status !== 'connected' || (args.server && s.cfg.name !== args.server)) continue;
        for (const r of s.resources) lines.push(`${s.cfg.name} | ${r.uri} | ${r.name ?? ''}${r.description ? ` — ${r.description}` : ''}`);
      }
      return lines.join('\n') || 'No resources.';
    }
    if (toolName === 'mcp_read_resource') {
      const s = this.servers.get(args.server);
      if (!s?.client) return `Error: MCP server "${args.server}" is not connected.`;
      try {
        const res = await s.client.readResource({ uri: args.uri }, { signal });
        return res.contents.map((c: any) => c.text ?? `[binary ${c.mimeType ?? ''} resource ${c.uri}]`).join('\n\n');
      } catch (e: any) { return `Error reading resource: ${e.message}`; }
    }

    const target = this.toolIndex.get(toolName);
    if (!target) return `Error: unknown MCP tool ${toolName}`;
    const s = this.servers.get(target.server)!;
    if (!s.client) return `Error: MCP server "${target.server}" is not connected.`;
    if (!(await this.approve(target.server, target.tool, args))) return 'User denied this MCP tool call.';

    this.output.appendLine(`[${target.server}] call ${target.tool} ${JSON.stringify(args).slice(0, 500)}`);
    try {
      const res: any = await s.client.callTool({ name: target.tool, arguments: args }, undefined, {
        signal,
        timeout: s.cfg.timeoutMs ?? 120000
      });
      return formatToolResult(res);
    } catch (e: any) {
      return `Error from MCP server "${target.server}": ${e.message}`;
    }
  }

  // ---------- prompts & UI ----------

  async pickAndRenderPrompt(): Promise<string | undefined> {
    const items: (vscode.QuickPickItem & { server: string; prompt: McpPrompt })[] = [];
    for (const s of this.servers.values()) {
      if (s.status !== 'connected') continue;
      for (const p of s.prompts) items.push({ label: p.name, description: s.cfg.name, detail: p.description, server: s.cfg.name, prompt: p });
    }
    if (!items.length) { vscode.window.showInformationMessage('No MCP prompts are available.'); return; }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Choose an MCP prompt', matchOnDetail: true });
    if (!pick) return;
    const args: Record<string, string> = {};
    for (const a of pick.prompt.arguments ?? []) {
      const v = await vscode.window.showInputBox({ prompt: `${a.name}${a.required ? '' : ' (optional)'}`, placeHolder: a.description, ignoreFocusOut: true });
      if (v === undefined) return;
      if (v || a.required) args[a.name] = v;
    }
    const res = await this.servers.get(pick.server)!.client!.getPrompt({ name: pick.prompt.name, arguments: args });
    return res.messages
      .map((m: any) => (m.content?.type === 'text' ? m.content.text : m.content?.type === 'resource' ? m.content.resource?.text ?? '' : ''))
      .filter(Boolean)
      .join('\n\n');
  }

  async showServers() {
    const items = [...this.servers.values()].map((s) => ({
      label: `${icon(s.status)} ${s.cfg.name}`,
      description: `${s.cfg.type} · ${s.status}${s.status === 'connected' ? ` · ${s.tools.length} tools` : ''}`,
      detail: s.error ?? `from ${s.cfg.source}${s.tools.length ? ` — ${s.tools.map((t) => t.name).join(', ')}` : ''}`,
      name: s.cfg.name
    }));
    items.push({ label: '$(refresh) Reconnect all', description: '', detail: 'Reload MCP configuration and reconnect', name: '__all' });
    items.push({ label: '$(output) Show MCP log', description: '', detail: undefined as any, name: '__log' });
    items.push({ label: '$(gear) Edit MCP servers in settings', description: '', detail: undefined as any, name: '__settings' });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'MCP servers (select one to restart it)' });
    if (!pick) return;
    if (pick.name === '__all') return this.connectAll();
    if (pick.name === '__log') return this.output.show();
    if (pick.name === '__settings') return vscode.commands.executeCommand('workbench.action.openSettingsJson');
    return this.restart(pick.name);
  }

  summary(): string {
    const all = [...this.servers.values()];
    if (!all.length) return '';
    const ok = all.filter((s) => s.status === 'connected');
    const err = all.filter((s) => s.status === 'error').length;
    return `MCP ${ok.length}/${all.length}${err ? ` (${err} failed)` : ''} · ${this.toolIndex.size} tools`;
  }

  dispose() { this.disconnectAll(); this.output.dispose(); this._onDidChange.dispose(); }
}

// ---------- helpers ----------

async function paginate(fn: (cursor?: string) => Promise<any>, key: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await fn(cursor);
    out.push(...(r[key] ?? []));
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${ms} ms trying to ${what}`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function cleanSchema(schema: any): Record<string, unknown> {
  const s = schema && typeof schema === 'object' ? { ...schema } : {};
  delete s.$schema;
  if (s.type !== 'object') return { type: 'object', properties: {} };
  if (!s.properties) s.properties = {};
  return s;
}

function formatToolResult(res: any): string {
  if (res.toolResult !== undefined) return JSON.stringify(res.toolResult, null, 2); // legacy servers
  const parts: string[] = [];
  for (const c of res.content ?? []) {
    switch (c.type) {
      case 'text': parts.push(c.text); break;
      case 'image': parts.push(`[image ${c.mimeType}, ${Math.round((c.data?.length ?? 0) * 0.75 / 1024)} KB]`); break;
      case 'audio': parts.push(`[audio ${c.mimeType}]`); break;
      case 'resource': parts.push(c.resource?.text ?? `[resource ${c.resource?.uri}]`); break;
      case 'resource_link': parts.push(`[resource link: ${c.uri}${c.name ? ` (${c.name})` : ''}]`); break;
      default: parts.push(JSON.stringify(c));
    }
  }
  if (!parts.length && res.structuredContent) parts.push(JSON.stringify(res.structuredContent, null, 2));
  const text = parts.join('\n');
  return res.isError ? `Tool reported an error:\n${text}` : text || '(no output)';
}

function hash6(s: string) {
  return require('crypto').createHash('sha1').update(s).digest('hex').slice(0, 6);
}

function icon(s: Status) {
  return s === 'connected' ? '$(pass-filled)' : s === 'error' ? '$(error)' : s === 'disabled' ? '$(circle-slash)' : '$(sync~spin)';
}
