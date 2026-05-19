/**
 * Gemini API Service - Multi-turn conversation handler
 * Supports grounding (Google Search) for research stage
 */

export class GeminiService {
  constructor(apiKey, model = 'gemini-3.1-pro-preview') {
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
        maxOutputTokens: this._getMaxOutputTokens(),
      }
    };

    if (useGrounding) {
      requestBody.tools = [{
        googleSearch: {}
      }];
    }

    let response;
    try {
      response = await fetch(
        `${this.baseUrl}/${this.model}:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody)
        }
      );
    } catch (error) {
      const networkError = this._buildNetworkError(error);

      if (this._isRetryableNetworkError(error) && retryCount < MAX_RETRIES) {
        const delay = this._getRetryDelay(networkError.message, retryCount);
        if (this.onRetryWait) {
          this.onRetryWait(Math.ceil(delay / 1000), retryCount + 1, MAX_RETRIES, 'network');
        }

        await this._delay(delay);
        return this._requestWithRetries(contents, useGrounding, retryCount + 1);
      }

      throw networkError;
    }

    if (!response.ok) {
      const errorData = await this._readError(response);
      const errorMessage = errorData.error?.message || `API Error: ${response.status}`;
      const apiError = this._buildApiError(response, errorData, errorMessage);

      if (this._isRetryable(response.status, errorMessage)) {
        if (retryCount < MAX_RETRIES) {
          const delay = this._getRetryDelay(errorMessage, retryCount);
          if (this.onRetryWait) {
            this.onRetryWait(Math.ceil(delay / 1000), retryCount + 1, MAX_RETRIES, 'rate');
          }

          await this._delay(delay);
          return this._requestWithRetries(contents, useGrounding, retryCount + 1);
        }
      }

      throw apiError;
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    const assistantMessage = candidate?.content;
    const responseText = this._extractText(assistantMessage);

    if (!responseText.trim()) {
      const emptyResponseError = this._buildEmptyResponseError(data);

      if (this._shouldRetryEmpty(emptyResponseError, retryCount, MAX_RETRIES)) {
        const delay = this._getRetryDelay(emptyResponseError.message, retryCount);
        if (this.onRetryWait) {
          this.onRetryWait(Math.ceil(delay / 1000), retryCount + 1, MAX_RETRIES, 'empty');
        }

        await this._delay(delay);
        return this._requestWithRetries(contents, useGrounding, retryCount + 1);
      }

      throw emptyResponseError;
    }

    const groundingMetadata = candidate?.groundingMetadata;

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

  _extractText(content) {
    return (content?.parts || [])
      .map(part => part.text || '')
      .join('');
  }

  _buildEmptyResponseError(data) {
    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const finishMessage = candidate?.finishMessage;
    const promptFeedback = data.promptFeedback;
    const blockReason = promptFeedback?.blockReason;
    const blockReasonMessage = promptFeedback?.blockReasonMessage;
    const safetyDetails = this._formatSafetyRatings(candidate?.safetyRatings || promptFeedback?.safetyRatings);

    const parts = [];
    if (blockReason) {
      parts.push(`запрос заблокирован фильтром Gemini: ${blockReason}`);
    } else if (finishReason) {
      parts.push(`Gemini остановился без текста: ${finishReason}`);
    } else {
      parts.push('Gemini вернул пустой ответ без текста');
    }

    if (finishMessage) parts.push(finishMessage);
    if (blockReasonMessage) parts.push(blockReasonMessage);
    if (safetyDetails) parts.push(`safety: ${safetyDetails}`);

    const error = new Error(parts.join('. '));
    error.name = 'GeminiEmptyResponseError';
    error.finishReason = finishReason || null;
    error.blockReason = blockReason || null;
    error.details = data;
    return error;
  }

  _formatSafetyRatings(ratings = []) {
    if (!Array.isArray(ratings) || ratings.length === 0) return '';

    return ratings
      .filter(rating => rating?.blocked || ['MEDIUM', 'HIGH'].includes(rating?.probability))
      .map(rating => `${rating.category}:${rating.probability}${rating.blocked ? ':blocked' : ''}`)
      .join(', ');
  }

  _shouldRetryEmpty(error, retryCount, maxRetries) {
    if (retryCount >= maxRetries) return false;

    return !['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(error.finishReason)
      && !error.blockReason;
  }

  _buildApiError(response, errorData, errorMessage) {
    const status = errorData.error?.status || response.statusText || 'UNKNOWN';
    const message = `Gemini API ${response.status} ${status}: ${errorMessage}`;
    const error = new Error(message);
    error.status = response.status;
    error.details = errorData;
    return error;
  }

  _buildNetworkError(error) {
    const message = error?.message || 'network request failed';
    const apiError = new Error(`Gemini API network error: ${message}`);
    apiError.name = 'GeminiNetworkError';
    apiError.cause = error;
    return apiError;
  }

  _isRetryableNetworkError(error) {
    const code = error?.cause?.code || error?.code || '';
    const message = (error?.message || '').toLowerCase();

    return error?.name === 'TypeError'
      || message.includes('fetch failed')
      || ['UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code);
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

  _getMaxOutputTokens() {
    if (this.model.includes('gemini-3')) return 32768;
    return 16384;
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
