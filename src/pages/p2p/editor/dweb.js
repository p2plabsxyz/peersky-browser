import { update, showSpinner, basicCSS } from './codeEditor.js';
import { $, uploadButton, protocolSelect, fetchButton, fetchCidInput } from './common.js';

// assemble code before uploading
export async function assembleCode() {
    // Display loading spinner
    showSpinner(true);

    // Combine your code into a single HTML file
    let combinedCode = `
    <!DOCTYPE html>
    <html>
    <head>
        <style>${basicCSS}</style>
        <style>${document.getElementById("cssCode").value}</style>
    </head>
    <body>
        ${document.getElementById("htmlCode").value}
        <script>${document.getElementById("javascriptCode").value}</script>
    </body>
    </html>`;

    // Convert the combined code into a Blob
    const blob = new Blob([combinedCode], { type: 'text/html' });
    const file = new File([blob], "index.html", { type: 'text/html' });

    // Upload the file
    await uploadFile(file);
    showSpinner(false);
}

uploadButton.addEventListener('click', assembleCode);

// Upload code to Dweb
async function uploadFile(file) {
    const protocol = protocolSelect.value;

    const formData = new FormData();

    // Append file to the FormData
    formData.append('file', file, file.name);


    // Construct the URL based on the protocol
    let url;
    if (protocol === 'hyper') {
        const hyperdriveUrl = await generateHyperdriveKey('p2p-editor');
        url = `${hyperdriveUrl}`;
    } else {
        url = `ipfs://bafyaabakaieac/`;
    }

    // Perform the upload for each file
    try {
        const response = await fetch(url, {
            method: 'PUT',
            body: formData,
        });

        if (!response.ok) {
            addError(file, await response.text());
        }
        const urlResponse = protocol === 'hyper' ? response.url : response.headers.get('Location');
        addURL(urlResponse);
    } catch (error) {
        console.error(`Error uploading ${file}:`, error);
    } finally {
        showSpinner(false);
    }
}



async function generateHyperdriveKey(name) {
    try {
        const response = await fetch(`hyper://localhost/?key=${name}`, { method: 'POST' });
        if (!response.ok) {
            throw new Error(`Failed to generate Hyperdrive key: ${response.statusText}`);
        }
        return await response.text();  // This returns the hyper:// URL
    } catch (error) {
        console.error('Error generating Hyperdrive key:', error);
        throw error;
    }
}


function addURL(url) {
    const listItem = document.createElement('li');
    const link = document.createElement('a');
    link.href = url;
    link.textContent = url;

    const copyContainer = document.createElement('span');
    const copyIcon = '⊕'
    copyContainer.innerHTML = copyIcon;
    copyContainer.onclick = function() {
        navigator.clipboard.writeText(url).then(() => {
            copyContainer.textContent = ' Copied!';
            setTimeout(() => {
                copyContainer.innerHTML = copyIcon;
            }, 3000);
        }).catch(err => {
            console.error('Error in copying text: ', err);
        });
    };

    listItem.appendChild(link);
    listItem.appendChild(copyContainer);
    uploadListBox.appendChild(listItem);
}


function addError(name, text) {
    uploadListBox.innerHTML += `<li class="log">Error in ${name}: ${text}</li>`
}

// The fetchFromDWeb function detects which protocol is used and fetches the content
async function fetchFromDWeb(url) {
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
        const data = await response.text();
        parseAndDisplayData(data);
    } catch (error) {
        console.error("Error fetching from DWeb:", error);
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
    const parser = new DOMParser();
    const doc = parser.parseFromString(data, 'text/html');

    // Extracting CSS
    const styleElements = Array.from(doc.querySelectorAll('style'));

    // Remove the first element (agregore theme CSS)
    styleElements.shift();

    // Now combine the CSS from the remaining <style> elements
    let cssContent = styleElements.map(style => style.innerHTML).join('');

    // Extracting JavaScript
    const jsContent = doc.querySelector('script') ? doc.querySelector('script').innerHTML : '';

    // Remove script and style tags from the HTML content
    doc.querySelectorAll('script, style').forEach(el => el.remove());
    const htmlContent = doc.body.innerHTML; // Get the content inside the body tag without script/style tags

    // Displaying the content in respective textareas
    $('#htmlCode').value = htmlContent;
    $('#cssCode').value = cssContent;
    $('#javascriptCode').value = jsContent;
    update(0);
}