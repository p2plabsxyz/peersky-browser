const DEFAULT_PAGE = 'peersky://home';
const webviewContainer = document.querySelector('#webview');
const nav = document.querySelector('#navbox');
const pageTitle = document.querySelector('title');

const searchParams = new URL(window.location.href).searchParams;
const toNavigate = searchParams.has('url') ? searchParams.get('url') : DEFAULT_PAGE;

document.addEventListener('DOMContentLoaded', () => {
  // Ensure we correctly call loadURL on the webview itself
  webviewContainer.loadURL(toNavigate);

  nav.addEventListener('back', () => webviewContainer.goBack());
  nav.addEventListener('forward', () => webviewContainer.goForward());
  nav.addEventListener('refresh', () => webviewContainer.reload());
  nav.addEventListener('home', () => {
    webviewContainer.loadURL('peersky://home');
    nav.querySelector('#url').value = 'peersky://home';
  });
  nav.addEventListener('navigate', ({ detail }) => {
    const { url } = detail;
    navigateTo(url);
  });
});

// Listen for custom events from tracked-box that should forward these details
webviewContainer.addEventListener('did-navigate', (e) => {
  nav.querySelector('#url').value = e.detail.url; // Ensure this detail is passed by the event
});

webviewContainer.addEventListener('page-title-updated', (e) => {
  pageTitle.innerText = e.detail.title + ' - Peersky Browser'; // Ensure this detail is passed by the event
});

function navigateTo(url) {
  webviewContainer.loadURL(url);
}
