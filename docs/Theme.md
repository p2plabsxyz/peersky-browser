# Theme Protocol (`browser://theme/`)

## Overview

The `browser://theme/` protocol provides a standardized way for web applications to access browser-level CSS styles and theme variables in Peersky and other compatible browsers, such as [Agregore](https://agregore.mauve.moe/). This protocol ensures consistent theming across different browsers by serving CSS files with a common set of variables based on the [Base16 theme framework](https://github.com/chriskempson/base16). It allows developers to build applications that adapt to the browser's theme without needing browser-specific code.

## Purpose

The goal of the `browser://theme/` protocol is to:
- Enable cross-browser compatibility for theming in any browser, including p2p browsers like Peersky and Agregore.
- Provide a unified set of theme variables using Base16 conventions.
- Allow web applications to import styles or variables without hardcoding browser-specific protocols (e.g., `peersky://` or `agregore://`).

## Implementation

### Protocol Handler
The `browser://theme/` protocol is implemented in Peersky via a custom Electron protocol handler (`theme-handler.js`). It serves CSS files from the `src/pages/theme/` directory when requests are made to URLs like `browser://theme/vars.css` or `browser://theme/base.css`.

- **Location**: Files are stored in `src/pages/theme/` (e.g., `vars.css`, `base.css`, `index.css`).
- **URL Structure**: Requests to `browser://theme/<filename>` map to `src/pages/theme/<filename>`.
- **Example**: `browser://theme/vars.css` serves `src/pages/theme/vars.css`.

### Base16 Integration
To ensure cross-browser compatibility, the theme protocol uses the Base16 theme framework, which defines 16 color variables (`--base00` to `--base0F`). These variables are declared in `vars.css` and used across all theme-related CSS files.

- **Variables**: `vars.css` defines:
  - `--base00` to `--base07`: Core UI colors (backgrounds, text, etc.).
  - `--base08` to `--base0F`: Accent colors for highlights or interactive elements.
- **Component Variables**: Browser-specific variables (e.g., `--peersky-background-color`) are defined in terms of Base16 variables for consistency (e.g., `--peersky-background-color: var(--base00);`).

### Cross-Browser Compatibility
The `browser://theme/` protocol enables apps built for Agregore to work seamlessly in Peersky (and vice versa) by:
1. **Standardized Protocol**: Both browsers implement `browser://theme/` to serve their theme CSS files.
2. **Base16 Variables**: Apps use Base16 variables (e.g., `--base00`) directly or map browser-specific variables (e.g., `--ag-theme-background`) to Base16 variables. For example:
   - In Agregore: `--ag-theme-background: var(--base00);`
   - In Peersky: `--base00: #000000;`
   - Result: An Agregore app using `--ag-theme-background` renders with Peersky’s `--base00` color (`#000000`).
3. **Fallbacks**: Apps can import `browser://theme/vars.css` to ensure all Base16 variables are available, even if browser-specific variables are used.

This approach ensures that apps adapt to the host browser’s theme without requiring separate stylesheets for each browser.

## Usage

### Importing Theme Styles
Web applications can import theme styles or variables using `<style>` tags or `<link>` elements. Examples:

- **Import Variables**:
  ```html
  <style>
    @import url("browser://theme/vars.css");
    body {
      background-color: var(--base00);
      color: var(--base07);
    }
  </style>
  ```

- **Import Default Styles**:
  ```html
  <link rel="stylesheet" href="browser://theme/style.css">
  ```

- **Use Browser-Specific Variables** (for Agregore apps in Peersky):
  ```html
  <style>
    @import url("browser://theme/vars.css");
    body {
      background-color: var(--ag-theme-background); /* Maps to --base00 in Peersky */
    }
  </style>
  ```
