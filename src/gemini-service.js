/**
 * Gemini API Service - Multi-turn conversation handler
 * Supports grounding (Google Search) for research stage
 */

export class GeminiService {
  constructor(apiKey, model = 'gemini-2.5-flash') {
    this.apiKey = apiKey;
    this.model = model;
    this.conversationHistory = [];
    this.requestLog = [];
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
  }

  /**
   * Reset conversation history
   */
  reset() {
    this.conversationHistory = [];
    this.requestLog = [];
  }

  /**
   * Send message with Google Search grounding (for Stage 1)
   */
  async sendWithSearch(message, options = {}) {
    return this._send(message, true, options);
  }

  /**
   * Send regular message (for Stages 2-4)
   */
  async send(message, options = {}) {
    return this._send(message, false, options);
  }

  /**
   * Internal send method with retry logic.
   * useHistory=false keeps the user's semantic context explicit without
   * resending the whole raw API chat on every pipeline step.
   */
  async _send(message, useGrounding = false, options = {}) {
    const useHistory = options.useHistory !== false;
    const userMessage = {
      role: 'user',
      parts: [{ text: message }]
    };

    if (useHistory) {
      this.conversationHistory.push(userMessage);
    }

    const contents = useHistory ? this.conversationHistory : [userMessage];

    try {
      const result = await this._requestWithRetries(contents, useGrounding);
      const assistantMessage = result.assistantMessage;

      if (useHistory) {
        this.conversationHistory.push(assistantMessage);
      }

      this.requestLog.push(userMessage, assistantMessage);

      return result;
    } catch (error) {
      if (useHistory) {
        this.conversationHistory.pop();
      }
      throw error;
    }
  }

  async _requestWithRetries(contents, useGrounding = false, retryCount = 0) {
    const MAX_RETRIES = 5;
    const requestBody = {
      contents,
      generationConfig: {
        temperature: this.model.includes('gemini-3') ? 1.0 : 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 8192,
      }
    };

    if (useGrounding) {
      requestBody.tools = [{
        googleSearch: {}
      }];
    }

    const response = await fetch(
      `${this.baseUrl}/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const errorData = await this._readError(response);
      const errorMessage = errorData.error?.message || `API Error: ${response.status}`;
      const apiError = this._buildApiError(response, errorData, errorMessage);

      if (this._isRetryable(response.status, errorMessage)) {
        const fallbackModel = this._getFallbackModel();
        if (fallbackModel && retryCount === 0) {
          this.model = fallbackModel;
          if (this.onModelChange) {
            this.onModelChange(fallbackModel, `Gemini вернул ${response.status}. Переключаюсь на ${fallbackModel} и продолжаю.`);
          }
          return this._requestWithRetries(contents, useGrounding, retryCount + 1);
        }

        if (retryCount < MAX_RETRIES) {
          const delay = this._getRetryDelay(errorMessage, retryCount);
          if (this.onRetryWait) {
            this.onRetryWait(Math.ceil(delay / 1000), retryCount + 1, MAX_RETRIES);
          }

          await this._delay(delay);
          return this._requestWithRetries(contents, useGrounding, retryCount + 1);
        }
      }

      throw apiError;
    }

    const data = await response.json();
    const assistantMessage = data.candidates?.[0]?.content;

    if (!assistantMessage) {
      const finishReason = data.candidates?.[0]?.finishReason;
      throw new Error(finishReason ? `Gemini stopped without text: ${finishReason}` : 'Empty response from API');
    }

    const responseText = assistantMessage.parts
      .map(part => part.text || '')
      .join('');

    const groundingMetadata = data.candidates?.[0]?.groundingMetadata;

    return {
      text: responseText,
      grounding: groundingMetadata,
      fullResponse: data,
      assistantMessage
    };
  }

  async _readError(response) {
    try {
      return await response.json();
    } catch {
      return {
        error: {
          message: await response.text().catch(() => response.statusText),
          status: response.statusText
        }
      };
    }
  }

  _buildApiError(response, errorData, errorMessage) {
    const status = errorData.error?.status || response.statusText || 'UNKNOWN';
    const message = `Gemini API ${response.status} ${status}: ${errorMessage}`;
    const error = new Error(message);
    error.status = response.status;
    error.details = errorData;
    return error;
  }

  _isRetryable(status, message) {
    const normalized = message.toLowerCase();
    return [429, 500, 502, 503, 504].includes(status)
      || normalized.includes('quota')
      || normalized.includes('rate')
      || normalized.includes('exceeded')
      || normalized.includes('overload')
      || normalized.includes('high demand')
      || normalized.includes('deadline');
  }

  _getFallbackModel() {
    if (this.model.includes('gemini-3') || this.model.includes('pro-preview')) {
      return 'gemini-2.5-flash';
    }

    if (this.model === 'gemini-2.5-flash') {
      return 'gemini-2.5-flash-lite';
    }

    return null;
  }

  _getRetryDelay(message, retryCount) {
    const retryMatch = message.match(/retry in (\d+\.?\d*)s/i);
    if (retryMatch) {
      return Math.ceil(parseFloat(retryMatch[1]) * 1000) + 1000;
    }

    return Math.pow(2, retryCount) * 2500 + Math.random() * 1000;
  }

  /**
   * Helper delay for retry
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current conversation history for display
   */
  getHistory() {
    return this.requestLog.map(msg => ({
      role: msg.role,
      text: msg.parts.map(p => p.text || '').join('')
    }));
  }

  /**
   * Get formatted conversation log for export
   */
  getLog() {
    return this.requestLog.map(msg => {
      const role = msg.role === 'user' ? 'USER' : 'MODEL';
      const text = msg.parts ? msg.parts.map(p => p.text).join('') : (msg.content || '');
      return `### ${role}:\n${text}\n\n`;
    }).join('---\n\n');
  }

  /**
   * Set API key
   */
  setApiKey(key) {
    this.apiKey = key;
  }

  /**
   * Set model
   */
  setModel(model) {
    this.model = model;
  }
}

/**
 * Text chunker - splits text into semantic blocks
 */
export function chunkText(text, minSize = 200, maxSize = 500) {
  const chunks = [];

  // Split by double newlines (paragraphs) first
  const paragraphs = text.split(/\n\s*\n/);

  let currentChunk = '';

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // If adding this paragraph would exceed maxSize, save current and start new
    if (currentChunk && (currentChunk.length + trimmed.length + 2) > maxSize) {
      if (currentChunk.length >= minSize) {
        chunks.push(currentChunk.trim());
        currentChunk = trimmed;
      } else {
        // Current chunk too small, try to split paragraph by sentences
        currentChunk += '\n\n' + trimmed;
      }
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + trimmed;
    }

    // If current chunk exceeds maxSize, we need to split it
    if (currentChunk.length > maxSize) {
      const sentenceChunks = splitBySentences(currentChunk, minSize, maxSize);
      if (sentenceChunks.length > 1) {
        chunks.push(...sentenceChunks.slice(0, -1));
        currentChunk = sentenceChunks[sentenceChunks.length - 1];
      }
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Helper to split by sentences
 */
function splitBySentences(text, minSize, maxSize) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if ((current + sentence).length > maxSize && current.length >= minSize) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

// Singleton instance
let serviceInstance = null;

export function getGeminiService(apiKey, model) {
  if (!serviceInstance || (apiKey && serviceInstance.apiKey !== apiKey)) {
    serviceInstance = new GeminiService(apiKey, model);
  } else if (model && serviceInstance.model !== model) {
    serviceInstance.setModel(model);
  }
  return serviceInstance;
}
