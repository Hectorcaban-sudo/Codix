# Codix

Codix is a Continue-style AI coding agent for VS Code that **reads your whole solution**, talks to an **internal OpenAI-compatible server**, and supports **custom headers + client certificates (mTLS)** for authentication.

## What it does

- **Whole-solution awareness.** On startup it indexes every text file in the workspace (respecting `.gitignore` and exclude globs), parses `.sln` / `.csproj` / `package.json` etc. to understand project structure, and keeps the index live with a file watcher.
  - If the solution fits in the model's context budget, **every file is sent in full** with each request.
  - If it's bigger, the most relevant files (open editors, project/config files, files matching the question) are loaded in full, and the agent reaches the rest with `search_code` / `read_file`. The chat shows which mode is active.
- **Agent loop with tools:** `list_files`, `read_file`, `search_code`, `edit_file` (exact snippet replace), `write_file`, `get_diagnostics` (VS Code Problems), and optionally `run_command` (e.g. `dotnet build`).
- **Safe edits.** Every change opens a diff (current ↔ proposed) and waits for Accept / Reject, unless `autoApplyEdits` is on.
- Sidebar chat with streaming, Stop button, code blocks with Copy / Insert, and **Ask About Selection** (`Ctrl+Shift+L`).

## Install

```bash
npm install
npm run compile
npm run package          # produces codix-0.3.0.vsix
code --install-extension codix-0.3.0.vsix
```

Or open the folder in VS Code and press **F5** to run it in an Extension Development Host.

## Configure your internal server

Add to your **User** `settings.json` (Ctrl+Shift+P → *Preferences: Open User Settings (JSON)*):

```jsonc
{
  "codix.apiBase": "https://llm.internal.company.com/v1",
  "codix.model": "gpt-4o",
  "codix.contextWindowTokens": 128000,

  "codix.requestOptions": {
    "headers": {
      "X-Api-Gateway-Key": "${env:LLM_GATEWAY_KEY}",
      "X-Client-Id": "vscode-codix"
    },
    "caBundlePath": "C:/certs/company-root-ca.pem",
    "clientCertificate": {
      "cert": "C:/certs/me.crt.pem",
      "key": "C:/certs/me.key.pem",
      "passphrase": "${env:LLM_CERT_PASSPHRASE}"
    },
    "verifySsl": true
  }
}
```

Then run **Codix: Set API Key** if your server also uses a bearer token (stored in VS Code SecretStorage, sent as `Authorization: Bearer <key>`), and **Codix: Test Connection**.

### Options (mirrors Continue's `requestOptions`)

| Setting | Purpose |
|---|---|
| `requestOptions.headers` | Any custom headers. Values support `${env:VAR}`, `${secret:apiKey}`, `${workspaceFolder}`. |
| `requestOptions.caBundlePath` | Internal CA `.pem` (string or array). Added on top of the normal root CAs. |
| `requestOptions.clientCertificate.cert` / `.key` | Client certificate and private key (PEM paths, or the PEM text inline). |
| `requestOptions.clientCertificate.passphrase` | Passphrase for an encrypted key. |
| `requestOptions.pfxPath` / `pfxPassphrase` | Use a `.pfx` / `.p12` instead of PEM cert+key. |
| `requestOptions.verifySsl` | Keep `true`. Only disable temporarily for troubleshooting. |
| `requestOptions.proxy` | HTTPS proxy URL (falls back to `HTTPS_PROXY`). |
| `requestOptions.timeoutMs` | Request timeout. |
| `authHeaderName` / `authHeaderPrefix` | Change how the stored key is sent (e.g. `api-key` with empty prefix for Azure-style gateways). Set name to `""` to send no key. |

**Coming from Continue?** Your `config.yaml` `requestOptions` map directly:
`headers` → `headers`, `caBundlePath` → `caBundlePath`, `clientCertificate.cert/key/passphrase` → same names.

**Windows cert store only (.pfx):** export it with *certmgr → Export → Yes, export the private key → .PFX*, then set `pfxPath`.
**Convert PFX to PEM:** `openssl pkcs12 -in me.pfx -out me.crt.pem -clcerts -nokeys` and `openssl pkcs12 -in me.pfx -out me.key.pem -nocerts`.

## MCP servers

The agent is an MCP client. Tools from connected servers are offered to the model next to the built-in ones (shown in chat as `tool (MCP: server)`). Resources can be listed and read by the agent, and prompts can be inserted into the chat.

Supported transports: **stdio**, **Streamable HTTP**, and legacy **SSE** (tried automatically if Streamable HTTP fails).

### Configure in settings

```jsonc
"codix.mcpServers": [
  // Local stdio server
  {
    "name": "filesystem-docs",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}/docs"]
  },
  // Stdio server with a secret from the environment
  {
    "name": "jira",
    "command": "uvx",
    "args": ["mcp-atlassian"],
    "env": { "JIRA_URL": "https://jira.internal", "JIRA_API_TOKEN": "${env:JIRA_TOKEN}" },
    "autoApprove": ["jira_get_issue", "jira_search"]
  },
  // Internal remote server: custom header + client certificate, same as the LLM server
  {
    "name": "internal-tools",
    "url": "https://mcp.internal.company.com/mcp",
    "headers": { "X-Api-Gateway-Key": "${input:gatewayKey}" },
    "requestOptions": {
      "caBundlePath": "C:/certs/company-root-ca.pem",
      "clientCertificate": { "cert": "C:/certs/me.crt.pem", "key": "C:/certs/me.key.pem", "passphrase": "${env:LLM_CERT_PASS}" }
    }
  },
  // Or reuse codix.requestOptions (headers + certs) as-is
  { "name": "internal-search", "url": "https://search-mcp.internal/mcp", "useGlobalRequestOptions": true }
]
```

| Field | Meaning |
|---|---|
| `command`, `args`, `env`, `cwd` | stdio server. `env` is added to your normal environment. |
| `url`, `type` | Remote server. `type` is `streamable-http` (default) or `sse`. |
| `headers` | Extra HTTP headers for remote servers. |
| `requestOptions` | `caBundlePath`, `clientCertificate`, `pfxPath`, `verifySsl`, `proxy`, `headers` — same as the LLM settings. |
| `useGlobalRequestOptions` | Send the LLM server's headers + certs to this server too. Off by default so gateway keys aren't sent to other servers. |
| `autoApprove` | `true`, or a list of tool names that run without asking. |
| `disabled`, `timeoutMs` | Self-explanatory. |

Values support `${env:VAR}`, `${workspaceFolder}`, and `${input:id}`. `${input:id}` asks you once and stores the value in VS Code SecretStorage.

### Workspace config files

In trusted workspaces the extension also reads **`.vscode/mcp.json`** (VS Code format, `{"servers": {...}}`) and **`.continue/mcpServers/*.json`** (Continue / Claude Desktop format, `{"mcpServers": {...}}`), so existing configs work unchanged. You're asked once before a workspace's servers start, and again whenever the file changes. Turn off with `codix.mcpLoadWorkspaceConfigs`.

### Approvals and UI

- `codix.mcpToolApproval`: `ask` (default) shows each call's arguments with **Allow** / **Allow for this session**; `auto` never asks.
- Chat toolbar: **⚡** shows server status (restart a server, reconnect all, open the log); **/** inserts an MCP prompt.
- Commands: *Show MCP Servers*, *Reconnect MCP Servers*, *Insert MCP Prompt*. Server stderr and calls are logged in the **Codix MCP** output channel.

## Other settings

| Setting | Default | Notes |
|---|---|---|
| `contextWindowTokens` | 128000 | Set to your model's real window. |
| `solutionContextBudget` | 0.6 | Share of the window used to preload source files. |
| `includeGlobs` / `excludeGlobs` | all / bin, obj, node_modules… | What gets indexed. |
| `maxFileSizeKb` | 256 | Bigger files are listed but not loaded. |
| `autoApplyEdits` | false | Skip the diff approval. |
| `allowTerminalCommands` | false | Enables `run_command` (still asks each time). |
| `useNativeTools` | true | Turn off if your server/model doesn't support OpenAI `tools`; a text-based tool protocol is used instead. |
| `systemPromptExtra` | "" | Team conventions to add to every request. |


## Chat sessions and models

- **New Chat** (`codix.newChat`) always registers, even if MCP setup fails, so the title-bar + button should not show "command not found".
- Chats persist across reloads (up to 50). Use the ☰ toolbar button or **Codix: Chat History**.
- **Codix: Select Model** lists `/v1/models` on your server and writes `codix.model`.
- **Codix: Set PFX Passphrase** stores the passphrase in SecretStorage. Reference it as `${secret:pfxPassphrase}` in `requestOptions`.

## Troubleshooting

| Error | Fix |
|---|---|
| `unable to get local issuer certificate` / `self-signed certificate in chain` | Set `caBundlePath` to the company root CA. |
| `certificate required` / `ECONNRESET` / `EPROTO` | Server wants a client cert: set `clientCertificate` or `pfxPath`. |
| `bad decrypt` | Wrong key/PFX passphrase. |
| HTTP 401/403 | Check header names/values; confirm `${env:…}` variables exist in the environment VS Code was launched from. |
| HTTP 400 mentioning `tools` | Set `useNativeTools` to `false`. |
| `command 'codix.newChat' not found` | Extension did not activate. Run `npm run compile`, then F5. Check Help → Toggle Developer Tools for the activation exception. |

## Project layout

```
src/
  extension.ts        activation, commands
  config.ts           settings + ${env:} interpolation
  llmClient.ts        OpenAI-compatible streaming client (custom headers, CA, mTLS, proxy)
  indexer.ts          whole-solution index, .sln parsing, relevance packing, search
  tools.ts            agent tools + diff-approval for edits
  mcpManager.ts       MCP client: stdio / Streamable HTTP / SSE, tools, resources, prompts, approvals
  tls.ts              shared header + CA + client-certificate handling
  agent.ts            tool-calling loop, context/history budgeting
  chatViewProvider.ts sidebar webview bridge
  sessionStore.ts      persisted chat threads
media/                webview UI (main.js, main.css, icon.svg)
```
