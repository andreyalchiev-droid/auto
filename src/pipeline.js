/**
 * Pipeline - 4-stage text processing workflow
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
        this.currentStage = 0;
        this.stageResults = {};
        this.chunks = [];
        this.currentChunkIndex = 0;
        this.onStageChange = null;
        this.onProgress = null;
        this.onMessage = null;
        this.onTyping = null;  // Callback for typing indicator
        this.isWaitingForReview = false;
    }

    /**
     * Start the pipeline with input text
     */
    async start(text) {
        this.originalText = text;
        this.gemini.reset();
        this.currentStage = 1;
        this.stageResults = {};
        this.chunks = [];
        this.currentChunkIndex = 0;
        this.isWaitingForReview = false;

        // Load prompts fresh (picks up any user edits)
        this.PROMPTS = loadPrompts();

        await this.runStage1();
    }

    /**
     * Stage 1: Research - Google search for verification
     */
    async runStage1() {
        this.currentStage = 1;
        this._emitStageChange(1, 'active');

        // Combined prompt: Research prompt + Transcription text
        const combinedMessage = `${this.PROMPTS.research}\n\nВот текст транскрибации:\n\n${this.originalText}`;

        this._emitMessage('user', combinedMessage);
        this._emitProgress('Поиск информации в Google...');

        try {
            const result = await this.gemini.sendWithSearch(combinedMessage);
            this._emitMessage('assistant', result.text);
            this.stageResults.research = result.text;

            // Automatically continue to next sub-stage
            this._emitProgress('Поиск завершен. Применяю результаты...');
            return await this.continueStage1();
        } catch (error) {
            this._emitProgress(`Ошибка: ${error.message}`);
            throw error;
        }
    }

    /**
     * Continue Stage 1: Apply research findings
     */
    async continueStage1() {
        this._emitMessage('user', this.PROMPTS.researchApply);
        this._emitProgress('Применение исправлений к тексту...');

        try {
            const result = await this.gemini.send(this.PROMPTS.researchApply);
            this._emitMessage('assistant', result.text);
            this.stageResults.researchApplied = result.text;

            this._emitStageChange(1, 'completed');

            // Automatically continue to Stage 2
            return await this.runStage2();
        } catch (error) {
            this._emitProgress(`Ошибка: ${error.message}`);
            throw error;
        }
    }

    /**
     * Stage 2: Edit text in chunks
     */
    async runStage2() {
        this.currentStage = 2;
        this.isWaitingForReview = false;
        this._emitStageChange(2, 'active');

        // Get the text to process (either from stage 1 or original)
        const textToProcess = this.stageResults.researchApplied || this.originalText;

        // Chunk the text
        this.chunks = chunkText(textToProcess, 200, 500);
        this.currentChunkIndex = 0;

        this._emitProgress(`Разбито на ${this.chunks.length} блоков. Начинаю редактирование...`);

        // Send first batch (2 chunks) with the edit prompt
        const firstBatch = this.chunks.slice(0, 2);
        const firstMessage = `${this.PROMPTS.edit}\n\nВот первые блоки текста:\n\n${firstBatch.join('\n\n---\n\n')}`;

        this._emitMessage('user', firstMessage);

        try {
            const result = await this.gemini.send(firstMessage);
            this._emitMessage('assistant', result.text);

            this.currentChunkIndex = 2;
            this.stageResults.editedChunks = [result.text];

            // Continue with remaining chunks
            return await this._continueEditing();
        } catch (error) {
            this._emitProgress(`Ошибка: ${error.message}`);
            throw error;
        }
    }

    /**
     * Continue editing remaining chunks
     */
    async _continueEditing() {
        while (this.currentChunkIndex < this.chunks.length) {
            const batchSize = Math.min(2, this.chunks.length - this.currentChunkIndex);
            const batch = this.chunks.slice(this.currentChunkIndex, this.currentChunkIndex + batchSize);

            this._emitProgress(`Обработка блоков ${this.currentChunkIndex + 1}-${this.currentChunkIndex + batchSize} из ${this.chunks.length}...`);

            const message = `${this.PROMPTS.editContinue}\n\n${batch.join('\n\n---\n\n')}`;
            this._emitMessage('user', message);

            try {
                const result = await this.gemini.send(message);
                this._emitMessage('assistant', result.text);
                this.stageResults.editedChunks.push(result.text);
                this.currentChunkIndex += batchSize;

                // Small delay between requests to avoid rate limiting
                await this._delay(500);
            } catch (error) {
                this._emitProgress(`Ошибка: ${error.message}`);
                throw error;
            }
        }

        this._emitStageChange(2, 'completed');

        // Automatically continue to Stage 3
        return await this.runStage3();
    }

    /**
     * Stage 3: Combine all blocks
     */
    async runStage3() {
        this.currentStage = 3;
        this.isWaitingForReview = false;
        this._emitStageChange(3, 'active');

        const combinedChunks = this.stageResults.editedChunks
            .map((chunk, i) => `[Блок ${i + 1}]\n${chunk}`)
            .join('\n\n');

        const prompt = `${this.PROMPTS.combine}\n\nВОТ ОТРЕДАКТИРОВАННЫЕ БЛОКИ:\n\n${combinedChunks}`;

        this._emitMessage('user', 'Объедини все итоговые блоки в один текст...');
        this._emitProgress('Объединение блоков...');

        try {
            const result = await this.gemini.send(prompt);
            this._emitMessage('assistant', result.text);
            this.stageResults.combined = result.text;

            this._emitStageChange(3, 'completed');

            // Automatically proceed to Stage 4
            return await this.runStage4();
        } catch (error) {
            this._emitProgress(`Ошибка: ${error.message}`);
            throw error;
        }
    }

    /**
     * Stage 4: Generate title
     */
    async runStage4() {
        this.currentStage = 4;
        this._emitStageChange(4, 'active');

        this._emitMessage('user', this.PROMPTS.title);
        this._emitProgress('Генерация заголовка...');

        try {
            const result = await this.gemini.send(this.PROMPTS.title);
            this._emitMessage('assistant', result.text);
            this.stageResults.title = result.text;

            this._emitStageChange(4, 'completed');
            this._emitProgress('Готово! Скопируйте результат в Google Docs');

            return {
                title: this.stageResults.title,
                text: this.stageResults.combined
            };
        } catch (error) {
            this._emitProgress(`Ошибка: ${error.message}`);
            throw error;
        }
    }

    /**
     * Continue to next stage after review
     */
    async continue() {
        if (!this.isWaitingForReview) return;

        this.isWaitingForReview = false;

        if (this.currentStage === 1 && !this.stageResults.researchApplied) {
            return await this.continueStage1();
        } else if (this.currentStage === 1) {
            return await this.runStage2();
        } else if (this.currentStage === 2) {
            return await this.runStage3();
        }
    }

    /**
     * Get final result
     */
    getFinalResult() {
        return {
            title: this.stageResults.title || '',
            text: this.stageResults.combined || '',
            original: this.originalText
        };
    }

    /**
     * Helper to emit stage change
     */
    _emitStageChange(stage, status) {
        if (this.onStageChange) {
            this.onStageChange(stage, status);
        }
    }

    /**
     * Helper to emit progress
     */
    _emitProgress(message) {
        if (this.onProgress) {
            this.onProgress(message);
        }
    }

    /**
     * Helper to emit message
     */
    _emitMessage(role, text) {
        if (this.onMessage) {
            this.onMessage(role, text);
        }
    }

    /**
     * Helper to emit typing state
     */
    _emitTyping(isTyping) {
        if (this.onTyping) {
            this.onTyping(isTyping);
        }
    }

    /**
     * Helper delay
     */
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
