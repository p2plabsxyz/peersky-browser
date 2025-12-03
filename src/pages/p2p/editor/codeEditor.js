import { $, loadingSpinner, backdrop, iframe } from './common.js'; // Import common functions

// Attach event listeners directly using the $ selector function
[$('#htmlCode'), $('#javascriptCode'), $('#cssCode')].forEach(element => {
    element.addEventListener('input', () => update());
});

// CSS for published files: default white background, black text
export let basicCSS = `
    body {
        font-size: 1.2rem;
        margin: 0;
        padding: 0;
        background: #FFFFFF;
        color: #000000;
    }
`;

// CSS for iframe preview: Use current theme colors
function getPreviewCSS() {
    const computedStyle = getComputedStyle(document.documentElement);
    const bgColor = computedStyle.getPropertyValue('--browser-theme-background').trim();
    const textColor = computedStyle.getPropertyValue('--browser-theme-text-color').trim();
    
    return `
        :root {
            --browser-theme-background: ${bgColor};
            --browser-theme-text-color: ${textColor};
        }
        body {
            font-size: 1.2rem;
            margin: 0;
            padding: 0;
            background: var(--browser-theme-background);
            color: var(--browser-theme-text-color);
        }
    `;
}

// Function for live rendering
export function update() {
    let htmlCode = $('#htmlCode').value;
    console.log('HTML Code:', htmlCode);
    let cssCode = $('#cssCode').value;
    console.log('CSS Code:', cssCode);
    let javascriptCode = $('#javascriptCode').value;
    console.log('JavaScript Code:', javascriptCode);
    // Assemble all elements for the iframe preview, using dynamic theme CSS
    let iframeContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="utf-8">
        <style>${getPreviewCSS()}</style>
        <style>${cssCode}</style>
    </head>
    <body>
        ${htmlCode}
        <script>${javascriptCode}</script>
    </body>
    </html>
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