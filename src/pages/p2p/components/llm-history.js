/**
 * <llm-history> – Reusable LLM history web component.
 *
 * Attributes:
 *   app-id   – filter entries by appId (e.g. "ai-chat", "p2pmd")
 *   limit    – max sessions to show (default 100)
 *   mode     – "sessions" (default) or "entries"
 *
 * Events:
 *   select-session  – detail: { sessionId, appId, entries[] }
 *   select-entry    – detail: { sessionId, entries[] }
 *
 * API:
 *   refresh()   – reload from llmMemory
 */

class LLMHistory extends HTMLElement {
  constructor() {
    super();
    this._sessions = [];
    this._entries = [];
    this._search = '';
    this._mode = 'sessions';
  }

  connectedCallback() {
    this._syncAttrs();
    this._render();
    this.refresh();
  }

  static get observedAttributes() { return ['app-id', 'limit', 'mode']; }

  attributeChangedCallback() {
    this._syncAttrs();
    this.refresh();
  }

  _syncAttrs() {
    this._appId = this.getAttribute('app-id') || null;
    this._limit = parseInt(this.getAttribute('limit') || '100', 10);
    this._mode = this.getAttribute('mode') || 'sessions';
  }

  async refresh() {
    if (!window.llmMemory) return;
    let enabled = false;
    try { enabled = await window.llmMemory.isEnabled(); } catch { /* ignore */ }
    if (!enabled) {
      this._showEmpty('Memory is disabled. Enable it in Settings \u2192 AI / LLMs.');
      return;
    }

    const opts = { limit: this._limit };
    if (this._appId) opts.appId = this._appId;

    if (this._mode === 'entries') {
      if (this._search) opts.search = this._search;
      try { this._entries = await window.llmMemory.list(opts); } catch { this._entries = []; }
      this._renderEntries();
    } else {
      try { this._sessions = await window.llmMemory.listSessions(opts); } catch { this._sessions = []; }
      this._renderSessions();
    }
  }

  _render() {
    this.textContent = '';
    const root = document.createElement('div');
    root.className = 'llm-history-root';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'llm-history-search-wrap';
    const input = document.createElement('input');
    input.className = 'llm-history-search';
    input.type = 'search';
    input.placeholder = 'Search history\u2026';
    input.addEventListener('input', () => {
      this._search = input.value.trim();
      this.refresh();
    });
    searchWrap.appendChild(input);

    const list = document.createElement('div');
    list.className = 'llm-history-list';

    root.append(searchWrap, list);
    this.appendChild(root);
    this._injectStyles();
  }

  _getList() {
    return this.querySelector('.llm-history-list');
  }

  _showEmpty(msg) {
    const list = this._getList();
    if (!list) return;
    list.textContent = '';
    const d = document.createElement('div');
    d.className = 'llm-history-empty';
    d.textContent = msg;
    list.appendChild(d);
  }

  _renderSessions() {
    const list = this._getList();
    if (!list) return;

    let sessions = this._sessions;
    if (this._search) {
      const q = this._search.toLowerCase();
      sessions = sessions.filter(s => (s.title || '').toLowerCase().includes(q));
    }

    if (!sessions.length) { this._showEmpty('No history yet.'); return; }

    list.textContent = '';
    for (const s of sessions) {
      const item = document.createElement('div');
      item.className = 'llm-history-item';
      item.dataset.sessionId = s.sessionId;
      item.dataset.appId = s.appId;
      item.title = s.title || '';

      const titleEl = document.createElement('div');
      titleEl.className = 'llm-history-title';
      titleEl.textContent = s.title || 'Untitled';

      const metaEl = document.createElement('div');
      metaEl.className = 'llm-history-meta';
      metaEl.textContent = s.appId + ' \u00B7 ' + s.messageCount + ' msg \u00B7 ' + _relTime(s.ts);

      item.append(titleEl, metaEl);
      item.addEventListener('click', async () => {
        list.querySelectorAll('.llm-history-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        let entries;
        try { entries = await window.llmMemory.list({ sessionId: s.sessionId }); } catch { entries = []; }
        this.dispatchEvent(new CustomEvent('select-session', {
          bubbles: true,
          detail: { sessionId: s.sessionId, appId: s.appId, entries }
        }));
      });
      list.appendChild(item);
    }
  }

  _renderEntries() {
    const list = this._getList();
    if (!list) return;

    if (!this._entries.length) { this._showEmpty('No history yet.'); return; }

    const seen = new Map();
    for (const e of [...this._entries].reverse()) {
      if (!seen.has(e.sessionId) && e.role === 'user') seen.set(e.sessionId, e);
    }
    const display = Array.from(seen.values());

    list.textContent = '';
    for (const e of display) {
      const item = document.createElement('div');
      item.className = 'llm-history-item';
      item.dataset.sessionId = e.sessionId;
      item.title = e.content || '';

      const titleEl = document.createElement('div');
      titleEl.className = 'llm-history-title';
      titleEl.textContent = e.content.slice(0, 80).replace(/\n/g, ' ');

      const metaEl = document.createElement('div');
      metaEl.className = 'llm-history-meta';
      metaEl.textContent = (e.model || '') + ' \u00B7 ' + _relTime(e.ts);

      item.append(titleEl, metaEl);
      item.addEventListener('click', async () => {
        list.querySelectorAll('.llm-history-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        let entries;
        try { entries = await window.llmMemory.list({ sessionId: e.sessionId }); } catch { entries = []; }
        this.dispatchEvent(new CustomEvent('select-entry', {
          bubbles: true,
          detail: { sessionId: e.sessionId, entries }
        }));
      });
      list.appendChild(item);
    }
  }

  _injectStyles() {
    const id = 'llm-history-styles';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      .llm-history-root { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
      .llm-history-search-wrap { padding: 8px; }
      .llm-history-search {
        width: 100%; box-sizing: border-box;
        padding: 6px 10px; border-radius: 6px;
        border: 1px solid var(--browser-theme-border, #333);
        background: var(--browser-theme-input-bg, #1e1e1e);
        color: var(--browser-theme-text, #fff);
        font-size: 13px;
      }
      .llm-history-list { flex: 1; overflow-y: auto; padding: 4px 0; }
      .llm-history-item {
        padding: 10px 12px; cursor: pointer; border-radius: 6px;
        margin: 2px 6px; transition: background 0.15s;
      }
      .llm-history-item:hover { background: var(--browser-theme-hover, rgba(255,255,255,0.07)); }
      .llm-history-item.active { background: var(--browser-theme-active, rgba(255,255,255,0.13)); }
      .llm-history-title {
        font-size: 13px; font-weight: 500;
        color: var(--browser-theme-text, #fff);
        overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
      }
      .llm-history-meta {
        font-size: 11px; color: var(--browser-theme-text-muted, #888);
        margin-top: 2px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
      }
      .llm-history-empty {
        padding: 16px 12px; font-size: 13px;
        color: var(--browser-theme-text-muted, #888); text-align: center;
      }
    `;
    document.head.appendChild(style);
  }
}

function _relTime(ts) {
  if (!ts) return '';
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

customElements.define('llm-history', LLMHistory);
