/**
 * Gemini API Service - Multi-turn conversation handler
 * Supports grounding (Google Search) for research stage
 */

export class GeminiService {
  constructor(apiKey, model = 'gemini-2.0-flash') {
    this.apiKey = apiKey;
    this.model = model;
    this.conversationHistory = [];
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
  }

  /**
   * Reset conversation history
   */
  reset() {
    this.conversationHistory = [];
  }

  /**
   * Send message with Google Search grounding (for Stage 1)
   */
  async sendWithSearch(message) {
    return this._send(message, true);
  }

  /**
   * Send regular message (for Stages 2-4)
   */
  async send(message) {
    return this._send(message, false);
  }

  /**
   * Internal send method with retry logic
   */
  async _send(message, useGrounding = false, retryCount = 0) {
    const MAX_RETRIES = 3;
    const FALLBACK_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash'];

    // Add user message to history (only on first attempt)
    if (retryCount === 0) {
      this.conversationHistory.push({
        role: 'user',
        parts: [{ text: message }]
      });
    }

    const requestBody = {
      contents: this.conversationHistory,
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 8192,
      }
    };

    // Add grounding for search capability
    if (useGrounding) {
      requestBody.tools = [{
        googleSearch: {}
      }];
    }

    try {
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
        const errorData = await response.json();
        const errorMessage = errorData.error?.message || `API Error: ${response.status}`;

        // Check for quota/rate limit errors
        if (response.status === 429 || errorMessage.includes('quota') || errorMessage.includes('rate') || errorMessage.includes('exceeded')) {
          console.warn(`Rate limit hit (attempt ${retryCount + 1}/${MAX_RETRIES}):`, errorMessage);

          // Try fallback model if available and not already on fallback
          if (this.model.includes('gemini-3') || this.model.includes('pro-preview')) {
            const fallbackModel = FALLBACK_MODELS[0];
            console.warn(`Switching to fallback model: ${fallbackModel}`);
            this.model = fallbackModel;

            // Notify about model change if callback exists
            if (this.onModelChange) {
              this.onModelChange(fallbackModel, 'Gemini 3 Pro недоступен, переключаемся на Gemini 2.0 Flash');
            }

            return this._send(message, useGrounding, retryCount);
          }

          // Parse retry time from error message (e.g., "retry in 37.427166332s")
          let delay = Math.pow(2, retryCount) * 2000 + Math.random() * 1000;
          const retryMatch = errorMessage.match(/retry in (\d+\.?\d*)s/i);
          if (retryMatch) {
            delay = Math.ceil(parseFloat(retryMatch[1]) * 1000) + 1000; // Add 1 second buffer
            console.log(`API suggests retry in ${retryMatch[1]}s, waiting ${delay}ms...`);
          }

          // Exponential backoff retry
          if (retryCount < MAX_RETRIES) {
            // Notify about wait time
            if (this.onRetryWait) {
              this.onRetryWait(Math.ceil(delay / 1000), retryCount + 1, MAX_RETRIES);
            }

            console.log(`Retrying in ${delay}ms...`);
            await this._delay(delay);
            return this._send(message, useGrounding, retryCount + 1);
          }
        }

        throw new Error(errorMessage);
      }

      const data = await response.json();

      // Extract response text
      const assistantMessage = data.candidates?.[0]?.content;

      if (!assistantMessage) {
        throw new Error('Empty response from API');
      }

      // Add assistant response to history
      this.conversationHistory.push(assistantMessage);

      // Extract text from parts
      const responseText = assistantMessage.parts
        .map(part => part.text || '')
        .join('');

      // Extract grounding metadata if available
      const groundingMetadata = data.candidates?.[0]?.groundingMetadata;

      return {
        text: responseText,
        grounding: groundingMetadata,
        fullResponse: data
      };
    } catch (error) {
      // Remove the failed user message from history (only on final failure)
      if (retryCount === 0 || retryCount >= MAX_RETRIES) {
        this.conversationHistory.pop();
      }
      throw error;
    }
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
    return this.conversationHistory.map(msg => ({
      role: msg.role,
      text: msg.parts.map(p => p.text || '').join('')
    }));
  }

  /**
   * Get formatted conversation log for export
   */
  getLog() {
    return this.conversationHistory.map(msg => {
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
  }
  return serviceInstance;
}
