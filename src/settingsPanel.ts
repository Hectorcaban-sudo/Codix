import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig, SECRET_API_KEY } from './config';
import { BAE_MODELS, apiBaseFor } from './models';

export class SettingsPanel {
  private panel?: vscode.WebviewPanel;

  constructor(private context: vscode.ExtensionContext) {}

  open() {
    if (this.panel) {
      this.panel.reveal();
      this.postState();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'codix.settings',
      'Codix Settings',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => (this.panel = undefined));
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready': this.postState(); break;
        case 'save': await this.save(msg); break;
        case 'uploadCa': await this.uploadCa(); break;
        case 'setKey': await vscode.commands.executeCommand('codix.setApiKey'); this.postState(); break;
        case 'test': await vscode.commands.executeCommand('codix.testConnection'); break;
        case 'pickModel': await this.pickModel(msg.index); break;
      }
    });
  }

  private async postState() {
    const cfg = getConfig();
    const keySet = !!(await this.context.secrets.get(SECRET_API_KEY));
    this.panel?.webview.postMessage({
      type: 'state',
      apiBase: cfg.apiBase,
      model: cfg.model,
      authHeaderName: cfg.authHeaderName,
      authHeaderPrefix: cfg.authHeaderPrefix,
      caBundlePath: Array.isArray(cfg.requestOptions.caBundlePath)
        ? cfg.requestOptions.caBundlePath[0] ?? ''
        : cfg.requestOptions.caBundlePath,
      contextWindowTokens: cfg.contextWindowTokens,
      keySet,
      models: BAE_MODELS
    });
  }

  private async save(msg: any) {
    const c = vscode.workspace.getConfiguration('codix');
    await c.update('apiBase', msg.apiBase, vscode.ConfigurationTarget.Global);
    await c.update('model', msg.model, vscode.ConfigurationTarget.Global);
    await c.update('authHeaderName', msg.authHeaderName, vscode.ConfigurationTarget.Global);
    await c.update('authHeaderPrefix', msg.authHeaderPrefix, vscode.ConfigurationTarget.Global);
    await c.update('contextWindowTokens', Number(msg.contextWindowTokens) || 128000, vscode.ConfigurationTarget.Global);
    const ro = c.get<any>('requestOptions') ?? {};
    ro.caBundlePath = msg.caBundlePath || '';
    await c.update('requestOptions', ro, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('Codix settings saved.');
    this.postState();
  }

  private async pickModel(index: number) {
    const m = BAE_MODELS[index];
    if (!m) return;
    const c = vscode.workspace.getConfiguration('codix');
    await c.update('model', m.modelName, vscode.ConfigurationTarget.Global);
    await c.update('apiBase', apiBaseFor(m.urlSlug), vscode.ConfigurationTarget.Global);
    await c.update('contextWindowTokens', m.context, vscode.ConfigurationTarget.Global);
    // Match the example: apikey header, no Bearer prefix
    await c.update('authHeaderName', 'apikey', vscode.ConfigurationTarget.Global);
    await c.update('authHeaderPrefix', '', vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Codix: ${m.name} → ${apiBaseFor(m.urlSlug)}`);
    this.postState();
  }

  private async uploadCa() {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { Certificates: ['pem', 'crt', 'cer', 'ca'] },
      title: 'Select CA certificate (PEM)'
    });
    if (!uris?.[0]) return;
    const src = uris[0];
    const dir = this.context.globalStorageUri;
    await vscode.workspace.fs.createDirectory(dir);
    const dest = vscode.Uri.joinPath(dir, 'ca-bundle.pem');
    const data = await vscode.workspace.fs.readFile(src);
    await vscode.workspace.fs.writeFile(dest, data);
    const c = vscode.workspace.getConfiguration('codix');
    const ro = c.get<any>('requestOptions') ?? {};
    ro.caBundlePath = dest.fsPath;
    await c.update('requestOptions', ro, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Codix: CA stored at ${dest.fsPath}`);
    this.postState();
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
label { display: block; margin-top: 12px; font-weight: 600; }
input, select { width: 100%; box-sizing: border-box; margin-top: 4px; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
button { margin: 8px 8px 0 0; padding: 6px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; }
.row { display: flex; gap: 8px; align-items: center; }
.models { max-height: 240px; overflow: auto; border: 1px solid var(--vscode-panel-border); margin-top: 8px; }
.models button { display: block; width: 100%; text-align: left; background: none; color: inherit; border-bottom: 1px solid var(--vscode-panel-border); }
.models button:hover { background: var(--vscode-list-hoverBackground); }
</style></head><body>
<h2>Codix Settings</h2>
<p id="keyStatus"></p>
<label>API Base</label>
<input id="apiBase" />
<label>Model</label>
<input id="model" />
<label>Context window tokens</label>
<input id="contextWindowTokens" type="number" />
<label>Auth header name</label>
<input id="authHeaderName" placeholder="apikey" />
<label>Auth header prefix</label>
<input id="authHeaderPrefix" placeholder="" />
<label>CA bundle path</label>
<div class="row"><input id="caBundlePath" /><button id="uploadCa">Upload PEM</button></div>
<div>
  <button id="save">Save</button>
  <button id="setKey">Set API Key</button>
  <button id="test">Test Connection</button>
</div>
<h3>BAE GenAI models</h3>
<p>Click a model to set model name, API base, context, and apikey auth.</p>
<div id="models" class="models"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type !== 'state') return;
  $('apiBase').value = m.apiBase || '';
  $('model').value = m.model || '';
  $('authHeaderName').value = m.authHeaderName || '';
  $('authHeaderPrefix').value = m.authHeaderPrefix || '';
  $('caBundlePath').value = m.caBundlePath || '';
  $('contextWindowTokens').value = m.contextWindowTokens || 128000;
  $('keyStatus').textContent = m.keySet ? 'API key is stored.' : 'No API key stored.';
  $('models').innerHTML = (m.models || []).map((x, i) =>
    '<button data-i="' + i + '">' + x.name + ' — ' + x.modelName + ' (' + x.context + ')</button>'
  ).join('');
});
$('save').onclick = () => vscode.postMessage({
  type: 'save',
  apiBase: $('apiBase').value,
  model: $('model').value,
  authHeaderName: $('authHeaderName').value,
  authHeaderPrefix: $('authHeaderPrefix').value,
  caBundlePath: $('caBundlePath').value,
  contextWindowTokens: $('contextWindowTokens').value
});
$('uploadCa').onclick = () => vscode.postMessage({ type: 'uploadCa' });
$('setKey').onclick = () => vscode.postMessage({ type: 'setKey' });
$('test').onclick = () => vscode.postMessage({ type: 'test' });
$('models').onclick = (e) => {
  const btn = e.target.closest('button[data-i]');
  if (btn) vscode.postMessage({ type: 'pickModel', index: Number(btn.dataset.i) });
};
vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
  }
}
