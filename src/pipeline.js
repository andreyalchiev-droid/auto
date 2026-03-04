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
            await this.runNextStage();
        } catch (error) {
            this._emitProgress(`Ошибка: ${error.message}`);
            throw error;
        }
    }

    async runSearchStage(prompt) {
        const combinedMessage = `${prompt.text}\n\nВот текст:\n\n${this.currentText}`;
        this._emitMessage('user', combinedMessage);
        this._emitProgress('Поиск информации в Google...');

        const result = await this.gemini.sendWithSearch(combinedMessage);
        this._emitMessage('assistant', result.text);

        // Search usually returns info, which the next standard stage applies.
        // We'll just update current text so it can be optionally used, 
        //, but keeping conversation history makes next standard stages contextual either way.
        this.currentText = result.text;
    }

    async runStandardStage(prompt) {
        // First stage might need the source text if not using conversational context automatically.
        let message = prompt.text;
        if (this.currentStageIndex === 0) {
            message = `${prompt.text}\n\nВот текст:\n\n${this.originalText}`;
        }

        this._emitMessage('user', message);
        this._emitProgress('Обработка...');

        const result = await this.gemini.send(message);
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
        this.chunks = chunkText(textToProcess, 200, 500);
        this.currentChunkIndex = 0;
        let editedChunks = [];

        this._emitProgress(`Разбито на ${this.chunks.length} блоков. Начинаю редактирование...`);

        // First batch
        const firstBatch = this.chunks.slice(0, 2);
        const firstMessage = `${prompt.text}\n\nВот первые блоки текста:\n\n${firstBatch.join('\n\n---\n\n')}`;

        this._emitMessage('user', firstMessage);
        let result = await this.gemini.send(firstMessage);
        this._emitMessage('assistant', result.text);
        editedChunks.push(result.text);

        this.currentChunkIndex = 2;

        while (this.currentChunkIndex < this.chunks.length) {
            const batchSize = Math.min(2, this.chunks.length - this.currentChunkIndex);
            const batch = this.chunks.slice(this.currentChunkIndex, this.currentChunkIndex + batchSize);

            this._emitProgress(`Обработка блоков ${this.currentChunkIndex + 1}-${this.currentChunkIndex + batchSize} из ${this.chunks.length}...`);

            const message = `Продолжай редактировать. Вот следующие блоки текста.\n\n${batch.join('\n\n---\n\n')}`;
            this._emitMessage('user', message);

            result = await this.gemini.send(message);
            this._emitMessage('assistant', result.text);
            editedChunks.push(result.text);
            this.currentChunkIndex += batchSize;

            await this._delay(500);
        }

        this.currentText = editedChunks.join('\n\n---\n\n');
        this.stageResults.editedChunks = editedChunks;
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

        const message = `${prompt.text}\n\nВОТ МАТЕРИАЛ ДЛЯ ОБЪЕДИНЕНИЯ:\n\n${combinedChunks}`;

        this._emitMessage('user', message);
        this._emitProgress('Объединение...');

        const result = await this.gemini.send(message);
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
