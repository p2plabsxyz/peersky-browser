/**
 * Error Page Display System
 * Shows descriptive Chromium error messages
 */

(function() {
  try {
    let query = location.search;
    if (!query && location.href.includes('?')) {
      query = '?' + location.href.split('?')[1];
    }

    const params = new URLSearchParams(query);
    
    const code = params.get('code') ;
    const name = params.get('name') ;
    const msg = params.get('msg') ;
    const url = params.get('url');

    // Set page title
    document.title = name + ' - Peersky';
    
    // Update DOM elements
    const titleEl = document.getElementById('errorTitle');
    const codeEl = document.getElementById('errorCode');
    const msgEl = document.getElementById('errorMessage');
    const urlEl = document.getElementById('errorUrl');
    
    if (titleEl) titleEl.textContent = name;
    if (msgEl) msgEl.textContent = msg;
    
    if (code && codeEl) {
      codeEl.textContent = 'Error Code: ' + code;
      codeEl.style.display = 'block';
    }
    
    if (url && urlEl) {
      try {
        urlEl.textContent = decodeURIComponent(url);
      } catch (e) {
        urlEl.textContent = url;
      }
      urlEl.style.display = 'block';
    }
  } catch (e) {
    console.error('[Error Page] Failed to render:', e);
    
    // Fallback to default error message
    const titleEl = document.getElementById('errorTitle');
    const msgEl = document.getElementById('errorMessage');
    
    if (titleEl) titleEl.textContent = 'Connection Error';
    if (msgEl) msgEl.textContent = 'Unable to connect to the server.';
  }
})();