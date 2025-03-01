import { $, loadingSpinner, backdrop, iframe } from './common.js'; // Import common functions

// Attach event listeners directly using the $ selector function
[$('#htmlCode'), $('#javascriptCode'), $('#cssCode')].forEach(element => {
    element.addEventListener('input', () => update());
});

// Import CSS from Agregore theme to use in the iframe preview
export let basicCSS = `
    :root {
        --peersky-p2p-background-color: #18181b;
        --peersky-text-color: #FFFFFF;
    }
    body {
        font-size: 1.2rem;
        margin: 0;
        padding: 0;
        background: var(--peersky-p2p-background-color);
        color: var(--peersky-text-color);
    }
`;

//Function for live Rendering
export function update() {
    let htmlCode = $('#htmlCode').value;
    console.log('HTML Code:', htmlCode);
    let cssCode = $('#cssCode').value;
    console.log('CSS Code:', cssCode);
    let javascriptCode = $('#javascriptCode').value;
    console.log('JavaScript Code:', javascriptCode);
    // Assemble all elements and Include the basic CSS from Agregore theme
    let iframeContent = `
    <style>${basicCSS}</style>
    <style>${cssCode}</style>
    <script>${javascriptCode}</script>
    ${htmlCode}
    `;
    
    let iframeDoc = iframe.contentWindow.document;
    iframeDoc.open();
    iframeDoc.write(iframeContent);
    iframeDoc.close();
}


// Show or hide the loading spinner
export function showSpinner(show) {
    backdrop.style.display = show ? 'block' : 'none';
    loadingSpinner.style.display = show ? 'block' : 'none';
}