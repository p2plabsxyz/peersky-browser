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
      // Helper function to escape HTML
      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }
      
      function escapeHtmlAttribute(text) {
        return text
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#x27;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      bookmarkElement.innerHTML = `
        <a href="${escapeHtmlAttribute(bookmark.url)}" class="bookmark-link" title="${escapeHtmlAttribute(bookmark.url)}">
          <img src="${escapeHtmlAttribute(
            bookmark.favicon || "peersky://static/assets/svg/favicon.svg"
          )}" alt="favicon" class="favicon">
          <span class="title">${escapeHtml(bookmark.title)}</span>
        </a>
        <button class="delete-btn" data-url="${escapeHtmlAttribute(bookmark.url)}">×</button>
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
    const link = document.createElement("link");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("href", "peersky://theme/bookmarks.css");

    const container = document.createElement("div");
    container.className = "bookmarks-container";
    container.innerHTML = `<h1>Bookmarks</h1>`;

    this.shadowRoot.innerHTML = ""; // Clear previous content
    this.shadowRoot.appendChild(link);
    this.shadowRoot.appendChild(container);
  }
}

customElements.define("bookmark-box", BookmarkBox);
