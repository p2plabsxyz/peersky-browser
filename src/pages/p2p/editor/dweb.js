import { update, showSpinner, basicCSS } from './codeEditor.js';
import { $, uploadButton, protocolSelect, fetchButton, fetchCidInput } from './common.js';

// Toggle title input visibility based on protocol
function toggleTitleInput() {
    const titleInput = $('#titleInput');
    if (protocolSelect.value === 'ipfs') {
        titleInput.classList.add('hidden');
        titleInput.removeAttribute('required');
    } else {
        titleInput.classList.remove('hidden');
        titleInput.setAttribute('required', '');
    }
}

// Restore protocol from localStorage (if exists)
const lastProtocol = localStorage.getItem('lastProtocol');
if (lastProtocol) {
    protocolSelect.value = lastProtocol;
}

// Initialize title input visibility
toggleTitleInput();

// Update visibility + save protocol on change
protocolSelect.addEventListener('change', () => {
    toggleTitleInput();
    localStorage.setItem('lastProtocol', protocolSelect.value);
});

// Assemble code before uploading
export async function assembleCode() {
    const protocol = protocolSelect.value;
    let fileName = 'index.html';

    if (protocol === 'hyper') {
        const title = $('#titleInput').value.trim();
        if (!title) {
            alert("Please enter a title for your project.");
            return;
        }
        fileName = `${title.replace(/\s+/g, '-').toLowerCase()}.html`;
    }

    // Display loading spinner
    showSpinner(true);

    // Combine your code into a single HTML file
    let combinedCode = `
    <!DOCTYPE html>
    <html>
    <head>
        <style>${basicCSS}</style>
        <style>${$('#cssCode').value}</style>
    </head>
    <body>
        ${$('#htmlCode').value}
        <script>${$('#javascriptCode').value}</script>
    </body>
    </html>`;

    // Convert the combined code into a Blob
    const blob = new Blob([combinedCode], { type: 'text/html' });
    const file = new File([blob], fileName, { type: 'text/html' });

    // Upload the file
    await uploadFile(file);
    showSpinner(false);
}

uploadButton.addEventListener('click', assembleCode);

// Upload code to Dweb
async function uploadFile(file) {
    const protocol = protocolSelect.value;
    console.log(`[uploadFile] Uploading ${file.name}, protocol: ${protocol}`);

    let url;
    if (protocol === 'hyper') {
        const hyperdriveUrl = await getOrCreateHyperdrive();
        url = `${hyperdriveUrl}${encodeURIComponent(file.name)}`;
        console.log(`[uploadFile] Hyper URL: ${url}`);
    } else {
        url = `ipfs://bafyaabakaieac/${encodeURIComponent(file.name)}`;
        console.log(`[uploadFile] IPFS URL: ${url}`);
    }

    try {
        const response = await fetch(url, {
            method: 'PUT',
            body: file, // Send raw file bytes
            headers: {
                'Content-Type': file.type || 'text/html'
            }
        });

        console.log(`[uploadFile] Response status: ${response.status}, ok: ${response.ok}`);
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[uploadFile] Error uploading ${file.name}: ${errorText}`);
            addError(file.name, errorText);
            return;
        }

        const finalUrl = protocol === 'hyper' ? url : response.headers.get('Location');
        addURL(finalUrl);
    } catch (error) {
        console.error(`[uploadFile] Error uploading ${file.name}:`, error);
        addError(file.name, error.message);
    } finally {
        showSpinner(false);
    }
}

let hyperdriveUrl = null;

async function getOrCreateHyperdrive() {
    if (!hyperdriveUrl) {
        const name = 'p2p-editor';
        try {
            const response = await fetch(`hyper://localhost/?key=${encodeURIComponent(name)}`, { method: 'POST' });
            if (!response.ok) {
                throw new Error(`Failed to generate Hyperdrive key: ${response.statusText}`);
            }
            hyperdriveUrl = await response.text();
            console.log(`[getOrCreateHyperdrive] Hyperdrive URL: ${hyperdriveUrl}`);
        } catch (error) {
            console.error('[getOrCreateHyperdrive] Error generating Hyperdrive key:', error);
            throw error;
        }
    }
    return hyperdriveUrl;
}

function addURL(url) {
    console.log(`[addURL] Adding URL: ${url}`);
    const listItem = document.createElement('li');
    const link = document.createElement('a');
    link.href = url;
    link.textContent = url;

    const copyContainer = document.createElement('span');
    const copyIcon = '⊕';
    copyContainer.innerHTML = copyIcon;
    copyContainer.onclick = function() {
        navigator.clipboard.writeText(url).then(() => {
            copyContainer.textContent = ' Copied!';
            setTimeout(() => {
                copyContainer.innerHTML = copyIcon;
            }, 3000);
        }).catch(err => {
            console.error('[addURL] Error in copying text: ', err);
        });
    };

    listItem.appendChild(link);
    listItem.appendChild(copyContainer);
    uploadListBox.appendChild(listItem);
}

function addError(name, text) {
    console.log(`[addError] Error in ${name}: ${text}`);
    uploadListBox.innerHTML += `<li class="log">Error in ${name}: ${text}</li>`;
}

// The fetchFromDWeb function detects which protocol is used and fetches the content
async function fetchFromDWeb(url) {
    console.log(`[fetchFromDWeb] Fetching URL: ${url}`);
    if (!url) {
        alert("Please enter a CID or Name.");
        return;
    }

    if (!url.startsWith('ipfs://') && !url.startsWith('hyper://')) {
        alert("Invalid protocol. URL must start with ipfs:// or hyper://");
        return;
    }

    try {
        const response = await fetch(url);
        console.log(`[fetchFromDWeb] Response status: ${response.status}`);
        const data = await response.text();
        parseAndDisplayData(data);
    } catch (error) {
        console.error("[fetchFromDWeb] Error fetching from DWeb:", error);
        alert("Failed to fetch from DWeb.");
    }
}

// Modified event listener for fetchButton
fetchButton.addEventListener('click', () => {
    const cidOrName = fetchCidInput.value;
    fetchFromDWeb(cidOrName);
});

// Parse the data and display it in the code editor
function parseAndDisplayData(data) {
    console.log(`[parseAndDisplayData] Parsing received data`);
    const parser = new DOMParser();
    const doc = parser.parseFromString(data, 'text/html');

    // Extracting CSS
    const styleElements = Array.from(doc.querySelectorAll('style'));
    styleElements.shift(); // Remove the first element (basicCSS)
    let cssContent = styleElements.map(style => style.innerHTML).join('');

    // Extracting JavaScript
    const jsContent = doc.querySelector('script') ? doc.querySelector('script').innerHTML : '';

    // Remove script and style tags from the HTML content
    doc.querySelectorAll('script, style').forEach(el => el.remove());
    const htmlContent = doc.body.innerHTML; // Get the content inside the body tag without script/style tags

    // Displaying the content in respective textareas
    console.log(`[parseAndDisplayData] Setting HTML: ${htmlContent.substring(0, 50)}...`);
    console.log(`[parseAndDisplayData] Setting CSS: ${cssContent.substring(0, 50)}...`);
    console.log(`[parseAndDisplayData] Setting JS: ${jsContent.substring(0, 50)}...`);
    $('#htmlCode').value = htmlContent;
    $('#cssCode').value = cssContent;
    $('#javascriptCode').value = jsContent;
    update(0);
}
