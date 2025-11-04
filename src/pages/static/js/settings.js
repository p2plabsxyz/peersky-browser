/**
 * Settings Page JavaScript - Unified Preload Frontend
 *
 * Secure settings interface using unified preload script with context-aware API exposure.
 * Receives full electronAPI access when on settings pages with comprehensive fallbacks.
 */

let settingsAPI;
let eventCleanupFunctions = [];

// Hosts for built-in engines (lowercase)
const BUILTIN_SEARCH_HOSTS = new Set([
  "duckduckgo.com",
  "search.brave.com",
  "www.ecosia.org",
  "kagi.com",
  "www.startpage.com",
]);

function isBuiltInSearchTemplate(tpl) {
  try {
    // Replace %s with a sample to parse a real URL
    const url = new URL(tpl.replace("%s", encodeURIComponent("test")));
    const host = url.hostname.toLowerCase();

    if (!BUILTIN_SEARCH_HOSTS.has(host)) return false;

    // Extra safety: common built-in paths that indicate "regular web search"
    const p = url.pathname.toLowerCase();

    // duckduckgo: /  (query in ?q=)
    // brave: /search
    // ecosia: /search
    // kagi: /search
    // startpage: /do/search
    if (
      host === "duckduckgo.com" || // homepage with ?q=
      (host === "search.brave.com" && p.includes("/search")) ||
      (host === "www.ecosia.org" && p.includes("/search")) ||
      (host === "kagi.com" && p.includes("/search")) ||
      (host === "www.startpage.com" && p.includes("/do/search"))
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Validates a custom search template:
// - must start with http:// or https://
// - must include %s
// - must be a parsable URL once %s is replaced
function validateSearchTemplate(tpl) {
  if (typeof tpl !== "string")
    return { valid: false, reason: "Template must be a string." };

  const s = tpl.trim();
  if (!s) return { valid: false, reason: "Template cannot be empty." };
  if (!s.startsWith("http://") && !s.startsWith("https://")) {
    return {
      valid: false,
      reason: "Template must start with http:// or https://.",
    };
  }
  if (!s.includes("%s")) {
    return {
      valid: false,
      reason: "Template must include %s where the query should go.",
    };
  }

  // Parse and sanity check
  let parsed;
  try {
    parsed = new URL(s.replace("%s", encodeURIComponent("test search")));
  } catch {
    return {
      valid: false,
      reason: "Template is not a valid URL after inserting a query.",
    };
  }

  // Block built-in engines — user should pick them from the dropdown
  if (isBuiltInSearchTemplate(s)) {
    return {
      valid: false,
      reason:
        "This is a built-in search engine. Please select it from the dropdown.",
    };
  }

  return { valid: true };
}

function setTemplateFieldState(inputEl, messageEl, state) {
  inputEl.classList.remove("invalid", "valid");
  messageEl.classList.remove("error", "success");

  if (state.valid) {
    inputEl.classList.add("valid");
    messageEl.classList.add("success");
    messageEl.innerHTML =
      "✅ Press <b>Enter</b> to set this custom search engine.";
  } else {
    inputEl.classList.add("invalid");
    messageEl.classList.add("error");
    messageEl.textContent = state.reason || "Invalid template.";
  }
}

// Initialize API access with fallback handling
function initializeAPI() {
  console.log("Settings: Attempting to initialize API...");
  console.log("Settings: window.electronAPI available:", !!window.electronAPI);
  console.log("Settings: window.peersky available:", !!window.peersky);

  // Primary: unified preload electronAPI (for settings pages)
  if (window.electronAPI?.settings) {
    console.log("Settings: Using electronAPI from unified preload");
    settingsAPI = window.electronAPI;
    return true;
  }

  // Secondary: peersky API (fallback if context detection fails)
  if (window.peersky?.settings) {
    console.log("Settings: Using peersky.settings API");
    settingsAPI = {
      settings: window.peersky.settings,
      ...window.peersky.events,
      readCSS: window.peersky.css?.readCSS,
    };
    return true;
  }

  // Fallback: Direct IPC (development mode)
  if (window.electronIPC) {
    settingsAPI = createFallbackAPI(window.electronIPC);
    return true;
  }

  // Legacy fallbacks
  const ipcSources = [
    () => require("electron").ipcRenderer,
    () => parent.require("electron").ipcRenderer,
    () => top.require("electron").ipcRenderer,
  ];

  for (const getIPC of ipcSources) {
    try {
      const ipc = getIPC();
      if (ipc) {
        settingsAPI = createFallbackAPI(ipc);
        return true;
      }
    } catch (e) {
      // Continue to next fallback
    }
  }

  return false;
}

// Create fallback API wrapper
function createFallbackAPI(ipc) {
  const wrapCallback = (eventName, callback) => {
    const wrappedCallback = (event, ...args) => callback(...args);
    ipc.on(eventName, wrappedCallback);
    return () => ipc.removeListener(eventName, wrappedCallback);
  };

  return {
    settings: {
      getAll: () => ipc.invoke("settings-get-all"),
      get: (key) => ipc.invoke("settings-get", key),
      set: (key, value) => ipc.invoke("settings-set", key, value),
      reset: () => ipc.invoke("settings-reset"),
      clearCache: () => ipc.invoke("settings-clear-cache"),
      uploadWallpaper: (filePath) =>
        ipc.invoke("settings-upload-wallpaper", filePath),
    },
    onThemeChanged: (callback) => wrapCallback("theme-changed", callback),
    onSearchEngineChanged: (callback) =>
      wrapCallback("search-engine-changed", callback),
    onShowClockChanged: (callback) =>
      wrapCallback("show-clock-changed", callback),
    onWallpaperChanged: (callback) =>
      wrapCallback("wallpaper-changed", callback),
  };
}

document.addEventListener("DOMContentLoaded", async () => {
  // Initialize API access
  if (!initializeAPI()) {
    console.error(
      "Settings: No API access available - settings will not persist"
    );
    showSettingsSavedMessage("Settings API not available", "error");
    loadDefaultSettings();
    return;
  }

  // Set up event listeners with cleanup tracking
  try {
    if (settingsAPI.onThemeChanged) {
      const cleanup1 = settingsAPI.onThemeChanged((newTheme) => {
        const themeToggle = document.getElementById("theme-toggle");
        if (themeToggle && themeToggle.value !== newTheme) {
          themeToggle.value = newTheme;
          updateCustomDropdownDisplays();
        }
        // Theme variables update automatically with unified theme system
        // reloadThemeCSS(); // No longer needed
      });
      eventCleanupFunctions.push(cleanup1);
    }

    if (settingsAPI.onSearchEngineChanged) {
      const cleanup2 = settingsAPI.onSearchEngineChanged((newEngine) => {
        const searchEngine = document.getElementById("search-engine");
        if (searchEngine && searchEngine.value !== newEngine) {
          searchEngine.value = newEngine;
          updateCustomDropdownDisplays();
        }
        // Toggle the Custom URL row live when engine changes
        const row = document.getElementById("custom-search-row");
        if (row) {
          row.style.display = newEngine === "custom" ? "" : "none";
        }
      });
      eventCleanupFunctions.push(cleanup2);
    }

    if (settingsAPI.onShowClockChanged) {
      const cleanup3 = settingsAPI.onShowClockChanged((showClock) => {
        const clockToggle = document.getElementById("show-clock");
        if (clockToggle && clockToggle.checked !== showClock) {
          clockToggle.checked = showClock;
        }
      });
      eventCleanupFunctions.push(cleanup3);
    }

    if (settingsAPI.onWallpaperChanged) {
      const cleanup4 = settingsAPI.onWallpaperChanged((wallpaperType) => {
        const wallpaperSelector = document.getElementById("wallpaper-selector");
        if (wallpaperSelector && wallpaperSelector.value !== wallpaperType) {
          wallpaperSelector.value = wallpaperType;
          updateCustomDropdownDisplays();
        }
      });
      eventCleanupFunctions.push(cleanup4);
    }

    if (settingsAPI.onVerticalTabsChanged) {
      const cleanup4 = settingsAPI.onVerticalTabsChanged((enabled) => {
        const verticalToggle = document.getElementById("vertical-tabs");
        if (verticalToggle && verticalToggle.checked !== enabled) {
          verticalToggle.checked = enabled;
        }
      });
      eventCleanupFunctions.push(cleanup4);
    }
  } catch (error) {
    console.error("Settings: Failed to set up event listeners:", error);
  }

  // Initialize sidebar navigation
  initializeSidebarNavigation();

  // Initialize custom dropdowns
  initializeCustomDropdowns();

  // Get form elements
  const searchEngine = document.getElementById("search-engine");
  const customSearchRow = document.getElementById("custom-search-row");
  const customSearchTemplate = document.getElementById(
    "custom-search-template"
  );
  const customSearchMessage = document.getElementById("custom-search-message");

  const themeToggle = document.getElementById("theme-toggle");
  const showClock = document.getElementById("show-clock");
  const verticalTabs = document.getElementById("vertical-tabs");
  const keepTabsExpanded = document.getElementById("keep-tabs-expanded");
  const wallpaperSelector = document.getElementById("wallpaper-selector");
  const wallpaperFile = document.getElementById("wallpaper-file");
  const wallpaperBrowse = document.getElementById("wallpaper-browse");
  const wallpaperRemove = document.getElementById("wallpaper-remove");
  const wallpaperPreview = document.getElementById("wallpaper-preview");
  const clearCache = document.getElementById("clear-cache");

  // Handle built-in wallpaper selector change
  wallpaperSelector?.addEventListener("change", async (e) => {
    const selectedValue = e.target.value;
    console.log("Built-in wallpaper changed to:", selectedValue);
    await saveSettingToBackend("wallpaper", selectedValue);
  });

  // Handle browse button click
  wallpaperBrowse?.addEventListener("click", () => {
    wallpaperFile.click();
  });

  // Handle remove custom wallpaper
  wallpaperRemove?.addEventListener("click", async () => {
    if (confirm("Remove custom wallpaper and switch to default?")) {
      try {
        // Switch back to default wallpaper
        await saveSettingToBackend("wallpaper", "redwoods");

        // Update UI
        wallpaperSelector.value = "redwoods";
        updateCustomDropdownDisplays();
        updateCustomWallpaperUI(false);

        showSettingsSavedMessage("Custom wallpaper removed", "success");
      } catch (error) {
        console.error("Failed to remove custom wallpaper:", error);
        showSettingsSavedMessage("Failed to remove custom wallpaper", "error");
      }
    }
  });

  // Handle wallpaper file selection
  wallpaperFile?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (file) {
      try {
        console.log("Selected wallpaper file:", file.name);

        // Check if settingsAPI supports wallpaper upload
        if (!settingsAPI.settings.uploadWallpaper) {
          showSettingsSavedMessage("Wallpaper upload not supported", "error");
          return;
        }

        // Validate file size (max 10MB)
        if (file.size > 10 * 1024 * 1024) {
          showSettingsSavedMessage(
            "File too large. Please select an image smaller than 10MB.",
            "error"
          );
          return;
        }

        showSettingsSavedMessage("Uploading wallpaper...", "warning");

        // Read file content using FileReader
        const fileContent = await readFileAsBase64(file);

        // Upload wallpaper using file data
        const result = await settingsAPI.settings.uploadWallpaper({
          name: file.name,
          content: fileContent,
        });

        if (result.success) {
          // Update UI to show custom wallpaper is active
          updateCustomWallpaperUI(true);

          showSettingsSavedMessage(
            "Wallpaper uploaded successfully!",
            "success"
          );
          console.log("Wallpaper uploaded:", result.path);
        } else {
          showSettingsSavedMessage("Failed to upload wallpaper", "error");
        }
      } catch (error) {
        console.error("Failed to upload wallpaper:", error);
        showSettingsSavedMessage(
          `Failed to upload wallpaper: ${error.message}`,
          "error"
        );
      }
    }
  });

  // Handle clear cache button
  clearCache?.addEventListener("click", async () => {
    if (
      confirm(
        "Are you sure you want to clear the browser cache? This action cannot be undone."
      )
    ) {
      try {
        console.log("Clear cache requested");
        const result = await settingsAPI.settings.clearCache();

        if (result.success) {
          alert("Cache cleared successfully!");
          console.log("Cache clearing completed:", result.message);
        } else {
          alert("Cache clearing failed. Please try again.");
          console.error("Cache clearing failed:", result);
        }
      } catch (error) {
        console.error("Failed to clear cache:", error);
        alert(`Failed to clear cache: ${error.message}`);
      }
    }
  });

  // Add change listeners for form elements
  searchEngine?.addEventListener("change", async (e) => {
    const value = e.target.value;
    console.log("Search engine changed (UI):", value);

    if (value === "custom") {
      // Show inline input/modal, but do NOT save the engine yet
      if (customSearchRow) customSearchRow.style.display = "";
      // optional UX: prefill from existing template and focus
      customSearchTemplate?.focus();
      customSearchTemplate?.select?.();
      return; // do NOT call settings.set('searchEngine', 'custom') yet
    }

    // For all non-custom engines, persist immediately and hide the row
    await saveSettingToBackend("searchEngine", value);
    if (customSearchRow) customSearchRow.style.display = "none";
  });

  // Live validation as user types
  customSearchTemplate?.addEventListener("input", () => {
    customSearchMessage.style.display = ""; // show again while editing
    const state = validateSearchTemplate(customSearchTemplate.value);
    setTemplateFieldState(customSearchTemplate, customSearchMessage, state);
  });

  // Save custom search template on Enter
  customSearchTemplate?.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const tpl = customSearchTemplate.value.trim();

    const state = validateSearchTemplate(tpl);
    setTemplateFieldState(customSearchTemplate, customSearchMessage, state);
    if (!state.valid) return;

    try {
      // Save template first
      await saveSettingToBackend("customSearchTemplate", tpl);
      // Then set engine to custom (only now)
      if (searchEngine && searchEngine.value !== "custom") {
        searchEngine.value = "custom";
      }
      await saveSettingToBackend("searchEngine", "custom");

      // ✅ Hide the helper message once successfully set
      customSearchMessage.textContent = "";
      customSearchMessage.style.display = "none";

      if (customSearchRow) customSearchRow.style.display = "";
      showSettingsSavedMessage("Custom search template saved", "success");
    } catch (err) {
      console.error(err);
      showSettingsSavedMessage("Failed to save custom template", "error");
    }
  });

  themeToggle?.addEventListener("change", async (e) => {
    console.log("Theme changed:", e.target.value);

    // Apply theme immediately for instant feedback
    applyThemeImmediately(e.target.value);

    await saveSettingToBackend("theme", e.target.value);
  });

  showClock?.addEventListener("change", async (e) => {
    console.log("Show clock changed:", e.target.checked);
    await saveSettingToBackend("showClock", e.target.checked);
  });

  verticalTabs?.addEventListener("change", async (e) => {
    const enabled = e.target.checked;
    console.log("Vertical tabs changed:", enabled);
    await saveSettingToBackend("verticalTabs", enabled);
    try {
      if (enabled) {
        settingsAPI.hideTabComponents?.();
      } else {
        settingsAPI.loadTabComponents?.();
      }
    } catch (err) {
      console.error("Failed to toggle tab components:", err);
    }
  });

  keepTabsExpanded?.addEventListener("change", async (e) => {
    const keepExpanded = e.target.checked;
    console.log("Keep tabs expanded changed:", keepExpanded);
    await saveSettingToBackend("keepTabsExpanded", keepExpanded);
  });

  // Initialize custom wallpaper UI state
  updateCustomWallpaperUI(false);

  // Load settings from backend
  loadSettingsFromBackend();
});

function loadDefaultSettings() {
  const searchEngine = document.getElementById("search-engine");
  const themeToggle = document.getElementById("theme-toggle");
  const showClock = document.getElementById("show-clock");
  const verticalTabs = document.getElementById("vertical-tabs");
  const keepTabsExpanded = document.getElementById("keep-tabs-expanded");
  const wallpaperSelector = document.getElementById("wallpaper-selector");

  if (searchEngine) searchEngine.value = "duckduckgo";
  if (themeToggle) themeToggle.value = "dark";
  if (showClock) showClock.checked = true;
  if (verticalTabs) verticalTabs.checked = false;
  if (keepTabsExpanded) keepTabsExpanded.checked = false;
  if (wallpaperSelector) wallpaperSelector.value = "redwoods";
}

// Load settings from backend
async function loadSettingsFromBackend() {
  if (!settingsAPI?.settings) {
    console.warn("Settings: API not available, using defaults");
    loadDefaultSettings();
    return;
  }

  try {
    const settings = await settingsAPI.settings.getAll();
    populateFormFields(settings);
  } catch (error) {
    console.error("Settings: Failed to load settings:", error);
    showSettingsSavedMessage(
      `Failed to load settings: ${error.message}`,
      "error"
    );
    loadDefaultSettings();
  }
}

// Populate form fields with settings data
function populateFormFields(settings) {
  const searchEngine = document.getElementById("search-engine");
  const customSearchRow = document.getElementById("custom-search-row"); // NEW
  const customSearchTemplate = document.getElementById(
    "custom-search-template"
  );
  const customSearchMessage = document.getElementById("custom-search-message"); // <-- add this

  const themeToggle = document.getElementById("theme-toggle");
  const showClock = document.getElementById("show-clock");
  const verticalTabs = document.getElementById("vertical-tabs");
  const keepTabsExpanded = document.getElementById("keep-tabs-expanded");
  const wallpaperSelector = document.getElementById("wallpaper-selector");

  if (searchEngine && settings.searchEngine) {
    searchEngine.value = settings.searchEngine;
  }
  // Show/hide the custom row based on saved engine
  if (customSearchRow) {
    customSearchRow.style.display =
      settings.searchEngine === "custom" ? "" : "none";
  }

  // Prefill template input
  if (customSearchTemplate) {
    const tpl = settings.customSearchTemplate || "https://duckduckgo.com/?q=%s";
    customSearchTemplate.value = tpl;

    const state = validateSearchTemplate(tpl);

    // Apply only visual input state (valid/invalid)…
    customSearchTemplate.classList.remove("invalid", "valid");
    if (state.valid) customSearchTemplate.classList.add("valid");
    else customSearchTemplate.classList.add("invalid");

    // …and control the message based on whether the engine is already set
    // If engine is already 'custom' and template is valid, HIDE the message.
    if (settings.searchEngine === "custom" && state.valid) {
      customSearchMessage.textContent = "";
      customSearchMessage.classList.remove("error", "success");
      customSearchMessage.style.display = "none";
    } else {
      // Otherwise show the neutral hint (not the success text)
      customSearchMessage.style.display = "";
      customSearchMessage.classList.remove("error", "success");
      customSearchMessage.innerHTML =
        "Use <code>%s</code> where the query should go.";
    }
  }

  if (themeToggle && settings.theme) {
    themeToggle.value = settings.theme;

    // Apply theme immediately on page load (no transition disabling for settings)
    applyThemeImmediately(settings.theme);
  }
  if (showClock && typeof settings.showClock === "boolean") {
    showClock.checked = settings.showClock;
  }
  if (verticalTabs && typeof settings.verticalTabs === "boolean") {
    verticalTabs.checked = settings.verticalTabs;
  }
  if (keepTabsExpanded && typeof settings.keepTabsExpanded === "boolean") {
    keepTabsExpanded.checked = settings.keepTabsExpanded;
  }
  if (wallpaperSelector && settings.wallpaper) {
    // Only set built-in wallpaper values, ignore custom
    if (
      settings.wallpaper === "redwoods" ||
      settings.wallpaper === "mountains"
    ) {
      wallpaperSelector.value = settings.wallpaper;
    } else if (settings.wallpaper === "custom") {
      // For custom wallpaper, show custom UI but keep built-in selector unchanged
      updateCustomWallpaperUI(true);
    }
  }

  // Update custom dropdown displays after loading settings
  updateCustomDropdownDisplays();

  // Remove any remaining loader
  const loader = document.getElementById("theme-loader");
  if (loader) {
    loader.style.opacity = "0";
    setTimeout(() => loader.remove(), 200);
  }

  console.log("Form fields populated with settings");
}

async function saveSettingToBackend(key, value) {
  if (!settingsAPI?.settings) {
    console.warn("Settings: API not available, setting not saved:", key, value);
    showSettingsSavedMessage("Settings not available", "error");
    return;
  }

  try {
    const result = await settingsAPI.settings.set(key, value);

    // Create user-friendly success messages
    const successMessages = {
      searchEngine: "Search engine updated successfully!",
      customSearchTemplate: "Custom template updated successfully!", // NEW
      theme: "Theme updated successfully!",
      showClock: "Clock setting updated successfully!",
      wallpaper: "Wallpaper updated successfully!",
      verticalTabs: "Vertical tabs setting updated successfully!",
    };

    const message = successMessages[key] || `${key} updated successfully!`;
    showSettingsSavedMessage(message, "success");
    return result;
  } catch (error) {
    console.error("Settings: Failed to save setting:", error);

    // Create user-friendly error messages
    const errorMessages = {
      searchEngine: "Failed to save search engine setting",
      customSearchTemplate: "Failed to save custom template", // NEW
      theme: "Failed to save theme setting",
      showClock: "Failed to save clock setting",
      wallpaper: "Failed to save wallpaper setting",
      verticalTabs: "Failed to save vertical tabs setting",
    };

    const errorMessage = errorMessages[key] || `Failed to save ${key} setting`;
    showSettingsSavedMessage(`${errorMessage}: ${error.message}`, "error");

    // Reload settings to sync UI with backend state
    await loadSettingsFromBackend();
    throw error;
  }
}

async function resetSettingsToDefaults() {
  if (!settingsAPI?.settings) {
    console.warn("Settings: API not available, cannot reset settings");
    showSettingsSavedMessage("Settings not available", "error");
    return;
  }

  if (
    !confirm(
      "Are you sure you want to reset all settings to defaults? This cannot be undone."
    )
  ) {
    return;
  }

  try {
    const result = await settingsAPI.settings.reset();
    await loadSettingsFromBackend();
    showSettingsSavedMessage("Settings have been reset to defaults", "success");
    return result;
  } catch (error) {
    console.error("Settings: Failed to reset settings:", error);
    showSettingsSavedMessage(
      `Failed to reset settings: ${error.message}`,
      "error"
    );
    throw error;
  }
}

// Apply theme immediately to current page for instant feedback
function applyThemeImmediately(themeName) {
  try {
    // Set theme attribute FIRST for immediate variable updates
    document.documentElement.setAttribute("data-theme", themeName);

    // Remove old theme classes (legacy support)
    document.documentElement.classList.remove(
      ...Array.from(document.documentElement.classList).filter((c) =>
        c.startsWith("theme-")
      )
    );

    console.log("Theme applied immediately:", themeName);
  } catch (error) {
    console.error("Failed to apply theme immediately:", error);
  }
}

// Sidebar navigation functionality for page switching
function initializeSidebarNavigation() {
  const navItems = document.querySelectorAll(".nav-item");
  const pages = document.querySelectorAll(".settings-page");

  // Handle nav clicks for page switching
  navItems.forEach((item) => {
    item.addEventListener("click", (e) => {
      const sectionName = item.getAttribute("data-section");

      // If no data-section attribute, allow normal navigation (for external links like bookmarks)
      if (!sectionName) {
        return; // Allow default behavior
      }

      e.preventDefault();
      navigateToSection(sectionName);
    });
  });

  // Parse URL subpath and navigate to appropriate section
  const currentPath = window.location.pathname || window.location.hash;
  let targetSection = "appearance"; // default

  // Check for URL subpath (e.g., /settings/search)
  const subpathMatch = currentPath.match(/\/settings\/(\w+)/);
  if (subpathMatch) {
    targetSection = subpathMatch[1];
  }
  // Check for hash-based navigation (backward compatibility)
  else if (currentPath.includes("#")) {
    const hashSection = currentPath.replace("#", "");
    if (
      hashSection &&
      ["appearance", "search", "tabs", "extensions"].includes(hashSection)
    ) {
      targetSection = hashSection;
    }
  }

  // Update UI to show the determined section (don't trigger navigation on page load)
  updateSectionUI(targetSection);

  // TODO: Add back/forward history support for subpaths
  // Future implementation should update browser history when switching sections
  // and handle browser back/forward navigation within settings subpaths
}

// Navigate to a specific settings section
function navigateToSection(sectionName) {
  const currentPath = window.location.pathname || "";
  const targetURL = `peersky://settings/${sectionName}`;

  // Check if we're already on the target section to avoid unnecessary navigation
  if (currentPath.includes(`/settings/${sectionName}`)) {
    // Just update the UI without navigation
    updateSectionUI(sectionName);
    return;
  }

  // Navigate to the new URL - this will update the address bar and trigger a reload
  // The page will parse the new URL and show the correct section
  window.location.href = targetURL;
}

// Update the UI to show the correct section (separated for reuse)
function updateSectionUI(sectionName) {
  const navItems = document.querySelectorAll(".nav-item");
  const pages = document.querySelectorAll(".settings-page");
  const targetPageId = sectionName + "-section";

  // Update active nav item
  navItems.forEach((nav) => nav.classList.remove("active"));
  const targetNavItem = document.querySelector(
    `[data-section="${sectionName}"]`
  );
  if (targetNavItem) {
    targetNavItem.classList.add("active");
  }

  // Show corresponding page
  pages.forEach((page) => page.classList.remove("active"));
  const targetPage = document.getElementById(targetPageId);
  if (targetPage) {
    targetPage.classList.add("active");
  }
}

// Custom dropdown functionality
function initializeCustomDropdowns() {
  const customSelects = document.querySelectorAll(".custom-select");

  customSelects.forEach((select) => {
    const display = select.querySelector(".select-display");
    const dropdown = select.querySelector(".select-dropdown");
    const options = select.querySelectorAll(".select-option");
    const hiddenInput = select.parentElement.querySelector(
      'input[type="hidden"]'
    );

    // Toggle dropdown on display click
    display.addEventListener("click", (e) => {
      e.stopPropagation();

      // Close other dropdowns
      document
        .querySelectorAll(".custom-select.open")
        .forEach((otherSelect) => {
          if (otherSelect !== select) {
            otherSelect.classList.remove("open");
          }
        });

      // Toggle current dropdown
      select.classList.toggle("open");
    });

    // Handle option selection
    options.forEach((option) => {
      option.addEventListener("click", (e) => {
        e.stopPropagation();

        const value = option.dataset.value;
        const text = option.textContent;

        // Update display
        display.textContent = text;
        display.dataset.value = value;

        // Update hidden input
        if (hiddenInput) {
          hiddenInput.value = value;

          // Trigger change event for settings saving
          const changeEvent = new Event("change", { bubbles: true });
          hiddenInput.dispatchEvent(changeEvent);
        }

        // Update selected state
        options.forEach((opt) => opt.classList.remove("selected"));
        option.classList.add("selected");

        // Close dropdown
        select.classList.remove("open");
      });
    });
  });

  // Close dropdowns when clicking outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".custom-select")) {
      document.querySelectorAll(".custom-select.open").forEach((select) => {
        select.classList.remove("open");
      });
    }
  });

  // Update dropdown displays based on current values
  updateCustomDropdownDisplays();
}

// Update custom wallpaper UI state
function updateCustomWallpaperUI(isCustomActive) {
  const wallpaperRemove = document.getElementById("wallpaper-remove");
  const wallpaperPreview = document.getElementById("wallpaper-preview");

  if (isCustomActive) {
    wallpaperRemove?.style.setProperty("display", "inline-flex");
    wallpaperPreview?.style.setProperty("display", "block");
  } else {
    wallpaperRemove?.style.setProperty("display", "none");
    wallpaperPreview?.style.setProperty("display", "none");
  }
}

// Read file as base64 using FileReader
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // Remove the data URL prefix (data:image/jpeg;base64,)
      const base64Content = reader.result.split(",")[1];
      resolve(base64Content);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Update custom dropdown displays with current values
function updateCustomDropdownDisplays() {
  const customSelects = document.querySelectorAll(".custom-select");

  customSelects.forEach((select) => {
    const display = select.querySelector(".select-display");
    const options = select.querySelectorAll(".select-option");
    const hiddenInput = select.parentElement.querySelector(
      'input[type="hidden"]'
    );

    if (hiddenInput && hiddenInput.value) {
      const selectedOption = [...options].find(
        (opt) => opt.dataset.value === hiddenInput.value
      );
      if (selectedOption) {
        display.textContent = selectedOption.textContent;
        display.dataset.value = selectedOption.dataset.value;

        // Update selected state
        options.forEach((opt) => opt.classList.remove("selected"));
        selectedOption.classList.add("selected");
      }
    }
  });
}

// Show temporary message with type support (success, error, warning)
function showSettingsSavedMessage(message, type = "success") {
  // Remove any existing message
  const existingMessage = document.querySelector(".settings-saved-message");
  if (existingMessage) {
    existingMessage.remove();
  }

  // Create new message element with appropriate styling
  const messageEl = document.createElement("div");
  messageEl.className = `settings-saved-message ${type}`;
  messageEl.textContent = message;

  // Minimal styling
  messageEl.style.position = "fixed";
  messageEl.style.top = "20px";
  messageEl.style.right = "20px";
  messageEl.style.padding = "12px 20px";
  messageEl.style.borderRadius = "6px";
  messageEl.style.fontFamily = "Arial, sans-serif";
  messageEl.style.zIndex = "10000";
  messageEl.style.opacity = "0";
  messageEl.style.transition = "opacity 0.2s ease-in-out";

  // Add type-specific styling
  if (type === "error") {
    messageEl.style.backgroundColor = "#f44336";
    messageEl.style.color = "white";
  } else if (type === "warning") {
    messageEl.style.backgroundColor = "#ff9800";
    messageEl.style.color = "white";
  } else {
    messageEl.style.backgroundColor = "#0fba84";
    messageEl.style.color = "white";
  }

  document.body.appendChild(messageEl);

  // Fade in
  setTimeout(() => {
    messageEl.style.opacity = "1";
  }, 10);

  const duration = type === "error" ? 3000 : 2000;
  setTimeout(() => {
    messageEl.style.opacity = "0";
    setTimeout(() => {
      if (messageEl.parentNode) {
        messageEl.parentNode.removeChild(messageEl);
      }
    }, 300);
  }, duration);
}

// Cleanup function for event listeners
function cleanup() {
  eventCleanupFunctions.forEach((cleanupFn) => {
    try {
      cleanupFn();
    } catch (error) {
      console.error("Settings: Error during cleanup:", error);
    }
  });
  eventCleanupFunctions = [];
}

// Cleanup on page unload
window.addEventListener("beforeunload", cleanup);
