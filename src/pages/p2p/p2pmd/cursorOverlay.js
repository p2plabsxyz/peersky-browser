/**
 * Renders authorship marks and live peer cursors over the textarea.
 */
let _textarea = null;
let _localClientId = null;
let _gutterEl = null;
let _authorGutterEl = null;
let _overlayEl = null;
let _mirrorEl = null;
let _rafId = null;
let _peers = [];
let _resizeObserver = null;
let _lineAuthors = {};
const PEER_NAME_TRUNCATE_LEN = 8;
const PEER_COLOR_SATURATION = 70;

function _onScroll() { _scheduleUpdate(); }
function _onInput() { _scheduleUpdate(); }

export function initCursorOverlay(textareaEl, localClientId) {
  destroyCursorOverlay();
  _textarea = textareaEl;
  _localClientId = localClientId;

  const wrapper = _textarea.parentElement;
  _authorGutterEl = _el("div", "author-gutter", wrapper);
  _gutterEl = _el("div", "peer-gutter", wrapper);
  _overlayEl = _el("div", "peer-cursor-overlay", wrapper);

  _mirrorEl = document.createElement("div");
  _mirrorEl.setAttribute("aria-hidden", "true");
  _mirrorEl.style.cssText =
    "position:fixed;top:-9999px;left:-9999px;visibility:hidden;" +
    "white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;overflow:hidden;";
  document.body.appendChild(_mirrorEl);

  _textarea.addEventListener("scroll", _onScroll, { passive: true });
  _textarea.addEventListener("input", _onInput, { passive: true });

  _resizeObserver = new ResizeObserver(_scheduleUpdate);
  _resizeObserver.observe(_textarea);
  _scheduleUpdate();
}

export function updateCursorOverlay(peers) {
  _peers = Array.isArray(peers) ? peers : [];
  _scheduleUpdate();
}

export function setLocalColor(color) {}

export function updateLineAuthors(lineAuthorsMap) {
  _lineAuthors = lineAuthorsMap && typeof lineAuthorsMap === "object" ? lineAuthorsMap : {};
  _scheduleUpdate();
}

export function destroyCursorOverlay() {
  if (_rafId !== null) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
  if (_textarea) {
    _textarea.removeEventListener("scroll", _onScroll);
    _textarea.removeEventListener("input", _onInput);
  }
  if (_resizeObserver) {
    _resizeObserver.disconnect();
    _resizeObserver = null;
  }

  if (_authorGutterEl) { _authorGutterEl.remove(); _authorGutterEl = null; }
  if (_gutterEl) { _gutterEl.remove(); _gutterEl = null; }
  if (_overlayEl) { _overlayEl.remove(); _overlayEl = null; }
  if (_mirrorEl) { _mirrorEl.remove(); _mirrorEl = null; }

  _textarea = null;
  _localClientId = null;
  _peers = [];
  _lineAuthors = {};
}

function _scheduleUpdate() {
  if (_rafId !== null) return;
  _rafId = requestAnimationFrame(() => {
    _rafId = null;
    _redraw();
  });
}

function _redraw() {
  if (!_textarea) return;
  _syncMirror();
  _renderAuthorshipGutter();
  _renderLiveCursors();
}

function _renderAuthorshipGutter() {
  if (!_authorGutterEl) return;
  _authorGutterEl.innerHTML = "";

  const text = _textarea.value || "";
  const scrollTop = _textarea.scrollTop;
  for (const [lineStr, info] of Object.entries(_lineAuthors)) {
    const line = parseInt(lineStr, 10);
    if (!Number.isFinite(line) || line < 1 || !info?.color) continue;

    const coords = _getCaretCoords(text, _lineToOffset(text, line));
    if (!coords) continue;

    const top = coords.top - scrollTop;
    if (top < -coords.lh || top > _textarea.clientHeight + coords.lh) continue;

    const mark = document.createElement("div");
    mark.className = "author-gutter-mark";
    mark.style.cssText = `top:${top}px;height:${coords.lh}px;background:${info.color};`;
    mark.title = info.name || "";
    _authorGutterEl.appendChild(mark);
  }
}

function _renderLiveCursors() {
  if (!_gutterEl || !_overlayEl) return;
  _gutterEl.innerHTML = "";
  _overlayEl.innerHTML = "";

  const text = _textarea.value || "";
  const scrollTop = _textarea.scrollTop;
  const remote = _peers.filter((p) =>
    p && p.clientId && p.clientId !== _localClientId &&
    typeof p.cursorLine === "number" && p.cursorLine > 0
  );

  for (const peer of remote) {
    const coords = _getCaretCoords(
      text,
      _lineColumnToOffset(text, peer.cursorLine, peer.cursorColumn)
    );
    if (!coords) continue;

    const top = coords.top - scrollTop;
    const color = peer.color || _hsl(peer.clientId);
    const name = peer.name || _trunc(peer.clientId, PEER_NAME_TRUNCATE_LEN);
    const idle = peer.isTyping === false;
    if (top < -coords.lh || top > _textarea.clientHeight + coords.lh) continue;

    const chip = document.createElement("div");
    chip.className = idle ? "peer-cursor-chip idle" : "peer-cursor-chip";
    chip.style.cssText =
      `top:${top}px;left:${Math.max(0, coords.left - _textarea.scrollLeft - 4)}px;` +
      `height:${coords.lh}px;--peer-color:${color};`;
    chip.dataset.peerName = name;
    chip.title = name;
    _overlayEl.appendChild(chip);
  }
}

function _syncMirror() {
  if (!_textarea || !_mirrorEl) return;
  const cs = window.getComputedStyle(_textarea);
  const copy = [
    "font-family", "font-size", "font-weight", "font-style", "letter-spacing",
    "line-height", "text-indent", "text-transform", "word-spacing",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
    "box-sizing"
  ].map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";");
  _mirrorEl.style.cssText =
    "position:fixed;top:-9999px;left:-9999px;visibility:hidden;" +
    "white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;overflow:hidden;" +
    `width:${_textarea.clientWidth}px;${copy}`;
}

/* Returns coordinates relative to textarea top-left. */
function _getCaretCoords(text, offset) {
  if (!_mirrorEl) return null;
  const safe = Math.max(0, Math.min(Number.isFinite(offset) ? offset : 0, text.length));

  _mirrorEl.textContent = "";
  _mirrorEl.appendChild(document.createTextNode(text.slice(0, safe)));
  const span = document.createElement("span");
  span.textContent = text[safe] || "\u200b";
  _mirrorEl.appendChild(span);
  _mirrorEl.appendChild(document.createTextNode(text.slice(safe + 1)));

  const sr = span.getBoundingClientRect();
  const mr = _mirrorEl.getBoundingClientRect();
  const cs = window.getComputedStyle(_textarea);
  const lh = parseFloat(cs.lineHeight) || 20;

  return { top: sr.top - mr.top, left: sr.left - mr.left, lh };
}

function _lineToOffset(text, line) {
  if (!text || line <= 1) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n" && ++n === line) return i + 1;
  }
  return text.length;
}

/* 1-based line+column to char offset. */
function _lineColumnToOffset(text, line, column) {
  const lineStart = _lineToOffset(text, line);
  if (!Number.isFinite(Number(column)) || Number(column) <= 1) return lineStart;
  const nextLineStart = _lineToOffset(text, Number(line) + 1);
  const lineEndExclusive = nextLineStart > lineStart ? Math.max(lineStart, nextLineStart - 1) : text.length;
  const maxCharsOnLine = Math.max(0, lineEndExclusive - lineStart);
  const colIndex = Math.max(0, Math.min(maxCharsOnLine, Math.floor(Number(column)) - 1));
  return lineStart + colIndex;
}

function _trunc(s, n) {
  return !s ? "" : s.length <= n ? s : `${s.slice(0, n)}...`;
}

function _hsl(id) {
  if (!id) return "#888";
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  return `hsl(${h % 360},${PEER_COLOR_SATURATION}%,55%)`;
}

function _el(tag, id, parent) {
  const el = document.createElement(tag);
  el.id = id;
  parent.appendChild(el);
  return el;
}