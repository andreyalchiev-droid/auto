/**
 * Pipeline - Dynamic text processing workflow
 */

import { chunkText } from './gemini-service.js';
import { loadPrompts } from './prompts.js';

/**
 * Pipeline state manager
 */
export class Pipeline {
    constructor(geminiService) {
        this.gemini = geminiService;
        this.originalText = '';
        this.currentText = '';
        this.prompts = [];
        this.currentStageIndex = 0;
        this.chunks = [];
        this.currentChunkIndex = 0;
        this.stageResults = {};
        this.onStageChange = null;
        this.onProgress = null;
        this.onMessage = null;
        this.onTyping = null;
        this.isWaitingForReview = false;
        this.requestDelayMs = 1500;
    }

    /**
     * Start the pipeline with input text
     */
    async start(text) {
        this.originalText = text;
        this.currentText = text;
        this.gemini.reset();
        this.prompts = loadPrompts().filter(p => p.enabled);
        this.currentStageIndex = 0;
        this.stageResults = {};
        this.chunks = [];
        this.currentChunkIndex = 0;
        this.isWaitingForReview = false;

        if (this.prompts.length === 0) {
            throw new Error('Нет активных промптов для работы');
        }

        await this.runNextStage();
    }

    async runNextStage() {
        if (this.currentStageIndex >= this.prompts.length) {
            return;
        }

        const prompt = this.prompts[this.currentStageIndex];
        this._emitStageChange(this.currentStageIndex + 1, 'active');

        try {
            if (prompt.type === 'search') {
                await this.runSearchStage(prompt);
            } else if (prompt.type === 'chunked') {
                await this.runChunkedStage(prompt);
            } else if (prompt.type === 'combine') {
                await this.runCombineStage(prompt);
            } else {
                await this.runStandardStage(prompt);
            }

            this._emitStageChange(this.currentStageIndex + 1, 'completed');
            this.currentStageIndex++;
            if (this.currentStageIndex < this.prompts.length) {
                await this._delay(this.requestDelayMs);
            }
            await this.runNextStage();
        } catch (error) {
            this._emitProgress(`Ошибка: ${error.message}`);
            throw error;
        }
    }

    async runSearchStage(prompt) {
        const combinedMessage = `${prompt.text}${this._getOutputRule(prompt)}

Вот текст:

${this.currentText}`;
        this._emitMessage('user', combinedMessage);
        this._emitProgress('Поиск информации в Google...');

        const result = await this.gemini.sendWithSearch(combinedMessage, { useHistory: false });
        this._emitMessage('assistant', result.text);

        this.stageResults.research = result.text;
    }

    async runStandardStage(prompt) {
        const message = this._buildStandardStageMessage(prompt);

        this._emitMessage('user', message);
        this._emitProgress('Обработка...');

        const result = await this.gemini.send(message, { useHistory: false });
        this._emitMessage('assistant', result.text);

        if (prompt.id === 'title') {
            this.stageResults.title = result.text;
        } else {
            this.currentText = result.text;
            this.stageResults.body = result.text;
        }
    }

    async runChunkedStage(prompt) {
        const textToProcess = this.currentText || this.originalText;
        this.chunks = chunkText(textToProcess, 650, 1100);
        this.currentChunkIndex = 0;
        let editedChunks = [];

        this._emitProgress(`Разбито на ${this.chunks.length} блоков. Начинаю редактирование...`);

        while (this.currentChunkIndex < this.chunks.length) {
            const chunk = this.chunks[this.currentChunkIndex];
            const previousChunk = this.currentChunkIndex > 0
                ? this.chunks[this.currentChunkIndex - 1]
                : '';

            this._emitProgress(`Обработка блока ${this.currentChunkIndex + 1} из ${this.chunks.length}...`);

            const result = await this._sendChunkWithSafetySplit(prompt, chunk, previousChunk);
            editedChunks.push(result.text);

            this.stageResults.editedChunks = editedChunks;
            this.stageResults.body = editedChunks.join('\n\n---\n\n');
            this.currentChunkIndex += 1;

            if (this.currentChunkIndex < this.chunks.length) {
                await this._delay(this.requestDelayMs);
            }
        }

        this.currentText = editedChunks.join('\n\n---\n\n');
        this.stageResults.editedChunks = editedChunks;
        this.stageResults.body = this.currentText;
    }

    async _sendChunkWithSafetySplit(prompt, chunk, previousChunk, depth = 0) {
        try {
            return await this._sendChunk(prompt, chunk, previousChunk);
        } catch (error) {
            if (!this._isProhibitedContentError(error)) {
                throw error;
            }

            if (previousChunk) {
                this._emitProgress(`Gemini заблокировал блок ${this.currentChunkIndex + 1} с предыдущим контекстом. Пробую без предыдущего контекста...`);
                try {
                    return await this._sendChunk(prompt, chunk, '');
                } catch (retryError) {
                    if (!this._isProhibitedContentError(retryError)) {
                        throw retryError;
                    }
                    error = retryError;
                    previousChunk = '';
                }
            }

            const fallbackChunks = chunkText(chunk, 250, 550);

            if (depth >= 2 || fallbackChunks.length <= 1) {
                throw error;
            }

            this._emitProgress(`Gemini заблокировал блок ${this.currentChunkIndex + 1}. Делю его на ${fallbackChunks.length} меньшие части...`);

            const editedParts = [];
            let previousPart = previousChunk;

            for (let i = 0; i < fallbackChunks.length; i++) {
                this._emitProgress(`Повтор блока ${this.currentChunkIndex + 1}: часть ${i + 1} из ${fallbackChunks.length}...`);
                const result = await this._sendChunkWithSafetySplit(prompt, fallbackChunks[i], previousPart, depth + 1);
                editedParts.push(result.text);
                previousPart = fallbackChunks[i];
            }

            return {
                text: editedParts.join('\n\n---\n\n')
            };
        }
    }

    async _sendChunk(prompt, chunk, previousChunk = '') {
        const message = this._buildChunkStageMessage(prompt, chunk, previousChunk);
        this._emitMessage('user', message);

        try {
            const result = await this.gemini.send(message, { useHistory: false });
            this._emitMessage('assistant', result.text);
            return result;
        } catch (error) {
            if (this._isProhibitedContentError(error) && !error.message.includes(`блок ${this.currentChunkIndex + 1}`)) {
                error.message = `Gemini заблокировал блок ${this.currentChunkIndex + 1}: ${error.message}`;
            }
            throw error;
        }
    }

    async runCombineStage(prompt) {
        let combinedChunks = '';
        if (this.stageResults.editedChunks) {
            combinedChunks = this.stageResults.editedChunks
                .map((chunk, i) => `[Блок ${i + 1}]\n${chunk}`)
                .join('\n\n');
        } else {
            combinedChunks = this.currentText;
        }

        const message = `${prompt.text}${this._getOutputRule(prompt)}

ИСХОДНЫЙ ТЕКСТ ДЛЯ КОНТЕКСТА:

${this.originalText}

ВОТ МАТЕРИАЛ ДЛЯ ОБЪЕДИНЕНИЯ:

${combinedChunks}`;

        this._emitMessage('user', message);
        this._emitProgress('Объединение...');

        const result = await this.gemini.send(message, { useHistory: false });
        this._emitMessage('assistant', result.text);

        this.currentText = result.text;
        this.stageResults.body = result.text;
    }

    getFinalResult() {
        return {
            title: this.stageResults.title || '',
            text: this.stageResults.body || this.currentText || '',
            original: this.originalText
        };
    }

    _buildStandardStageMessage(prompt) {
        if (prompt.id === 'researchApply') {
            return `${prompt.text}${this._getOutputRule(prompt)}

ИСХОДНЫЙ ТЕКСТ:

${this.originalText}

РЕЗУЛЬТАТЫ ПОИСКА И ПРОВЕРКИ:

${this.stageResults.research || 'Нет отдельного результата поиска.'}`;
        }

        if (prompt.id === 'title') {
            return `${prompt.text}${this._getOutputRule(prompt)}

КОНТЕКСТ ИСХОДНОГО ТЕКСТА:

${this.originalText}

ИТОГОВЫЙ ТЕКСТ:

${this.currentText}`;
        }

        return `${prompt.text}${this._getOutputRule(prompt)}

ИСХОДНЫЙ ТЕКСТ ДЛЯ ОБЩЕГО КОНТЕКСТА:

${this.originalText}

ТЕКУЩИЙ РАБОЧИЙ ТЕКСТ:

${this.currentText || this.originalText}`;
    }

    _buildChunkStageMessage(prompt, chunk, previousChunk = '') {
        const previousOriginalBlock = previousChunk
            ? this._formatPreviousBlock(previousChunk)
            : 'Нет.';

        return `${prompt.text}${this._getOutputRule(prompt)}

ВАЖНО:
- Сейчас редактируй только текущий блок.
- Предыдущий блок нужен только как контекст, чтобы не потерять связь мысли.
- Не редактируй предыдущий блок, не возвращай его в ответе и не добавляй из него новые смыслы.
- Не пересобирай заново уже готовые блоки.
- Верни результат только для текущего блока.

ПРЕДЫДУЩИЙ ОРИГИНАЛЬНЫЙ БЛОК ДЛЯ КОНТЕКСТА:

${previousOriginalBlock}

ТЕКУЩИЙ БЛОК ДЛЯ РЕДАКТИРОВАНИЯ:

${chunk}`;
    }

    _formatPreviousBlock(text) {
        return this._truncateText(text, 900);
    }

    _truncateText(text, maxLength) {
        if (!text || text.length <= maxLength) return text || '';
        return `${text.slice(0, maxLength).trim()}...`;
    }

    _isProhibitedContentError(error) {
        return error?.blockReason === 'PROHIBITED_CONTENT'
            || error?.finishReason === 'PROHIBITED_CONTENT'
            || error?.message?.includes('PROHIBITED_CONTENT');
    }

    _getOutputRule(prompt) {
        if (prompt.type === 'search') {
            return `

ФОРМАТ ОТВЕТА:
- Верни только найденные факты, уточнения и возможные исправления.
- Без вступлений вроде "я провел поиск" и без финальных комментариев.`;
        }

        if (prompt.id === 'title') {
            return `

ФОРМАТ ОТВЕТА:
- Верни только один готовый заголовок.
- Без объяснений, вариантов, вступлений и комментариев.`;
        }

        if (prompt.type === 'combine') {
            return `

ФОРМАТ ОТВЕТА:
- Верни только итоговый объединенный текст.
- Без вступлений, пояснений, технических комментариев и markdown-разделителей.`;
        }

        return `

ФОРМАТ ОТВЕТА:
- Верни только результат обработки текста.
- Без вступлений, пояснений, технических комментариев и финальных замечаний.`;
    }

    async continue() {
        // Deprecated basically, dynamic pipeline runs purely automatically.
    }

    _emitStageChange(stage, status) {
        if (this.onStageChange) this.onStageChange(stage, status);
    }

    _emitProgress(message) {
        if (this.onProgress) this.onProgress(message);
    }

    _emitMessage(role, text) {
        if (this.onMessage) this.onMessage(role, text);
    }

    _emitTyping(isTyping) {
        if (this.onTyping) this.onTyping(isTyping);
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
