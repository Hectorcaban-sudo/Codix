export type MentionKind = 'workspace' | 'file' | 'folder' | 'selection';

export interface Mention {
  kind: MentionKind;
  /** Workspace-relative path for file/folder mentions. */
  path?: string;
  raw: string;
}

const TOKEN = /@(workspace|file|folder|selection)(?::([^\s]+))?/gi;

export function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  let m: RegExpExecArray | null;
  const rx = new RegExp(TOKEN.source, TOKEN.flags);
  while ((m = rx.exec(text))) {
    out.push({
      kind: m[1].toLowerCase() as MentionKind,
      path: m[2]?.replace(/\\/g, '/').replace(/^\/+/, ''),
      raw: m[0]
    });
  }
  return out;
}

export function mentionLabel(m: Mention): string {
  if (m.kind === 'workspace') return '@workspace';
  if (m.kind === 'selection') return '@selection';
  return m.path ? `@${m.kind}:${m.path}` : `@${m.kind}`;
}
