class PaginationControl extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.data = [];
    this.searchKeys = [];
    this.currentPage = 1;
    this.itemsPerPage = 10;
    this.renderWrapper = (html) => html;
    this.renderItem = () => '';
    this.emptyMessage = '<p class="archive-empty">Loading…</p>';
    this.onRendered = null;
    this.searchQuery = '';
    this.filteredData = [];
    this.renderContainer();
  }

  renderContainer() {
    const style = document.createElement('style');
    style.textContent = `
      :host {
        display: block;
        width: 100%;
        outline: none !important;
        box-shadow: none !important;
      }
      :host(:focus-within) {
        outline: none !important;
        box-shadow: none !important;
      }

      /* ── Search input ─────────────────────────────────────────── */
      .pagination-header {
        margin-bottom: 10px;
      }
      .search-input {
        padding: 5px 10px;
        min-width: 220px;
        border: 1px solid var(--settings-border);
        border-radius: 5px;
        background: var(--settings-bg-primary);
        color: var(--settings-text-primary);
        font-size: 13px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        outline: none;
        transition: border-color 0.2s ease, box-shadow 0.2s ease;
        box-sizing: border-box;
      }
      .search-input:focus {
        border-color: var(--settings-border-focus);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--settings-border-focus) 20%, transparent);
      }
      .search-input::placeholder {
        color: var(--settings-text-secondary);
        opacity: 0.6;
      }

      /* ── Content area ─────────────────────────────────────────── */
      .content-area {
        width: 100%;
        overflow-x: auto;
      }

      /* ── Table — mirrors the .archive-table rules from settings.css ── */
      .content-area table {
        width: 100%;
        border-collapse: collapse;
        background: var(--settings-card-bg);
        border: 1px solid var(--settings-border);
        border-radius: 8px;
        overflow: hidden;
        table-layout: fixed;
        font-size: 0.9rem;
      }
      .content-area thead tr {
        border-bottom: 1px solid var(--settings-border);
      }
      .content-area th {
        padding: 8px 12px;
        text-align: left;
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--settings-text-secondary);
        letter-spacing: 0.04em;
        text-transform: uppercase;
        overflow-wrap: break-word;
      }
      .content-area tbody tr {
        border-bottom: 1px solid var(--settings-border);
        transition: background 0.12s ease;
      }
      .content-area tbody tr:last-child {
        border-bottom: none;
      }
      .content-area tbody tr:hover {
        background: color-mix(in srgb, var(--settings-border) 18%, transparent);
      }
      .content-area td {
        padding: 10px 12px;
        color: var(--settings-text-primary);
        font-size: 0.87rem;
        vertical-align: middle;
        overflow-wrap: break-word;
      }
      .content-area td:last-child {
        white-space: nowrap;
      }

      /* Hash/CID columns */
      .content-area .archive-hash {
        font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
        font-size: 0.83rem;
        color: var(--browser-theme-primary-highlight);
        font-weight: 400;
      }

      /* ── Action buttons (copy/open) ───────────────────────────── */
      /* 
         SVG icons in <img src="peersky://..."> are inherently black silhouettes.
         We use --pagination-icon-filter (defined per-theme in themes.css) to
         make them visible in the current theme. This var inherits through shadow DOM.
         Dark themes: invert to white. Light/coloured themes: darken to theme text colour.
      */
      .content-area .archive-action-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 3px;
        margin-right: 8px;
        background: none !important;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        text-decoration: none;
        color: var(--settings-text-primary);
        transition: background 0.15s ease;
      }
      .content-area .archive-action-btn:last-child {
        margin-right: 0;
      }
      .content-area .archive-action-btn:hover {
        background: color-mix(in srgb, var(--settings-border) 30%, transparent) !important;
      }
      .content-area .archive-action-btn img {
        width: 14px;
        height: 14px;
        display: block;
        opacity: 0.7;
        filter: var(--pagination-icon-filter, invert(1) brightness(0.85));
        transition: opacity 0.2s ease, filter 0.2s ease;
      }
      .content-area .archive-action-btn:hover img {
        opacity: 1;
        filter: var(--pagination-icon-filter-hover, invert(1) brightness(1.2));
      }

      /* ── Pagination controls bar ──────────────────────────────── */
      .pagination-controls {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 5px;
        margin-top: 12px;
        flex-wrap: wrap;
      }
      .pagination-btn {
        height: 26px;
        padding: 0 10px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: var(--settings-card-bg);
        border: 1px solid var(--settings-border);
        border-radius: 4px;
        cursor: pointer;
        color: var(--settings-text-primary);
        font-size: 12px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        transition: background 0.15s ease, border-color 0.15s ease;
        line-height: 1;
        box-sizing: border-box;
      }
      .pagination-btn:hover:not(:disabled) {
        background: color-mix(in srgb, var(--settings-border) 35%, var(--settings-card-bg));
        border-color: var(--settings-border-hover);
      }
      .pagination-btn:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
      .pagination-btn.active {
        background: var(--browser-theme-primary-highlight);
        color: var(--settings-card-bg);
        border-color: var(--browser-theme-primary-highlight);
        font-weight: 600;
      }
      .pagination-ellipsis {
        color: var(--settings-text-secondary);
        font-size: 12px;
        padding: 0 2px;
      }
      .pagination-info {
        font-size: 12px;
        color: var(--settings-text-secondary);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        margin-left: 4px;
      }
      /* Arrow Prev/Next buttons — same height, narrower horizontal padding */
      .pagination-btn-arrow {
        padding: 0 7px;
      }
      .arrow-icon {
        display: block;
        width: 13px;
        height: 13px;
        opacity: 0.75;
        filter: var(--pagination-icon-filter, invert(1) brightness(0.85));
        transition: opacity 0.15s ease, filter 0.15s ease;
      }
      .pagination-btn-arrow:hover:not(:disabled) .arrow-icon {
        opacity: 1;
        filter: var(--pagination-icon-filter-hover, invert(1) brightness(1.2));
      }
      .pagination-btn-arrow:disabled .arrow-icon {
        opacity: 0.3;
      }

      /* ── Empty / error states ─────────────────────────────────── */
      .content-area .archive-empty {
        color: var(--settings-text-secondary);
        font-size: 0.85rem;
        padding: 1rem;
        text-align: center;
        background: var(--settings-card-bg);
        border: 1px solid var(--settings-border);
        border-radius: 8px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .content-area .archive-empty.error {
        color: var(--settings-danger-color, #ef4444);
      }
    `;

    this.shadowRoot.innerHTML = '';
    this.shadowRoot.appendChild(style);

    const wrapper = document.createElement('div');

    // ── Search header
    this.headerEl = document.createElement('div');
    this.headerEl.className = 'pagination-header';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'search-input';
    const searchPlaceholder = this.getAttribute('search-placeholder') || 'Search...';
    searchInput.placeholder = searchPlaceholder;
    searchInput.setAttribute('aria-label', searchPlaceholder);
    searchInput.addEventListener('input', (e) => {
      this.searchQuery = e.target.value.toLowerCase();
      this.currentPage = 1;
      this.applyFilter();
    });
    this.headerEl.appendChild(searchInput);
    wrapper.appendChild(this.headerEl);

    // ── Content
    this.contentArea = document.createElement('div');
    this.contentArea.className = 'content-area';
    wrapper.appendChild(this.contentArea);

    // ── Pagination controls
    this.controlsArea = document.createElement('div');
    this.controlsArea.className = 'pagination-controls';
    wrapper.appendChild(this.controlsArea);

    this.shadowRoot.appendChild(wrapper);
    this.applyFilter();
  }

  setup({ data, searchKeys, renderWrapper, renderItem, emptyMessage, onRendered }) {
    this.data = data || [];
    this.searchKeys = searchKeys || [];
    this.renderWrapper = renderWrapper || ((html) => html);
    this.renderItem = renderItem || (() => '');
    this.emptyMessage = emptyMessage || '<p class="archive-empty">No items found.</p>';
    this.onRendered = onRendered || null;
    this.currentPage = 1;
    this.applyFilter();
  }

  applyFilter() {
    if (!this.searchQuery) {
      this.filteredData = this.data;
    } else {
      this.filteredData = this.data.filter(item =>
        this.searchKeys.some(key => {
          const val = item[key];
          return val != null && String(val).toLowerCase().includes(this.searchQuery);
        })
      );
    }
    this.renderPage();
  }

  renderPage() {
    const totalPages = Math.max(1, Math.ceil(this.filteredData.length / this.itemsPerPage));
    if (this.currentPage > totalPages) this.currentPage = totalPages;

    const startIdx = (this.currentPage - 1) * this.itemsPerPage;
    const currentItems = this.filteredData.slice(startIdx, startIdx + this.itemsPerPage);

    if (currentItems.length === 0) {
      this.contentArea.innerHTML = this.emptyMessage;
    } else {
      this.contentArea.innerHTML = this.renderWrapper(currentItems.map(this.renderItem).join(''));
    }

    this.renderControls(totalPages);

    if (this.headerEl) {
      this.headerEl.style.display = this.data.length > this.itemsPerPage ? '' : 'none';
    }

    if (this.onRendered) {
      setTimeout(() => this.onRendered(this.contentArea), 0);
    }
  }

  renderControls(totalPages) {
    this.controlsArea.innerHTML = '';
    if (totalPages <= 1) return;

    const addDots = () => {
      const s = document.createElement('span');
      s.className = 'pagination-ellipsis';
      s.textContent = '…';
      this.controlsArea.appendChild(s);
    };

    const addPageBtn = (n) => {
      const btn = document.createElement('button');
      btn.className = `pagination-btn${n === this.currentPage ? ' active' : ''}`;
      btn.textContent = n;
      btn.addEventListener('click', () => { this.currentPage = n; this.renderPage(); });
      this.controlsArea.appendChild(btn);
    };

    // Prev
    const prev = document.createElement('button');
    prev.className = 'pagination-btn pagination-btn-arrow';
    prev.title = 'Previous page';
    prev.disabled = this.currentPage === 1;
    prev.innerHTML = '<img src="peersky://static/assets/svg/chevron-left.svg" width="13" height="13" alt="Prev" class="arrow-icon">';
    prev.addEventListener('click', () => { this.currentPage--; this.renderPage(); });
    this.controlsArea.appendChild(prev);

    // Page numbers with smart ellipsis
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) addPageBtn(i);
    } else {
      addPageBtn(1);
      if (this.currentPage > 3) addDots();
      const start = Math.max(2, this.currentPage - 1);
      const end = Math.min(totalPages - 1, this.currentPage + 1);
      for (let i = start; i <= end; i++) addPageBtn(i);
      if (this.currentPage < totalPages - 2) addDots();
      addPageBtn(totalPages);
    }

    // Next
    const next = document.createElement('button');
    next.className = 'pagination-btn pagination-btn-arrow';
    next.title = 'Next page';
    next.disabled = this.currentPage === totalPages;
    next.innerHTML = '<img src="peersky://static/assets/svg/chevron-right.svg" width="13" height="13" alt="Next" class="arrow-icon">';
    next.addEventListener('click', () => { this.currentPage++; this.renderPage(); });
    this.controlsArea.appendChild(next);

    const info = document.createElement('span');
    info.className = 'pagination-info';
    info.textContent = `(${this.filteredData.length} total)`;
    this.controlsArea.appendChild(info);
  }
}

customElements.define('pagination-control', PaginationControl);
