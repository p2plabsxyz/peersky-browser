// Handles LLM API with streaming support for chat and completion
import settingsManager from './settings-manager.js';
import { ipcMain, dialog, shell } from 'electron';
import { Agent } from 'undici';

let isInitialized = false;
let initializedModel = null; // Track which model we initialized with
// Completion Iterators, id to iterator
const inProgress = new Map();
let streamId = 1;

// Create custom undici agent with no timeouts for LLM requests
// This prevents "Headers Timeout Error" when models take long to respond
const llmAgent = new Agent({
  headersTimeout: 0, // No timeout for headers
  bodyTimeout: 0     // No timeout for body
});

// Download management
let currentDownloadModel = null;
let currentDownloadPercent = 0;

// Ollama availability tracking
let ollamaMissingNotified = false;

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 2048;

function isUsingLocalOllama(settings) {
  const baseURL = settings.llm?.baseURL || '';
  return settings.llm?.apiKey === 'ollama' && (baseURL.includes('127.0.0.1') || baseURL.includes('localhost'));
}

function isLikelyOllamaMissing(error) {
  const message = error?.message || '';
  return message.includes('ECONNREFUSED') || message.includes('ENOTFOUND') || message.includes('fetch failed');
}

function isOpenRouterURL(url = '') {
  return url.includes('openrouter.ai');
}

function constructChatURL(baseURLRaw) {
  let url = baseURLRaw || '';

  // Default to local Ollama if nothing configured
  if (!url) {
    url = 'http://127.0.0.1:11434';
  }

  if (isOpenRouterURL(url)) {
    const normalized = url.endsWith('/') ? url.slice(0, -1) : url;
    const base = normalized.includes('/api/v1') ? normalized : `${normalized}/api/v1`;
    return `${base}/chat/completions`;
  }

  // Ollama-style endpoints expect /v1/ prefix
  const baseURL = url.endsWith('/') ? url : url + '/';
  return baseURL + 'v1/chat/completions';
}

async function maybeShowOllamaNotInstalledDialog(error) {
  if (ollamaMissingNotified) return;
  const settings = settingsManager.settings || {};
  if (!isUsingLocalOllama(settings)) return;
  if (!isLikelyOllamaMissing(error)) return;
  ollamaMissingNotified = true;
  try {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Open Install Guide', 'Dismiss'],
      defaultId: 0,
      cancelId: 1,
      title: 'Ollama Not Detected',
      message: 'PeerSky could not connect to the local Ollama service.',
      detail: 'Install or start Ollama to enable local AI generation. You can also configure a remote endpoint under Settings > AI / LLMs.'
    });
    if (response === 0) {
      await shell.openExternal('https://ollama.com/download');
    }
  } catch (dialogError) {
    console.error('Failed to show Ollama install dialog:', dialogError);
  }
}

// IPC Handlers
ipcMain.handle('llm-supported', async (event) => {
  const settings = settingsManager.settings || {};
  if (!settings.llm?.enabled) return false;
  return isSupported();
});

ipcMain.handle('llm-chat', async (event, args) => {
  const settings = settingsManager.settings || {};
  if (!settings.llm?.enabled) return Promise.reject(new Error('LLM API is disabled'));
  return chat(args);
});

ipcMain.handle('llm-complete', async (event, args) => {
  const settings = settingsManager.settings || {};
  if (!settings.llm?.enabled) return Promise.reject(new Error('LLM API is disabled'));
  return complete(args);
});

ipcMain.handle('llm-update-settings', async (event, newSettings) => {
  try {
    // Update the settings through settings manager
    const currentSettings = settingsManager.settings || {};
    const oldModel = currentSettings.llm?.model;
    const oldBaseURL = currentSettings.llm?.baseURL;
    const oldApiKey = currentSettings.llm?.apiKey;
    currentSettings.llm = newSettings;
    await settingsManager.saveSettings();

    // Force reload settings to ensure backend has latest values
    await settingsManager.loadSettings();

    // Reset Ollama missing notification if connection settings changed
    if (newSettings.baseURL !== oldBaseURL || newSettings.apiKey !== oldApiKey) {
      ollamaMissingNotified = false;
    }

    // Reset initialization when model changes so next API call uses new model
    if (newSettings.model !== oldModel) {
      console.log(`Model changed from ${oldModel} to ${newSettings.model}, will reinitialize on next use`);
      isInitialized = false;
      initializedModel = null;
    }
    
    // If LLM is enabled, check if we need to download the model
    // Check even if model name didn't change (user might have deleted it with ollama rm)
    if (newSettings.enabled && newSettings.model) {
      // Always check if model exists, even if name didn't change
      const modelExists = await hasModel();
      
      if (!modelExists) {
        // Check if using OpenRouter - no download needed
        if (newSettings.apiKey !== 'ollama' && isOpenRouterURL(newSettings.baseURL)) {
          console.log('Using OpenRouter API, no model download needed');
          return { success: true };
        }
        
        // Model not found locally, auto-download for Ollama
        console.log(`Model ${newSettings.model} not found locally, starting download...`);
        
        try {
          // Don't show progress until we know the model exists
          let downloadStarted = false;
          let lastPercent = 0;
          let lastSentPercent = -1;

          // Pull the model with progress tracking
          const success = await pullModel((percent, status) => {
            // Track last known percent
            if (percent >= 0) {
              lastPercent = percent;
            }

            // Only send progress events after we're sure download is happening
            if (!downloadStarted && percent >= 0) {
              downloadStarted = true;
              if (!event.sender.isDestroyed()) {
                event.sender.send('llm-download-progress', {
                  status: 'starting',
                  model: newSettings.model,
                  percent: 0
                });
              }
            }
            
            if (downloadStarted && !event.sender.isDestroyed()) {
              // Use last known non-negative percent if this update is a sentinel
              const currentPercent = percent >= 0 ? percent : lastPercent;

              // Throttle to changes of at least 1% (integer step)
              if (
                currentPercent >= 0 &&
                Math.floor(currentPercent) !== Math.floor(lastSentPercent)
              ) {
                lastSentPercent = currentPercent;
                event.sender.send('llm-download-progress', {
                  status: 'downloading',
                  model: newSettings.model,
                  percent: currentPercent,
                  message: status
                });
              }
            }
          });
          
          if (success) {
            // Send completion
            event.sender.send('llm-download-progress', {
              status: 'complete',
              model: newSettings.model,
              percent: 100
            });
            
            // Update the installed models list
            event.sender.send('llm-models-updated', {
              model: newSettings.model
            });
          } else {
            // Model doesn't exist in Ollama library
            event.sender.send('llm-download-progress', {
              status: 'error',
              model: newSettings.model,
              message: `Model '${newSettings.model}' not found. Check available models at ollama.com/library`,
              percent: 0
            });
            return { success: false, error: `Model '${newSettings.model}' not found in Ollama library` };
          }
        } catch (error) {
          if (error.message && (error.message.includes('not found') || error.message.includes('file does not exist'))) {
            // Model doesn't exist - don't send progress event, just return error
            console.log(`Model ${newSettings.model} not found:`, error.message);
            return { success: false, error: `Model '${newSettings.model}' not found. Check available models at ollama.com/library` };
          } else {
            // Other errors during download - send error progress
            if (!event.sender.isDestroyed()) {
              event.sender.send('llm-download-progress', {
                status: 'error',
                model: newSettings.model,
                message: error.message || 'Download failed',
                percent: 0
              });
            }
            return { success: false, error: error.message };
          }
        }
      }
    }
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});


ipcMain.handle('llm-test-connection', async (event) => {
  try {
    const settings = settingsManager.settings || {};
    if (!settings.llm?.enabled) {
      return { success: false, error: 'LLM is not enabled' };
    }
    
    // Try to list models to test Ollama connection
    const models = await listModels();
    return { success: true, models };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('llm-chat-stream', async (event, args) => {
  const settings = settingsManager.settings || {};
  if (!settings.llm?.enabled) return Promise.reject(new Error('LLM API is disabled'));
  const id = streamId++;
  const iterator = chatStream(args);
  inProgress.set(id, iterator);
  return { id };
});

ipcMain.handle('llm-complete-stream', async (event, args) => {
  const settings = settingsManager.settings || {};
  if (!settings.llm?.enabled) return Promise.reject(new Error('LLM API is disabled'));
  const id = streamId++;
  const iterator = completeStream(args);
  inProgress.set(id, iterator);
  return { id };
});

ipcMain.handle('llm-iterate-next', async (event, args) => {
  const { id } = args;
  if (!inProgress.has(id)) throw new Error('Unknown Iterator');
  const iterator = inProgress.get(id);
  const { done, value } = await iterator.next();
  if (done) inProgress.delete(id);
  return { done, value };
});

ipcMain.handle('llm-iterate-return', async (event, args) => {
  const { id } = args;
  if (!inProgress.has(id)) return;
  const iterator = inProgress.get(id);
  await iterator.return();
  inProgress.delete(id);
});

export async function isSupported() {
  const settings = settingsManager.settings || {};
  if (!settings.llm?.enabled) return false;
  
  // If API key is 'ollama', we treat it as local Ollama service
  if (settings.llm.apiKey === 'ollama') {
    // Local Ollama can always pull models on demand
    return true;
  }
  
  // For other providers, check if API key is set
  return !!settings.llm.apiKey;
}

export function addPreloads(session) {
  // This is handled by unified-preload.js in PeerSky
  // No separate preload needed
}

export async function init() {
  const settings = settingsManager.settings || {};
  if (!settings.llm?.enabled) throw new Error('LLM API is disabled');
  
  const currentModel = settings.llm.model || 'qwen2.5-coder:3b';
  
  // Check if we need to reinitialize for a different model
  if (isInitialized && initializedModel === currentModel) {
    return; // Already initialized with this model
  }
  
  // Reset initialization if model changed
  if (initializedModel && initializedModel !== currentModel) {
    console.log(`Model changed from ${initializedModel} to ${currentModel}, reinitializing...`);
    isInitialized = false;
  }
  
  console.log(`Initializing with model ${currentModel}...`);
  
  try {
    if (!(await hasModel())) {
      console.log(`Model ${currentModel} not found, will be downloaded when settings are updated`);
      // Don't throw error - model will be downloaded when user selects it in settings
    }
  } catch (error) {
    console.error('Error checking for model:', error);
    // Continue anyway - model might be downloaded later
  }
  
  isInitialized = true;
  initializedModel = currentModel; // Remember which model we initialized with
}

async function listModels() {
  try {
    const settings = settingsManager.settings || {};
    
    // OpenRouter doesn't have a list models endpoint we can use
    if (settings.llm.apiKey !== 'ollama' && isOpenRouterURL(settings.llm.baseURL)) {
      return [];
    }
    
    const rawBase = settings.llm.baseURL || 'http://127.0.0.1:11434/';
    const baseURL = rawBase.replace(/\/+$/, '');
    const response = await fetch(`${baseURL}/api/tags`);
    
    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.models || [];
  } catch (error) {
    console.error('Error listing models:', error);
    await maybeShowOllamaNotInstalledDialog(error);
    return [];
  }
}

async function pullModel(progressCallback) {
  const settings = settingsManager.settings || {};
  const rawBase = settings.llm.baseURL || 'http://127.0.0.1:11434/';
  const baseURL = rawBase.replace(/\/+$/, '');

  const modelName = settings.llm.model || 'qwen2.5-coder:3b';
  
  console.log(`Pulling model ${modelName} from ${baseURL}/api/pull`);
  
  currentDownloadModel = modelName;
  currentDownloadPercent = 0;
  
  try {
    // Use streaming to get progress updates
    const response = await fetch(`${baseURL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName, stream: true })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to pull model: ${response.statusText}`);
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let hasError = false;
    let errorMessage = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const data = JSON.parse(line);
            
            // Check for error in response
            if (data.error) {
              hasError = true;
              errorMessage = data.error;
              console.error(`Pull error: ${data.error}`);
              // Check if it's a "not found" error
              if (data.error.includes('not found') || data.error.includes('no such file')) {
                throw new Error(`Model '${modelName}' not found in Ollama library`);
              }
            }
            
            if (data.status) {
              console.log(`Pull status: ${data.status}`);
              // Calculate progress if available
              if (data.completed && data.total) {
                const percent = Math.round((data.completed / data.total) * 100);
                currentDownloadPercent = percent; // Track globally
                if (progressCallback) {
                  progressCallback(percent, data.status);
                }
              } else if (progressCallback) {
                progressCallback(-1, data.status);
              }
            }
          } catch (e) {
            if (e.message && e.message.includes('not found')) {
              throw e; // Re-throw "not found" errors
            }
            console.error('Error parsing pull response:', e);
          }
        }
      }
    }
    
    if (hasError) {
      throw new Error(errorMessage);
    }
    
    console.log(`Model ${modelName} pulled successfully`);
    currentDownloadModel = null;
    return true; // Success
  } catch (error) {
    console.error(`Error pulling model: ${error}`);
    await maybeShowOllamaNotInstalledDialog(error);
    throw error;
  } finally {
    currentDownloadModel = null;
    currentDownloadPercent = 0;
  }
}

async function hasModel() {
  try {
    const settings = settingsManager.settings || {};
    
    // If using OpenRouter, assume model exists (cloud-based)
    if (settings.llm.apiKey !== 'ollama' && isOpenRouterURL(settings.llm.baseURL)) {
      return true;
    }
    
    const models = await listModels();
    const modelName = settings.llm.model || 'qwen2.5-coder:3b';
    // Check if model exists - Ollama models have a 'name' field
    const found = models.find((model) => {
      return model.name === modelName || model.name.startsWith(modelName + ':');
    });
    
    if (found) {
      console.log(`Checking for model ${modelName}: found`);
      return true;
    } else {
      console.log(`Checking for model ${modelName}: not found`);
      return false;
    }
  } catch (error) {
    console.error('Error checking for model:', error);
    await maybeShowOllamaNotInstalledDialog(error);
    return false;
  }
}

// Note: We removed the validateModelExists function because /api/show only works
// for locally installed models, not for checking if a model exists in the Ollama library.
// Instead, we let Ollama's pull endpoint handle validation - it will return an error
// if the model doesn't exist in the library.

export async function chat({
  messages = [],
  temperature,
  maxTokens,
  stop
}) {
  await init();
  const settings = settingsManager.settings || {};
  
  // Get settings first
  const baseURLRaw = settings.llm.baseURL || 'http://127.0.0.1:11434/';
  const apiKey = settings.llm.apiKey || 'ollama';
  const model = settings.llm.model || 'qwen2.5-coder:3b';
  const isOpenRouter = isOpenRouterURL(baseURLRaw);
  
  // Only check if model is installed for Ollama (not OpenRouter)
  if (!isOpenRouter && !(await hasModel())) {
    throw new Error(`Model '${model}' is not installed. Please select it in Settings > AI / LLMs to download it.`);
  }
  
  // Construct the full URL for chat completions
  // OpenRouter: https://openrouter.ai/api/v1/chat/completions
  // Ollama: http://127.0.0.1:11434/v1/chat/completions
  const chatURL = constructChatURL(baseURLRaw);
  
  // Simple request body - let Ollama use its defaults
  console.log('Making chat request to URL:', chatURL);
  const { choices } = await post(chatURL, {
    messages,
    model,
    temperature: temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    stop,
    stream: false
  }, 'Unable to generate chat completion', true, apiKey);

  return choices[0].message;
}

export async function complete({
  prompt,
  temperature,
  maxTokens,
  stop
}) {
  await init();
  
  // Most modern APIs don't have separate completion endpoints
  // Convert to chat format
  return chat({
    messages: [{ role: 'user', content: prompt }],
    temperature,
    maxTokens,
    stop
  });
}

export async function* chatStream({
  messages = [],
  temperature,
  maxTokens,
  stop
} = {}) {
  await init();
  const settings = settingsManager.settings || {};
  
  // Get settings first
  const baseURLRaw = settings.llm.baseURL || 'http://127.0.0.1:11434/';
  const apiKey = settings.llm.apiKey || 'ollama';
  const model = settings.llm.model || 'qwen2.5-coder:3b';
  const isOpenRouter = isOpenRouterURL(baseURLRaw);
  
  // Only check if model is installed for Ollama (not OpenRouter)
  if (!isOpenRouter && !(await hasModel())) {
    throw new Error(`Model '${model}' is not installed. Please select it in Settings > AI / LLMs to download it.`);
  }
  
  // Construct the full URL for chat completions
  const chatURL = constructChatURL(baseURLRaw);
  
  // Simple streaming request - let Ollama use its defaults
  for await (const { choices } of stream(chatURL, {
    messages,
    model,
    temperature: temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    stop
  }, 'Unable to generate chat stream', apiKey)) {
    if (choices && choices[0]?.delta) {
      yield choices[0].delta;
    }
  }
}

export async function* completeStream({
  prompt,
  temperature,
  maxTokens,
  stop
}) {
  // Convert to chat stream
  const messages = [{ role: 'user', content: prompt }];
  try {
    for await (const delta of chatStream({ messages, temperature, maxTokens, stop })) {
      yield delta.content || '';
    }
  } catch (error) {
    await maybeShowOllamaNotInstalledDialog(error);
    throw error;
  }
}

async function* stream(url, data = {}, errorMessage = 'Request failed', apiKey = 'ollama') {
  // Don't add trailing slash - URL should already be complete
  if (!data.stream) data.stream = true;
  
  const headers = {
    'Content-Type': 'application/json; charset=utf8'
  };
  
  // Add authorization header for OpenRouter or other authenticated APIs
  if (apiKey && apiKey !== 'ollama') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
      dispatcher: llmAgent // Use custom agent with no timeouts
    });
    
    if (!response.ok) {
      throw new Error(`${errorMessage} ${await response.text()}`);
    }
    
    const decoder = new TextDecoder('utf-8');
    let remaining = '';
    
    const reader = response.body.getReader();
    
    for await (const chunk of iterate(reader)) {
      remaining += decoder.decode(chunk, { stream: true });
      const lines = remaining.split('\n');
      remaining = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;
          if (data) {
            try {
              yield JSON.parse(data);
            } catch (e) {
              console.error('Failed to parse streaming data:', e, data);
            }
          }
        }
      }
    }
  } catch (error) {
    await maybeShowOllamaNotInstalledDialog(error);
    throw error;
  }
}

async function post(url, data, errorMessage = 'Request failed', parseBody = true, apiKey = 'ollama') {
  const headers = {
    'Content-Type': 'application/json; charset=utf8'
  };
  
  // Add authorization header for OpenRouter or other authenticated APIs
  if (apiKey && apiKey !== 'ollama') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
      dispatcher: llmAgent // Use custom agent with no timeouts
    });

    if (!response.ok) {
      throw new Error(`${errorMessage} ${await response.text()}`);
    }

    if (parseBody) {
      return await response.json();
    }
    return await response.text();
  } catch (error) {
    throw error;
  }
}

async function* iterate(reader) {
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

export default {
  isSupported,
  init,
  chat,
  complete,
  chatStream,
  completeStream
};
