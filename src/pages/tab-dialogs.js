// Dialogs a tab asked for, such as a site's sign-in, drawn over that tab
// (src/tab-dialogs.js). As in Chrome a dialog belongs to its tab: it is on
// screen only while its tab is, keeps what was typed while another tab is in
// front, and keeps clicks and keys from that page only.
//
// This page runs with node integration, and the text shown comes from sites,
// so it only ever goes in as textContent.
(() => {
  const { ipcRenderer } = require('electron')

  // By the webContents id of a tab's page: its webview, the layer over it, and
  // its dialogs in the order they came, the first one on screen.
  const tabs = new Map()

  const BUILDERS = {
    'sign-in': signIn
  }

  ipcRenderer.on('tab-dialog-show', (_event, dialog) => add(dialog))
  ipcRenderer.on('tab-dialog-close', (_event, message) => remove(message?.id))
  window.addEventListener('resize', () => [...tabs.values()].forEach(update))

  function webviewFor (webContentsId) {
    for (const webview of document.querySelectorAll('webview')) {
      try {
        if (webview.getWebContentsId() === webContentsId) return webview
      } catch {}
    }
    return null
  }

  function send (dialog, answer) {
    if (dialog.answered) return
    dialog.answered = true
    ipcRenderer.send('tab-dialog-answer', { id: dialog.id, answer })
  }

  function add (dialog) {
    if (!dialog || typeof dialog.id !== 'number') return
    const build = BUILDERS[dialog.kind]
    const webview = build ? webviewFor(dialog.webContentsId) : null
    if (!webview) return send(dialog, null)
    const tab = tabs.get(dialog.webContentsId) || track(dialog.webContentsId, webview)
    dialog.element = build(dialog, (answer) => {
      send(dialog, answer)
      drop(tab, dialog)
    })
    tab.dialogs.push(dialog)
    update(tab)
  }

  // Main took this one down: the tab went to another page, or closed.
  function remove (id) {
    for (const tab of tabs.values()) {
      const dialog = tab.dialogs.find((each) => each.id === id)
      if (!dialog) continue
      dialog.answered = true
      drop(tab, dialog)
      return
    }
  }

  function drop (tab, dialog) {
    const index = tab.dialogs.indexOf(dialog)
    if (index === -1) return
    const hadFocus = dialog.element.contains(document.activeElement)
    tab.dialogs.splice(index, 1)
    dialog.element.remove()
    update(tab)
    if (hadFocus && !tab.dialogs.length && shown(tab.webview)) tab.webview.focus()
  }

  function track (webContentsId, webview) {
    const layer = document.createElement('div')
    layer.className = 'tab-dialog-layer'
    layer.hidden = true
    webview.parentElement.appendChild(layer)
    const tab = { webContentsId, webview, layer, dialogs: [], focusDue: false }
    const refresh = () => update(tab)
    // The tab bar shows and hides a tab's page through its style.
    tab.styleWatch = new MutationObserver(refresh)
    tab.styleWatch.observe(webview, { attributes: true, attributeFilter: ['style'] })
    tab.sizeWatch = new ResizeObserver(refresh)
    tab.sizeWatch.observe(webview)
    // The page cannot be used while its dialog is up, so focus meant for it
    // goes to the dialog: the tab bar's when the tab is picked, and Tab
    // moving into it.
    tab.onFocus = () => {
      if (!layer.hidden) setTimeout(() => focusDialog(tab), 0)
    }
    webview.addEventListener('focus', tab.onFocus)
    const focusPage = webview.focus
    Object.defineProperty(webview, 'focus', {
      configurable: true,
      writable: true,
      value: (...args) => (layer.hidden ? focusPage.apply(webview, args) : focusDialog(tab))
    })
    tabs.set(webContentsId, tab)
    return tab
  }

  function untrack (tab) {
    tab.styleWatch.disconnect()
    tab.sizeWatch.disconnect()
    tab.webview.removeEventListener('focus', tab.onFocus)
    delete tab.webview.focus
    tab.layer.remove()
    tabs.delete(tab.webContentsId)
  }

  function shown (webview) {
    return webview.isConnected && webview.style.display !== 'none'
  }

  function update (tab) {
    if (!tab.webview.isConnected) {
      for (const dialog of tab.dialogs) send(dialog, null)
      tab.dialogs = []
    }
    if (!tab.dialogs.length) return untrack(tab)
    const first = tab.dialogs[0]
    if (first.element.parentNode !== tab.layer) {
      tab.layer.replaceChildren(first.element)
      tab.focusDue = true
    }
    const visible = shown(tab.webview)
    const appearing = visible && tab.layer.hidden
    tab.layer.hidden = !visible
    if (!visible) return
    place(tab)
    if (appearing || tab.focusDue) {
      tab.focusDue = false
      focusDialog(tab)
    }
  }

  // Over the page's own box, wherever the tab bar put it: one side of a split
  // view, beside the DevTools or a side panel. Measured from the box the layer
  // is placed in, which for an extension's side panel is the panel, not the
  // page's parent.
  function place ({ webview, layer }) {
    const page = webview.getBoundingClientRect()
    const box = (layer.offsetParent || layer.parentElement).getBoundingClientRect()
    layer.style.left = `${page.left - box.left}px`
    layer.style.top = `${page.top - box.top}px`
    layer.style.width = `${page.width}px`
    layer.style.height = `${page.height}px`
  }

  function focusDialog (tab) {
    const dialog = tab.dialogs[0]
    if (!dialog || tab.layer.hidden || dialog.element.contains(document.activeElement)) return
    dialog.focusTarget?.focus()
  }

  function make (tag, className, text) {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text != null) element.textContent = text
    return element
  }

  function field (form, label, type) {
    const row = make('label', 'tab-dialog-field')
    const input = document.createElement('input')
    input.type = type
    input.autocomplete = 'off'
    input.spellcheck = false
    input.setAttribute('autocapitalize', 'off')
    row.append(make('span', null, label), input)
    form.append(row)
    return input
  }

  function buttons (cancel, ok) {
    const row = make('div', 'tab-dialog-buttons')
    row.append(cancel, ok)
    return row
  }

  function button (label, type = 'button') {
    const element = make('button', type === 'submit' ? 'primary' : null, label)
    element.type = type
    return element
  }

  function frame (dialog, role, title) {
    const form = make('form', 'tab-dialog')
    form.noValidate = true
    form.setAttribute('autocomplete', 'off')
    form.setAttribute('role', role)
    form.setAttribute('aria-modal', 'true')
    const heading = make('h2', 'tab-dialog-title', title)
    heading.id = `tab-dialog-${dialog.id}`
    form.setAttribute('aria-labelledby', heading.id)
    form.append(heading)
    return form
  }

  // Escape is Cancel, and Tab goes round the dialog rather than into the page.
  function keys (form, cancel) {
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        cancel()
        return
      }
      if (event.key !== 'Tab') return
      const stops = [...form.querySelectorAll('input, button')]
      const first = stops[0]
      const last = stops[stops.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    })
  }

  // Chrome's: the origin that asked, a note when the connection to it is not
  // private, a username, a password, and nothing filled in.
  function signIn (dialog, done) {
    const form = frame(dialog, 'dialog', 'Sign in')
    form.append(make('p', 'tab-dialog-origin', dialog.origin))
    if (dialog.notPrivate) form.append(make('p', 'tab-dialog-note', 'Your connection to this site is not private'))
    const username = field(form, 'Username', 'text')
    const password = field(form, 'Password', 'password')
    const cancel = button('Cancel')
    form.append(buttons(cancel, button('Sign in', 'submit')))
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const answer = { username: username.value, password: password.value }
      username.value = ''
      password.value = ''
      done(answer)
    })
    cancel.addEventListener('click', () => done(null))
    keys(form, () => done(null))
    dialog.focusTarget = username
    return form
  }
})()
