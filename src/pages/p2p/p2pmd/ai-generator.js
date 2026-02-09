import {
  markdownInput,
  toggleAiButton,
  aiContainer,
  aiPromptBox,
  generateButton,
  showAiLog,
  aiLogDialog,
  aiLogs,
  closeAiLog
} from "./common.js";
import { renderPreview } from "./noteEditor.js";
import { scheduleSend, scheduleDraftSave } from "./p2p.js";

const AI_PROMPT_STORAGE = "p2pmd-ai-prompt";

function safeLocalStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

const savedPrompt = safeLocalStorageGet(AI_PROMPT_STORAGE);
if (savedPrompt?.trim()) {
  aiPromptBox.value = savedPrompt;
}

aiPromptBox.addEventListener("input", () => {
  safeLocalStorageSet(AI_PROMPT_STORAGE, aiPromptBox.value.trim());
});

toggleAiButton.addEventListener("click", () => {
  aiContainer.classList.toggle("hidden");
});

showAiLog.addEventListener("click", () => aiLogDialog.showModal());
closeAiLog.addEventListener("click", () => aiLogDialog.close());

function appendLog(title, message) {
  const dt = document.createElement("dt");
  dt.textContent = title;
  aiLogs.appendChild(dt);
  const dd = document.createElement("dd");
  dd.textContent = message;
  aiLogs.appendChild(dd);
}

function isEditRequest(prompt) {
  const lower = prompt.toLowerCase().trim();
  const editPattern = /\b(add|edit|modify|change|update|rewrite|improve|fix|remove|delete|replace|insert|make|create|write|put|include|move|merge|split|format|restructure|reorganize|shorten|expand|extend|summarize|translate|convert|transform|rephrase|paraphrase|simplify|elaborate|proofread|correct|revise|refine|polish|enhance|optimize|beautify|clean|append|prepend|swap|rename|number|bold|italicize|underline|highlight|indent|dedent|wrap|unwrap|generate|compose|draft|outline|list|table|heading|title|section|paragraph|sentence|bullet|link|image|code|block|quote|style|theme|tone|voice)\b/i;
  return editPattern.test(lower);
}

async function generateMarkdown() {
  const prompt = aiPromptBox.value.trim();
  if (!prompt) {
    alert("Please enter a prompt.");
    return;
  }
  aiLogs.innerHTML = "";
  appendLog("Prompt", prompt);
  aiLogDialog.showModal();
  if (!window.llm || !window.llm.chat) {
    appendLog("Error", "LLM API not available. Enable LLM in settings.");
    return;
  }
  try {
    const draft = markdownInput.value;
    const hasDraft = draft.trim().length > 0;
    const editMode = hasDraft && isEditRequest(prompt);

    let systemContent, userContent;

    if (hasDraft && editMode) {
      systemContent = "You are a document editor. Apply the user's edit instruction to the draft below. Return ONLY the complete updated document. Do not add explanations, commentary, or any text outside the document.";
      userContent = `Edit instruction: ${prompt}\n\nDocument:\n${draft}`;
    } else if (hasDraft) {
      systemContent = "The user has a document and wants to ask a question. Answer the question concisely. Do NOT include or repeat the document in your response.";
      userContent = `Question: ${prompt}\n\nDocument for context:\n${draft}`;
    } else {
      systemContent = "You are a helpful assistant. Generate markdown content based on the user's request.";
      userContent = prompt;
    }

    if (hasDraft) {
      appendLog("Draft", draft);
    }
    appendLog("Mode", editMode ? "Edit draft" : hasDraft ? "Question (draft unchanged)" : "Generate new");

    const messages = [
      { role: "system", content: systemContent },
      { role: "user", content: userContent }
    ];
    const response = await window.llm.chat({ messages, temperature: 0.6, maxTokens: 4096 });
    const output = response?.content || "";

    if (!output.trim()) {
      appendLog("Result", "No content generated.");
      return;
    }

    if (editMode || !hasDraft) {
      markdownInput.value = output;
      renderPreview();
      scheduleSend();
      scheduleDraftSave();
      appendLog("Result", output);
    } else {
      appendLog("Result", output);
    }
  } catch (error) {
    appendLog("Error", error.message || String(error));
  }
}

generateButton.addEventListener("click", generateMarkdown);
