import * as vscode from 'vscode';

export interface RequestOptions {
  headers: Record<string, string>;
  caBundlePath: string | string[];
  clientCertificate: { cert: string; key: string; passphrase?: string };
  pfxPath: string;
  pfxPassphrase?: string;
  verifySsl: boolean;
  timeoutMs: number;
  proxy: string;
}

export interface AgentConfig {
  apiBase: string;
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  temperature: number;
  requestOptions: RequestOptions;
  authHeaderName: string;
  authHeaderPrefix: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  maxFileSizeKb: number;
  maxFiles: number;
  solutionContextBudget: number;
  maxAgentSteps: number;
  autoApplyEdits: boolean;
  allowTerminalCommands: boolean;
  useNativeTools: boolean;
  systemPromptExtra: string;
}

export const SECRET_API_KEY = 'codix.apiKey';

export function getConfig(): AgentConfig {
  const c = vscode.workspace.getConfiguration('codix');
  const ro = c.get<Partial<RequestOptions>>('requestOptions') ?? {};
  return {
    apiBase: (c.get<string>('apiBase') ?? '').replace(/\/+$/, ''),
    model: c.get<string>('model') ?? 'gpt-4o',
    contextWindowTokens: c.get<number>('contextWindowTokens') ?? 128000,
    maxOutputTokens: c.get<number>('maxOutputTokens') ?? 4096,
    temperature: c.get<number>('temperature') ?? 0.1,
    requestOptions: {
      headers: ro.headers ?? {},
      caBundlePath: ro.caBundlePath ?? '',
      clientCertificate: {
        cert: ro.clientCertificate?.cert ?? '',
        key: ro.clientCertificate?.key ?? '',
        passphrase: ro.clientCertificate?.passphrase ?? ''
      },
      pfxPath: ro.pfxPath ?? '',
      pfxPassphrase: ro.pfxPassphrase ?? '',
      verifySsl: ro.verifySsl ?? true,
      timeoutMs: ro.timeoutMs ?? 300000,
      proxy: ro.proxy ?? ''
    },
    authHeaderName: c.get<string>('authHeaderName') ?? 'Authorization',
    authHeaderPrefix: c.get<string>('authHeaderPrefix') ?? 'Bearer ',
    includeGlobs: c.get<string[]>('includeGlobs') ?? ['**/*'],
    excludeGlobs: c.get<string[]>('excludeGlobs') ?? [],
    maxFileSizeKb: c.get<number>('maxFileSizeKb') ?? 256,
    maxFiles: c.get<number>('maxFiles') ?? 20000,
    solutionContextBudget: c.get<number>('solutionContextBudget') ?? 0.6,
    maxAgentSteps: c.get<number>('maxAgentSteps') ?? 25,
    autoApplyEdits: c.get<boolean>('autoApplyEdits') ?? false,
    allowTerminalCommands: c.get<boolean>('allowTerminalCommands') ?? false,
    useNativeTools: c.get<boolean>('useNativeTools') ?? true,
    systemPromptExtra: c.get<string>('systemPromptExtra') ?? ''
  };
}

/** Replaces ${env:NAME}, ${secret:apiKey} and ${workspaceFolder} in a string. */
export function interpolate(value: string, apiKey: string | undefined): string {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return value
    .replace(/\$\{env:([^}]+)\}/g, (_, name) => process.env[name] ?? '')
    .replace(/\$\{secret:apiKey\}/g, apiKey ?? '')
    .replace(/\$\{workspaceFolder\}/g, ws)
    .replace(/^~(?=[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? '~');
}
