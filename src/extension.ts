import * as vscode from 'vscode';
import { Agent } from './agent';
import { ChatViewProvider } from './chatViewProvider';
import { getConfig, SECRET_API_KEY } from './config';
import { SolutionIndex } from './indexer';
import { LlmClient } from './llmClient';
import { McpManager } from './mcpManager';
import { PROPOSED_SCHEME, ProposedContentProvider } from './tools';

export async function activate(context: vscode.ExtensionContext) {
  const index = new SolutionIndex(getConfig);
  const proposed = new ProposedContentProvider();

  const getClient = async () => new LlmClient(getConfig(), await context.secrets.get(SECRET_API_KEY));
  const mcp = new McpManager(context);
  const agent = new Agent(index, proposed, getConfig, getClient, mcp);
  const chat = new ChatViewProvider(context.extensionUri, agent, index, mcp);

  const reindex = () =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Codix: indexing' },
      (p) => index.build(p)
    );

  context.subscriptions.push(
    index,
    mcp,
    vscode.commands.registerCommand('codix.mcpServers', () => mcp.showServers()),
    vscode.commands.registerCommand('codix.mcpReconnect', () => mcp.connectAll()),
    vscode.commands.registerCommand('codix.mcpPrompt', async () => {
      try {
        const text = await mcp.pickAndRenderPrompt();
        if (text) chat.prefill(text);
      } catch (e: any) { vscode.window.showErrorMessage(`MCP prompt failed: ${e.message}`); }
    }),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, proposed),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, { webviewOptions: { retainContextWhenHidden: true } }),

    vscode.commands.registerCommand('codix.reindex', reindex),
    vscode.commands.registerCommand('codix.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('codix.askAboutSelection', () => chat.askAboutSelection()),

    vscode.commands.registerCommand('codix.setApiKey', async () => {
      const key = await vscode.window.showInputBox({ prompt: 'API key / token for your OpenAI server (stored in VS Code SecretStorage)', password: true, ignoreFocusOut: true });
      if (key !== undefined) {
        await context.secrets.store(SECRET_API_KEY, key);
        vscode.window.showInformationMessage('Codix: API key saved.');
      }
    }),
    vscode.commands.registerCommand('codix.clearApiKey', async () => {
      await context.secrets.delete(SECRET_API_KEY);
      vscode.window.showInformationMessage('Codix: API key cleared.');
    }),

    vscode.commands.registerCommand('codix.testConnection', async () => {
      const cfg = getConfig();
      try {
        const client = await getClient();
        const res = await client.chat([{ role: 'user', content: 'Reply with the single word: pong' }], undefined);
        vscode.window.showInformationMessage(`Codix: connected to ${cfg.apiBase} (${cfg.model}). Reply: ${res.content.trim().slice(0, 80)}`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Codix: connection failed — ${e.message}`);
      }
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codix.mcpServers') || e.affectsConfiguration('codix.mcpLoadWorkspaceConfigs')) {
        mcp.connectAll();
      }
      if (e.affectsConfiguration('codix.includeGlobs') || e.affectsConfiguration('codix.excludeGlobs') || e.affectsConfiguration('codix.maxFileSizeKb')) {
        reindex();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => reindex())
  );

  if (vscode.workspace.workspaceFolders?.length) reindex();
  mcp.connectAll();

  // Reconnect when a workspace MCP config file changes.
  const mcpWatcher = vscode.workspace.createFileSystemWatcher('**/{.vscode/mcp.json,.continue/mcpServers/*.json}');
  const reload = () => mcp.connectAll();
  mcpWatcher.onDidChange(reload); mcpWatcher.onDidCreate(reload); mcpWatcher.onDidDelete(reload);
  context.subscriptions.push(mcpWatcher);
}

export function deactivate() {}
