class NavBox extends HTMLElement {
  constructor() {
    super();
    this.isLoading = false; // Add isLoading state
    this.buildNavBox();
    this.attachEvents();
  }

  buildNavBox() {
    this.id = "navbox";
    const buttons = [
      { id: "back", svg: "left.svg" },
      { id: "forward", svg: "right.svg" },
      { id: "refresh", svg: "reload.svg" },
      { id: "home", svg: "home.svg" },
    ];

    this.buttonElements = {}; // Store references to buttons

    buttons.forEach((button) => {
      const btnElement = this.createButton(
        button.id,
        `peersky://static/assets/svg/${button.svg}`
      );
      this.appendChild(btnElement);
      this.buttonElements[button.id] = btnElement;
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
      .then((response) => response.text())
      .then((svgContent) => {
        const svgContainer = document.createElement("div");
        svgContainer.innerHTML = svgContent;
        const svgElement = svgContainer.querySelector("svg");
        svgElement.setAttribute("width", "18");
        svgElement.setAttribute("height", "18");
        svgElement.setAttribute("fill", "currentColor");
        button.appendChild(svgElement);
      });
    return button;
  }

  updateButtonIcon(button, svgFileName) {
    const svgPath = `peersky://static/assets/svg/${svgFileName}`;
    // Clear existing SVG
    button.innerHTML = ''; // Use innerHTML to clear all content
    // Fetch new SVG
    fetch(svgPath)
      .then((response) => response.text())
      .then((svgContent) => {
        const svgContainer = document.createElement("div");
        svgContainer.innerHTML = svgContent;
        const svgElement = svgContainer.querySelector("svg");
        svgElement.setAttribute("width", "18");
        svgElement.setAttribute("height", "18");
        svgElement.setAttribute("fill", "currentColor");
        button.appendChild(svgElement);
      });
  }

  setLoading(isLoading) {
    this.isLoading = isLoading;
    const refreshButton = this.buttonElements["refresh"];
    if (isLoading) {
      // Change icon to close.svg
      this.updateButtonIcon(refreshButton, "close.svg");
    } else {
      // Change icon to reload.svg
      this.updateButtonIcon(refreshButton, "reload.svg");
    }
  }

  attachEvents() {
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (button) {
        if (button.id === "refresh") {
          if (this.isLoading) {
            this.dispatchEvent(new CustomEvent("stop"));
          } else {
            this.dispatchEvent(new CustomEvent("reload"));
          }
        } else {
          this.navigate(button.id);
        }
      }
    });

    this.querySelector("#url").addEventListener("keypress", (event) => {
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
