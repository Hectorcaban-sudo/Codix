import { AgentConfig } from './config';
import { SolutionIndex, estimateTokens } from './indexer';
import { ChatMessage, LlmClient, ToolCall } from './llmClient';
import { ProposedContentProvider, runTool, toolSchemas } from './tools';
import { McpManager } from './mcpManager';
import { ToolSchema } from './llmClient';
import { Mention } from './mentions';

export interface AgentEvents {
  onToken: (t: string) => void;
  onToolStart: (name: string, args: string) => void;
  onToolEnd: (name: string, result: string) => void;
  onStepStart: () => void;
  onContextInfo: (info: string) => void;
}

function textToolInstructions(tools: ToolSchema[]) {
  return `
To use a tool, reply with ONLY a fenced block in exactly this format and then stop:
\`\`\`tool
{"name": "<tool name>", "arguments": { ... }}
\`\`\`
You will receive the result in the next message. Available tools:
${tools.map((t) => `- ${t.function.name}: ${t.function.description} Parameters: ${JSON.stringify(t.function.parameters)}`).join('\n')}
When you are finished, answer normally without a tool block.`;
}

export class Agent {
  private history: ChatMessage[] = [];
  private pinned: string[] = [];
  private mentionFocus = false;

  constructor(
    private index: SolutionIndex,
    private proposed: ProposedContentProvider,
    private getCfg: () => AgentConfig,
    private getClient: () => Promise<LlmClient>,
    private mcp?: McpManager
  ) {}

  private allTools(cfg: AgentConfig): ToolSchema[] {
    return [...toolSchemas(cfg), ...(this.mcp?.toolSchemas() ?? [])];
  }

  reset() { this.history = []; this.pinned = []; this.mentionFocus = false; }
  pin(paths: string[]) { this.pinned.push(...paths); }
  applyMentions(mentions: Mention[]) {
    this.mentionFocus = mentions.some((m) => m.kind === 'file' || m.kind === 'folder' || m.kind === 'selection');
    for (const m of mentions) {
      if (m.kind === 'file' && m.path) this.pin([m.path]);
      if (m.kind === 'folder' && m.path) this.pin(this.index.filesUnder(m.path).map((f) => f.rel));
      if (m.kind === 'workspace') this.mentionFocus = false;
    }
  }
  getHistory(): ChatMessage[] { return this.history; }
  loadHistory(messages: ChatMessage[]) { this.history = messages; this.pinned = []; }

  private systemPrompt(cfg: AgentConfig, query: string, events: AgentEvents): string {
    const budget = Math.floor(cfg.contextWindowTokens * cfg.solutionContextBudget);
    const overview = this.index.overview();
    const overviewTokens = estimateTokens(overview);
    const ctx = this.index.buildSolutionContext(Math.max(0, budget - overviewTokens), query, this.pinned);

    const names = ctx.paths?.slice(0, 12).join(', ') ?? '';
    events.onContextInfo(
      ctx.omitted === 0
        ? `Whole solution loaded: ${ctx.included} files`
        : `Loaded ${ctx.included} relevant files${names ? ` (${names}${ctx.included > 12 ? ', …' : ''})` : ''}; ${ctx.omitted} more via tools`
    );

    const mentionNote = this.pinned.length
      ? `The user tagged these paths — treat them as the primary subject of the question:\n${[...new Set(this.pinned)].slice(0, 40).map((p) => `- ${p}`).join('\n')}`
      : '';

    return [
      `You are Codix, an expert software engineer working inside the user's VS Code workspace.`,
      `You have the user's entire solution indexed. Its structure and ${ctx.omitted === 0 ? 'the full source of every file' : 'the full source of the most relevant files'} are below.`,
      mentionNote,
      `Guidelines:
- Ground every answer in the actual code. Cite files as path:line.
- Before editing, make sure you understand every caller/usage affected (use search_code across the solution).
- Make changes with edit_file (exact snippet replacement) or write_file (new files). Keep edits minimal and consistent with existing style.
- After edits, call get_diagnostics to check for errors when relevant.
- If a request is ambiguous, ask a short clarifying question instead of guessing.`,
      this.mcp?.describe()
        ? `You also have tools from connected MCP servers (names start with "mcp__<server>__"). Use them when they are the right source (tickets, docs, databases, internal APIs, etc.). MCP calls may need user approval.\n${this.mcp.describe()}`
        : '',
      cfg.useNativeTools ? '' : textToolInstructions(this.allTools(cfg)),
      cfg.systemPromptExtra,
      `<solution_overview>\n${overview}\n</solution_overview>`,
      `<solution_source>\n${ctx.text}\n</solution_source>`
    ].filter(Boolean).join('\n\n');
  }

  private trimHistory(cfg: AgentConfig, systemTokens: number) {
    const limit = cfg.contextWindowTokens - cfg.maxOutputTokens - systemTokens - 1000;
    const size = () => this.history.reduce((a, m) => a + estimateTokens((m.content ?? '') + JSON.stringify(m.tool_calls ?? '')), 0);
    for (let i = 0; i < this.history.length - 4 && size() > limit; i++) {
      const m = this.history[i];
      if (m.role === 'tool' && (m.content?.length ?? 0) > 400) m.content = m.content!.slice(0, 400) + '\n...(older tool output trimmed)';
    }
    while (size() > limit && this.history.length > 2) {
      this.history.shift();
      while (this.history[0]?.role === 'tool') this.history.shift();
    }
  }

  async run(userText: string, events: AgentEvents, signal: AbortSignal): Promise<void> {
    await this.index.ready();
    const cfg = this.getCfg();
    const client = await this.getClient();
    this.history.push({ role: 'user', content: userText });

    for (let step = 0; step < cfg.maxAgentSteps; step++) {
      if (signal.aborted) throw new Error('Cancelled');
      events.onStepStart();
      const system = this.systemPrompt(cfg, userText, events);
      this.trimHistory(cfg, estimateTokens(system));
      const messages: ChatMessage[] = [{ role: 'system', content: system }, ...this.history];

      const result = await client.chat(messages, cfg.useNativeTools ? this.allTools(cfg) : undefined, { onToken: events.onToken, signal });

      let toolCalls: ToolCall[] = result.toolCalls;
      let content = result.content;
      if (!cfg.useNativeTools) {
        const parsed = parseTextToolCall(content);
        if (parsed) { toolCalls = [parsed.call]; content = parsed.before; }
      }

      if (!toolCalls.length) {
        this.history.push({ role: 'assistant', content });
        return;
      }

      if (cfg.useNativeTools) {
        this.history.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
      } else {
        this.history.push({ role: 'assistant', content: result.content });
      }

      for (const call of toolCalls) {
        if (signal.aborted) throw new Error('Cancelled');
        events.onToolStart(call.function.name, call.function.arguments);
        const out = this.mcp?.handles(call.function.name)
          ? await this.mcp.callTool(call.function.name, call.function.arguments, signal)
          : await runTool(call.function.name, call.function.arguments, { index: this.index, cfg, proposed: this.proposed, log: () => {}, signal });
        const capped = out.length > 60000 ? out.slice(0, 60000) + '\n...(truncated; use read_file with a line range)' : out;
        events.onToolEnd(call.function.name, capped);
        if (cfg.useNativeTools) {
          this.history.push({ role: 'tool', tool_call_id: call.id, content: capped });
        } else {
          this.history.push({ role: 'user', content: `Result of ${call.function.name}:\n${capped}` });
        }
      }
    }
    events.onToken(`\n\n_Stopped after ${cfg.maxAgentSteps} steps (codix.maxAgentSteps)._`);
  }
}

function parseTextToolCall(text: string): { call: ToolCall; before: string } | undefined {
  const m = /```tool\s*([\s\S]*?)```/.exec(text);
  if (!m) return undefined;
  try {
    const obj = JSON.parse(m[1].trim());
    return {
      call: { id: `text_${Date.now()}`, type: 'function', function: { name: obj.name, arguments: JSON.stringify(obj.arguments ?? {}) } },
      before: text.slice(0, m.index).trim()
    };
  } catch {
    return undefined;
  }
}
