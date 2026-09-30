import * as vscode from 'vscode';
import { ChatMessage } from './llmClient';

export interface StoredSession {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
}

const KEY = 'codix.sessions.v1';
const ACTIVE = 'codix.activeSession';

export class SessionStore {
  constructor(private ctx: vscode.ExtensionContext) {}

  list(): StoredSession[] {
    return (this.ctx.globalState.get<StoredSession[]>(KEY) ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  activeId(): string | undefined {
    return this.ctx.globalState.get<string>(ACTIVE);
  }

  get(id: string): StoredSession | undefined {
    return this.list().find((s) => s.id === id);
  }

  async save(session: StoredSession) {
    const all = this.list().filter((s) => s.id !== session.id);
    all.unshift(session);
    await this.ctx.globalState.update(KEY, all.slice(0, 50));
    await this.ctx.globalState.update(ACTIVE, session.id);
  }

  async create(title = 'New chat'): Promise<StoredSession> {
    const session: StoredSession = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      updatedAt: Date.now(),
      messages: []
    };
    await this.save(session);
    return session;
  }

  async remove(id: string) {
    await this.ctx.globalState.update(KEY, this.list().filter((s) => s.id !== id));
    if (this.activeId() === id) await this.ctx.globalState.update(ACTIVE, undefined);
  }
}
