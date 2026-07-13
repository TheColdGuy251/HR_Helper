    document.addEventListener('DOMContentLoaded', function() {
        // Элементы DOM, специфичные для чата
        const backToDialoguesBtn = document.getElementById('backToDialoguesBtn');
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        const messagesContainer = document.getElementById('messages');
        const chatStatus = document.getElementById('chatStatus');

        const sessionId = document.getElementById('sessionId')?.value;
        const dialogueId = document.getElementById('dialogueId')?.value;

        // ===== Черновики =====
        const DRAFT_KEY = sessionId ? `hr_chat_draft_${sessionId}` : null;
        let draftSaveTimer = null;
        let draftServerTimer = null;
        let lastServerDraft = null;
        function saveDraft(value) {
            if (!DRAFT_KEY) return;
            try {
                if (value && value.trim()) localStorage.setItem(DRAFT_KEY, value);
                else localStorage.removeItem(DRAFT_KEY);
            } catch (e) { /* localStorage может быть недоступен в приватном режиме */ }
        }
        // Черновик на сервере — чтобы пустой диалог «не сохранялся», а с черновиком
        // отображался в списке и переиспользовался по «+» (#19). Реже, чем localStorage.
        function saveDraftServer(value) {
            const v = (value || '').trim();
            const dlgId = document.getElementById('dialogueId')?.value;
            if (!dlgId) return;
            if (v === lastServerDraft) return;
            lastServerDraft = v;
            clearTimeout(draftServerTimer);
            draftServerTimer = setTimeout(() => {
                fetch(`/api/dialogues/${dlgId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ draft: v }),
                }).catch(() => {});
            }, 700);
        }
        function loadDraft() {
            if (!DRAFT_KEY) return '';
            try { return localStorage.getItem(DRAFT_KEY) || ''; } catch (e) { return ''; }
        }
        function clearDraft() {
            if (!DRAFT_KEY) return;
            try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
            saveDraftServer('');  // очищаем и серверный черновик
        }

        // Переменные для непрочитанных сообщений
        let unreadMessages = new Set();
        let isProcessingDocument = false;

        // Текущее состояние подписки/стрима
        let currentStreaming = {
            assistantId: null,    // активный assistant_message.id (int)
            controller: null,     // AbortController для fetch
            reader: null,         // reader от response.body.getReader()
            active: false,        // флаг активности подписки
            lastSeqSeen: 0        // последний seq, который клиент увидел
        };

        // Хранит id последнего ассистентского сообщения из истории (если есть)
        let lastAssistantId = null;
        // Пересланные из мессенджера сообщения, ожидающие первой отправки
        // (приходят в GET /messages как pending_forward; уходят с первым send).
        let pendingForwardItems = null;
        // ID сообщений, чьи стримы УЖЕ завершились — больше не пытаемся подключаться
        const completedStreams = new Set();
        // throttle: не дёргаем сервер на каждый visibility/focus
        let lastResumeCheckAt = 0;
        const RESUME_CHECK_THROTTLE_MS = 15000;

        // Инициализация
        if (sessionId) {
            loadMessages();
            if (chatStatus) chatStatus.textContent = 'Онлайн';
            // Запускаем проверку непрочитанных сообщений через 1 секунду
            setTimeout(startUnreadCheck, 1000);

            // Восстанавливаем черновик из localStorage и подписываемся на сохранение
            if (messageInput) {
                const draft = loadDraft();
                if (draft) messageInput.value = draft;
                autoResizeInput();
                messageInput.addEventListener('input', () => {
                    autoResizeInput();
                    clearTimeout(draftSaveTimer);
                    draftSaveTimer = setTimeout(() => saveDraft(messageInput.value), 200);
                    saveDraftServer(messageInput.value);
                });
            }
        } else if (chatStatus) {
            chatStatus.textContent = 'Сессия не найдена';
        }

        // ===== Inline-поле названия диалога =====
        const titleInput = document.getElementById('dialogueTitleInput');
        const titleStatus = document.getElementById('dialogueTitleStatus');
        let titleSaveTimer = null;
        let titleSaved = (titleInput?.value || '').trim();
        let autoTitleRequested = false;

        // Динамическая ширина поля названия по числу символов (с верхним пределом).
        let titleMeasurer = null;
        function autosizeTitle() {
            if (!titleInput) return;
            if (!titleMeasurer) {
                titleMeasurer = document.createElement('span');
                const cs = getComputedStyle(titleInput);
                Object.assign(titleMeasurer.style, {
                    position: 'absolute', visibility: 'hidden', whiteSpace: 'pre',
                    left: '-9999px', top: '0',
                    fontFamily: cs.fontFamily, fontSize: cs.fontSize,
                    fontWeight: cs.fontWeight, letterSpacing: cs.letterSpacing,
                });
                document.body.appendChild(titleMeasurer);
            }
            const cs = getComputedStyle(titleInput);
            titleMeasurer.textContent = titleInput.value || titleInput.placeholder || '';
            const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
                + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
            const minW = parseFloat(cs.minWidth) || 160;
            const maxW = parseFloat(cs.maxWidth) || 460;
            const w = Math.min(maxW, Math.max(minW, titleMeasurer.offsetWidth + pad + 6));
            titleInput.style.width = w + 'px';
        }

        async function patchDialogueTitle(value) {
            if (!dialogueId) return;
            try {
                const resp = await fetch(`/api/dialogues/${dialogueId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: value }),
                });
                if (!resp.ok) throw new Error(resp.status);
                if (titleStatus) {
                    titleStatus.textContent = 'сохранено';
                    titleStatus.className = 'dialogue-title-status saved';
                    setTimeout(() => { if (titleStatus.textContent === 'сохранено') titleStatus.textContent = ''; }, 1500);
                }
                titleSaved = value;
            } catch (e) {
                if (titleStatus) {
                    titleStatus.textContent = 'не сохранилось';
                    titleStatus.className = 'dialogue-title-status error';
                }
            }
        }

        if (titleInput) {
            titleInput._autosize = autosizeTitle;
            autosizeTitle();
            titleInput.addEventListener('input', () => {
                autosizeTitle();
                if (titleStatus) {
                    titleStatus.textContent = 'набираю…';
                    titleStatus.className = 'dialogue-title-status';
                }
                clearTimeout(titleSaveTimer);
                titleSaveTimer = setTimeout(() => {
                    const v = titleInput.value.trim();
                    if (v !== titleSaved) patchDialogueTitle(v);
                }, 600);
            });
            titleInput.addEventListener('blur', () => {
                clearTimeout(titleSaveTimer);
                const v = titleInput.value.trim();
                if (v !== titleSaved) patchDialogueTitle(v);
            });
        }

        function applyAutoTitle(title) {
            if (!titleInput || titleInput.value.trim()) return;   // пользователь сам ввёл
            if (!title || title === 'Новый диалог') return;
            titleInput.value = title;
            titleSaved = title;
            autosizeTitle();
            if (titleStatus) {
                titleStatus.textContent = 'предложено ИИ';
                titleStatus.className = 'dialogue-title-status saved';
                setTimeout(() => {
                    if (titleStatus.textContent === 'предложено ИИ') titleStatus.textContent = '';
                }, 2500);
            }
        }

        // Название приходит SSE-событием dialogue_title (без поллинга /api/dialogues).
        window.addEventListener('hr:dialogues-changed', (e) => {
            const d = e.detail;
            if (d && d.type === 'dialogue_title' && String(d.dialogue_id) === String(dialogueId)) {
                applyAutoTitle(d.title);
            }
        });

        function requestAutoTitle() {
            // Fire-and-forget: запрос не должен ждать окончания LLM-работы
            // и не должен блокировать переход пользователя на другую страницу.
            if (autoTitleRequested) return;
            if (!dialogueId || !titleInput) return;
            if (titleInput.value.trim()) return;
            autoTitleRequested = true;
            try {
                fetch(`/api/dialogues/${dialogueId}/auto-title`, {
                    method: 'POST',
                    keepalive: true,   // переживает уход со страницы
                }).catch(() => {});
            } catch (e) { /* ignore */ }
            // Единственный страховочный опрос на случай недоступного SSE.
            setTimeout(pollAutoTitle, 12000);
        }

        async function pollAutoTitle() {
            if (!dialogueId || !titleInput || titleInput.value.trim()) return;
            try {
                const resp = await fetch(`/api/dialogues?filter=all`);
                const data = await resp.json();
                const dlg = (data.items || []).find((x) => String(x.id) === String(dialogueId));
                if (dlg) applyAutoTitle(dlg.title);
            } catch (e) { /* ignore */ }
        }

        // Навигация
        if (backToDialoguesBtn) {
            backToDialoguesBtn.addEventListener('click', () => {
                window.location.href = '/dialogues';
            });
        }
    // helper: считать, что пользователь "внизу" если расстояние до низа <= threshold (px)
    function isUserAtBottom(threshold = 150) {
        if (!messagesContainer) return true;
        return (messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight) <= threshold;
    }

    // Если пользователь во время стрима сам отскроллил вверх — отключаем автоскролл,
    // чтобы он мог спокойно читать предыдущие сообщения. Возвращаем поведение,
    // когда он снова окажется у низа (либо нажмёт floating-indicator).
    let userScrolledUp = false;
    let lastKnownScrollTop = 0;
    if (messagesContainer) {
        messagesContainer.addEventListener('scroll', () => {
            const cur = messagesContainer.scrollTop;
            // Скролл вверх руками: считаем только заметное движение (> 4px),
            // чтобы дрожь от resize/новых чанков не триггерила флаг.
            if (cur < lastKnownScrollTop - 4) {
                userScrolledUp = true;
            }
            if (isUserAtBottom(20)) {
                userScrolledUp = false;
            }
            lastKnownScrollTop = cur;
            updateFloatingIndicator();
        }, { passive: true });
    }

    function scrollToBottom(force = false) {
        if (!messagesContainer) return;
        if (force) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
            userScrolledUp = false;
            lastKnownScrollTop = messagesContainer.scrollTop;
            return;
        }
        if (userScrolledUp) return;
        if (isUserAtBottom()) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
            lastKnownScrollTop = messagesContainer.scrollTop;
        }
    }
        // Устанавливаем один обработчик для кнопки: поведение зависит от режима (send/abort)
    async function handleSendButtonClick(e) {
        if (currentStreaming.active) {
            // режим: прервать — вызываем серверный abort, затем локально отменяем
            const abortedId = currentStreaming.assistantId;
            try {
                const payload = {
                    session_id: sessionId,
                    assistant_message_id: abortedId || null
                };
                await fetch('/api/chat/stream/abort', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            } catch (err) {
                console.error('Не удалось отправить запрос на отмену генерации:', err);
            } finally {
                if (abortedId) completedStreams.add(abortedId);
                lastAssistantId = null;
                markLocalAssistantAsCancelled();
                abortCurrentSubscription();
            }
        } else {
            sendMessage();
        }
    }

        // Экспорт для панели быстрого набора FAQ (её код живёт вне этого замыкания)
        window._chatSendMessage = sendMessage;

        if (sendButton && messageInput) {
            sendButton.addEventListener('click', handleSendButtonClick);
            // Enter — отправить, Shift+Enter — перенос строки (textarea).
            messageInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    // если в стриме — не отправляем, иначе отправляем
                    if (!currentStreaming.active) sendMessage();
                }
            });
        }

        // При возврате к вкладке проверяем, не идёт ли где-то стрим, на который мы потеряли подписку.
        // НИКОГДА не перезагружаем сообщения (избегаем мерцания на каждом Alt+Tab / file-picker).
        async function maybeResumeStream() {
            if (!sessionId) return;
            if (currentStreaming.active) return;                       // уже подписаны
            if (lastAssistantId && completedStreams.has(lastAssistantId)) return; // стрим завершён

            // throttle: не чаще раза в 15 секунд
            const now = Date.now();
            if (now - lastResumeCheckAt < RESUME_CHECK_THROTTLE_MS) return;
            lastResumeCheckAt = now;

            try {
                const resp = await fetch(`/api/chat/stream/active?session_id=${sessionId}`);
                if (!resp.ok) return;
                const data = await resp.json();
                const active = (data.active || []).find(a => a && a.message_id);
                if (!active) return;
                if (completedStreams.has(active.message_id)) return;

                // На сервере есть живой стрим — подключаемся, не дёргая историю
                lastAssistantId = active.message_id;
                currentStreaming.lastSeqSeen = 0;
                startStreaming({
                    assistantId: lastAssistantId,
                    lastSeqSeen: currentStreaming.lastSeqSeen,
                });
            } catch (e) {
                console.warn('Resume-check failed', e);
            }
        }

        window.addEventListener('focus', maybeResumeStream);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) maybeResumeStream();
        });

    function markLocalAssistantAsCancelled() {
    if (!messagesContainer) return;
    try {
        let el = null;
        if (currentStreaming.assistantId) {
            el = messagesContainer.querySelector(`[data-message-id="${currentStreaming.assistantId}"]`);
        }
        if (!el) {
            const botMessages = messagesContainer.querySelectorAll('.message.bot');
            if (botMessages && botMessages.length > 0) {
                el = botMessages[botMessages.length - 1];
            }
        }
        if (el) {
            const contentEl = el.querySelector('.message-content');
            if (contentEl) {
                if (!contentEl.textContent.includes('(Генерация прервана)')) {
                    contentEl.textContent = (contentEl.textContent || '') + '\n\n(Генерация прервана)';
                }
            }

            // Пометим как прочитанное и уберём класс/счетчик непрочитанных
            el.classList.remove('unread');
            el.dataset.isRead = 'true';
            const mid = el.dataset.messageId;
            if (mid) unreadMessages.delete(String(mid));
            updateUnreadIndicator();
        }
    } catch (e) {
        console.error('markLocalAssistantAsCancelled error', e);
    }
}


        // ----------------- UI helper: режим стрима -----------------
        function setStreamingUI(active) {
            if (!messageInput || !sendButton) return;
            if (active) {
                // блокируем ввод и меняем поведение/вид кнопки (иконка «стоп»)
                messageInput.disabled = true;
                sendButton.innerHTML = '<i class="fas fa-stop"></i>';
                sendButton.title = 'Прервать';
                sendButton.setAttribute('aria-label', 'Прервать');
                sendButton.classList.add('abort');
                sendButton.setAttribute('aria-pressed', 'true');
                chatStatus.textContent = 'Генерация...';
            } else {
                messageInput.disabled = false;
                sendButton.innerHTML = '<i class="fas fa-arrow-up"></i>';
                sendButton.title = 'Отправить';
                sendButton.setAttribute('aria-label', 'Отправить');
                sendButton.classList.remove('abort');
                sendButton.setAttribute('aria-pressed', 'false');
                chatStatus.textContent = 'Онлайн';
            }
            updateUnreadIndicator();
        }

        // ----------------- Функции -----------------
        async function loadMessages() {
            if (!sessionId || !messagesContainer) return;

            try {
                const response = await fetch(`/api/chat/messages?session_id=${sessionId}&mark_as_read=true`);
                const data = await response.json();

                if (data.success) {
                    renderMessages(data.messages);
                    pendingForwardItems = (data.pending_forward && data.pending_forward.length)
                        ? data.pending_forward : null;
                    renderPendingForwardPreview();
                    scrollToBottom(true);

                    // Проверяем активные фоновые стримы на сервере для этой сессии
                    try {
                        const activeResp = await fetch(`/api/chat/stream/active?session_id=${sessionId}`);
                        if (activeResp.ok) {
                            const activeData = await activeResp.json();
                            if (activeData && activeData.success && Array.isArray(activeData.active) && activeData.active.length > 0) {
                                // Берём самую свежую активную задачу (последняя по started_at)
                                const sorted = activeData.active.sort((a, b) => {
                                    const ta = a.started_at ? new Date(a.started_at).getTime() : 0;
                                    const tb = b.started_at ? new Date(b.started_at).getTime() : 0;
                                    return tb - ta;
                                });
                                const active = sorted[0];
                                if (active && active.message_id && !completedStreams.has(active.message_id)) {
                                    // Обновим UI текущим содержимым (если есть) и подпишемся
                                    const elem = messagesContainer.querySelector(`[data-message-id="${active.message_id}"]`);
if (elem) {
    const contentEl = elem.querySelector('.message-content');
    if (contentEl && typeof active.content !== 'undefined') {
        // Используем setRawContentForElement чтобы сохранить data-raw-content и перерисовать
        setRawContentForElement(contentEl, active.content || '');
    }
} else {
    addMessageToUI('assistant', active.content || '', active.message_id, true);
}


                                    lastAssistantId = active.message_id;
                                    // last_seq=0 → сервер отдаст ВЕСЬ накопленный буфер в initial_chunk.
                                    // Если передать active.last_seq, сервер вернёт пусто и затрёт уже отрисованный текст.
                                    currentStreaming.lastSeqSeen = 0;
                                    startStreaming({ assistantId: lastAssistantId, lastSeqSeen: 0 });
                                    return;
                                }
                            }
                        }
                    } catch (err) {
                        console.error('Не удалось проверить активный стрим:', err);
                    }

                    // Активных стримов нет — больше ничего не делаем.
                    // Не используем эвристики «возможно ещё пишет»: они дают ложные подключения.
                } else {
                    showErrorMessage('Ошибка загрузки сообщений: ' + data.error);
                }
            } catch (error) {
                console.error('Error:', error);
                showErrorMessage('Ошибка подключения');
            }
        }

        function abortCurrentSubscription() {
            try {
                if (currentStreaming.reader) {
                    currentStreaming.reader.cancel && currentStreaming.reader.cancel();
                }
            } catch (e) {}
            try {
                if (currentStreaming.controller) {
                    currentStreaming.controller.abort();
                }
            } catch (e) {}
            currentStreaming.active = false;
            currentStreaming.controller = null;
            currentStreaming.reader = null;
            // Не очищаем assistantId и lastSeqSeen — полезно для автоподписки

            // Обновляем UI (включая кнопку)
            setStreamingUI(false);
        }

        async function startStreaming({ assistantId = null, message = null, retryOf = null, targetEl = null, pendingUserEl = null, use_rag = true, temperature = 0.7, lastSeqSeen = undefined } = {}) {
    // Если уже подписаны на тот же assistantId — ничего не делаем
    if (assistantId && currentStreaming.active && currentStreaming.assistantId === assistantId) {
        return;
    }

    // Отменяем предыдущую подписку (если есть)
    abortCurrentSubscription();

    // Создаём temp element если ассистентский элемент отсутствует
    let tempAssistantElement = null;
    let isTemp = false;
    let replaceExistingId = false;  // ретрай: заменить id существующего пузыря на новый вариант
    if (!messagesContainer) {
        console.error('messagesContainer not found');
        return;
    }

    if (retryOf && targetEl) {
        // «Попробовать снова»: перегенерируем прямо в существующий пузырь (targetEl).
        tempAssistantElement = targetEl;
        replaceExistingId = true;
    } else if (assistantId) {
        tempAssistantElement = messagesContainer.querySelector(`[data-message-id="${assistantId}"]`);
        if (!tempAssistantElement) {
            // Подписываемся на уже существующий stream — создаём элемент и помечаем его как прочитанным,
            // чтобы не возникал бейдж "непрочитанных" пока пользователь в этой сессии видит генерацию.
            addMessageToUI('assistant', '', assistantId, true);
            tempAssistantElement = messagesContainer.querySelector(`[data-message-id="${assistantId}"]`);
        }
    } else {
        // Запуск новой генерации: добавим временный typing элемент
        const tempId = `temp-${Date.now()}`;
        addMessageToUI('assistant', '__typing__', tempId, true);
        tempAssistantElement = messagesContainer.querySelector(`[data-message-id="${tempId}"]`);
        isTemp = true;
    }

    const assistantContentEl = tempAssistantElement ? tempAssistantElement.querySelector('.message-content') : null;
    // Помечаем как стримящийся — пока флаг стоит, блок «Источники» не показываем
    // (только нумерация ссылок live); блок появится после завершения генерации.
    if (assistantContentEl) assistantContentEl.dataset.streaming = 'true';

    // Показываем режим стрима (блокируем ввод и меняем кнопку)
    setStreamingUI(true);

    const controller = new AbortController();
    currentStreaming.controller = controller;
    currentStreaming.active = true;

    // Подготовим тело запроса — либо подписка по assistant_message_id, либо запуск новой генерации по message
    const lastSeq = (typeof lastSeqSeen !== 'undefined') ? lastSeqSeen : (currentStreaming.lastSeqSeen || 0);
    const body = assistantId ? { session_id: sessionId, assistant_message_id: assistantId, last_seq: lastSeq } :
        retryOf ? { session_id: sessionId, retry_of: retryOf, use_rag: use_rag } :
        { session_id: sessionId, message: message };
    // Быстрый набор FAQ: одноразовый id записи → точный курируемый ответ без LLM
    if (!assistantId && !retryOf && window._pendingFaqId) {
        body.faq_id = window._pendingFaqId;
        window._pendingFaqId = null;
    }

    try {
        const resp = await fetch('/api/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        if (!resp.ok || !resp.body) {
            currentStreaming.active = false;
            console.error('Streaming response not ok');
            setStreamingUI(false);
            return;
        }

        const reader = resp.body.getReader();
        currentStreaming.reader = reader;
        currentStreaming.assistantId = assistantId || null;
        if (assistantId && lastSeq !== undefined) currentStreaming.lastSeqSeen = lastSeq;

        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // SSE события разделяются пустой строкой
            const parts = buffer.split('\n\n');
            buffer = parts.pop(); // остаток

            for (const partRaw of parts) {
                const part = partRaw.trim();
                if (!part) continue;

                // SSE-комментарии (строки, начинающиеся с ':') — игнорируем
                if (part.startsWith(':')) continue;

                const prefix = 'data: ';
                if (!part.startsWith(prefix)) {
                    // Неизвестный формат строки — пропускаем, не выводим в чат
                    continue;
                }
                let payload = null;
                const jsonStr = part.slice(prefix.length).trim();
                try {
                    payload = JSON.parse(jsonStr);
                } catch (e) {
                    console.error('SSE JSON parse error', e, jsonStr);
                    continue;
                }

                // Heartbeat — игнорируем
                if (payload && payload.noop) continue;

                // Статусы pipeline («Поиск…», «Реранкинг…», «Генерация…»)
                if (payload && payload.status) {
                    const headerMap = { search: 'Поиск в базе знаний…', rerank: 'Анализ найденного…', generate: 'Генерация ответа…' };
                    if (chatStatus) chatStatus.textContent = headerMap[payload.status] || 'Обработка…';
                    // Обновляем индикатор внутри пузырька, если ответ ещё не начат
                    if (assistantContentEl) setThinkingStatus(assistantContentEl, payload.status);
                    // initial-payload может тоже нести status — продолжаем обработку
                    if (payload.initial !== true) continue;
                }

                // Если сервер прислал message_id (например initial header) — установим его
                if (payload.message_id && !currentStreaming.assistantId) {
                    currentStreaming.assistantId = payload.message_id;
                    // заменим temp-id на реальный id, если нужно
                    if (isTemp && tempAssistantElement && tempAssistantElement.dataset.messageId && String(tempAssistantElement.dataset.messageId).startsWith('temp-')) {
                        // Обновляем dataset и набор непрочитанных
                        tempAssistantElement.dataset.messageId = String(currentStreaming.assistantId);
                        tempAssistantElement.dataset.isRead = 'false';
                        unreadMessages.add(String(currentStreaming.assistantId));
                        updateUnreadIndicator();
                        isTemp = false;
                    }
                    // Ретрай: у существующего пузыря был старый id — переводим его на
                    // id нового варианта, чтобы стрим и done-обработчик нашли элемент.
                    if (replaceExistingId && tempAssistantElement) {
                        tempAssistantElement.dataset.messageId = String(currentStreaming.assistantId);
                        replaceExistingId = false;
                    }
                }
                // id только что отправленного сообщения пользователя → проставляем пузырю
                // и показываем кнопку «изменить» сразу (без перезагрузки).
                if (payload.user_message_id && pendingUserEl) {
                    assignUserMessageId(pendingUserEl, payload.user_message_id);
                    pendingUserEl = null;
                }

                // Структурные источники (приходят рано — до текста, либо в head):
                // сохраняем на элементе, чтобы ссылки нумеровались правильно уже
                // во время стрима, без мелькания сырых номеров чанков.
                if (payload.sources && assistantContentEl) {
                    try { assistantContentEl.dataset.sources = JSON.stringify(payload.sources); } catch (e) {}
                    // Отдельное событие «только источники» — перерисуем и продолжим.
                    if (!payload.initial && !payload.done && payload.seq === undefined && payload.chunk === undefined) {
                        const rawNow = assistantContentEl.dataset.rawContent || '';
                        if (rawNow) setRawContentForElement(assistantContentEl, rawNow);
                        continue;
                    }
                }

                // special handling for initial snapshot (replace, not append)
                if (payload.initial) {
                    const initialText = (typeof payload.initial_chunk !== 'undefined') ? payload.initial_chunk : (payload.chunk || '');
                    if (assistantContentEl) {
                        // Защита: не затираем уже отрисованный текст пустым initial.
                        // Это случай, когда сервер посчитал, что клиент уже видел всё (last_seq был передан в startStreaming),
                        // и шлёт пустой snapshot. Перетирание = потеря всей предыдущей генерации в UI.
                        const existing = assistantContentEl.dataset.rawContent || '';
                        if (initialText || !existing) {
                            setRawContentForElement(assistantContentEl, initialText);
                            scrollToBottom(false);
                        }
                    }
                    if (payload.last_seq !== undefined) {
                        currentStreaming.lastSeqSeen = Number(payload.last_seq) || 0;
                    }
                    // продолжаем (не аппендим initial как обычный chunk)
                    continue;
                }

                if (payload.error) {
                    if (assistantContentEl) {
                        setRawContentForElement(assistantContentEl, 'Ошибка: ' + String(payload.error));
                        scrollToBottom(false);
                    } else {
                        // если нет элемента — кладём в UI новое сообщение
                        addMessageToUI('assistant', 'Ошибка: ' + String(payload.error));
                    }
                } else if (payload.seq !== undefined) {
                    const seq = Number(payload.seq);
                    // игнорируем дубликаты
                    if (seq <= (currentStreaming.lastSeqSeen || 0)) {
                        continue;
                    }
                    // апендим chunk (payload.chunk может быть пустой строкой)
                    if (assistantContentEl) {
                        appendRawContentForElement(assistantContentEl, payload.chunk || '');
                        scrollToBottom(false);
                        updateFloatingIndicator();
                    } else {
                        // На всякий случай — если элемент пропал, добавим в UI
                        addMessageToUI('assistant', payload.chunk || '');
                    }
                    currentStreaming.lastSeqSeen = seq;
                } else if (payload.chunk !== undefined) {
                    // backward-compat: если нет seq и нет initial, просто добавляем (редкий случай)
                    if (assistantContentEl) {
                        appendRawContentForElement(assistantContentEl, payload.chunk || '');
                        scrollToBottom(false);
                    } else {
                        addMessageToUI('assistant', payload.chunk || '');
                    }
                } else if (payload.done) {
                    // Стрим завершён. НЕ перезагружаем историю — это вызывает мерцание UI.
                    const finishedId = currentStreaming.assistantId || payload.message_id;
                    if (finishedId) completedStreams.add(finishedId);
                    lastAssistantId = null;
                    clearPendingGen();  // пользователь здесь — toast не нужен

                    // После завершения генерации — попросим ИИ предложить название диалога,
                    // если пользователь его не задал сам.
                    requestAutoTitle();

                    if (finishedId && messagesContainer) {
                        const el = messagesContainer.querySelector(`[data-message-id="${finishedId}"]`);
                        if (el) {
                            el.classList.remove('unread');
                            el.dataset.isRead = 'true';
                            unreadMessages.delete(String(finishedId));
                            updateUnreadIndicator();
                        }
                        // Пользователь был в чате к моменту завершения — помечаем ответ
                        // прочитанным В БД (иначе диалог остаётся «непрочитанным» в списке).
                        if (finishedId && typeof markMessagesAsRead === 'function') {
                            markMessagesAsRead([finishedId]);
                        }
                        // Генерация завершена — снимаем флаг стрима и делаем финальную
                        // перерисовку: теперь добавляется блок «Источники».
                        {
                            const contentEl = el.querySelector('.message-content');
                            if (contentEl) {
                                contentEl.dataset.streaming = '';
                                const srcs = (payload.sources && payload.sources.length)
                                    ? payload.sources
                                    : (contentEl.dataset.sources ? JSON.parse(contentEl.dataset.sources) : null);
                                // Сервер прислал финальный текст после пост-обработки
                                // (дедуп, восстановленные ссылки [k]) — он приоритетнее
                                // настримленной версии.
                                if (typeof payload.content === 'string' && payload.content) {
                                    contentEl.dataset.rawContent = payload.content;
                                }
                                const rawTxt = contentEl.dataset.rawContent || '';
                                contentEl.innerHTML = formatMessageContent(rawTxt, srcs, true);
                            }
                        }
                        // Если бот сгенерировал документ — крепим карточку «скачать»
                        if (payload.attachment) {
                            attachDocumentCard(el, payload.attachment);
                            scrollToBottom(false);
                        }
                        // Мета ответа: clarify-чипы + дисклеймер/контакт (А2/А3)
                        {
                            const wrapEl = el.querySelector('.message-wrapper');
                            if (wrapEl && !wrapEl.querySelector('.chat-answer-note, .chat-clarify-opts')) {
                                const cEl = el.querySelector('.message-content');
                                const srcsMeta = (payload.sources && payload.sources.length)
                                    ? payload.sources
                                    : (cEl && cEl.dataset.sources ? JSON.parse(cEl.dataset.sources) : null);
                                const metaHtml = renderAnswerMeta({
                                    role: 'assistant', meta: payload.meta || null, sources: srcsMeta,
                                });
                                if (metaHtml) {
                                    const tmpM = document.createElement('div');
                                    tmpM.innerHTML = metaHtml;
                                    while (tmpM.firstElementChild) wrapEl.appendChild(tmpM.firstElementChild);
                                    scrollToBottom(false);
                                }
                            }
                        }
                        // Футер ответа: [‹ i/n ›] копировать·лайк·дизлайк·повтор + время.
                        // variant_* приходят в done-payload (актуально после ретрая).
                        if (finishedId && el && !el.querySelector('.message-footer')) {
                            const wrap = el.querySelector('.message-wrapper');
                            if (wrap) {
                                const footerHtml = renderAssistantFooter({
                                    id: finishedId,
                                    user_rating: 0,
                                    ts: new Date().toISOString(),
                                    variant_group: payload.variant_group,
                                    variant_index: payload.variant_index,
                                    variant_count: payload.variant_count,
                                });
                                const tmp = document.createElement('div');
                                tmp.innerHTML = footerHtml;
                                if (tmp.firstElementChild) wrap.appendChild(tmp.firstElementChild);
                                attachFeedbackHandlers(el);
                            }
                        }
                    }

                    abortCurrentSubscription();
                    return;
                }
            }
        }

        // завершение чтения потока естественным путём
        currentStreaming.active = false;
        currentStreaming.controller = null;
        currentStreaming.reader = null;

    } catch (err) {
        if (err && err.name === 'AbortError') {
            // пометим временный ассистентский элемент как прерванный (если есть)
            try {
                if (assistantContentEl) {
                    appendRawContentForElement(assistantContentEl, '\n\n(Генерация прервана)');
                    scrollToBottom(false);
                }
            } catch (e) {
                console.warn('Error marking aborted content', e);
            }
        } else {
            console.error('Streaming error', err);
            if (assistantContentEl) {
                appendRawContentForElement(assistantContentEl, '\n\n(Ошибка генерации)');
                scrollToBottom(false);
            } else {
                addMessageToUI('assistant', 'Ошибка генерации ответа');
            }
        }
        currentStreaming.active = false;
        currentStreaming.controller = null;
        currentStreaming.reader = null;
        setStreamingUI(false);
    } finally {
        // В конце — убедимся, что UI возвращён в нормальное состояние
        setStreamingUI(false);
    }
}

        // ===== Учёт «генерация в процессе» для toast после ухода со страницы =====
        function readPendingGens() {
            try { return JSON.parse(localStorage.getItem('pendingGenerations') || '[]'); } catch (e) { return []; }
        }
        function writePendingGens(list) {
            try { localStorage.setItem('pendingGenerations', JSON.stringify(list)); } catch (e) {}
        }
        function recordPendingGen() {
            if (!sessionId) return;
            const title = (document.getElementById('dialogueTitleInput')?.value || '').trim() || 'Диалог';
            const list = readPendingGens().filter((p) => p.sessionId !== sessionId);
            list.push({ sessionId, dialogueId: String(dialogueId || ''), title, ts: Date.now() });
            writePendingGens(list);
        }
        function clearPendingGen() {
            if (!sessionId) return;
            writePendingGens(readPendingGens().filter((p) => p.sessionId !== sessionId));
        }

        async function sendMessage() {
            if (!sessionId || !messageInput) return;
            const hasForward = !!(pendingForwardItems && pendingForwardItems.length);
            // Пустой текст допустим, только если отправляем пересланные сообщения.
            if (!messageInput.value.trim() && !hasForward) return;

            const message = messageInput.value.trim();

            // Снимок прикреплённых файлов (уйдут в это сообщение и будут «потрачены»).
            let pendingAttachNames = [];
            const attCont = document.getElementById('attachedFiles');
            if (attCont) {
                pendingAttachNames = [...attCont.querySelectorAll('.att-name')]
                    .map((el) => (el.textContent || '').trim()).filter(Boolean);
            }

            // Превью пересылки заменяется настоящим сообщением пользователя.
            if (hasForward) removePendingForwardPreview();

            // Добавляем сообщение пользователя в интерфейс (с чипами вложений)
            addMessageToUI('user', message, null, false, pendingAttachNames);
            // Ссылка на только что добавленный пузырь пользователя — сервер пришлёт его
            // id в initial-пейлоаде, и мы покажем кнопку «изменить» сразу.
            const pendingUserEl = messagesContainer ? messagesContainer.lastElementChild : null;
            if (pendingUserEl) pendingUserEl.classList.add('msg-just-sent');   // анимация отправки
            if (hasForward && pendingUserEl) {
                const ce = pendingUserEl.querySelector('.message-content');
                if (ce) ce.insertAdjacentHTML('afterbegin', renderForwardedBlock(pendingForwardItems));
                pendingForwardItems = null;
            }
            messageInput.value = '';
            autoResizeInput();  // вернуть поле к одной строке
            clearDraft();
            // Очередь вложений «потрачена» на это сообщение — очищаем панель сразу.
            if (attCont) attCont.innerHTML = '';
            recordPendingGen();  // если уйдём со страницы — глобальный поллер покажет toast

            try {
                // Стартуем поток — это запустит серверную генерацию и подпишется на SSE
                // startStreaming сам создаст временный assistant элемент и заменит его на реальный message_id
                await startStreaming({ message: message, pendingUserEl: pendingUserEl });

                // После завершения стрима loadMessages() уже был вызван при done
            } catch (err) {
                console.error('sendMessage error', err);
                addMessageToUI('assistant', 'Ошибка соединения с сервером');
                setStreamingUI(false);
            }
        }
        function getUserAvatarSrc() {
    try {
        const profileAvatar = document.getElementById('profileAvatar');
        const profileModalAvatar = document.getElementById('profileModalAvatar');

        // Сначала ищем реальный <img> (inline script в base.html должен его добавить)
        const img = (profileAvatar && profileAvatar.querySelector('.avatar-img')) ||
                    (profileModalAvatar && profileModalAvatar.querySelector('.avatar-img'));
        if (img && img.src) return img.src;

        // Если img нет — определим по data-sex (фолбэк к статическим файлам)
        const sex = (profileAvatar && profileAvatar.dataset.sex) ||
                    (profileModalAvatar && profileModalAvatar.dataset.sex) || '';
        const s = String(sex).trim().toLowerCase();
        if (s.startsWith('м') || s === 'male' || s === 'm') {
            return '/static/images/male.svg';
        } else if (s.startsWith('ж') || s === 'female' || s === 'f') {
            return '/static/images/female.svg';
        }
    } catch (e) {
        console.warn('getUserAvatarSrc error', e);
    }
    return null;
}
// escapeHtml и escapeAttr берём из scripts.js (window.escapeHtml / window.escapeAttr)
const safeText = window.escapeHtml;
function getAvatarHtml(role, msg = {}) {
    if (role === 'user') {
        const src = getUserAvatarSrc();
        if (src) {
            return `<img class="chat-avatar-img" src="${escapeAttr(src)}" alt="Аватар пользователя">`;
        }

        // Попробуем взять инициалы из глобального .avatar-initials (если есть)
        const initialsEl = document.querySelector('.avatar-initials');
        const initials = initialsEl ? (initialsEl.textContent || '').trim() : '';
        if (initials) {
            return `<div class="chat-avatar-initials">${safeText(initials)}</div>`;
        }

        // Фолбэк
        return '👤';
    } else {
        // ассистент
        return '🤖';
    }
}

// Формат времени сообщения: сегодня → «HH:MM», раньше → «DD/MM/YYYY HH:MM».
// На вход — ISO с UTC-меткой от сервера; new Date локализует в зону пользователя.
function formatMsgTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    const sameDay = d.getFullYear() === now.getFullYear()
        && d.getMonth() === now.getMonth()
        && d.getDate() === now.getDate();
    return sameDay ? hm : `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${hm}`;
}

// Мета-строка под сообщением: кнопка копирования + время. iso может быть пустым —
// тогда время проставится при завершении генерации.
function buildMessageMeta(role, iso) {
    const t = iso || '';
    return `<div class="message-meta">`
        + `<button class="msg-action-btn msg-copy-btn" type="button" title="Копировать сообщение" aria-label="Копировать сообщение"><i class="fas fa-copy"></i></button>`
        + `<span class="msg-time" data-ts="${escapeAttr(t)}">${formatMsgTime(t)}</span>`
        + `</div>`;
}

// Копирование сообщения «вместе со стилями»: в буфер кладём и text/html (сохранит
// форматирование при вставке в Word/почту), и text/plain (исходный markdown).
// Авто-высота поля ввода: растёт под текст (в т.ч. переносы строк) максимум до 5 строк,
// дальше — вертикальная прокрутка. Пока строк ≤5, скролла НЕТ (overflow hidden), чтобы
// не мелькала полоса при одной строке. Горизонтальной прокрутки нет (перенос строк).
// ВАЖНО: константа объявлена ЛОКАЛЬНО — функция вызывается на раннем этапе init,
// module-level const был бы в TDZ и ронял весь обработчик инициализации.
function autoResizeInput() {
    const MAX_ROWS = 5;
    const ta = document.getElementById('messageInput');
    if (!ta) return;
    ta.style.height = 'auto';
    const cs = getComputedStyle(ta);
    const line = parseFloat(cs.lineHeight) || 20;
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const borderY = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    const maxH = Math.round(line * MAX_ROWS + padY + borderY);
    const needed = ta.scrollHeight;
    if (needed > maxH) {
        ta.style.height = maxH + 'px';
        ta.style.overflowY = 'auto';
    } else {
        ta.style.height = needed + 'px';
        ta.style.overflowY = 'hidden';
    }
}

// Универсальная авто-высота для произвольного textarea (редактор сообщения в пузыре).
// Растёт до maxRows строк, дальше — вертикальный скролл.
function autoResizeEl(el, maxRows = 6) {
    if (!el) return;
    el.style.height = 'auto';
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 20;
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const borderY = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    const maxH = Math.round(line * maxRows + padY + borderY);
    const needed = el.scrollHeight;
    if (needed > maxH) {
        el.style.height = maxH + 'px';
        el.style.overflowY = 'auto';
    } else {
        el.style.height = needed + 'px';
        el.style.overflowY = 'hidden';
    }
}

// Футер сообщения ПОЛЬЗОВАТЕЛЯ: [‹ i/n ›] изменить · копировать · время — у левого края.
function renderUserFooter(msg) {
    const id = msg.id;
    const iso = msg.ts || '';
    const nav = renderVariantNav(msg);
    const canEdit = id && !String(id).startsWith('temp');
    const editBtn = canEdit
        ? `<button class="msg-action-btn msg-edit-btn" type="button" data-edit="${escapeAttr(id)}" title="Изменить сообщение" aria-label="Изменить сообщение"><i class="fas fa-pen"></i></button>`
        : '';
    const copyBtn = `<button class="msg-action-btn msg-copy-btn" type="button" title="Копировать сообщение" aria-label="Копировать сообщение"><i class="fas fa-copy"></i></button>`;
    // Переслать своё сообщение коллеге (в мессенджер).
    const fwdBtn = `<button class="msg-action-btn msg-forward-btn" type="button" title="Переслать коллеге" aria-label="Переслать коллеге"><i class="fas fa-share"></i></button>`;
    const time = iso ? `<span class="msg-time" data-ts="${escapeAttr(iso)}">${formatMsgTime(iso)}</span>` : '';
    // Порядок: копировать · изменить · переслать · переключение веток · время.
    return `<div class="message-footer message-footer-user"><div class="msg-actions">${copyBtn}${editBtn}${fwdBtn}</div>${nav}${time}</div>`;
}

// Присваивает только что отправленному пузырю пользователя серверный id и пересобирает
// его футер (чтобы кнопка «изменить» появилась сразу, без перезагрузки страницы).
function assignUserMessageId(el, id) {
    if (!el || !id) return;
    el.dataset.messageId = String(id);
    const footer = el.querySelector('.message-footer');
    if (!footer) return;
    const tsEl = footer.querySelector('.msg-time');
    const ts = (tsEl && tsEl.dataset.ts) || new Date().toISOString();
    const tmp = document.createElement('div');
    tmp.innerHTML = renderUserFooter({ id, ts });
    if (tmp.firstElementChild) footer.replaceWith(tmp.firstElementChild);
}

async function copyMessage(contentEl, btn) {
    if (!contentEl) return;
    const html = contentEl.innerHTML;
    const text = contentEl.dataset.rawContent || contentEl.innerText || '';
    let ok = false;
    try {
        if (navigator.clipboard && window.ClipboardItem) {
            await navigator.clipboard.write([new ClipboardItem({
                'text/html': new Blob([html], { type: 'text/html' }),
                'text/plain': new Blob([text], { type: 'text/plain' }),
            })]);
            ok = true;
        } else if (navigator.clipboard) {
            await navigator.clipboard.writeText(text);
            ok = true;
        }
    } catch (e) {
        try { await navigator.clipboard.writeText(text); ok = true; } catch (e2) { ok = false; }
    }
    // Фолбэк для незащищённого контекста (http в локальной сети): execCommand
    // копирует только простой текст, но работает там, где Clipboard API недоступен.
    if (!ok) {
        try {
            const tmp = document.createElement('textarea');
            tmp.value = text;
            tmp.style.position = 'fixed';
            tmp.style.opacity = '0';
            document.body.appendChild(tmp);
            tmp.select();
            ok = document.execCommand('copy');
            document.body.removeChild(tmp);
        } catch (e3) { ok = false; }
    }
    if (btn) {
        const icon = btn.querySelector('i');
        const prev = icon ? icon.className : 'fas fa-copy';
        if (icon) icon.className = ok ? 'fas fa-check' : 'fas fa-xmark';
        btn.classList.toggle('copied', ok);
        setTimeout(() => { if (icon) icon.className = prev; btn.classList.remove('copied'); }, 1400);
    }
}

// Навигация по вариантам ответа: ‹ i/n › (только если вариантов больше одного).
function renderVariantNav(msg) {
    const count = Number(msg.variant_count || 1);
    if (count <= 1) return '';
    const idx = Number(msg.variant_index || 1);
    return `<div class="msg-variant-nav">`
        + `<button class="msg-variant-btn msg-variant-prev" type="button" title="Предыдущий вариант"${idx <= 1 ? ' disabled' : ''}><i class="fas fa-chevron-left"></i></button>`
        + `<span class="msg-variant-count">${idx}/${count}</span>`
        + `<button class="msg-variant-btn msg-variant-next" type="button" title="Следующий вариант"${idx >= count ? ' disabled' : ''}><i class="fas fa-chevron-right"></i></button>`
        + `</div>`;
}

// Футер ответа ассистента: [‹ i/n ›] копировать · нравится · не нравится · повторить · [время справа].
function renderAssistantFooter(msg) {
    const id = msg.id;
    const r = Number(msg.user_rating || 0);
    const iso = msg.ts || '';
    const nav = renderVariantNav(msg);
    const actions = `<div class="msg-actions">`
        + `<button class="msg-action-btn msg-copy-btn" type="button" title="Копировать сообщение" aria-label="Копировать сообщение"><i class="fas fa-copy"></i></button>`
        + `<button class="msg-action-btn chat-feedback-btn ${r === 1 ? 'is-active' : ''}" data-rate="1" data-feedback-for="${escapeAttr(id)}" type="button" title="Понравился" aria-label="Понравился"><i class="fas fa-thumbs-up"></i></button>`
        + `<button class="msg-action-btn chat-feedback-btn ${r === -1 ? 'is-active is-negative' : ''}" data-rate="-1" data-feedback-for="${escapeAttr(id)}" type="button" title="Не понравился" aria-label="Не понравился"><i class="fas fa-thumbs-down"></i></button>`
        + `<button class="msg-action-btn msg-retry-btn" type="button" data-retry="${escapeAttr(id)}" title="Попробовать снова" aria-label="Попробовать снова"><i class="fas fa-rotate-right"></i></button>`
        + `<button class="msg-action-btn msg-forward-btn" type="button" data-forward="${escapeAttr(id)}" title="Переслать коллеге" aria-label="Переслать коллеге"><i class="fas fa-share"></i></button>`
        + `</div>`;
    const factcheck = renderFactCheckBadge(msg);
    const time = iso
        ? `<span class="msg-time" data-ts="${escapeAttr(iso)}">${formatMsgTime(iso)}</span>`
        : `<span class="msg-time" data-ts=""></span>`;
    return `<div class="message-footer">${nav}${actions}${factcheck}${time}</div>`;
}

// Полная перестройка содержимого пузыря ассистента (для переключения вариантов).
function rebuildAssistantMessage(el, msg) {
    if (!el || !msg) return;
    el.dataset.messageId = msg.id;
    const wrap = el.querySelector('.message-wrapper');
    if (!wrap) return;
    const raw = (msg.content == null) ? '' : String(msg.content);
    const formatted = (typeof formatMessageContent === 'function')
        ? formatMessageContent(raw, msg.sources, true)
        : escapeHtml(raw);
    let html = `<div class="message-content" data-raw-content="${escapeAttr(raw)}">${formatted}</div>`;
    if (msg.attachment) html += renderAttachmentCard(msg.attachment);
    html += renderAnswerMeta(msg);
    html += renderAssistantFooter(msg);  // self-check-чип — внутри футера
    wrap.innerHTML = html;
    if (typeof attachFeedbackHandlers === 'function') attachFeedbackHandlers(el);
}

        function renderMessages(messages) {
    if (!messagesContainer) return;

    if (!messages || messages.length === 0) {
        messagesContainer.innerHTML = `
            <div class="no-messages">
                <p>Нет сообщений. Начните диалог!</p>
            </div>
        `;
        return;
    }

    messagesContainer.innerHTML = messages.map(msg => {
        const visualRole = (msg.role === 'assistant') ? 'bot' : msg.role;
        const unreadClass = (msg.role === 'assistant' && !msg.is_read) ? 'unread' : '';
        const raw = (typeof msg.content === 'undefined' || msg.content === null) ? '' : String(msg.content);
        // Незавершённый ответ без текста (после правки/ретрая, до первого чанка) —
        // показываем индикатор «думает», иначе форматируем контент.
        let formatted;
        if (msg.role === 'assistant' && !msg.is_finished && !raw) {
            formatted = renderThinkingIndicator('search');
        } else {
            formatted = (typeof formatMessageContent === 'function') ? formatMessageContent(raw, msg.sources) : escapeHtml(raw);
        }
        const attachmentHtml = msg.attachment ? renderAttachmentCard(msg.attachment) : '';
        const userAttachHtml = (msg.user_attachments && msg.user_attachments.length)
            ? renderUserAttachments(msg.user_attachments) : '';
        // Пересланные из мессенджера сообщения — блоком над текстом пользователя.
        const fwdHtml = (msg.role === 'user' && msg.forwarded) ? renderForwardedBlock(msg.forwarded) : '';
        // Ассистент (только если ответ завершён): навигация вариантов + действия + self-check + время.
        // Пользователь: навигация правок + изменить + копировать + время (у левого края).
        let footerHtml = '';
        if (msg.role === 'assistant') {
            footerHtml = msg.is_finished ? renderAssistantFooter(msg) : '';
        } else {
            footerHtml = renderUserFooter(msg);
        }

        return `
        <div class="message ${visualRole} ${unreadClass}"
             data-message-id="${escapeAttr(msg.id)}"
             data-is-read="${escapeAttr(msg.is_read)}">
            <div class="message-avatar">
                ${getAvatarHtml(msg.role, msg)}
            </div>
            <div class="message-wrapper">
                <div class="message-content" data-raw-content="${escapeAttr(raw)}">
                    ${fwdHtml}${formatted}
                </div>
                ${userAttachHtml}
                ${attachmentHtml}
                ${(msg.role === 'assistant' && msg.is_finished) ? renderAnswerMeta(msg) : ''}
                ${footerHtml}
            </div>
        </div>
        `;
    }).join('');
    attachFeedbackHandlers(messagesContainer);

    // Инициализируем набор непрочитанных сообщений
    updateUnreadMessagesSet();
}


// ===== Быстрый набор частых вопросов (FAQ): категория → вопрос → ветка =====
(function () {
    const toggle = document.getElementById('faqQuickToggle');
    const panel = document.getElementById('faqQuickPanel');
    const chipsEl = document.getElementById('faqQuickChips');
    const pathEl = document.getElementById('faqQuickPath');
    if (!toggle || !panel || !chipsEl) return;

    let menu = null;       // категории с вопросами (грузится лениво)
    let stack = [];        // навигация: [] → [катИдx] → [катИдx, вопрИдx]

    function chip(label, cls, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'faq-chip' + (cls ? ' ' + cls : '');
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
    }

    function sendFaq(question, faqId) {
        const input = document.getElementById('messageInput');
        const send = window._chatSendMessage;
        if (!input || typeof send !== 'function') return;
        input.value = question;
        window._pendingFaqId = faqId;
        panel.hidden = true;
        toggle.classList.remove('open');
        send();
    }

    function render() {
        chipsEl.innerHTML = '';
        pathEl.innerHTML = '';
        if (!menu) return;
        if (stack.length) {
            pathEl.appendChild(chip('← Назад', 'faq-chip-back', () => { stack.pop(); render(); }));
            const crumbs = [menu[stack[0]].label];
            if (stack.length > 1) crumbs.push(menu[stack[0]].items[stack[1]].block);
            const span = document.createElement('span');
            span.className = 'faq-path-text';
            span.textContent = crumbs.join(' → ');
            pathEl.appendChild(span);
        }
        if (stack.length === 0) {
            menu.forEach((cat, i) => {
                chipsEl.appendChild(chip(cat.label, 'faq-chip-cat', () => { stack = [i]; render(); }));
            });
        } else if (stack.length === 1) {
            menu[stack[0]].items.forEach((item, j) => {
                const hasOpts = item.options && item.options.length;
                chipsEl.appendChild(chip(
                    item.block + (hasOpts ? ' …' : ''),
                    hasOpts ? 'faq-chip-branch' : '',
                    () => {
                        if (hasOpts) { stack = [stack[0], j]; render(); }
                        else sendFaq(item.question, item.id);
                    }
                ));
            });
        } else {
            const item = menu[stack[0]].items[stack[1]];
            (item.options || []).forEach((opt) => {
                chipsEl.appendChild(chip(opt.label, '', () =>
                    sendFaq(item.question + ' — ' + opt.label, opt.id)));
            });
        }
    }

    toggle.addEventListener('click', async () => {
        panel.hidden = !panel.hidden;
        toggle.classList.toggle('open', !panel.hidden);
        if (panel.hidden || menu) return;
        try {
            const r = await fetch('/api/chat/faq-menu');
            const d = await r.json();
            menu = (d.categories || []).filter((c) => c.items && c.items.length);
            if (!menu.length) {
                chipsEl.innerHTML = '<span class="faq-quick-loading">FAQ пока не загружен</span>';
                return;
            }
            render();
        } catch (e) {
            chipsEl.innerHTML = '<span class="faq-quick-loading">Не удалось загрузить FAQ</span>';
        }
    });
})();

// ===== Мета ответа (А2/А3): уточняющий вопрос FAQ + дисклеймер с контактом =====
// Кнопки-варианты под уточняющим вопросом (клик отправляет вариант как сообщение).
function renderClarifyChips(meta) {
    if (!meta || !meta.clarify || !meta.clarify.options || !meta.clarify.options.length) return '';
    const chips = meta.clarify.options.map((o) =>
        `<button type="button" class="chat-clarify-opt" data-option="${escapeAttr(o)}">${escapeHtml(o)}</button>`
    ).join('');
    return `<div class="chat-clarify-opts">${chips}</div>`;
}

// Обязательная пометка (протокол, п.1): информация не окончательная + контакт
// подразделения. Показывается у ответов по базе знаний (есть источники) и у
// ответов FAQ (известен контакт).
function renderAnswerNote(msg) {
    const hasSources = !!(msg.sources && msg.sources.length);
    const contact = msg.meta && msg.meta.contact;
    if (!hasSources && !contact) return '';
    let html = '<div class="chat-answer-note"><i class="fas fa-circle-info"></i><div>' +
        '<span class="chat-note-text">Информация носит справочный характер и не является ' +
        'окончательной редакцией — актуальные положения уточняйте в первоисточниках.</span>';
    if (contact) {
        html += `<span class="chat-note-contact"><i class="fas fa-user-tie"></i> Контакт: ${escapeHtml(contact)}</span>`;
    }
    html += '</div></div>';
    return html;
}

// А2: связанные бланки/документы FAQ — кликабельные карточки «Открыть/Скачать».
function renderRelatedFiles(meta) {
    const files = meta && meta.related_files;
    if (!files || !files.length) return '';
    const cards = files.map((f) => {
        const icon = f.kind === 'template' ? 'fa-file-word' : 'fa-file-lines';
        const kindLabel = f.kind === 'template' ? 'бланк — открыть/скачать' : 'документ — открыть/скачать';
        const view = f.view_url || f.url;
        return '<div class="chat-attachment">' +
            `<a class="chat-attachment-main" href="${escapeAttr(view)}" target="_blank" rel="noopener" title="Открыть">` +
            `<div class="chat-attachment-icon"><i class="fas ${icon}"></i></div>` +
            `<div class="chat-attachment-body"><div class="chat-attachment-title">${escapeHtml(f.title || 'Документ')}</div>` +
            `<div class="chat-attachment-name">${kindLabel}</div></div></a>` +
            `<a class="chat-attachment-action" href="${escapeAttr(f.url)}" title="Скачать" aria-label="Скачать">` +
            '<i class="fas fa-download"></i></a></div>';
    }).join('');
    return '<div class="chat-related-files"><div class="chat-related-title">' +
        '<i class="fas fa-paperclip"></i> Бланки и документы</div>' + cards + '</div>';
}

function renderAnswerMeta(msg) {
    if (!msg || msg.role !== 'assistant') return '';
    return renderClarifyChips(msg.meta) + renderRelatedFiles(msg.meta) + renderAnswerNote(msg);
}

// ===== Пересланные из мессенджера сообщения (в стиле пересылки мессенджера) =====
// Классы msgr-fwd-from* берутся из messenger.css (подключён глобально в base.html).
function forwardItemHtml(it) {
    const who = it.ai ? 'HR-ассистент' : (it.from_name || '—');
    const ava = it.ai ? '<i class="fa-solid fa-robot"></i>' : escapeHtml(it.from_initials || '?');
    let inner =
        '<div class="msgr-fwd-from"><span class="msgr-fwd-from-label"><i class="fa-solid fa-share"></i> Переслано от</span>' +
        '<span class="msgr-fwd-from-ava">' + ava + '</span>' +
        '<span class="msgr-fwd-from-name">' + escapeHtml(who) + '</span>' +
        (it.chat ? '<span class="chat-fwd-chat">· ' + escapeHtml(it.chat) + '</span>' : '') +
        '</div>';
    if (it.text) inner += '<div class="chat-fwd-text">' + escapeHtml(it.text) + '</div>';
    const atts = it.attachments || [];
    const imgs = atts.filter((a) => a.is_image);
    const files = atts.filter((a) => !a.is_image);
    if (imgs.length) {
        inner += '<div class="chat-fwd-imgs">' + imgs.map((a) =>
            '<a href="' + escapeAttr(a.url) + '" target="_blank" rel="noopener">' +
            '<img src="' + escapeAttr(a.url) + '" alt="' + escapeAttr(a.name || '') + '" loading="lazy"></a>'
        ).join('') + '</div>';
    }
    if (files.length) {
        inner += '<div class="msg-attachments">' + files.map((a) =>
            '<a class="msg-attach-chip" href="' + escapeAttr(a.url + '?download=1') + '" title="Скачать">' +
            '<i class="fas fa-paperclip"></i>' + escapeHtml(a.name || 'файл') + '</a>'
        ).join('') + '</div>';
    }
    return '<div class="chat-fwd-item">' + inner + '</div>';
}

function renderForwardedBlock(items) {
    if (!items || !items.length) return '';
    return '<div class="chat-fwd-block">' + items.map(forwardItemHtml).join('') + '</div>';
}

// Превью ещё НЕ отправленной пересылки: псевдо-пузырь в конце ленты.
function removePendingForwardPreview() {
    if (!messagesContainer) return;
    const el = messagesContainer.querySelector('.chat-fwd-pending');
    if (el) el.remove();
}

function renderPendingForwardPreview() {
    removePendingForwardPreview();
    if (!pendingForwardItems || !pendingForwardItems.length || !messagesContainer) return;
    const noMessagesEl = messagesContainer.querySelector('.no-messages');
    if (noMessagesEl) noMessagesEl.remove();
    const div = document.createElement('div');
    div.className = 'message user chat-fwd-pending';
    div.innerHTML =
        '<div class="message-avatar">' + getAvatarHtml('user', {}) + '</div>' +
        '<div class="message-wrapper"><div class="message-content">' +
        renderForwardedBlock(pendingForwardItems) +
        '<div class="chat-fwd-hint"><i class="fas fa-share"></i> Готово к отправке ассистенту — ' +
        'добавьте вопрос или комментарий (необязательно) и нажмите «Отправить»</div>' +
        '</div></div>';
    messagesContainer.appendChild(div);
    scrollToBottom(true);
}

// Чипы прикреплённых пользователем файлов под его сообщением (#8).
function renderUserAttachments(list) {
    if (!list || !list.length) return '';
    const chips = list.map((f) => {
        const name = (typeof f === 'string') ? f : (f.name || 'файл');
        const icon = (typeof sourceFileIcon === 'function') ? sourceFileIcon(name) : 'fa-paperclip';
        return `<span class="msg-attach-chip"><i class="fas ${icon}"></i>${escapeHtml(name)}</span>`;
    }).join('');
    return `<div class="msg-attachments">${chips}</div>`;
}

function addMessageToUI(role, content, messageId = null, isRead = false, attachments = null) {
    if (!messagesContainer) return;

    // Удаляем плейсхолдер "Нет сообщений..."
    const noMessagesEl = messagesContainer.querySelector('.no-messages');
    if (noMessagesEl) noMessagesEl.remove();

    const messageDiv = document.createElement('div');
    const visualRole = (role === 'assistant') ? 'bot' : role;

    // typing-индикатор считается видимым (чтобы не отображать как непрочитанное)
    if (content === '__typing__') {
        isRead = true;
    }

    messageDiv.className = `message ${visualRole} ${role === 'assistant' && !isRead ? 'unread' : ''}`;
    if (messageId) {
        messageDiv.dataset.messageId = messageId;
        messageDiv.dataset.isRead = String(!!isRead);
    }

    // Формируем .message-content всегда — даже для typing-индикатора
    let contentInnerHtml = '';
    if (content === '__typing__') {
        // сохраняем data-raw-content пустым — это позволит потом appendRawContentForElement работать корректно
        contentInnerHtml = `
            <div class="message-content" data-raw-content="" data-status="search">
                ${renderThinkingIndicator('search')}
        `;
    } else {
        const raw = (typeof content === 'undefined' || content === null) ? '' : String(content);
        let formatted;
        if (typeof formatMessageContent === 'function') {
            try {
                formatted = formatMessageContent(raw);
            } catch (e) {
                console.warn('formatMessageContent error, falling back to escapeHtml', e);
                formatted = escapeHtml(raw);
            }
        } else {
            formatted = escapeHtml(raw);
        }
        contentInnerHtml = `<div class="message-content" data-raw-content="${escapeAttr(raw)}">${formatted}</div>`;
    }

    const attachHtml = (attachments && attachments.length) ? renderUserAttachments(attachments) : '';
    // Футер — для готовых сообщений. Для «печатает…» добавим позже (по завершении).
    // Пользователь — левый футер (копирование/время; изменить/навигация появятся после
    // перезагрузки, когда у сообщения есть серверный id). Ассистент-ошибка — мета.
    let metaHtml = '';
    if (content !== '__typing__') {
        metaHtml = (role === 'user')
            ? renderUserFooter({ id: messageId, ts: new Date().toISOString() })
            : buildMessageMeta(role, new Date().toISOString());
    }
    messageDiv.innerHTML = `
        <div class="message-avatar">
            ${getAvatarHtml(role, { id: messageId })}
        </div>
        <div class="message-wrapper">
            ${contentInnerHtml}
            ${attachHtml}
            ${metaHtml}
        </div>
    `;

    messagesContainer.appendChild(messageDiv);
    scrollToBottom(false);

    // Обновляем набор непрочитанных сообщений
    if (role === 'assistant') {
        if (messageId) {
            if (!isRead) {
                unreadMessages.add(String(messageId));
                messageDiv.classList.add('unread');
            } else {
                unreadMessages.delete(String(messageId));
                messageDiv.classList.remove('unread');
            }
        } else {
            // временные элементы (без id) не считаем непрочитанными
        }
        updateUnreadIndicator();
    }
}



        // Новая функция для обновления набора непрочитанных сообщений
        function updateUnreadMessagesSet() {
            if (!messagesContainer) return;

            unreadMessages.clear();
            // У сообщений ассистента визуальный класс 'bot' (не 'assistant').
            const unreadElements = messagesContainer.querySelectorAll('.message.bot.unread');
            unreadElements.forEach(element => {
                const messageId = element.dataset.messageId;
                if (messageId) {
                    unreadMessages.add(String(messageId));
                }
            });
            updateUnreadIndicator();
        }

        function updateUnreadIndicator() {
    const unreadCount = unreadMessages.size;

    // Обновляем бейдж в заголовке
    if (chatStatus) {
        // Если сейчас идёт генерация в этом клиенте — показываем "Генерация..." и при необходимости
        // добавляем число непрочитанных рядом, но не затираем статус генерации.
        if (currentStreaming && currentStreaming.active) {
            // Покажем генерацию и (опционально) количество непрочитанных
            if (unreadCount > 0) {
                chatStatus.innerHTML = `Генерация... • <span class="unread-indicator">${unreadCount} непрочитанных</span>`;
                chatStatus.classList.add('has-unread');
            } else {
                chatStatus.textContent = 'Генерация...';
                chatStatus.classList.remove('has-unread');
            }
        } else {
            // Обычное поведение: если есть непрочитанные — показываем их, иначе "Онлайн"
            if (unreadCount > 0) {
                chatStatus.innerHTML = `Онлайн • <span class="unread-indicator">${unreadCount} непрочитанных</span>`;
                chatStatus.classList.add('has-unread');
            } else {
                chatStatus.textContent = 'Онлайн';
                chatStatus.classList.remove('has-unread');
            }
        }
    }

    // Обновляем плавающий индикатор
    updateFloatingIndicator();
}

        // Функция для проверки видимости сообщений
        function checkVisibleMessages() {
            if (!messagesContainer) return;

            const messages = messagesContainer.querySelectorAll('.message.bot.unread');
            const visibleUnread = [];

            messages.forEach(message => {
                const rect = message.getBoundingClientRect();
                const containerRect = messagesContainer.getBoundingClientRect();

                // Сообщение видимо, если оно находится в пределах контейнера
                const isVisible = (
                    rect.top >= containerRect.top &&
                    rect.bottom <= containerRect.bottom &&
                    rect.left >= containerRect.left &&
                    rect.right <= containerRect.right
                );

                if (isVisible) {
                    const messageId = message.dataset.messageId;
                    if (messageId) {
                        visibleUnread.push(messageId);
                    }
                }
            });

            // Если есть видимые непрочитанные сообщения, отмечаем их как прочитанные
            if (visibleUnread.length > 0) {
                markMessagesAsRead(visibleUnread);
            }
        }

        // Функция для отметки сообщений как прочитанных
        async function markMessagesAsRead(messageIds) {
            try {
                const response = await fetch('/api/chat/mark-as-read', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        session_id: sessionId,
                        message_ids: messageIds
                    })
                });

                const data = await response.json();

                if (data.success) {
                    // Обновляем UI
                    messageIds.forEach(id => {
                        const messageElement = messagesContainer.querySelector(`[data-message-id="${id}"]`);
                        if (messageElement) {
                            messageElement.classList.remove('unread');
                            messageElement.dataset.isRead = 'true';

                            // Убираем бейдж "Новое"
                            const badge = messageElement.querySelector('.unread-badge');
                            if (badge) {
                                badge.remove();
                            }
                        }

                        // Удаляем из набора
                        unreadMessages.delete(String(id));
                    });

                    updateUnreadIndicator();
                }
            } catch (error) {
                console.error('Error marking messages as read:', error);
            }
        }

        // Проверка видимости непрочитанных — ПО СОБЫТИЯМ (скролл/фокус/рендер),
        // а не 500мс-поллингом: тот впустую сканировал DOM дважды в секунду.
        function startUnreadCheck() {
            if (messagesContainer) {
                messagesContainer.addEventListener('scroll', debounce(checkVisibleMessages, 150));
            }
            window.addEventListener('focus', checkVisibleMessages);
            checkVisibleMessages();
        }

        // Функция для обновления плавающего индикатора
        function updateFloatingIndicator() {
            const floatingIndicator = document.getElementById('floatingUnreadIndicator');
            const floatingCount = document.getElementById('floatingUnreadCount');
            const countTextEl = floatingIndicator ? floatingIndicator.querySelector('.fui-text') : null;
            const unreadCount = unreadMessages.size;

            if (!floatingIndicator || !floatingCount) return;

            const streaming = currentStreaming && currentStreaming.active;
            const atBottom = isUserAtBottom(40);

            // Если идёт генерация в этом клиенте и пользователь привязан к низу —
            // индикатор показывать не нужно: он и так видит, что пишется.
            if (streaming && atBottom && !userScrolledUp) {
                floatingIndicator.classList.remove('visible');
                return;
            }

            // Во время генерации, если пользователь отскроллил вверх — показываем
            // отдельную кнопку «↓ Вернуться к ответу» (без счётчика непрочитанных).
            if (streaming && userScrolledUp) {
                floatingCount.textContent = '';
                if (countTextEl) countTextEl.textContent = 'Вернуться к ответу';
                floatingIndicator.classList.add('visible');
                floatingIndicator.onclick = scrollToFirstUnread;
                return;
            }

            // Обычный режим — количество непрочитанных
            if (unreadCount > 0) {
                floatingCount.textContent = unreadCount;
                if (countTextEl) countTextEl.textContent = 'непрочитанных';
                floatingIndicator.classList.add('visible');
                floatingIndicator.onclick = scrollToFirstUnread;
            } else {
                floatingIndicator.classList.remove('visible');
            }
        }

        // Функция для прокрутки к первому непрочитанному сообщению (или просто вниз,
        // если ничего не помечено непрочитанным — например, во время активной генерации
        // в этой же сессии: пользователь хочет «вернуться к ответу»).
        function scrollToFirstUnread() {
            if (!messagesContainer) return;

            const firstUnread = messagesContainer.querySelector('.message.bot.unread');
            if (firstUnread) {
                firstUnread.scrollIntoView({ behavior: 'smooth', block: 'center' });

                // Подсвечиваем сообщение
                firstUnread.style.backgroundColor = 'rgba(255, 215, 0, 0.2)';
                setTimeout(() => {
                    firstUnread.style.backgroundColor = '';
                }, 2000);
            } else {
                // Нет непрочитанных — просто прокручиваем к самому низу
                scrollToBottom(true);
            }
            // Сразу разрешаем автоскролл во время дальнейшей генерации
            userScrolledUp = false;
        }

        function showErrorMessage(message) {
            if (!messagesContainer) return;

            messagesContainer.innerHTML = `
                <div class="error-message">
                    ${escapeHtml(message)}
                </div>
            `;
        }
// Рендер контента ассистента (markdown, перенумерация ссылок, блок «Источники»,
// карточки) — общий код в static/js/message_format.js (window.MsgFmt).
// Обёртки-декларации (не const): hoisting гарантирует доступность до инициализации.
function formatMessageContent(raw, sources, includeSources = true) {
    return window.MsgFmt.formatMessageContent(raw, sources, includeSources);
}
function sourceFileIcon(filename) {
    return window.MsgFmt.sourceFileIcon(filename);
}



// Индикатор «бот думает» внутри пустого пузырька
const STATUS_LABELS = {
    search: 'Ищу в базе знаний…',
    rerank: 'Подбираю самые релевантные фрагменты…',
    rerank_done: 'Готовлю ответ…',
    generate: 'Формулирую ответ…',
};

function renderThinkingIndicator(statusKey) {
    const label = STATUS_LABELS[statusKey] || 'Подготовка ответа…';
    return `
        <div class="bot-thinking" data-thinking="true">
            <div class="typing-indicator typing-inline">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
            <span class="bot-thinking-status">${label}</span>
        </div>
    `;
}

// ===== Сохранение выделения текста при перерисовке innerHTML =====
// Во время стриминга innerHTML переписывается на каждый chunk — это убивает Selection
// (браузер сбрасывает range, как только нода удалена). Чтобы пользователь мог копировать
// уже сгенерированный текст, сохраняем offset'ы относительно root-элемента и восстанавливаем
// их после перерисовки. Используем walker по текстовым нодам — структура HTML не важна.
function _textOffsetWithin(root, node, nodeOffset) {
    if (node === root) {
        // selection «снаружи» текстовых нод (между <p>) — приблизим к концу
        let total = 0;
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (w.nextNode()) total += w.currentNode.textContent.length;
        return total;
    }
    let offset = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const cur = walker.currentNode;
        if (cur === node) return offset + nodeOffset;
        offset += cur.textContent.length;
    }
    return offset;
}

function _nodeAtTextOffset(root, target) {
    let offset = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let last = null;
    while (walker.nextNode()) {
        last = walker.currentNode;
        const len = last.textContent.length;
        if (offset + len >= target) {
            return { node: last, offset: Math.max(0, target - offset) };
        }
        offset += len;
    }
    if (last) return { node: last, offset: last.textContent.length };
    return { node: root, offset: 0 };
}

function _withPreservedSelection(rootEl, mutate) {
    const sel = (typeof window !== 'undefined') ? window.getSelection() : null;
    let snap = null;
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        if (rootEl.contains(range.startContainer) && rootEl.contains(range.endContainer)) {
            snap = {
                start: _textOffsetWithin(rootEl, range.startContainer, range.startOffset),
                end:   _textOffsetWithin(rootEl, range.endContainer,   range.endOffset),
            };
        }
    }
    mutate();
    if (snap && sel) {
        try {
            const s = _nodeAtTextOffset(rootEl, snap.start);
            const e = _nodeAtTextOffset(rootEl, snap.end);
            const r = document.createRange();
            r.setStart(s.node, s.offset);
            r.setEnd(e.node, e.offset);
            sel.removeAllRanges();
            sel.addRange(r);
        } catch (e) { /* выделение могло уйти за пределы — игнорируем */ }
    }
}

// Управление raw-контентом в DOM: все .message-content будут хранить сырой текст в data-raw-content
function setRawContentForElement(contentEl, raw) {
    if (!contentEl) return;
    contentEl.dataset.rawContent = raw || '';
    let sources = null;
    if (contentEl.dataset.sources) {
        try { sources = JSON.parse(contentEl.dataset.sources); } catch (e) { sources = null; }
    }
    const includeSources = contentEl.dataset.streaming !== 'true';  // блок только после стрима
    _withPreservedSelection(contentEl, () => {
        if (!raw) {
            const status = contentEl.dataset.status || 'search';
            contentEl.innerHTML = renderThinkingIndicator(status);
        } else {
            contentEl.innerHTML = formatMessageContent(raw, sources, includeSources);
        }
    });
}

function appendRawContentForElement(contentEl, chunk) {
    if (!contentEl) return;
    const prev = contentEl.dataset.rawContent || '';
    const next = prev + (chunk || '');
    setRawContentForElement(contentEl, next);
}

function setThinkingStatus(contentEl, statusKey) {
    if (!contentEl) return;
    contentEl.dataset.status = statusKey;
    const raw = contentEl.dataset.rawContent || '';
    // Перерисовываем индикатор только если контент ещё пустой
    if (!raw) {
        contentEl.innerHTML = renderThinkingIndicator(statusKey);
    }
}

function renderFactCheckBadge(msg) {
    if (!msg || msg.role !== 'assistant' || !msg.fact_check) return '';
    const fc = msg.fact_check;
    const supported = Number(fc.supported || 0);
    const total = Number(fc.total || 0);
    if (total <= 0) return '';
    // Компактный чип для строки футера (полный текст — в подсказке title).
    if (supported === 0) {
        return `<span class="chat-factcheck chat-factcheck-warn" title="Ни одно из ${total} утверждений ответа не подтверждается источниками. Перепроверьте перед использованием."><i class="fas fa-triangle-exclamation"></i> Не подкреплено (0/${total})</span>`;
    }
    if (supported < total) {
        return `<span class="chat-factcheck chat-factcheck-partial" title="${supported} из ${total} утверждений подтверждены источниками."><i class="fas fa-circle-info"></i> Частично (${supported}/${total})</span>`;
    }
    return '';
}

async function sendFeedback(messageId, rating) {
    try {
        const resp = await fetch('/api/chat/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message_id: Number(messageId), rating: rating }),
        });
        return resp.ok;
    } catch (e) { console.warn('feedback failed', e); return false; }
}

function attachFeedbackHandlers(root) {
    if (!root) return;
    root.querySelectorAll('.chat-feedback').forEach((bar) => {
        const msgId = bar.dataset.feedbackFor;
        bar.querySelectorAll('[data-rate]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const target = Number(btn.dataset.rate);
                const wasActive = btn.classList.contains('is-active');
                const newRating = wasActive ? 0 : target;
                bar.querySelectorAll('[data-rate]').forEach((b) => b.classList.remove('is-active', 'is-negative'));
                if (newRating === 1) btn.classList.add('is-active');
                if (newRating === -1) btn.classList.add('is-active', 'is-negative');
                await sendFeedback(msgId, newRating);
            });
        });
    });
}

// Карточка сгенерированного документа — общий код (window.MsgFmt).
function renderAttachmentCard(att) {
    return window.MsgFmt.renderAttachmentCard(att);
}

function attachDocumentCard(messageEl, att) {
    if (!messageEl || !att) return;
    const wrapper = messageEl.querySelector('.message-wrapper');
    if (!wrapper) return;
    // Не дублируем, если карточка уже есть
    if (wrapper.querySelector('.chat-attachment[data-doc-id="' + att.id + '"]')) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = renderAttachmentCard(att);
    const card = tmp.firstElementChild;
    if (card) {
        card.dataset.docId = att.id;
        wrapper.appendChild(card);
    }
}

        // escapeHtml / debounce — определены в scripts.js (window.*)
        const escapeHtml = window.escapeHtml;
        const debounce = window.debounce;

        const ALLOWED_ATTACH_EXT = ['.pdf', '.docx', '.doc', '.txt', '.md', '.rtf', '.odt', '.xls', '.xlsx', '.ods'];
        const attachedFilesContainer = document.getElementById('attachedFiles');

        async function uploadDocument(file) {
            if (!sessionId || !file || isProcessingDocument) return;
            const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
            if (!ALLOWED_ATTACH_EXT.includes(ext)) {
                addMessageToUI('assistant', `Поддерживаются файлы: ${ALLOWED_ATTACH_EXT.join(', ')}`);
                return;
            }

            isProcessingDocument = true;
            setUILocked(true);

            const uploadStatus = document.getElementById('uploadStatus');
            const uploadText = uploadStatus.querySelector('.upload-text');
            const uploadProgressBar = uploadStatus.querySelector('.upload-progress-bar');

            uploadStatus.style.display = 'block';
            uploadStatus.className = 'upload-status';
            uploadText.textContent = `Парсинг «${file.name}»…`;
            uploadProgressBar.style.width = '15%';

            const formData = new FormData();
            formData.append('file', file);
            formData.append('session_id', sessionId);

            try {
                const response = await fetch('/api/chat/upload-document', {
                    method: 'POST',
                    body: formData,
                });
                uploadProgressBar.style.width = '90%';
                const data = await response.json();
                uploadProgressBar.style.width = '100%';

                if (response.ok && data.success) {
                    uploadStatus.className = 'upload-status success';
                    uploadText.textContent = `✓ «${file.name}» прикреплён к следующему сообщению (${data.file.chars} символов).`;
                    await loadAttachedFiles();
                    setTimeout(() => { uploadStatus.style.display = 'none'; }, 3000);
                } else {
                    uploadStatus.className = 'upload-status error';
                    uploadText.textContent = `Ошибка: ${data.detail || data.error || 'не удалось загрузить'}`;
                    setTimeout(() => { uploadStatus.style.display = 'none'; }, 5000);
                }
            } catch (error) {
                console.error('Upload error:', error);
                uploadStatus.className = 'upload-status error';
                uploadText.textContent = 'Ошибка подключения к серверу';
                setTimeout(() => { uploadStatus.style.display = 'none'; }, 5000);
            } finally {
                isProcessingDocument = false;
                setUILocked(false);
            }
        }

        async function loadAttachedFiles() {
            if (!sessionId || !attachedFilesContainer) return;
            try {
                const resp = await fetch(`/api/chat/session-files?session_id=${sessionId}`);
                const data = await resp.json();
                renderAttachedFiles(data.items || []);
            } catch (err) {
                console.warn('Не удалось загрузить список вложений', err);
            }
        }

        function renderAttachedFiles(items) {
            if (!attachedFilesContainer) return;
            if (!items.length) {
                attachedFilesContainer.innerHTML = '';
                return;
            }
            const iconFor = (window.MsgFmt && window.MsgFmt.sourceFileIcon)
                ? window.MsgFmt.sourceFileIcon : () => 'fa-file';
            attachedFilesContainer.innerHTML = items.map(f => {
                const chars = Number(f.chars || 0).toLocaleString('ru-RU');
                return `
                <span class="attached-file" data-file-id="${f.id}">
                    <span class="att-ic"><i class="fas ${iconFor(f.name)}"></i></span>
                    <span class="att-info">
                        <span class="att-name" title="${escapeAttr(f.name)}">${escapeHtml(f.name)}</span>
                        <span class="att-meta">${chars} симв.</span>
                    </span>
                    <button type="button" class="att-remove" title="Открепить" aria-label="Открепить">
                        <i class="fas fa-xmark"></i>
                    </button>
                </span>`;
            }).join('');
            attachedFilesContainer.querySelectorAll('.att-remove').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const wrapper = e.currentTarget.closest('.attached-file');
                    const fileId = wrapper && wrapper.dataset.fileId;
                    if (!fileId) return;
                    try {
                        await fetch(`/api/chat/session-files/${fileId}`, { method: 'DELETE' });
                        loadAttachedFiles();
                    } catch (err) { console.warn(err); }
                });
            });
        }

        function setUILocked(locked) {
            const messageInputEl = document.getElementById('messageInput');
            const sendButtonEl = document.getElementById('sendButton');
            const attachButtonEl = document.getElementById('attachButton');
            const fileInputEl = document.getElementById('fileInput');

            if (messageInputEl) messageInputEl.disabled = locked;
            if (sendButtonEl) sendButtonEl.disabled = locked;
            if (fileInputEl) fileInputEl.disabled = locked;
            if (attachButtonEl) attachButtonEl.style.opacity = locked ? '0.5' : '1';

            if (messageInputEl) {
                messageInputEl.placeholder = locked
                    ? 'Обработка документа...'
                    : 'Вы можете задать свой вопрос здесь';
            }
        }

        const fileInput = document.getElementById('fileInput');
        const attachButton = document.getElementById('attachButton');

        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length > 0) {
                    uploadDocument(e.target.files[0]);
                    fileInput.value = '';
                }
            });
        }

        if (attachButton) {
            attachButton.addEventListener('dragenter', (e) => {
                if (!isProcessingDocument && sessionId) {
                    e.preventDefault();
                    attachButton.style.background = '#dbeafe';
                }
            });
            attachButton.addEventListener('dragleave', (e) => {
                e.preventDefault();
                attachButton.style.background = '';
            });
            attachButton.addEventListener('dragover', (e) => {
                if (!isProcessingDocument && sessionId) e.preventDefault();
            });
            attachButton.addEventListener('drop', (e) => {
                e.preventDefault();
                attachButton.style.background = '';
                if (!isProcessingDocument && sessionId && e.dataTransfer.files.length > 0) {
                    uploadDocument(e.dataTransfer.files[0]);
                }
            });
        }

        // Drag-and-drop файлов на ВСЮ область чата + вставка (Ctrl+V) из буфера.
        async function uploadFilesSeq(fileList) {
            for (const f of fileList) {
                if (!sessionId) break;
                // uploadDocument ставит isProcessingDocument; ждём завершения перед следующим
                // eslint-disable-next-line no-await-in-loop
                await uploadDocument(f);
            }
        }
        const chatBox = document.getElementById('chatBox');
        if (chatBox) {
            let dzDepth = 0;
            const hasFiles = (e) => e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
            chatBox.addEventListener('dragenter', (e) => { if (!sessionId || !hasFiles(e)) return; e.preventDefault(); dzDepth++; chatBox.classList.add('chat-drop-active'); });
            chatBox.addEventListener('dragover', (e) => { if (sessionId && hasFiles(e)) e.preventDefault(); });
            chatBox.addEventListener('dragleave', () => { if (--dzDepth <= 0) { dzDepth = 0; chatBox.classList.remove('chat-drop-active'); } });
            chatBox.addEventListener('drop', (e) => { e.preventDefault(); dzDepth = 0; chatBox.classList.remove('chat-drop-active'); if (sessionId && e.dataTransfer.files.length) uploadFilesSeq(e.dataTransfer.files); });
        }
        if (messageInput) {
            messageInput.addEventListener('paste', (e) => {
                const files = e.clipboardData && e.clipboardData.files;
                if (files && files.length && sessionId) { e.preventDefault(); uploadFilesSeq(files); }
            });
        }

        // ===== Модалка «все источники» =====
        function openSourcesModal(listHtml) {
            let overlay = document.getElementById('sourcesModal');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'sourcesModal';
                overlay.className = 'sources-modal-overlay';
                overlay.innerHTML =
                    '<div class="sources-modal" role="dialog" aria-modal="true" aria-label="Источники">' +
                    '<div class="sources-modal-head"><span class="sources-modal-title">Источники</span>' +
                    '<button type="button" class="sources-modal-close" aria-label="Закрыть">&times;</button></div>' +
                    '<div class="sources-modal-body"></div></div>';
                document.body.appendChild(overlay);
                const close = () => overlay.classList.remove('is-open');
                overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
                overlay.querySelector('.sources-modal-close').addEventListener('click', close);
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') close();
                });
            }
            overlay.querySelector('.sources-modal-body').innerHTML = `<div class="md-docs md-docs-modal">${listHtml}</div>`;
            overlay.classList.add('is-open');
        }

        // Переключение варианта: ответ ассистента — точечная замена пузыря; ветка
        // правки пользователя — переключается весь ход разговора → перезагружаем список.
        async function switchVariant(msgEl, id, dir) {
            if (!msgEl || !id) return;
            try {
                const resp = await fetch('/api/chat/variant', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: sessionId, message_id: Number(id), direction: dir }),
                });
                const data = await resp.json();
                if (!data || !data.success) return;
                if (data.reload || data.role === 'user') {
                    await loadMessages();
                } else if (data.message) {
                    rebuildAssistantMessage(msgEl, data.message);
                }
            } catch (err) { console.warn('switchVariant failed', err); }
        }

        // Редактирование сообщения пользователя прямо в пузыре: контент превращается
        // в textarea с текущим текстом; сохранение создаёт новую ветку вопроса + ответ.
        function startEditMessage(msgEl, id) {
            if (!msgEl || !id) return;
            const contentEl = msgEl.querySelector('.message-content');
            if (!contentEl || msgEl.querySelector('.msg-edit-box')) return;
            const raw = contentEl.dataset.rawContent || contentEl.innerText || '';
            const footer = msgEl.querySelector('.message-footer');
            // Ширина редактора — широкая зона (как в ChatGPT): не меньше 1.5× пузыря и
            // не меньше ~70% ленты, но в пределах доступной ширины.
            const contentW = contentEl.getBoundingClientRect().width;
            const avail = messagesContainer ? messagesContainer.clientWidth : contentW;
            const targetW = Math.min(
                Math.round(avail * 0.94),
                Math.max(Math.round(contentW * 1.5), Math.round(avail * 0.72)),
            );
            contentEl.style.display = 'none';
            if (footer) footer.style.display = 'none';
            msgEl.classList.add('editing');
            const box = document.createElement('div');
            box.className = 'msg-edit-box';
            if (targetW > 0) box.style.width = targetW + 'px';
            box.innerHTML =
                `<textarea class="msg-edit-input" aria-label="Изменить сообщение"></textarea>`
                + `<div class="msg-edit-actions">`
                + `<button type="button" class="msg-edit-cancel">Отмена</button>`
                + `<button type="button" class="msg-edit-save">Отправить</button>`
                + `</div>`;
            contentEl.after(box);
            const ta = box.querySelector('.msg-edit-input');
            ta.value = raw;
            autoResizeEl(ta);
            ta.focus();
            try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
            const closeEdit = () => {
                box.remove();
                msgEl.classList.remove('editing');
                contentEl.style.display = '';
                if (footer) footer.style.display = '';
            };
            ta.addEventListener('input', () => autoResizeEl(ta));
            ta.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(id, ta.value); }
                else if (e.key === 'Escape') { e.preventDefault(); closeEdit(); }
            });
            box.querySelector('.msg-edit-cancel').addEventListener('click', closeEdit);
            box.querySelector('.msg-edit-save').addEventListener('click', () => saveEdit(id, ta.value));
        }

        async function saveEdit(id, text) {
            text = (text || '').trim();
            if (!text || currentStreaming.active) return;
            try {
                const resp = await fetch('/api/chat/edit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: sessionId, message_id: Number(id), text }),
                });
                const data = await resp.json();
                if (!data || !data.success || !data.assistant_message_id) return;
                recordPendingGen();
                // loadMessages сам отрисует новую ветку и ПОДПИШЕТСЯ на активный стрим
                // ответа (см. /stream/active). Второй startStreaming здесь не нужен —
                // он прерывал бы первую подписку и дописывал «(Генерация прервана)».
                await loadMessages();
            } catch (err) { console.warn('saveEdit failed', err); }
        }

        // «Попробовать снова» — перегенерировать как новый вариант в этот же пузырь
        function retryMessage(msgEl, id) {
            if (!msgEl || !id || currentStreaming.active) return;
            // Всё, что ниже перегенерируемого ответа, принадлежит СТАРОЙ ветке —
            // убираем сразу (сервер скроет их после создания нового варианта;
            // вернуть ветку можно переключателем ‹ 1/2 ›).
            let sib = msgEl.nextElementSibling;
            while (sib) {
                const next = sib.nextElementSibling;
                sib.remove();
                sib = next;
            }
            updateUnreadMessagesSet();
            const wrap = msgEl.querySelector('.message-wrapper');
            if (wrap) {
                // Сбрасываем пузырь к состоянию генерации (убираем старый ответ и футер).
                wrap.innerHTML = `<div class="message-content" data-raw-content="" data-status="search" data-streaming="true">${renderThinkingIndicator('search')}</div>`;
            }
            recordPendingGen();
            startStreaming({ retryOf: Number(id), targetEl: msgEl });
        }

        if (messagesContainer) {
            messagesContainer.addEventListener('click', (e) => {
                // Кнопка копирования сообщения (копируем контент со стилями)
                const copyBtn = e.target.closest('.msg-copy-btn');
                if (copyBtn) {
                    const msgEl = copyBtn.closest('.message');
                    const contentEl = msgEl && msgEl.querySelector('.message-content');
                    copyMessage(contentEl, copyBtn);
                    return;
                }
                // Лайк/дизлайк (делегирование — кнопки без обёртки .chat-feedback)
                const fbBtn = e.target.closest('.chat-feedback-btn');
                if (fbBtn) {
                    const fid = fbBtn.dataset.feedbackFor;
                    const target = Number(fbBtn.dataset.rate);
                    const wasActive = fbBtn.classList.contains('is-active');
                    const newRating = wasActive ? 0 : target;
                    const actions = fbBtn.closest('.msg-actions');
                    if (actions) actions.querySelectorAll('.chat-feedback-btn').forEach((b) => b.classList.remove('is-active', 'is-negative'));
                    if (newRating === 1) fbBtn.classList.add('is-active');
                    if (newRating === -1) fbBtn.classList.add('is-active', 'is-negative');
                    if (fid) sendFeedback(fid, newRating);
                    return;
                }
                // Вариант ответа на уточняющий вопрос FAQ → отправляем как сообщение
                const clarifyBtn = e.target.closest('.chat-clarify-opt');
                if (clarifyBtn) {
                    if (currentStreaming.active || !messageInput) return;
                    const opts = clarifyBtn.closest('.chat-clarify-opts');
                    if (opts) opts.querySelectorAll('.chat-clarify-opt').forEach((b) => { b.disabled = true; });
                    messageInput.value = clarifyBtn.dataset.option || clarifyBtn.textContent;
                    sendMessage();
                    return;
                }
                // Повторить
                const retryBtn = e.target.closest('.msg-retry-btn');
                if (retryBtn) {
                    const msgEl = retryBtn.closest('.message');
                    const id = msgEl && msgEl.dataset.messageId;
                    if (id) retryMessage(msgEl, id);
                    return;
                }
                // Переслать сообщение коллеге (открывает мессенджер). Ответ ассистента
                // пересылаем снимком (forward_message_id), СВОЁ сообщение — как текст.
                const fwdBtn = e.target.closest('.msg-forward-btn');
                if (fwdBtn) {
                    const msgEl = fwdBtn.closest('.message');
                    const contentEl = msgEl && msgEl.querySelector('.message-content');
                    const preview = contentEl ? (contentEl.textContent || '').trim() : '';
                    if (msgEl && msgEl.classList.contains('user')) {
                        const text = contentEl ? (contentEl.innerText || contentEl.textContent || '').trim() : '';
                        if (text && typeof window.MessengerForwardText === 'function') {
                            window.MessengerForwardText(text, preview);
                        }
                    } else {
                        const id = msgEl && msgEl.dataset.messageId;
                        if (id && typeof window.MessengerForward === 'function') {
                            window.MessengerForward(id, preview);
                        }
                    }
                    return;
                }
                // Изменить сообщение пользователя (правка в пузыре → новая ветка)
                const editBtn = e.target.closest('.msg-edit-btn');
                if (editBtn) {
                    if (currentStreaming.active) return;
                    const msgEl = editBtn.closest('.message');
                    const id = msgEl && msgEl.dataset.messageId;
                    if (id) startEditMessage(msgEl, id);
                    return;
                }
                // Навигация по вариантам
                const navBtn = e.target.closest('.msg-variant-prev, .msg-variant-next');
                if (navBtn) {
                    if (navBtn.disabled || currentStreaming.active) return;
                    const msgEl = navBtn.closest('.message');
                    const id = msgEl && msgEl.dataset.messageId;
                    const dir = navBtn.classList.contains('msg-variant-prev') ? -1 : 1;
                    if (id) switchVariant(msgEl, id, dir);
                    return;
                }
                const btn = e.target.closest('.md-sources-more');
                if (!btn) return;
                const docs = btn.closest('.md-docs');
                if (docs) {
                    const clone = docs.cloneNode(true);
                    clone.querySelectorAll('.md-sources-more').forEach((b) => b.remove());
                    openSourcesModal(clone.innerHTML);
                    return;
                }
                // легаси-фолбэк: старый блок «Источники» из текста модели (ul/li)
                const ul = btn.parentElement.querySelector('ul');
                if (ul) openSourcesModal(`<ul class="md-sources-fulllist">${ul.innerHTML}</ul>`);
            });
        }

        // ===== Боковая панель быстрого переключения чатов =====
        (function initChatSidebar() {
            const sidebarList = document.getElementById('sidebarList');
            const sidebarSearch = document.getElementById('sidebarSearch');
            const sbFilterBtns = document.querySelectorAll('.sb-filter-btn');
            const sidebarNewChat = document.getElementById('sidebarNewChat');
            if (!sidebarList) return;

            let sbFilter = 'active';
            let sbItems = [];
            let sbQuery = '';
            const SB_PAGE = 15;          // диалогов в панели за раз
            let sbLimit = SB_PAGE;       // сколько сейчас запрашиваем/показываем
            let sbTotal = 0;             // всего диалогов под фильтром (с сервера)
            let sbSearchTimer = null;

            const curDialogueId = String(dialogueId || '');

            // Сворачивание панели (анимация) единым переключателем + запоминание
            const chatLayout = document.getElementById('chatLayout');
            const toggleBtn = document.getElementById('sidebarToggle');
            const sidebarBackdrop = document.getElementById('sidebarBackdrop');
            const isMobileLayout = () => window.matchMedia('(max-width: 900px)').matches;
            function setCollapsed(collapsed, persist = true) {
                if (!chatLayout) return;
                chatLayout.classList.toggle('sidebar-collapsed', collapsed);
                // На мобильном состояние шторки не запоминаем — она всегда стартует
                // закрытой (иначе перекрывала бы чат при заходе на страницу).
                if (persist && !isMobileLayout()) {
                    try { localStorage.setItem('chatSidebarCollapsed', collapsed ? '1' : '0'); } catch (e) {}
                }
            }
            if (toggleBtn) {
                toggleBtn.addEventListener('click', () =>
                    setCollapsed(!chatLayout.classList.contains('sidebar-collapsed')));
            }
            // Клик по затемнению закрывает мобильную шторку
            if (sidebarBackdrop) {
                sidebarBackdrop.addEventListener('click', () => setCollapsed(true, false));
            }
            if (isMobileLayout()) {
                // На телефоне панель всегда стартует закрытой (полноэкранный чат)
                setCollapsed(true, false);
            } else {
                try { if (localStorage.getItem('chatSidebarCollapsed') === '1') setCollapsed(true); } catch (e) {}
            }

            function renderSidebar(items) {
                if (!items.length) {
                    sidebarList.innerHTML = `<div class="chat-sidebar-empty">${sbQuery ? 'Ничего не найдено' : 'Нет диалогов'}</div>`;
                    return;
                }
                let html = items.map((d) => {
                    const isCur = String(d.id) === curDialogueId;
                    const active = isCur ? ' is-current' : '';
                    const href = d.session_id ? `/chat/${escapeAttr(d.session_id)}` : '#';
                    // Точка — ТОЛЬКО при непрочитанном ответе (синяя); текущий диалог
                    // (его сейчас и читают) меткой не помечаем.
                    const unread = d.unread && !isCur;
                    const dot = unread ? '<span class="csi-dot unread"></span>' : '';
                    return `<a class="chat-sidebar-item${active}${unread ? ' has-unread' : ''}" href="${href}">
                        ${dot}<span class="csi-title">${escapeHtml(d.title || 'Без названия')}</span>
                    </a>`;
                }).join('');
                if (sbTotal > items.length) {
                    const more = Math.min(SB_PAGE, sbTotal - items.length);
                    html += `<button class="chat-sidebar-more" id="sbShowMore" type="button">Показать ещё ${more}</button>`;
                }
                sidebarList.innerHTML = html;
                const moreBtn = document.getElementById('sbShowMore');
                if (moreBtn) {
                    moreBtn.addEventListener('click', () => {
                        sbLimit += SB_PAGE;
                        loadSidebar(true);
                    });
                }
            }

            function sidebarSig(items) {
                return items.map((d) => `${d.id}:${d.title}:${d.unread ? 1 : 0}:${d.is_finished ? 1 : 0}`).join('|');
            }
            let lastSidebarSig = null;

            // Подхватываем авто-название текущего диалога в шапку чата (если пользователь
            // не вводил своё — поле пустое).
            function syncHeaderTitle(items) {
                const ti = document.getElementById('dialogueTitleInput');
                if (!ti || (ti.value || '').trim()) return;
                const cur = items.find((d) => String(d.id) === curDialogueId);
                if (cur && cur.title && cur.title !== 'Новый диалог') {
                    ti.value = cur.title;
                    try { titleSaved = cur.title; } catch (e) {}
                    if (typeof ti._autosize === 'function') ti._autosize();
                    if (document.title) document.title = cur.title;
                }
            }

            async function loadSidebar(force) {
                try {
                    const params = new URLSearchParams({
                        filter: sbFilter,
                        page: '1',
                        page_size: String(sbLimit),
                    });
                    if (sbQuery.trim()) params.set('search', sbQuery.trim());
                    const resp = await fetch(`/api/dialogues?${params.toString()}`);
                    const data = await resp.json();
                    if (data.success) {
                        sbItems = data.items || [];
                        sbTotal = data.total || 0;
                        syncHeaderTitle(sbItems);
                        // Авто-обновление без мигания: перерисовываем только при изменениях
                        const sig = sbFilter + '||' + sbQuery + '||' + sbLimit + '/' + sbTotal + '||' + sidebarSig(sbItems);
                        if (force || sig !== lastSidebarSig) {
                            lastSidebarSig = sig;
                            renderSidebar(sbItems);
                        }
                    } else if (force) {
                        sidebarList.innerHTML = '<div class="chat-sidebar-empty">Ошибка загрузки</div>';
                    }
                } catch (e) {
                    if (force) sidebarList.innerHTML = '<div class="chat-sidebar-empty">Ошибка подключения</div>';
                }
            }

            sbFilterBtns.forEach((btn) => {
                btn.addEventListener('click', () => {
                    sbFilterBtns.forEach((b) => b.classList.remove('active'));
                    btn.classList.add('active');
                    sbFilter = btn.dataset.filter;
                    sbLimit = SB_PAGE;
                    loadSidebar(true);
                });
            });
            if (sidebarSearch) {
                sidebarSearch.addEventListener('input', () => {
                    sbQuery = sidebarSearch.value || '';
                    sbLimit = SB_PAGE;
                    clearTimeout(sbSearchTimer);
                    sbSearchTimer = setTimeout(() => loadSidebar(true), 250);
                });
            }
            if (sidebarNewChat) {
                sidebarNewChat.addEventListener('click', async () => {
                    try {
                        const resp = await fetch('/api/dialogues', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({}),
                        });
                        const data = await resp.json();
                        if (resp.ok && data.success && data.session_id) {
                            window.location.href = `/chat/${data.session_id}`;
                        }
                    } catch (e) { /* no-op */ }
                });
            }

            loadSidebar(true);
            // Обновление по push-событиям (SSE, #16); фолбэк редкий и только
            // при видимой вкладке — фоновые вкладки сервер не дёргают.
            window.addEventListener('hr:dialogues-changed', () => loadSidebar(false));
            setInterval(() => { if (!document.hidden) loadSidebar(false); }, 120000);
        })();

        // Загружаем список уже прикреплённых файлов при открытии чата
        if (sessionId) loadAttachedFiles();
    });


// ===== Выделение сообщений в /chat по логике /messenger =====
// Переиспользуем контроллер U.attachThreadInteractions: тап → контекстное меню,
// долгое нажатие → мультивыделение с протяжкой, копирование/пересылка выбранного.
(function () {
  function init() {
    const cont = document.getElementById('messages');
    const U = window.MsgrUI;
    if (!cont || !U || !U.attachThreadInteractions) return;

    // На каждый .message вешаем data-id и «живой» _msg (контент читается из DOM,
    // чтобы стрим/правка не оставляли устаревший текст), плюс кружок-галочку.
    function tagNode(el) {
      if (!el || el.nodeType !== 1 || !el.classList || !el.classList.contains('message')) return;
      const id = el.dataset.messageId || '';
      el.dataset.id = id;
      if (!el.querySelector('.msgr-select-check')) {
        const chk = document.createElement('span');
        chk.className = 'msgr-select-check';
        chk.innerHTML = '<i class="fa-solid fa-check"></i>';
        el.insertBefore(chk, el.firstChild);
      }
      const mine = el.classList.contains('user');
      el._msg = {
        id: id,
        mine: mine,
        sender_name: mine ? 'Вы' : 'HR-ассистент',
        get content() {
          const c = el.querySelector('.message-content');
          if (!c) return '';
          return (c.dataset.rawContent || '').trim() || (c.innerText || '').trim();
        },
      };
    }
    function tagAll() { cont.querySelectorAll('.message').forEach(tagNode); }
    tagAll();
    // Сообщения перерисовываются целиком (innerHTML) и добавляются при стриме —
    // перевешиваем метки на любые изменения childList.
    const mo = new MutationObserver((muts) => {
      for (const m of muts) { if (m.addedNodes && m.addedNodes.length) { tagAll(); break; } }
    });
    // Только верхний уровень: перерисовка ленты и добавление сообщений при стриме —
    // это добавление .message как прямого потомка. Обновления текста внутри пузыря
    // (стрим по чанкам) НЕ триггерят повторную разметку — контент читается «на лету».
    mo.observe(cont, { childList: true });

    const clickBtn = (node, sel) => { const b = node.querySelector(sel); if (b) b.click(); };
    function menuItems(m, node, sel) {
      const items = [{ label: 'Копировать', icon: 'fa-copy', onClick: () => clickBtn(node, '.msg-copy-btn') }];
      if (m.mine) {
        if (node.querySelector('.msg-edit-btn')) items.push({ label: 'Изменить', icon: 'fa-pen', onClick: () => clickBtn(node, '.msg-edit-btn') });
      } else {
        if (node.querySelector('.msg-retry-btn')) items.push({ label: 'Другой ответ', icon: 'fa-rotate-right', onClick: () => clickBtn(node, '.msg-retry-btn') });
        if (node.querySelector('.chat-feedback-btn[data-rate="1"]')) items.push({ label: 'Нравится', icon: 'fa-thumbs-up', onClick: () => clickBtn(node, '.chat-feedback-btn[data-rate="1"]') });
        if (node.querySelector('.chat-feedback-btn[data-rate="-1"]')) items.push({ label: 'Не нравится', icon: 'fa-thumbs-down', onClick: () => clickBtn(node, '.chat-feedback-btn[data-rate="-1"]') });
      }
      if (node.querySelector('.msg-forward-btn')) items.push({ label: 'Переслать коллеге', icon: 'fa-share', onClick: () => clickBtn(node, '.msg-forward-btn') });
      items.push({ sep: true });
      items.push({ label: 'Выделить', icon: 'fa-check-double', onClick: () => sel.startSelect() });
      return items;
    }

    U.attachThreadInteractions({
      container: cont,
      isGeneral: () => false,
      menuItems: menuItems,
      toolbar: {
        el: document.getElementById('chatSelTools'),
        count: document.getElementById('chatSelCount'),
        copy: document.getElementById('chatSelCopy'),
        fwd: document.getElementById('chatSelFwd'),
        cancel: document.getElementById('chatSelCancel'),
      },
      onCopy: (msgs) => U.copyText(U.groupedCopyText(msgs)),
      onForward: (msgs) => {
        const text = U.groupedCopyText(msgs);
        if (text && typeof window.MessengerForwardText === 'function') window.MessengerForwardText(text, 'выбранные сообщения');
      },
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
