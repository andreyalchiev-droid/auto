/**
 * Prompts Manager — хранение и управление промптами
 * Промпты сохраняются в localStorage, чтобы пережить перезагрузку.
 */

const STORAGE_KEY = 'autimatiks_prompts_v2';

// Дефолтные промпты
const DEFAULT_PROMPTS = [
    {
        id: 'research',
        type: 'search',
        label: '🔍 Этап 1: Исследование (Google Search)',
        description: 'Поиск и проверка информации',
        text: `Выясни сам то, что ты можешь выяснить через гугл поиск из указаний для контент-менеджера, что надо найти и уточнить по этому тексту в том числе перепроверь все названия из текста`,
        enabled: true,
        isCustom: false
    },
    {
        id: 'researchApply',
        type: 'standard',
        label: '📝 Этап 1: Применение результатов',
        description: 'Внесение найденной информации обратно в текст',
        text: `Дополни исходный текст той информацией которую ты нагуглил, там где это уместно.\nНи в коем случае не выкидывай никакие смысловые фразы и предложения, тебе нужно соблюсти точность передачи текста. подсвети жирным те части текста, где тебе пришлось исправлять текст`,
        enabled: true,
        isCustom: false
    },
    {
        id: 'edit',
        type: 'chunked',
        label: '✍️ Этап 2: Редактирование',
        description: 'Из разговорной речи в читабельный текст',
        text: `Помоги мне отредактировать текст. Цель из транскрипции разговорной речи сделать текст более подходящий под публикацию в текстовом виде в соц сетях. \nКатегорически нельзя выбрасывать любые смыслы и слова автора. Нужно максимально сохранить авторский стиль. \nВноси только ювелирные небольшие правки. Правь только явные повторы, разговорные конструкции и пунктуацию. Но правь текст только там где это явно необходимо\n\nПрисылай текст небольшими смысловыми блоками примерно по 200-500 символов(главное не разрывай смыслы)\n\nкак было, что поправил и как стало`,
        enabled: true,
        isCustom: false
    },
    {
        id: 'combine',
        type: 'combine',
        label: '🔗 Этап 3: Объединение блоков',
        description: 'Объединение отредактированных блоков в единый текст',
        text: `Объедини все итоговые блоки в один текст.\nЗамени все «» на ""`,
        enabled: true,
        isCustom: false
    },
    {
        id: 'title',
        type: 'standard',
        label: '💡 Этап 4: Заголовок',
        description: 'Генерация заголовка',
        text: `Придумай заголовок в формате "Про … "\n\nПримеры заголовков прошлых текстов: \n- Эпохи развития AI, которые мы пережили, и к чему всё идет\n- Про то, почему "ответственность" — это на самом деле пассивность, и что такое настоящий Ownership.\n- Про объектно-ориентированный менеджмент и то как множить результаты, а не действия.\n- Про ловушку префронтальной коры и "тупняк" по субботам`,
        enabled: true,
        isCustom: false
    }
];

/**
 * Загрузить промпты из localStorage (или вернуть дефолтные)
 */
export function loadPrompts() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            return JSON.parse(saved);
        }

        // Попытка миграции старых промптов (v1)
        const oldSaved = localStorage.getItem('autimatiks_prompts');
        if (oldSaved) {
            const oldParsed = JSON.parse(oldSaved);
            const migrated = JSON.parse(JSON.stringify(DEFAULT_PROMPTS));
            for (const p of migrated) {
                if (oldParsed[p.id]) {
                    p.text = oldParsed[p.id];
                }
            }
            savePrompts(migrated);
            return migrated;
        }
    } catch (e) {
        console.warn('Failed to load prompts from localStorage:', e);
    }

    return JSON.parse(JSON.stringify(DEFAULT_PROMPTS));
}

/**
 * Сохранить промпты в localStorage
 */
export function savePrompts(prompts) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
        return true;
    } catch (e) {
        console.error('Failed to save prompts:', e);
        return false;
    }
}

/**
 * Получить дефолтные промпты
 */
export function getDefaultPrompts() {
    return JSON.parse(JSON.stringify(DEFAULT_PROMPTS));
}

