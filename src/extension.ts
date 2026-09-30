import * as vscode from 'vscode';
import { Agent } from './agent';
import { ChatViewProvider } from './chatViewProvider';
import { getConfig, SECRET_API_KEY, SECRET_PFX_PASSPHRASE } from './config';
import { SolutionIndex } from './indexer';
import { LlmClient } from './llmClient';
import { McpManager } from './mcpManager';
import { SessionStore } from './sessionStore';
import { PROPOSED_SCHEME, ProposedContentProvider } from './tools';

const COMMANDS = [
  'codix.reindex',
  'codix.setApiKey',
  'codix.clearApiKey',
  'codix.setPfxPassphrase',
  'codix.testConnection',
  'codix.newChat',
  'codix.askAboutSelection',
  'codix.selectModel',
  'codix.showHistory',
  'codix.mcpServers',
  'codix.mcpReconnect',
  'codix.mcpPrompt'
] as const;

export async function activate(context: vscode.ExtensionContext) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.name = 'Codix';
  status.command = 'codix.chat.focus';
  status.text = '$(comment-discussion) Codix';
  status.tooltip = 'Open Codix chat';
  status.show();
  context.subscriptions.push(status);

  const registerFallback = (reason: string) => {
    for (const id of COMMANDS) {
      context.subscriptions.push(
        vscode.commands.registerCommand(id, () => {
          vscode.window.showErrorMessage(`Codix did not activate: ${reason}`);
        })
      );
    }
  };

  try {
    await start(context, status);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.error('Codix activation failed', e);
    vscode.window.showErrorMessage(`Codix failed to start: ${msg}`);
    status.text = '$(error) Codix';
    status.tooltip = msg;
    registerFallback(msg);
  }
}

async function start(context: vscode.ExtensionContext, status: vscode.StatusBarItem) {
  const index = new SolutionIndex(getConfig);
  const proposed = new ProposedContentProvider();
  const sessions = new SessionStore(context);

  const getClient = async () =>
    new LlmClient(getConfig(), await context.secrets.get(SECRET_API_KEY), await context.secrets.get(SECRET_PFX_PASSPHRASE));

  const mcp = new McpManager(context);
  const agent = new Agent(index, proposed, getConfig, getClient, mcp);
  const chat = new ChatViewProvider(context.extensionUri, agent, index, sessions, mcp);

  const refreshStatus = () => {
    const mcpLine = mcp.summary();
    status.text = `$(comment-discussion) Codix ${index.fileCount}`;
    status.tooltip = `${index.fileCount} files · ~${Math.round(index.totalTokens / 1000)}k tokens${mcpLine ? ' · ' + mcpLine : ''}`;
  };
  index.onDidChange(refreshStatus);
  mcp.onDidChange(refreshStatus);

  const reindex = () =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Codix: indexing' },
      (p) => index.build(p)
    );

  context.subscriptions.push(
    index,
    mcp,
    status,
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, proposed),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, {
      webviewOptions: { retainContextWhenHidden: true }
    }),

    vscode.commands.registerCommand('codix.reindex', reindex),
    vscode.commands.registerCommand('codix.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('codix.askAboutSelection', () => chat.askAboutSelection()),
    vscode.commands.registerCommand('codix.showHistory', () => chat.pickSession()),
    vscode.commands.registerCommand('codix.mcpServers', () => mcp.showServers()),
    vscode.commands.registerCommand('codix.mcpReconnect', () => mcp.connectAll()),
    vscode.commands.registerCommand('codix.mcpPrompt', async () => {
      try {
        const text = await mcp.pickAndRenderPrompt();
        if (text) chat.prefill(text);
      } catch (e: any) {
        vscode.window.showErrorMessage(`MCP prompt failed: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('codix.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'API key / token for your OpenAI server (stored in VS Code SecretStorage)',
        password: true,
        ignoreFocusOut: true
      });
      if (key !== undefined) {
        await context.secrets.store(SECRET_API_KEY, key);
        vscode.window.showInformationMessage('Codix: API key saved.');
      }
    }),
    vscode.commands.registerCommand('codix.clearApiKey', async () => {
      await context.secrets.delete(SECRET_API_KEY);
      vscode.window.showInformationMessage('Codix: API key cleared.');
    }),
    vscode.commands.registerCommand('codix.setPfxPassphrase', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'PFX / client-key passphrase (stored in SecretStorage; use ${secret:pfxPassphrase} in settings)',
        password: true,
        ignoreFocusOut: true
      });
      if (key !== undefined) {
        await context.secrets.store(SECRET_PFX_PASSPHRASE, key);
        vscode.window.showInformationMessage('Codix: PFX passphrase saved.');
      }
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

    vscode.commands.registerCommand('codix.selectModel', async () => {
      try {
        const client = await getClient();
        const models = await client.listModels();
        if (!models.length) {
          vscode.window.showWarningMessage('Server returned no models from /models.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          models.map((id) => ({ label: id, description: id === getConfig().model ? 'current' : undefined })),
          { placeHolder: 'Select a model' }
        );
        if (pick) {
          await vscode.workspace.getConfiguration('codix').update('model', pick.label, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`Codix model: ${pick.label}`);
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Could not list models: ${e.message}`);
      }
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codix.mcpServers') || e.affectsConfiguration('codix.mcpLoadWorkspaceConfigs')) {
        mcp.connectAll();
      }
      if (
        e.affectsConfiguration('codix.includeGlobs') ||
        e.affectsConfiguration('codix.excludeGlobs') ||
        e.affectsConfiguration('codix.maxFileSizeKb')
      ) {
        reindex();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => reindex())
  );

  if (vscode.workspace.workspaceFolders?.length) reindex();
  mcp.connectAll();

  const mcpWatcher = vscode.workspace.createFileSystemWatcher('**/{.vscode/mcp.json,.continue/mcpServers/*.json}');
  const reload = () => mcp.connectAll();
  mcpWatcher.onDidChange(reload);
  mcpWatcher.onDidCreate(reload);
  mcpWatcher.onDidDelete(reload);
  context.subscriptions.push(mcpWatcher);
}

export function deactivate() {}
