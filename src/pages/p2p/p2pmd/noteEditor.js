import { markdownInput, markdownPreview, loadingSpinner, backdrop } from "./common.js";

let md = null;
let renderTimer = null;

export function initMarkdown() {
  try {
    md = window.markdownit({
      html: false,
      linkify: true,
      breaks: true
    });
    
    const defaultRender = md.renderer.rules.link_open || function(tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };
    
    md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
      const aIndex = tokens[idx].attrIndex('target');
      if (aIndex < 0) {
        tokens[idx].attrPush(['target', '_blank']);
      } else {
        tokens[idx].attrs[aIndex][1] = '_blank';
      }
      const relIndex = tokens[idx].attrIndex('rel');
      if (relIndex < 0) {
        tokens[idx].attrPush(['rel', 'noopener noreferrer']);
      } else {
        tokens[idx].attrs[relIndex][1] = 'noopener noreferrer';
      }
      return defaultRender(tokens, idx, options, env, self);
    };
    
    renderPreview();
  } catch {
    md = null;
    markdownPreview.textContent = markdownInput.value || "";
  }
}

export function renderMarkdown(markdown) {
  if (!md) return markdown || "";
  return md.render(markdown || "");
}

export function renderPreview() {
  if (!md) {
    markdownPreview.textContent = markdownInput.value || "";
    return;
  }
  markdownPreview.innerHTML = md.render(markdownInput.value || "");
}

export function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPreview, 120);
}

export function showSpinner(show) {
  backdrop.style.display = show ? "block" : "none";
  loadingSpinner.style.display = show ? "block" : "none";
}
