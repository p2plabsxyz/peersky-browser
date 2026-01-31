import { $ } from './common.js';
import { update } from './codeEditor.js';
import { scheduleDraftSave } from './dweb.js';

const SYSTEM = 'system';
const USER = 'user';
const SYSTEM_PROMPT = `You are a programmer's assistant that helps users create simple web pages.`;
const PREFIX_MESSAGE = { role: SYSTEM, content: SYSTEM_PROMPT };

// Get DOM elements
const toggleAiButton = $('#toggleAiButton');
const aiContainer = $('#ai-container');
const aiPromptBox = $('#aiPromptBox');
const generateButton = $('#generateButton');
const showAiLogButton = $('#showAiLog');
const closeAiLogButton = $('#closeAiLog');
const aiLogDialog = $('#aiLogDialog');
const aiLogs = $('#aiLogs');

const htmlCodeArea = $('#htmlCode');
const cssCodeArea = $('#cssCode');
const javascriptCodeArea = $('#javascriptCode');

// Try to load saved prompt from localStorage
try {
    const savedPrompt = localStorage.getItem('editor-ai-prompt');
    if (savedPrompt?.trim()) {
        aiPromptBox.value = savedPrompt;
    }
} catch (e) {
    console.log('localStorage not available');
}

// Save prompt on input
aiPromptBox.addEventListener('input', () => {
    try {
        localStorage.setItem('editor-ai-prompt', aiPromptBox.value.trim());
    } catch (e) {
        // Silently fail
    }
});

// Toggle AI container
toggleAiButton.addEventListener('click', () => {
    aiContainer.classList.toggle('hidden');
});

// Show logs dialog
showAiLogButton.addEventListener('click', () => {
    aiLogDialog.showModal();
});

// Close logs dialog
closeAiLogButton.addEventListener('click', () => {
    aiLogDialog.close();
});

// Generate button click handler
generateButton.addEventListener('click', async () => {
    const prompt = aiPromptBox.value.trim();
    
    if (!prompt) {
        alert('Please enter a description of what you want to create!');
        return;
    }
    
    // Clear logs
    aiLogs.innerHTML = '';
    
    // Show logs dialog
    aiLogDialog.showModal();
    
    try {
        log("Starting generation", prompt);
        
        // Generate metadata (name)
        log("Generating metadata");
        const metadata = await makeMetadata(prompt);
        log("Metadata", JSON.stringify(metadata, null, 2));
        
        // Generate plan
        log("Making step by step plan");
        const plan = await makePlan(prompt, metadata);
        log("Generated plan", plan);
        
        // Generate HTML
        log("Generating HTML...");
        const html = await makeHTML(prompt, metadata, plan);
        log("✅ HTML Generated", html);
        htmlCodeArea.value = html;
        update(); // Update preview
        
        // Generate JavaScript
        log("Generating JavaScript...");
        const js = await makeJS(prompt, metadata, plan, html);
        log("✅ JavaScript Generated", js);
        javascriptCodeArea.value = js;
        update(); // Update preview
        
        // Generate CSS
        log("Generating CSS...");
        const css = await makeCSS(prompt, metadata, plan, html);
        log("✅ CSS Generated", css);
        cssCodeArea.value = css;
        update();
        scheduleDraftSave();
        
        log("🎉 Generation Complete!", "Your web page has been generated successfully!");
        
    } catch (error) {
        console.error('Generation error:', error);
        log("❌ Error", error.message || error.toString());
    }
});

// Logging function
function log(label, ...messages) {
    console.log(label, ...messages);
    
    const titleElement = document.createElement("dt");
    titleElement.textContent = label;
    aiLogs.appendChild(titleElement);
    
    for (let message of messages) {
        const detailElement = document.createElement("dd");
        const messageText = typeof message === 'string' ? message : JSON.stringify(message, null, 2);
        detailElement.textContent = messageText;
        aiLogs.appendChild(detailElement);
    }
    
    // Auto-scroll to bottom
    aiLogDialog.scrollTop = aiLogDialog.scrollHeight;
}

// Extract section helper
function extractSection(content, startText, endText) {
    const startIdx = content.indexOf(startText);
    if (startIdx === -1) {
        // Start marker not found, fall back to full content
        return content;
    }
    
    const start = startIdx + startText.length;
    const end = content.indexOf(endText, start);
    if (end === -1) {
        // End marker not found, fall back to full content
        return content;
    }

    return content.slice(start, end);
}

// Chat with LLM
async function chat(messages, opts = {}) {
    console.log('chat', messages);
    
    if (!window.llm || !window.llm.chat) {
        throw new Error('LLM API not available. Please enable LLM in settings.');
    }
    
    const response = await window.llm.chat({ messages, ...opts });
    console.log('chat response', response);
    return response;
}

// Generate metadata (name for the project)
async function makeMetadata(description) {
    const content = `I have a web page I'm trying to make with the following description:
${description}

I want you to come up with a descriptive name for this page.
Make it whimsical and include the main function.

Output in the form of a JSON object that looks like this:
{"name":"Name here"}`;

    const messages = [{ role: USER, content }];
    
    const { content: result } = await chat(messages);
    const data = extractSection(result, "{", "}");
    
    console.log("metadata parse", { result, data });
    
    try {
        return JSON.parse(`{${data}}`);
    } catch (e) {
        // Fallback if JSON parsing fails
        return { name: "Generated Page" };
    }
}

// Generate plan
async function makePlan(description, { name }) {
    const content = `I would like to make a web page that does the following:
${description}

I'm going to call it "${name}".
Plan how this page should work step by step.
You cannot rely on external files, if you need an image use a unicode symbol, emoji, or make an inline SVG.
Assume the general structure is taken care of, focus on the contents.
What elements do we need in the HTML and what are their IDs?
What function names do we need in the JavaScript?
How should we style layout with CSS?
Do we need user input via forms or keyboard and mouse?
Do not write any code, just the high level description.
Do not provide an example.`;

    const messages = [PREFIX_MESSAGE, { role: USER, content }];
    
    const result = await chat(messages, { stop: ['```'] });
    
    return result.content;
}

// Generate HTML
async function makeHTML(prompt, { name }, plan) {
    const content = `I'm planning to make a web page called ${name} with the following description:
${prompt}

Here are the more detailed plans:
${plan}

Now make the HTML for the page.
Just output the body content, don't include html, head, body tags.
You can call JS functions from event handlers like onclick.
Use HTML5 semantic elements where appropriate.
Use the id attribute for elements that will be dynamically modified by JavaScript.
Don't use images unless the user told you their URLs.
Instead of images make SVG or use an emoji.
Make sure to define all elements from the plan.
Don't include any script tags or styles.
No inline CSS either.
Output only the HTML code.`;

    const messages = [PREFIX_MESSAGE, { role: USER, content }];
    
    const { content: result } = await chat(messages, { stop: ["<script"] });
    
    // Try to extract from code block if present
    if (result.includes('```html')) {
        return extractSection(result, '```html', '```');
    } else if (result.includes('```')) {
        return extractSection(result, '```', '```');
    }
    
    return result;
}

// Generate JavaScript
async function makeJS(prompt, { name }, plan, html) {
    const content = `I'm planning to make a web page called ${name} with the following description:
${prompt}

Here are the more detailed plans:
${plan}

Only follow the JavaScript related plans.

Here's the HTML for the page:
\`\`\`html
${html}
\`\`\`

Now make the JavaScript for the page.
Use let and const for variable names.
Use element.onclick for event handlers.
Use console.log to log steps as they happen.
Make sure to define all the functions from the plan.
Do not use DOMContentLoaded or window.onload.
Only output the JavaScript and nothing else.
Output the JavaScript code inside a code block like this:
\`\`\`javascript
Code Here
\`\`\``;

    const messages = [PREFIX_MESSAGE, { role: USER, content }];
    
    const { content: result } = await chat(messages, { stop: ['```\n'] });
    
    if (result.includes('<script>')) {
        return extractSection(result, '<script>', '</script>');
    }
    
    if (result.includes('```javascript')) {
        return extractSection(result, '```javascript', '```');
    } else if (result.includes('```')) {
        return extractSection(result, '```', '```');
    }
    
    return result;
}

// Generate CSS
async function makeCSS(prompt, { name }, plan, html) {
    const content = `I'm planning to make a web page called ${name} with the following description:
${prompt}

Here's the HTML for the page:
\`\`\`html
${html}
\`\`\`

Here are the more detailed plans:
${plan}

Follow just the CSS related plans.

Now make the CSS for the page.
Use flexbox or grid for layout if needed.
Keep it minimal and functional.
Focus on layout, spacing, and basic styling.
Only provide the CSS and nothing else.
Output the CSS code inside a code block like:
\`\`\`css
Code Here
\`\`\``;

    const messages = [PREFIX_MESSAGE, { role: USER, content }];
    
    const result = await chat(messages, { stop: ['```\n'] });
    
    let css = result.content;
    
    if (css.includes('```css')) {
        css = extractSection(css, '```css', '```');
    } else if (css.includes('```')) {
        css = extractSection(css, '```', '```');
    }
    
    if (css.includes("<style>")) {
        css = extractSection(css, "<style>", "</style>");
    }
    
    return css;
}

console.log("AI Generator ready!");
