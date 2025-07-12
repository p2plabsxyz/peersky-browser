class BookmarkBox extends HTMLElement {
  constructor() {
    super();
    this.checkApiSupport();
    this.attachShadow({ mode: "open" });
    this.render();
    this.loadBookmarks();
  }
  checkApiSupport() {
    if (
      !window.electronAPI ||
      !window.electronAPI.getBookmarks ||
      !window.electronAPI.deleteBookmark
    ) {
      console.error("Bookmark API is not supported in this environment.");
      this.shadowRoot.innerHTML =
        "<p>Error: Bookmark API is not available.</p>";
      return;
    }
  }

  async loadBookmarks() {
    const bookmarks = await window.electronAPI.getBookmarks();
    this.displayBookmarks(bookmarks);
  }

  displayBookmarks(bookmarks) {
    const container = this.shadowRoot.querySelector(".bookmarks-container");
    container.innerHTML = "";

    if (!bookmarks || bookmarks.length === 0) {
      container.innerHTML = "<p>No bookmarks saved yet.</p>";
      return;
    }
    bookmarks.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));

    bookmarks.forEach((bookmark) => {
      const bookmarkElement = document.createElement("div");
      bookmarkElement.className = "bookmark-item";
      bookmarkElement.innerHTML = `
        <a href="${bookmark.url}" class="bookmark-link" title="${bookmark.url}">
          <img src="${
            bookmark.favicon || "peersky://static/assets/svg/favicon.svg"
          }" alt="favicon" class="favicon">
          <span class="title">${bookmark.title}</span>
        </a>
        <button class="delete-btn" data-url="${bookmark.url}">×</button>
      `;
      container.appendChild(bookmarkElement);
    });

    this.attachDeleteListeners();
  }

  attachDeleteListeners() {
    this.shadowRoot.querySelectorAll(".delete-btn").forEach((button) => {
      button.addEventListener("click", async (event) => {
        const urlToDelete = event.target.dataset.url;
        const success = await window.electronAPI.deleteBookmark(urlToDelete);
        if (success) {
          this.loadBookmarks();
        }
      });
    });
  }

  render() {
    this.shadowRoot.innerHTML = `
    <style>
      :host {
        --bg-color: var(--browser-theme-background, #18181b);
        --item-hover-bg: #27272a;
        --text-color: var(--browser-theme-text-color, #ffffff);
        --border-color: #2e2e30;
        --icon-size: 20px;
        --btn-color: #9ca3af;
        --btn-hover-color: #e5e7eb;
      }
    
      .bookmarks-container {
        background-color: var(--bg-color);
        color: var(--text-color);
        padding: 1rem 1.5rem;
        max-width: 720px;
        margin: 2rem auto;
        border-radius: 8px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
        font-family: var(--browser-theme-font-family, sans-serif);
      }

      h1 {
        font-size: 1.25rem;
        margin-bottom: 1rem;
        border-bottom: 1px solid var(--border-color);
        padding-bottom: 0.5rem;
      }

      .bookmark-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.75rem 0.5rem;
        border-bottom: 1px solid var(--border-color);
        transition: background 0.2s;
      }

      .bookmark-item:hover {
        background-color: var(--item-hover-bg);
        border-radius: 6px;
      }

      .bookmark-link {
        display: flex;
        align-items: center;
        text-decoration: none;
        color: var(--text-color);
        flex-grow: 1;
        overflow: hidden;
      }

      .favicon {
        width: var(--icon-size);
        height: var(--icon-size);
        margin-right: 0.75rem;
        flex-shrink: 0;
        border-radius: 3px;
      }

      .title {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 0.95rem;
      }

      .delete-btn {
        background: transparent;
        border: none;
        color: var(--btn-color);
        cursor: pointer;
        font-size: 1.25rem;
        padding: 0 0.5rem;
        transition: color 0.2s;
      }

      .delete-btn:hover {
        color: var(--btn-hover-color);
      }
    </style>

    <div class="bookmarks-container">
      <h1>Bookmarks</h1>
    </div>
  `;
  }
}

customElements.define("bookmark-box", BookmarkBox);
