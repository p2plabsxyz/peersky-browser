class NavBox extends HTMLElement {
  constructor() {
    super();
    this.isLoading = false;
    this.buildNavBox();
    this.attachEvents();
    this.attachThemeListener();
  }

  buildNavBox() {
    this.id = "navbox";
    const buttons = [
      { id: "back", svg: "left.svg", position: "start" },
      { id: "forward", svg: "right.svg", position: "start" },
      { id: "refresh", svg: "reload.svg", position: "start" },
      { id: "home", svg: "home.svg", position: "start" },
      { id: "settings", svg: "settings.svg", position: "end" },
      { id: "plus", svg: "plus.svg", position: "end" },
    ];

    this.buttonElements = {};

    // Create buttons that should appear before the URL input
    buttons
      .filter((btn) => btn.position === "start")
      .forEach((button) => {
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
    urlInput.placeholder = "Search with DuckDuckGo or type a P2P URL";
    this.appendChild(urlInput);

    // Create buttons that should appear after the URL input
    buttons
      .filter((btn) => btn.position === "end")
      .forEach((button) => {
        const btnElement = this.createButton(
          button.id,
          `peersky://static/assets/svg/${button.svg}`
        );
        this.appendChild(btnElement);
        this.buttonElements[button.id] = btnElement;
      });
  }

  createButton(id, svgPath) {
    const button = document.createElement("button");
    button.className = "nav-button";
    button.id = id;

    // Create a container for the SVG to manage icons
    const svgContainer = document.createElement("div");
    svgContainer.className = "svg-container";
    button.appendChild(svgContainer);

    this.loadSVG(svgContainer, svgPath);

    return button;
  }

  loadSVG(container, svgPath) {
    fetch(svgPath)
      .then((response) => response.text())
      .then((svgContent) => {
        container.innerHTML = svgContent;
        const svgElement = container.querySelector("svg");
        if (svgElement) {
          svgElement.setAttribute("width", "18");
          svgElement.setAttribute("height", "18");
          svgElement.setAttribute("fill", "currentColor");
        }
      })
      .catch((error) => {
        console.error(`Error loading SVG from ${svgPath}:`, error);
      });
  }

  updateButtonIcon(button, svgFileName) {
    const svgPath = `peersky://static/assets/svg/${svgFileName}`;
    const svgContainer = button.querySelector(".svg-container");
    if (svgContainer) {
      this.loadSVG(svgContainer, svgPath);
    } else {
      console.error("SVG container not found within the button.");
    }
  }

  setLoading(isLoading) {
    this.isLoading = isLoading;
    const refreshButton = this.buttonElements["refresh"];
    if (refreshButton) {
      if (isLoading) {
        this.updateButtonIcon(refreshButton, "close.svg");
      } else {
        this.updateButtonIcon(refreshButton, "reload.svg");
      }
    } else {
      console.error("Refresh button not found.");
    }
  }

  setNavigationButtons(canGoBack, canGoForward) {
    const backButton = this.buttonElements["back"];
    const forwardButton = this.buttonElements["forward"];

    if (backButton) {
      if (canGoBack) {
        backButton.classList.add("active");
        backButton.removeAttribute("disabled");
      } else {
        backButton.classList.remove("active");
        backButton.setAttribute("disabled", "true");
      }
    }

    if (forwardButton) {
      if (canGoForward) {
        forwardButton.classList.add("active");
        forwardButton.removeAttribute("disabled");
      } else {
        forwardButton.classList.remove("active");
        forwardButton.setAttribute("disabled", "true");
      }
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
        } else if (button.id === "plus") {
          this.dispatchEvent(new CustomEvent("new-window"));
        } else if (button.id === "settings") {
          this.dispatchEvent(new CustomEvent("navigate", { detail: { url: "peersky://settings" } }));
        } else if (!button.disabled) {
          this.navigate(button.id);
        }
      }
    });

    const urlInput = this.querySelector("#url");
    if (urlInput) {
      urlInput.addEventListener("keypress", (event) => {
        if (event.key === "Enter") {
          const url = event.target.value.trim();
          this.dispatchEvent(new CustomEvent("navigate", { detail: { url } }));
        }
      });
    } else {
      console.error("URL input not found within nav-box.");
    }
  }

  navigate(action) {
    this.dispatchEvent(new CustomEvent(action));
  }

  attachThemeListener() {
    // Listen for theme reload events from settings manager
    window.addEventListener('theme-reload', (event) => {
      console.log('NavBox received theme reload event:', event.detail);
      this.handleThemeChange(event.detail.theme);
    });
  }

  handleThemeChange(theme) {
    // Force re-evaluation of CSS by toggling a class
    this.classList.remove('theme-updating');
    // Use requestAnimationFrame to ensure the class removal is processed
    requestAnimationFrame(() => {
      this.classList.add('theme-updating');
      console.log('NavBox theme updated to:', theme);
      
      // Remove the temporary class after a brief moment
      setTimeout(() => {
        this.classList.remove('theme-updating');
      }, 100);
    });
  }
}

customElements.define("nav-box", NavBox);
