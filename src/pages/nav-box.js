class NavBox extends HTMLElement {
  constructor() {
    super();
    this.buildNavBox();
    this.attachEvents();
  }

  buildNavBox() {
    this.id = "navbox";
    const buttons = [
      { id: "back", svg: "left.svg" },
      { id: "forward", svg: "right.svg" },
      { id: "refresh", svg: "reload.svg" },
      { id: "home", svg: "home.svg" }
    ];

    buttons.forEach(button => {
      this.appendChild(this.createButton(button.id, `peersky://static/assets/svg/${button.svg}`));
    });

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.id = "url";
    urlInput.placeholder = "Search with DuckDuckGo or type a URL";
    this.appendChild(urlInput);
  }

  createButton(id, svgPath) {
    const button = document.createElement("button");
    button.className = "nav-button";
    button.id = id;

    fetch(svgPath)
      .then(response => response.text())
      .then(svgContent => {
        const svgContainer = document.createElement("div");
        svgContainer.innerHTML = svgContent;
        svgContainer.querySelector("svg").setAttribute("width", "18");
        svgContainer.querySelector("svg").setAttribute("height", "18");
        svgContainer.querySelector("svg").setAttribute("fill", "currentColor");
        button.appendChild(svgContainer.firstChild);
      });
    return button;
  }

  attachEvents() {
    this.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (button) {
        this.navigate(button.id);
      }
    });

    this.querySelector('#url').addEventListener('keypress', event => {
      if (event.key === "Enter") {
        const url = event.target.value.trim();
        this.dispatchEvent(new CustomEvent("navigate", { detail: { url } }));
      }
    });
  }

  navigate(action) {
    this.dispatchEvent(new CustomEvent(action));
  }
}

customElements.define("nav-box", NavBox);
