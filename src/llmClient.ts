import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { AgentConfig } from './config';
import { buildTlsOptions, explainTlsError, interpolateHeaders } from './tls';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}

export interface StreamHandlers {
  onToken?: (text: string) => void;
  signal?: AbortSignal;
}

export class LlmClient {
  private agent: http.Agent | undefined;

  constructor(private cfg: AgentConfig, private apiKey: string | undefined, private pfxPass?: string) {
    this.agent = this.buildAgent();
  }

  private buildAgent(): http.Agent | undefined {
    const ro = this.cfg.requestOptions;
    const tls: https.AgentOptions = { keepAlive: true, ...buildTlsOptions(ro, this.apiKey, this.pfxPass) };
    const proxy = ro.proxy || process.env.HTTPS_PROXY || process.env.https_proxy;
    if (proxy && this.cfg.apiBase.startsWith('https')) {
      return new HttpsProxyAgent(proxy, tls);
    }
    return this.cfg.apiBase.startsWith('https') ? new https.Agent(tls) : undefined;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json'
    };
    if (this.apiKey && this.cfg.authHeaderName) {
      h[this.cfg.authHeaderName] = `${this.cfg.authHeaderPrefix}${this.apiKey}`;
    }
    Object.assign(h, interpolateHeaders(this.cfg.requestOptions.headers, this.apiKey, this.pfxPass));
    return h;
  }

  async listModels(): Promise<string[]> {
    const url = new URL(this.cfg.apiBase + '/models');
    const lib = url.protocol === 'https:' ? https : http;
    const payload = await new Promise<string>((resolve, reject) => {
      const req = lib.request(url, { method: 'GET', agent: this.agent, headers: this.headers(), timeout: 30000 }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 300) reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 500)}`));
          else resolve(raw);
        });
      });
      req.on('error', (e) => reject(explainTlsError(e)));
      req.end();
    });
    const json = JSON.parse(payload);
    const data = json.data ?? json.models ?? [];
    return data.map((m: any) => m.id ?? m.name).filter(Boolean);
  }

  async chat(messages: ChatMessage[], tools: ToolSchema[] | undefined, handlers: StreamHandlers = {}): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: this.cfg.temperature,
      max_tokens: this.cfg.maxOutputTokens,
      stream: true
    };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    return this.request('/chat/completions', body, handlers);
  }

  private request(path: string, body: unknown, handlers: StreamHandlers): Promise<CompletionResult> {
    const url = new URL(this.cfg.apiBase + path);
    const payload = Buffer.from(JSON.stringify(body));
    const lib = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = lib.request(
        url,
        {
          method: 'POST',
          agent: this.agent,
          headers: { ...this.headers(), 'Content-Length': payload.length },
          timeout: this.cfg.requestOptions.timeoutMs
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            let err = '';
            res.on('data', (c) => (err += c));
            res.on('end', () => reject(new Error(`HTTP ${status} from ${url.host}: ${err.slice(0, 2000)}`)));
            return;
          }
          const isStream = (res.headers['content-type'] ?? '').includes('text/event-stream');
          isStream ? this.readStream(res, handlers, resolve, reject) : this.readJson(res, handlers, resolve, reject);
        }
      );
      req.on('timeout', () => req.destroy(new Error('Request timed out')));
      req.on('error', (e) => reject(explainTlsError(e)));
      handlers.signal?.addEventListener('abort', () => req.destroy(new Error('Cancelled')));
      req.write(payload);
      req.end();
    });
  }

  private readJson(
    res: http.IncomingMessage,
    h: StreamHandlers,
    resolve: (r: CompletionResult) => void,
    reject: (e: Error) => void
  ) {
    let raw = '';
    res.on('data', (c) => (raw += c));
    res.on('end', () => {
      try {
        const json = JSON.parse(raw);
        const choice = json.choices?.[0] ?? {};
        const content = choice.message?.content ?? '';
        if (content) h.onToken?.(content);
        resolve({ content, toolCalls: choice.message?.tool_calls ?? [], finishReason: choice.finish_reason ?? null });
      } catch {
        reject(new Error(`Could not parse server response: ${raw.slice(0, 500)}`));
      }
    });
  }

  private readStream(
    res: http.IncomingMessage,
    h: StreamHandlers,
    resolve: (r: CompletionResult) => void,
    reject: (e: Error) => void
  ) {
    let buffer = '';
    let content = '';
    let finishReason: string | null = null;
    const calls = new Map<number, ToolCall>();

    const handleData = (data: string) => {
      if (data === '[DONE]') return;
      let json: any;
      try { json = JSON.parse(data); } catch { return; }
      const choice = json.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};
      if (delta.content) {
        content += delta.content;
        h.onToken?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const existing = calls.get(idx) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.function.name += tc.function.name;
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
        calls.set(idx, existing);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };

    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) handleData(line.slice(5).trim());
      }
    });
    res.on('end', () => {
      if (buffer.trim().startsWith('data:')) handleData(buffer.trim().slice(5).trim());
      const toolCalls = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, c]) => ({ ...c, id: c.id || `call_${i}_${Date.now()}` }));
      resolve({ content, toolCalls, finishReason });
    });
    res.on('error', reject);
  }
}
