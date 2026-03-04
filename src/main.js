/**
 * Autimatiks - Main Application
 * Text Processing Pipeline with Gemini AI
 */

import './style.css';
import { getGeminiService } from './gemini-service.js';
import { Pipeline } from './pipeline.js';
import { loadPrompts, savePrompts, getDefaultPrompts } from './prompts.js';

// DOM Elements
const elements = {
  // Input
  transcriptionInput: document.getElementById('transcriptionInput'),
  startBtn: document.getElementById('startBtn'),
  inputSection: document.getElementById('inputSection'),

  // Pipeline
  pipelineSection: document.getElementById('pipelineSection'),
  pipelineStages: document.getElementById('pipelineStages'),

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
  addPromptBtn: document.getElementById('addPromptBtn'),
};

// App State
const state = {
  apiKey: localStorage.getItem('autimatiks_apiKey') || '',
  model: localStorage.getItem('autimatiks_model') || 'gemini-3.1-pro-preview',
  pipeline: null,
  geminiService: null,
  currentPromptsEditorState: [],
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
  elements.addPromptBtn.addEventListener('click', handleAddPrompt);
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

  try {
    // Generate pipeline UI dynamically BEFORE start so we have the array of active prompts.
    const prompts = loadPrompts().filter(p => p.enabled);
    if (prompts.length === 0) {
      showToast('Нет включенных промптов в настройках!', 'error');
      return;
    }
    renderPipelineStages(prompts);

    // Show pipeline UI
    elements.inputSection.style.display = 'none';
    elements.pipelineSection.style.display = 'block';
    elements.resultsSection.style.display = 'none';
    elements.chatSection.style.display = 'block';
    elements.statusBar.style.display = 'flex';
    elements.startBtn.disabled = true;
    elements.startBtn.innerHTML = '<span class="btn-icon">⏳</span> Обработка...';

    // Initialize status
    updateStatus('Инициализация...', 1, prompts.length);

    // Clear previous results
    elements.chatMessages.innerHTML = '';
    elements.resultsContent.textContent = '';

    await state.pipeline.start(text);

    // Finished successfully
    hideStatusBar();
    elements.resultsSection.style.display = 'block';
    showFinalResult();

  } catch (error) {
    showToast(`Ошибка: ${error.message}`, 'error');
    hideStatusBar();
    resetUI();
  }
}

// Generate Pipeline HTML
function renderPipelineStages(prompts) {
  elements.pipelineStages.innerHTML = '';

  prompts.forEach((prompt, index) => {
    // Stage container
    const stageDiv = document.createElement('div');
    stageDiv.className = 'stage';
    stageDiv.dataset.stage = index + 1;

    // Indicator
    const indicator = document.createElement('div');
    indicator.className = 'stage-indicator';
    indicator.innerHTML = `<span class="stage-number">${index + 1}</span><span class="stage-status"></span>`;

    // Content
    const content = document.createElement('div');
    content.className = 'stage-content';

    // Need a clean short title based on stage purpose
    const safeTitle = prompt.label.split(':').pop().trim();
    const shortDesc = prompt.description || 'Кастомный промпт';

    content.innerHTML = `<h3 class="stage-title">${safeTitle}</h3><p class="stage-desc">${shortDesc}</p>`;

    stageDiv.appendChild(indicator);
    stageDiv.appendChild(content);

    elements.pipelineStages.appendChild(stageDiv);

    // Connector lines between stages
    if (index < prompts.length - 1) {
      const connector = document.createElement('div');
      connector.className = 'stage-connector';
      elements.pipelineStages.appendChild(connector);
    }
  });
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
  const stageElements = elements.pipelineStages.querySelectorAll('.stage');
  const totalStages = stageElements.length;

  // Update all stages classes
  stageElements.forEach((el, index) => {
    const elStage = index + 1;
    el.classList.remove('active', 'completed');
    if (elStage < stage) {
      el.classList.add('completed');
    } else if (elStage === stage) {
      if (status === 'active') el.classList.add('active');
      if (status === 'completed') el.classList.add('completed');
    }
  });

  // Update results title based on stage
  if (state.pipeline && state.pipeline.prompts) {
    const currentPrompt = state.pipeline.prompts[stage - 1];
    if (currentPrompt) {
      elements.resultsTitle.textContent = currentPrompt.label;
    }
  }

  // Update status bar stage
  updateStatus(null, stage, totalStages);
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
function updateStatus(text, stage = null, total = null) {
  if (text !== null) elements.statusText.textContent = text;

  if (stage !== null && total !== null) {
    elements.statusStage.textContent = `Этап ${stage} из ${total}`;
  } else if (stage !== null) {
    const parts = elements.statusStage.textContent.split(' из ');
    if (parts.length === 2) {
      elements.statusStage.textContent = `Этап ${stage} из ${parts[1]}`;
    }
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
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

// Show Final Result
function showFinalResult() {
  const result = state.pipeline.getFinalResult();

  let html = '';
  if (result.title) {
    html += `
        <div style="margin-bottom: 20px;">
          <h3 style="color: var(--accent-primary); margin-bottom: 10px;">Заголовок:</h3>
          <p>${formatMessage(result.title)}</p>
        </div>
      `;
  }
  if (result.text) {
    html += `
        <div>
          <h3 style="color: var(--accent-primary); margin-bottom: 10px;">Текст:</h3>
          <div>${formatMessage(result.text)}</div>
        </div>
      `;
  }

  elements.resultsContent.innerHTML = html;
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

  const stripMarkdown = (text) => {
    if (!text) return '';
    return text
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/__((?:.|\n)+?)__/g, '$1')
      .replace(/_((?:.|\n)+?)_/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/^#+\s+/gm, '')
      .replace(/\[(.+?)\]\(.+?\)/g, '$1');
  };

  if (!result || (!result.title && !result.text)) {
    const content = elements.resultsContent.innerText;
    await copyToClipboard(content);
    return;
  }

  const textToCopy = [stripMarkdown(result.title), stripMarkdown(result.text)].filter(Boolean).join('\n\n');
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

  setTimeout(() => {
    toast.style.animation = 'slideInRight var(--transition-normal) reverse';
    setTimeout(() => toast.remove(), 250);
  }, 3000);
}

// ===== Prompts Editor =====

function showPromptsModal() {
  state.currentPromptsEditorState = loadPrompts();
  renderPromptsForm();
  elements.promptsModal.style.display = 'flex';
}

function hidePromptsModal() {
  elements.promptsModal.style.display = 'none';
}

function handleAddPrompt() {
  const newId = 'custom_' + Date.now();
  state.currentPromptsEditorState.push({
    id: newId,
    type: 'standard',
    label: '✨ Пользовательский промпт',
    description: 'Ваш собственный шаг обработки',
    text: 'Сделай следующее: ',
    enabled: true,
    isCustom: true
  });
  renderPromptsForm();
  // scroll to bottom
  setTimeout(() => {
    elements.promptsModalBody.scrollTop = elements.promptsModalBody.scrollHeight;
  }, 100);
}

function renderPromptsForm() {
  const currentPrompts = state.currentPromptsEditorState;
  const defaults = getDefaultPrompts();

  elements.promptsModalBody.innerHTML = '';

  currentPrompts.forEach((prompt, index) => {
    const isCustom = prompt.isCustom;
    let isModified = false;

    if (!isCustom) {
      const def = defaults.find(d => d.id === prompt.id);
      if (def && prompt.text !== def.text) {
        isModified = true;
      }
    }

    const group = document.createElement('div');
    group.className = 'prompt-group' + (isModified ? ' prompt-modified' : '');
    if (!prompt.enabled) {
      group.classList.add('prompt-disabled');
      group.style.opacity = '0.6';
    }

    const header = document.createElement('div');
    header.className = 'prompt-group-header';

    const headerLeft = document.createElement('div');
    headerLeft.style.display = 'flex';
    headerLeft.style.alignItems = 'center';
    headerLeft.style.gap = 'var(--space-md)';

    // Toggle switch
    const toggleContainer = document.createElement('label');
    toggleContainer.className = 'toggle-switch';
    toggleContainer.innerHTML = `
        <input type="checkbox" id="toggle_${prompt.id}" ${prompt.enabled ? 'checked' : ''}>
        <span class="toggle-slider"></span>
    `;

    const toggleInput = toggleContainer.querySelector('input');
    toggleInput.addEventListener('change', (e) => {
      prompt.enabled = e.target.checked;
      if (prompt.enabled) {
        group.classList.remove('prompt-disabled');
        group.style.opacity = '1';
      } else {
        group.classList.add('prompt-disabled');
        group.style.opacity = '0.6';
      }
    });

    const label = document.createElement('label');
    label.setAttribute('for', `prompt_${prompt.id}`);
    label.textContent = prompt.label;

    headerLeft.appendChild(toggleContainer);
    headerLeft.appendChild(label);

    const headerRight = document.createElement('div');
    headerRight.style.display = 'flex';
    headerRight.style.alignItems = 'center';
    headerRight.style.gap = 'var(--space-sm)';

    if (!isCustom) {
      const badge = document.createElement('span');
      badge.className = 'prompt-badge';
      badge.textContent = isModified ? '✏️ изменён' : '✅ по умолчанию';
      headerRight.appendChild(badge);
    } else {
      const delBtn = document.createElement('button');
      delBtn.innerHTML = '🗑️';
      delBtn.style.background = 'none';
      delBtn.style.border = 'none';
      delBtn.style.cursor = 'pointer';
      delBtn.title = 'Удалить';
      delBtn.onclick = () => {
        if (confirm('Удалить этот промпт?')) {
          state.currentPromptsEditorState.splice(index, 1);
          renderPromptsForm();
        }
      };
      headerRight.appendChild(delBtn);
    }

    header.appendChild(headerLeft);
    header.appendChild(headerRight);

    let desc;
    if (isCustom) {
      desc = document.createElement('input');
      desc.className = 'text-field';
      desc.style.marginBottom = 'var(--space-md)';
      desc.style.padding = 'var(--space-sm)';
      desc.value = prompt.label;
      desc.placeholder = 'Название этапа';
      desc.addEventListener('input', () => {
        prompt.label = desc.value;
      });
    } else {
      desc = document.createElement('p');
      desc.className = 'prompt-description';
      desc.textContent = prompt.description;
    }

    const textarea = document.createElement('textarea');
    textarea.id = `prompt_${prompt.id}`;
    textarea.className = 'prompt-textarea';
    textarea.value = prompt.text;
    textarea.dataset.id = prompt.id;
    textarea.spellcheck = false;

    // Disable textarea if prompt is disabled
    textarea.disabled = !prompt.enabled;
    toggleInput.addEventListener('change', (e) => {
      textarea.disabled = !e.target.checked;
    });

    // Character count
    const charCount = document.createElement('div');
    charCount.className = 'prompt-char-count';
    charCount.textContent = `${prompt.text.length} символов`;

    textarea.addEventListener('input', () => {
      prompt.text = textarea.value;
      charCount.textContent = `${textarea.value.length} символов`;

      if (!isCustom) {
        const def = defaults.find(d => d.id === prompt.id);
        const modified = textarea.value !== (def ? def.text : '');
        group.classList.toggle('prompt-modified', modified);
        const badge = headerRight.querySelector('.prompt-badge');
        if (badge) badge.textContent = modified ? '✏️ изменён' : '✅ по умолчанию';
      }
    });

    group.appendChild(header);
    group.appendChild(desc);
    group.appendChild(textarea);
    group.appendChild(charCount);
    elements.promptsModalBody.appendChild(group);
  });
}

function handleSavePrompts() {
  if (savePrompts(state.currentPromptsEditorState)) {
    showToast('Промпты сохранены! Новые промпты будут использованы при следующем запуске.', 'success');
    hidePromptsModal();
  } else {
    showToast('Ошибка сохранения промптов', 'error');
  }
}

function handleResetPrompts() {
  if (confirm('Сбросить все промпты к значениям по умолчанию? \nВсе пользовательские промпты будут удалены.')) {
    state.currentPromptsEditorState = getDefaultPrompts();
    renderPromptsForm();
    showToast('Промпты сброшены. Нажмите «Сохранить» чтобы применить.', 'info');
  }
}

// Initialize app
init();
