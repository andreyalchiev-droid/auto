/**
 * Autimatiks - Main Application
 * Text Processing Pipeline with Gemini AI
 */

import './style.css';
import { getGeminiService } from './gemini-service.js';
import { Pipeline } from './pipeline.js';
import { loadPrompts, savePrompts, getDefaultPrompts, getPromptMeta, getPromptOrder } from './prompts.js';

// DOM Elements
const elements = {
  // Input
  transcriptionInput: document.getElementById('transcriptionInput'),
  startBtn: document.getElementById('startBtn'),
  inputSection: document.getElementById('inputSection'),

  // Pipeline
  pipelineSection: document.getElementById('pipelineSection'),
  stages: {
    1: document.getElementById('stage1'),
    2: document.getElementById('stage2'),
    3: document.getElementById('stage3'),
    4: document.getElementById('stage4'),
  },

  // Results
  resultsSection: document.getElementById('resultsSection'),
  resultsTitle: document.getElementById('resultsTitle'),
  resultsContent: document.getElementById('resultsContent'),
  copyBtn: document.getElementById('copyBtn'),
  continueBtn: document.getElementById('continueBtn'),

  // Chat
  chatSection: document.getElementById('chatSection'),
  chatMessages: document.getElementById('chatMessages'),

  // Status Bar
  statusBar: document.getElementById('statusBar'),
  statusText: document.getElementById('statusText'),
  statusStage: document.getElementById('statusStage'),

  // Settings
  settingsBtn: document.getElementById('settingsBtn'),
  settingsModal: document.getElementById('settingsModal'),
  closeSettings: document.getElementById('closeSettings'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  modelSelect: document.getElementById('modelSelect'),
  saveSettings: document.getElementById('saveSettings'),

  // Prompts
  promptsBtn: document.getElementById('promptsBtn'),
  promptsModal: document.getElementById('promptsModal'),
  promptsModalBody: document.getElementById('promptsModalBody'),
  closePrompts: document.getElementById('closePrompts'),
  savePrompts: document.getElementById('savePrompts'),
  resetPrompts: document.getElementById('resetPrompts'),
};

// App State
const state = {
  apiKey: localStorage.getItem('autimatiks_apiKey') || 'AIzaSyDzRM1SXywdG6Mn_d-J9Y6v7lX_7B-lX9Y',
  model: localStorage.getItem('autimatiks_model') || 'gemini-3-pro-preview',
  pipeline: null,
  geminiService: null,
};

// Initialize
function init() {
  // Load saved settings
  elements.apiKeyInput.value = state.apiKey;
  elements.modelSelect.value = state.model;

  // Setup event listeners
  setupEventListeners();

  // Show settings modal if no API key
  if (!state.apiKey) {
    showSettingsModal();
  }
}

// Event Listeners
function setupEventListeners() {
  // Start button
  elements.startBtn.addEventListener('click', handleStart);

  // Settings
  elements.settingsBtn.addEventListener('click', showSettingsModal);
  elements.closeSettings.addEventListener('click', hideSettingsModal);
  elements.saveSettings.addEventListener('click', saveSettings);
  elements.settingsModal.addEventListener('click', (e) => {
    if (e.target === elements.settingsModal) hideSettingsModal();
  });

  // Prompts
  elements.promptsBtn.addEventListener('click', showPromptsModal);
  elements.closePrompts.addEventListener('click', hidePromptsModal);
  elements.savePrompts.addEventListener('click', handleSavePrompts);
  elements.resetPrompts.addEventListener('click', handleResetPrompts);
  elements.promptsModal.addEventListener('click', (e) => {
    if (e.target === elements.promptsModal) hidePromptsModal();
  });

  // Copy button
  elements.copyBtn.addEventListener('click', handleCopy);

  // Continue button
  elements.continueBtn.addEventListener('click', handleContinue);

  // Keyboard shortcut for settings (Ctrl/Cmd + ,)
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      showSettingsModal();
    }
    // Ctrl/Cmd + P for prompts
    if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
      e.preventDefault();
      showPromptsModal();
    }
  });
}

// Settings Modal
function showSettingsModal() {
  elements.settingsModal.style.display = 'flex';
}

function hideSettingsModal() {
  elements.settingsModal.style.display = 'none';
}

function saveSettings() {
  const apiKey = elements.apiKeyInput.value.trim();
  const model = elements.modelSelect.value;

  if (!apiKey) {
    showToast('Введите API ключ', 'error');
    return;
  }

  state.apiKey = apiKey;
  state.model = model;

  localStorage.setItem('autimatiks_apiKey', apiKey);
  localStorage.setItem('autimatiks_model', model);

  // Update service if exists
  if (state.geminiService) {
    state.geminiService.setApiKey(apiKey);
    state.geminiService.setModel(model);
  }

  showToast('Настройки сохранены', 'success');
  hideSettingsModal();
}

// Start Pipeline
async function handleStart() {
  const text = elements.transcriptionInput.value.trim();

  if (!text) {
    showToast('Вставьте текст транскрибации', 'error');
    return;
  }

  if (!state.apiKey) {
    showToast('Настройте API ключ', 'error');
    showSettingsModal();
    return;
  }

  // Initialize services
  state.geminiService = getGeminiService(state.apiKey, state.model);
  state.pipeline = new Pipeline(state.geminiService);

  // Setup pipeline callbacks
  state.pipeline.onStageChange = handleStageChange;
  state.pipeline.onProgress = handleProgress;
  state.pipeline.onMessage = handleMessage;
  state.pipeline.onTyping = handleTyping;

  // Setup model fallback notification
  state.geminiService.onModelChange = (newModel, reason) => {
    showToast(`⚠️ ${reason}`, 'warning');
    updateStatus(`Переключено на ${newModel}`, null);
  };

  // Setup retry wait notification with countdown
  state.geminiService.onRetryWait = (seconds, attempt, maxAttempts) => {
    showToast(`⏳ Rate limit, жду ${seconds}с (попытка ${attempt}/${maxAttempts})`, 'info');
    updateStatus(`Ожидание ${seconds}с (лимит API)...`, null);
  };

  // Show pipeline UI
  elements.inputSection.style.display = 'none';
  elements.pipelineSection.style.display = 'block';
  elements.resultsSection.style.display = 'none';
  elements.chatSection.style.display = 'block';
  elements.statusBar.style.display = 'flex';
  elements.startBtn.disabled = true;
  elements.startBtn.innerHTML = '<span class="btn-icon">⏳</span> Обработка...';

  // Initialize status
  updateStatus('Инициализация...', 1);

  // Clear previous results
  elements.chatMessages.innerHTML = '';
  elements.resultsContent.textContent = '';

  try {
    await state.pipeline.start(text);
  } catch (error) {
    showToast(`Ошибка: ${error.message}`, 'error');
    hideStatusBar();
    resetUI();
  }
}

// Continue Pipeline
async function handleContinue() {
  if (!state.pipeline) return;

  elements.continueBtn.style.display = 'none';

  try {
    await state.pipeline.continue();
  } catch (error) {
    showToast(`Ошибка: ${error.message}`, 'error');
  }
}

// Stage Change Handler
function handleStageChange(stage, status) {
  // Update all stages
  for (let i = 1; i <= 4; i++) {
    const stageEl = elements.stages[i];
    stageEl.classList.remove('active', 'completed');

    if (i < stage) {
      stageEl.classList.add('completed');
    } else if (i === stage) {
      if (status === 'active') {
        stageEl.classList.add('active');
      } else if (status === 'completed') {
        stageEl.classList.add('completed');
      }
    }
  }



  // Update results title based on stage
  const titles = {
    1: '🔍 Результаты поиска',
    2: '✍️ Отредактированные блоки',
    3: '🔗 Объединённый текст',
    4: '📝 Готовый результат',
  };
  elements.resultsTitle.textContent = titles[stage] || 'Результат';

  // Update status bar stage
  updateStatus(null, stage);

  // If all stages complete, show final result
  if (stage === 4 && status === 'completed') {
    hideStatusBar();
    elements.resultsSection.style.display = 'block';
    showFinalResult();
  }
}

// Progress Handler
function handleProgress(message) {
  // Update status bar
  updateStatus(message);

  // Update the active stage description
  const activeStage = document.querySelector('.stage.active');
  if (activeStage) {
    const desc = activeStage.querySelector('.stage-desc');
    if (desc) {
      desc.textContent = message;
    }
  }
}

// Update Status Bar
function updateStatus(text, stage = null) {
  elements.statusText.textContent = text;
  if (stage !== null) {
    elements.statusStage.textContent = `Этап ${stage} из 4`;
  }
}

// Hide Status Bar
function hideStatusBar() {
  elements.statusBar.style.display = 'none';
}

// Show/Hide Typing Indicator
function showTypingIndicator() {
  let indicator = document.getElementById('typingIndicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'typingIndicator';
    indicator.className = 'chat-typing-indicator';
    indicator.innerHTML = '<span></span><span></span><span></span> Gemini думает...';
  }
  elements.chatMessages.appendChild(indicator);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function hideTypingIndicator() {
  const indicator = document.getElementById('typingIndicator');
  if (indicator) indicator.remove();
}

// Handle Typing State
function handleTyping(isTyping) {
  if (isTyping) {
    showTypingIndicator();
  } else {
    hideTypingIndicator();
  }
}

// Message Handler
function handleMessage(role, text) {
  // Add to chat
  const messageEl = document.createElement('div');
  messageEl.className = `chat-message ${role}`;

  const roleLabel = document.createElement('div');
  roleLabel.className = 'chat-message-role';
  roleLabel.textContent = role === 'user' ? 'Вы' : 'Gemini';

  const content = document.createElement('div');
  content.className = 'chat-message-content';
  content.innerHTML = formatMessage(text);

  messageEl.appendChild(roleLabel);
  messageEl.appendChild(content);
  elements.chatMessages.appendChild(messageEl);

  // Scroll to bottom
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;

  // Update results with latest assistant message
  if (role === 'assistant') {
    elements.resultsContent.innerHTML = formatMessage(text);
  }
}

// Format message with markdown support
function formatMessage(text) {
  // Basic markdown formatting
  return text
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Line breaks
    .replace(/\n/g, '<br>');
}

// Show Final Result
function showFinalResult() {
  const result = state.pipeline.getFinalResult();

  elements.resultsContent.innerHTML = `
    <div style="margin-bottom: 20px;">
      <h3 style="color: var(--accent-primary); margin-bottom: 10px;">Заголовок:</h3>
      <p>${formatMessage(result.title)}</p>
    </div>
    <div>
      <h3 style="color: var(--accent-primary); margin-bottom: 10px;">Текст:</h3>
      <div>${formatMessage(result.text)}</div>
    </div>
  `;

  elements.continueBtn.style.display = 'none';

  // Add Log Button if not exists
  if (!document.getElementById('logBtn')) {
    const btn = document.createElement('button');
    btn.id = 'logBtn';
    btn.className = 'secondary-btn';
    btn.innerHTML = '<span>📜</span> Лог диалога';
    btn.onclick = downloadLog;
    btn.style.marginLeft = '10px';
    document.querySelector('.results-actions').appendChild(btn);
  }

  resetUI();
  showToast('Обработка завершена!', 'success');
}

function downloadLog() {
  if (!state.geminiService) return;
  const log = state.geminiService.getLog();
  const blob = new Blob([log], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `autimatiks-log-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

// Copy to Clipboard
async function handleCopy() {
  const result = state.pipeline?.getFinalResult();

  // Helper to strip markdown
  const stripMarkdown = (text) => {
    if (!text) return '';
    return text
      .replace(/\*\*(.+?)\*\*/g, '$1') // Bold **text** -> text
      .replace(/\*(.+?)\*/g, '$1')     // Italic *text* -> text
      .replace(/__((?:.|\n)+?)__/g, '$1') // Bold __text__ -> text
      .replace(/_((?:.|\n)+?)_/g, '$1')   // Italic _text_ -> text
      .replace(/`(.+?)`/g, '$1')       // Code `text` -> text
      .replace(/^#+\s+/gm, '')          // Headers
      .replace(/\[(.+?)\]\(.+?\)/g, '$1'); // Links [text](url) -> text
  };

  if (!result) {
    // Copy current visible content
    const content = elements.resultsContent.innerText;
    // innerText should already be plain text from the DOM, but let's be safe if there are artifacts
    // Actually innerText gives the rendered text, so <strong>foo</strong> becomes foo. 
    // However, if the text itself contained * chars that weren't rendered as HTML, they will be there.
    // Given the user flow, the result object is usually available when they want to copy the final artifact.
    await copyToClipboard(content);
    return;
  }

  const textToCopy = `${stripMarkdown(result.title)}\n\n${stripMarkdown(result.text)}`;
  await copyToClipboard(textToCopy);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Скопировано в буфер обмена', 'success');
  } catch (error) {
    showToast('Ошибка копирования', 'error');
  }
}

// Reset UI
function resetUI() {
  elements.startBtn.disabled = false;
  elements.startBtn.innerHTML = '<span class="btn-icon">▶️</span> Запустить обработку';
  elements.inputSection.style.display = 'block';
}

// Toast Notifications
function showToast(message, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️',
  };

  toast.innerHTML = `<span>${icons[type] || ''}</span> ${message}`;
  container.appendChild(toast);

  // Auto remove
  setTimeout(() => {
    toast.style.animation = 'slideInRight var(--transition-normal) reverse';
    setTimeout(() => toast.remove(), 250);
  }, 3000);
}
// ===== Prompts Editor =====

function showPromptsModal() {
  renderPromptsForm();
  elements.promptsModal.style.display = 'flex';
}

function hidePromptsModal() {
  elements.promptsModal.style.display = 'none';
}

/**
 * Render the prompts form dynamically
 */
function renderPromptsForm(promptsOverride) {
  const currentPrompts = promptsOverride || loadPrompts();
  const defaults = getDefaultPrompts();
  const meta = getPromptMeta();
  const order = getPromptOrder();

  elements.promptsModalBody.innerHTML = '';

  for (const key of order) {
    const isModified = currentPrompts[key] !== defaults[key];

    const group = document.createElement('div');
    group.className = 'prompt-group' + (isModified ? ' prompt-modified' : '');

    const header = document.createElement('div');
    header.className = 'prompt-group-header';

    const label = document.createElement('label');
    label.setAttribute('for', `prompt_${key}`);
    label.textContent = meta[key].label;

    const badge = document.createElement('span');
    badge.className = 'prompt-badge';
    badge.textContent = isModified ? '✏️ изменён' : '✅ по умолчанию';

    header.appendChild(label);
    header.appendChild(badge);

    const desc = document.createElement('p');
    desc.className = 'prompt-description';
    desc.textContent = meta[key].description;

    const textarea = document.createElement('textarea');
    textarea.id = `prompt_${key}`;
    textarea.className = 'prompt-textarea';
    textarea.value = currentPrompts[key];
    textarea.dataset.key = key;
    textarea.spellcheck = false;

    // Character count
    const charCount = document.createElement('div');
    charCount.className = 'prompt-char-count';
    charCount.textContent = `${currentPrompts[key].length} символов`;

    textarea.addEventListener('input', () => {
      charCount.textContent = `${textarea.value.length} символов`;
      // Update modified badge in real time
      const modified = textarea.value !== defaults[key];
      group.classList.toggle('prompt-modified', modified);
      badge.textContent = modified ? '✏️ изменён' : '✅ по умолчанию';
    });

    group.appendChild(header);
    group.appendChild(desc);
    group.appendChild(textarea);
    group.appendChild(charCount);
    elements.promptsModalBody.appendChild(group);
  }
}

/**
 * Save prompts from the form
 */
function handleSavePrompts() {
  const order = getPromptOrder();
  const prompts = {};

  for (const key of order) {
    const textarea = document.getElementById(`prompt_${key}`);
    if (textarea) {
      prompts[key] = textarea.value;
    }
  }

  if (savePrompts(prompts)) {
    showToast('Промпты сохранены! Новые промпты будут использованы при следующем запуске.', 'success');
    hidePromptsModal();
  } else {
    showToast('Ошибка сохранения промптов', 'error');
  }
}

/**
 * Reset prompts to defaults
 */
function handleResetPrompts() {
  if (confirm('Сбросить все промпты к значениям по умолчанию?')) {
    const defaults = getDefaultPrompts();
    renderPromptsForm(defaults);
    showToast('Промпты сброшены. Нажмите «Сохранить» чтобы применить.', 'info');
  }
}

// Initialize app
init();
