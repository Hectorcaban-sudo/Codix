(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messages = $('messages');
  const input = $('input');
  const sendBtn = $('send');
  let busy = false;
  let current = null;   // { el, text, bodyEl }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<em>$2</em>')
      .replace(/@(workspace|file|folder|selection)(?::[^\s]+)?/g, '<span class="mention">$&</span>');
  }

  // Small markdown renderer: fenced code, headings, lists, paragraphs.
  function render(md) {
    const out = [];
    const parts = md.split(/(```[\s\S]*?(?:```|$))/g);
    for (const part of parts) {
      if (part.startsWith('```')) {
        const m = /^```(\S*)\n?([\s\S]*?)(?:```)?$/.exec(part);
        const lang = m ? m[1] : '';
        const code = m ? m[2] : part.slice(3);
        out.push(
          `<div class="code"><div class="codebar"><span>${esc(lang)}</span><span>` +
          `<button data-act="copy">Copy</button><button data-act="insert">Insert</button></span></div>` +
          `<pre><code>${esc(code)}</code></pre></div>`
        );
        continue;
      }
      const lines = part.split('\n');
      let list = null;
      let para = [];
      const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
      const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
      for (const line of lines) {
        let m;
        if ((m = /^(#{1,4})\s+(.*)/.exec(line))) { flushPara(); flushList(); out.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`); }
        else if ((m = /^\s*[-*]\s+(.*)/.exec(line))) { flushPara(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); }
        else if ((m = /^\s*\d+[.)]\s+(.*)/.exec(line))) { flushPara(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); }
        else if (!line.trim()) { flushPara(); flushList(); }
        else { flushList(); para.push(line); }
      }
      flushPara(); flushList();
    }
    return out.join('');
  }

  function scroll() { messages.scrollTop = messages.scrollHeight; }

  function clearEmpty() { const e = messages.querySelector('.empty'); if (e) e.remove(); }

  function addUser(text) {
    clearEmpty();
    const el = document.createElement('div');
    el.className = 'msg user';
    el.innerHTML = render(text);
    messages.appendChild(el);
    scroll();
  }

  function startAssistant() {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = '<div class="ctx"></div><div class="body"><span class="thinking">Thinking…</span></div>';
    messages.appendChild(el);
    current = { el, text: '', bodyEl: el.querySelector('.body'), segStart: 0 };
    scroll();
  }

  function newTextSegment() {
    const seg = document.createElement('div');
    seg.className = 'body';
    current.el.appendChild(seg);
    current.bodyEl = seg;
    current.text = '';
  }

  function setBusy(b) {
    busy = b;
    sendBtn.textContent = b ? 'Stop' : 'Send';
    sendBtn.classList.toggle('stop', b);
  }

  function send() {
    if (busy) { vscode.postMessage({ type: 'stop' }); return; }
    hideMentions();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    vscode.postMessage({ type: 'send', text });
  }

  const mentionBox = $('mentions');
  let mentionState = null; // { start, end }
  let mentionItems = [];
  let mentionIdx = 0;

  function hideMentions() {
    if (mentionBox) { mentionBox.hidden = true; mentionBox.innerHTML = ''; }
    mentionState = null;
    mentionItems = [];
  }

  function renderMentions() {
    if (!mentionBox) return;
    if (!mentionItems.length) { hideMentions(); return; }
    mentionBox.hidden = false;
    mentionBox.innerHTML = mentionItems.map((it, i) =>
      `<button type="button" class="mention-item${i === mentionIdx ? ' active' : ''}" data-i="${i}"><strong>${esc(it.label)}</strong><span>${esc(it.detail || '')}</span></button>`
    ).join('');
  }

  function insertAt(start, end, text) {
    const v = input.value;
    input.value = v.slice(0, start) + text + v.slice(end);
    const pos = start + text.length;
    input.setSelectionRange(pos, pos);
    input.focus();
  }

  function applyMention(item) {
    if (!mentionState || !item) return;
    insertAt(mentionState.start, mentionState.end, item.insert + ' ');
    hideMentions();
  }

  function currentMention() {
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const m = /(^|\s)@([A-Za-z0-9_:\-./]*)$/.exec(before);
    if (!m) return null;
    const token = m[2];
    const start = pos - token.length - 1;
    const colon = token.indexOf(':');
    const prefix = (colon >= 0 ? token.slice(0, colon) : token).toLowerCase();
    const filter = colon >= 0 ? token.slice(colon + 1) : token;
    return { start, end: pos, prefix, filter, token };
  }

  function queryMentions() {
    const cur = currentMention();
    if (!cur) { hideMentions(); return; }
    mentionState = { start: cur.start, end: cur.end };
    vscode.postMessage({ type: 'mentionQuery', prefix: cur.prefix, filter: cur.filter });
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (mentionState && mentionItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mentionIdx = (mentionIdx + 1) % mentionItems.length; renderMentions(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); mentionIdx = (mentionIdx - 1 + mentionItems.length) % mentionItems.length; renderMentions(); return; }
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); applyMention(mentionItems[mentionIdx]); return; }
      if (e.key === 'Escape') { hideMentions(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', queryMentions);
  if (mentionBox) {
    mentionBox.addEventListener('mousedown', (e) => {
      const btn = e.target.closest('[data-i]');
      if (!btn) return;
      e.preventDefault();
      applyMention(mentionItems[Number(btn.dataset.i)]);
    });
  }
  $('new').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
  const hist = $('history'); if (hist) hist.addEventListener('click', () => vscode.postMessage({ type: 'history' }));
  const mentionBtn = $('mention'); if (mentionBtn) mentionBtn.addEventListener('click', () => {
    insertAt(input.selectionStart, input.selectionEnd, '@');
    queryMentions();
  });
  $('mcp').addEventListener('click', () => vscode.postMessage({ type: 'mcp' }));
  $('mcpPrompt').addEventListener('click', () => vscode.postMessage({ type: 'mcpPrompt' }));
  $('reindex').addEventListener('click', () => vscode.postMessage({ type: 'reindex' }));

  messages.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const code = btn.closest('.code').querySelector('code').textContent;
    vscode.postMessage({ type: btn.dataset.act, code });
    if (btn.dataset.act === 'copy') { btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = 'Copy'), 1200); }
  });

  window.addEventListener('message', ({ data: m }) => {
    switch (m.type) {
      case 'status': $('status').textContent = m.text; break;
      case 'clear': messages.innerHTML = '<div class="empty">New chat. Ask anything about your solution.</div>'; setBusy(false); break;
      case 'restore':
        messages.innerHTML = '';
        setBusy(false);
        for (const item of m.messages || []) {
          if (item.role === 'user') addUser(item.text);
          else { startAssistant(); current.text = item.text || ''; current.bodyEl.innerHTML = render(current.text); current = null; }
        }
        if (!messages.children.length) messages.innerHTML = '<div class="empty">Empty chat.</div>';
        break;
      case 'prefill': input.value = m.text; input.focus(); break;
      case 'insertMention':
        insertAt(input.selectionStart, input.selectionEnd, m.text);
        break;
      case 'mentionSuggestions':
        mentionItems = m.items || [];
        mentionIdx = 0;
        renderMentions();
        break;
      case 'user': addUser(m.text); break;
      case 'assistantStart': setBusy(true); startAssistant(); break;
      case 'contextInfo': if (current) current.el.querySelector('.ctx').textContent = m.text; break;
      case 'token':
        if (!current) break;
        current.text += m.text;
        current.bodyEl.innerHTML = render(current.text);
        scroll();
        break;
      case 'toolStart': {
        if (!current) break;
        if (!current.text) current.bodyEl.remove();
        const t = document.createElement('details');
        t.className = 'tool running';
        t.innerHTML = `<summary>⚙ ${esc(m.name)} <span class="arg">${esc(m.args || '')}</span></summary><pre></pre>`;
        current.el.appendChild(t);
        current.lastTool = t;
        scroll();
        break;
      }
      case 'toolEnd':
        if (current && current.lastTool) {
          current.lastTool.classList.remove('running');
          current.lastTool.querySelector('pre').textContent = m.result;
          newTextSegment();
        }
        break;
      case 'error': {
        const el = document.createElement('div');
        el.className = 'msg error';
        el.textContent = m.text;
        messages.appendChild(el);
        scroll();
        break;
      }
      case 'assistantEnd':
        setBusy(false);
        if (current) {
          current.el.querySelectorAll('.body').forEach((b) => { if (!b.textContent.trim() || b.querySelector('.thinking')) b.remove(); });
        }
        current = null;
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
