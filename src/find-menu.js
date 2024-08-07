class FindMenu extends HTMLElement {
  constructor() {
    super();

    this.currentSearchValue = '';

    this.addEventListener('keydown', ({ key }) => {
      if (key === 'Escape') this.hide();
    });
  }

  async connectedCallback() {
    this.innerHTML = `
      <input class="find-menu-input" title="Enter text to find in page" />
      <button class="find-menu-button find-menu-previous" title="Find previous item"></button>
      <button class="find-menu-button find-menu-next" title="Find next item"></button>
      <button class="find-menu-button find-menu-hide" title="Hide find menu"></button>
    `;

    this.input = this.querySelector('.find-menu-input');
    this.previousButton = this.querySelector('.find-menu-previous');
    this.nextButton = this.querySelector('.find-menu-next');
    this.hideButton = this.querySelector('.find-menu-hide');

    await this.loadSVG(this.previousButton, 'peersky://static/assets/svg/up.svg');
    await this.loadSVG(this.nextButton, 'peersky://static/assets/svg/down.svg');
    await this.loadSVG(this.hideButton, 'peersky://static/assets/svg/close.svg');

    this.input.addEventListener('input', (e) => {
      const { value } = this;
      if (!value) return;
      if (value.length > 0 && value !== this.currentSearchValue) {
        this.currentSearchValue = value;
        this.resetSearch();
      }
      this.dispatchEvent(new CustomEvent('next', { detail: { value } }));
    });

    this.input.addEventListener('keydown', ({ keyCode, shiftKey }) => {
      if (keyCode === 13) {
        const { value } = this;
        if (!value) return this.hide();
        if (value.length > 0 && value !== this.currentSearchValue) {
          this.currentSearchValue = value;
          this.resetSearch();
        }
        const direction = shiftKey ? 'previous' : 'next';
        this.dispatchEvent(new CustomEvent(direction, { detail: { value, findNext: true } }));
      }
    });

    this.previousButton.addEventListener('click', () => {
      const { value } = this;
      if (!value) return;
      this.dispatchEvent(new CustomEvent('previous', { detail: { value, findNext: false } }));
    });
    this.nextButton.addEventListener('click', () => {
      const { value } = this;
      if (!value) return;
      this.dispatchEvent(new CustomEvent('next', { detail: { value, findNext: true } }));
    });
    this.hideButton.addEventListener('click', () => this.hide());
  }

  async loadSVG(button, svgPath) {
    const response = await fetch(svgPath);
    const svgContent = await response.text();
    const svgContainer = document.createElement("div");
    svgContainer.innerHTML = svgContent;
    svgContainer.querySelector("svg").setAttribute("width", "14");
    svgContainer.querySelector("svg").setAttribute("height", "14");
    svgContainer.querySelector("svg").setAttribute("fill", "currentColor");
    button.appendChild(svgContainer.firstChild);
  }

  resetSearch() {
    const webview = document.querySelector('webview');
    if (webview) {
      webview.executeJavaScript('window.getSelection().removeAllRanges()');
    }
  }

  get value() {
    return this.input.value;
  }

  show() {
    this.classList.toggle('hidden', false);
    setTimeout(() => {
      this.focus();
    }, 10);
  }

  hide() {
    this.classList.toggle('hidden', true);
    this.dispatchEvent(new CustomEvent('hide'));
  }

  toggle() {
    const isActive = this.classList.toggle('hidden');
    if (isActive) this.focus();
    else this.dispatchEvent(new CustomEvent('hide'));
  }

  focus() {
    this.input.focus();
    this.input.select();
  }
}

customElements.define('find-menu', FindMenu);
