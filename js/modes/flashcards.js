/* ============================================================
   Flashcards mode.

   Front: the question. Back: the correct answer(s) and explanations.
   "Know" / "Still learning" are self-reported labels stored in
   question_progress.flashcard_status; they are never treated as
   mastery. Deck position, order and filter resume from study_sessions.

   Top half: pure deck logic (exported for `node --test`).
   Bottom half: the browser controller (window.Quizer.flashcards).
   ============================================================ */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api.deck;
    if (root) root.Quizer = Object.assign(root.Quizer || {}, { flashcards: api.controller });
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    const FILTERS = ['all', 'learning', 'know', 'unmarked'];
    const STATE_VERSION = 1;

    // ---- Pure deck logic ---------------------------------------------------

    /** Saved order, minus ids no longer in the set, plus new ids in set order. */
    function reconcileOrder(savedOrder, ids) {
        const present = new Set(ids);
        const seen = new Set();
        const kept = [];
        (Array.isArray(savedOrder) ? savedOrder : []).forEach((id) => {
            if (present.has(id) && !seen.has(id)) { kept.push(id); seen.add(id); }
        });
        ids.forEach((id) => { if (!seen.has(id)) { kept.push(id); seen.add(id); } });
        return kept;
    }

    /** Fisher-Yates shuffle; firstId (the card on screen) stays in front. */
    function shuffleOrder(order, random, firstId) {
        const rng = typeof random === 'function' ? random : Math.random;
        const out = order.slice();
        for (let i = out.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [out[i], out[j]] = [out[j], out[i]];
        }
        if (firstId !== undefined && firstId !== null) {
            const at = out.indexOf(firstId);
            if (at > 0) { out.splice(at, 1); out.unshift(firstId); }
        }
        return out;
    }

    function statusOf(statuses, id) {
        const s = statuses && statuses[id];
        return s === 'know' || s === 'learning' ? s : null;
    }

    /** Ids of the deck that match a filter, in deck order. */
    function filterOrder(order, statuses, filter) {
        if (filter === 'all' || !FILTERS.includes(filter)) return order.slice();
        if (filter === 'unmarked') return order.filter((id) => statusOf(statuses, id) === null);
        return order.filter((id) => statusOf(statuses, id) === filter);
    }

    /** Move within [0, length-1]; never wraps, never skips. */
    function step(index, delta, length) {
        if (!length) return 0;
        return Math.max(0, Math.min(length - 1, index + delta));
    }

    function countDeck(order, statuses, viewed) {
        const counts = { all: order.length, know: 0, learning: 0, unmarked: 0, viewed: 0 };
        const seen = viewed instanceof Set ? viewed : new Set(viewed || []);
        order.forEach((id) => {
            const s = statusOf(statuses, id);
            if (s === 'know') counts.know++;
            else if (s === 'learning') counts.learning++;
            else counts.unmarked++;
            if (seen.has(id)) counts.viewed++;
        });
        return counts;
    }

    /** Back of a card: each correct choice with its explanation. */
    function cardBack(question) {
        const choices = (question && question.choices) || {};
        const descriptions = (question && question.answerDescriptions) || {};
        const raw = question && question.answer;
        const keys = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
        return keys.map(String).map((key) => ({
            key,
            text: choices[key] !== undefined ? String(choices[key]) : '',
            explanation: descriptions[key] ? String(descriptions[key]) : '',
        }));
    }

    /**
     * A saved session made safe to use: unknown ids dropped, new questions
     * appended, bad values replaced. Never throws on corrupt input.
     */
    function normalizeState(raw, ids) {
        const state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const order = reconcileOrder(state.order, ids);
        const present = new Set(ids);
        const filter = FILTERS.includes(state.filter) ? state.filter : 'all';
        const currentId = present.has(state.currentId) ? state.currentId : (order[0] || null);
        const viewed = Array.isArray(state.viewed) ? state.viewed.filter((id) => present.has(id)) : [];
        return {
            v: STATE_VERSION,
            order,
            filter,
            currentId,
            viewed: Array.from(new Set(viewed)),
            shuffled: state.shuffled === true,
        };
    }

    const deck = { FILTERS, reconcileOrder, shuffleOrder, filterOrder, step, countDeck, cardBack, normalizeState };

    // ---- Browser controller ------------------------------------------------

    if (!root || typeof root.document === 'undefined') return { deck, controller: null };
    const doc = root.document;
    const L = () => root.Quizer && root.Quizer.learning;

    const FILTER_LABELS = { all: 'All', learning: 'Still learning', know: 'Know', unmarked: 'Not marked' };

    const s = {
        open: false,
        setId: null,
        title: '',
        questions: new Map(),   // id -> question
        statuses: {},           // id -> 'know' | 'learning'
        order: [],              // full deck order
        view: [],               // ids shown under the current filter (snapshot)
        index: 0,               // position in view
        filter: 'all',
        flipped: false,
        viewed: new Set(),
        shuffled: false,
        speaking: false,
        saveTimer: null,
        attemptQueue: [],
        attemptTimer: null,
        revealedThisSession: new Set(),
        lastSave: Promise.resolve(),  // in-flight position save, awaited by open()
    };

    const $ = (id) => doc.getElementById(id);

    // QSetStore is a top-level `const` in Cert.js: it lives in the shared
    // global scope but is NOT a window property, so read the binding itself.
    function activeSetId() {
        // eslint-disable-next-line no-undef
        return (typeof QSetStore !== 'undefined' && QSetStore) ? QSetStore.getActiveId() : null;
    }

    function currentId() { return s.view[s.index] || null; }

    // -- persistence --
    function snapshot() {
        return { v: STATE_VERSION, order: s.order, filter: s.filter, currentId: currentId(),
                 viewed: Array.from(s.viewed), shuffled: s.shuffled };
    }

    function scheduleSave() {
        if (!s.setId) return;
        clearTimeout(s.saveTimer);
        s.saveTimer = setTimeout(() => {
            s.saveTimer = null;
            s.lastSave = L().api.saveSession(s.setId, 'flashcards', snapshot())
                .catch((e) => console.warn('[flashcards] could not save position:', e.message));
        }, 600);
    }

    function flushSave() {
        if (!s.setId || !s.saveTimer) return;
        clearTimeout(s.saveTimer);
        s.saveTimer = null;
        s.lastSave = L().api.saveSession(s.setId, 'flashcards', snapshot()).catch(() => {});
    }

    // First flip of a card in a session is logged as "revealed": it counts
    // as reviewed for later stats, never as a correct or incorrect answer.
    function queueReveal(id) {
        if (s.revealedThisSession.has(id)) return;
        s.revealedThisSession.add(id);
        s.attemptQueue.push({ questionId: id, mode: 'flashcards', outcome: 'revealed' });
        clearTimeout(s.attemptTimer);
        s.attemptTimer = setTimeout(flushAttempts, 2500);
    }

    function flushAttempts() {
        clearTimeout(s.attemptTimer);
        if (!s.setId || !s.attemptQueue.length) return;
        const batch = s.attemptQueue.splice(0, s.attemptQueue.length);
        L().api.recordAttempts(s.setId, batch)
            .catch((e) => console.warn('[flashcards] could not log reviews:', e.message));
    }

    // -- view switching --
    function showOnly(view) {
        root.showModeView(view === 'flashcards' ? 'flashcardsView' : null);
    }

    // Loading, error and "no set" states replace the whole deck.
    function showState(kind, message, action) {
        const box = $('fcState');
        const body = $('fcBody');
        if (!kind) { box.hidden = true; body.hidden = false; return; }
        body.hidden = true;
        box.hidden = false;
        fillState(box, kind, message, action);
    }

    // A filter with no cards keeps the toolbar so the learner can switch back.
    function showFilterEmpty(message, action) {
        const box = $('fcFilterEmpty');
        if (!message) { box.hidden = true; return; }
        box.hidden = false;
        fillState(box, 'empty', message, action);
    }

    function fillState(box, kind, message, action) {
        box.className = 'ui-state ui-state--' + (kind === 'error' ? 'error' : kind === 'loading' ? 'loading' : 'empty');
        box.replaceChildren();
        if (kind === 'loading') {
            const spin = doc.createElement('span');
            spin.className = 'ui-spinner';
            spin.setAttribute('aria-hidden', 'true');
            box.appendChild(spin);
        }
        const text = doc.createElement('span');
        text.textContent = message;
        box.appendChild(text);
        if (action) {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn--secondary btn--sm';
            btn.textContent = action.label;
            btn.addEventListener('click', action.run);
            box.appendChild(btn);
        }
    }

    // -- rendering --
    function renderCounts() {
        const counts = countDeck(s.order, s.statuses, s.viewed);
        FILTERS.forEach((f) => {
            const btn = doc.querySelector(`[data-fc-filter="${f}"]`);
            if (!btn) return;
            btn.querySelector('.fc-filter__count').textContent = String(counts[f]);
            const active = f === s.filter;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        $('fcViewed').textContent = `${counts.viewed} of ${counts.all} viewed`;
        const pct = counts.all ? Math.round((counts.know / counts.all) * 100) : 0;
        $('fcKnowBar').style.width = pct + '%';
        $('fcKnowBar').parentElement.setAttribute('aria-valuenow', String(pct));
        $('fcKnowLabel').textContent = `${counts.know} of ${counts.all} marked Know`;
        renderTileMeta(counts);
    }

    function renderTileMeta(counts) {
        const meta = $('fcTileMeta');
        if (!meta) return;
        meta.textContent = counts && counts.all
            ? `${counts.all} cards · ${counts.know} known · ${counts.learning} still learning`
            : 'Uses your active question set';
    }

    function renderCard() {
        const id = currentId();
        const total = s.view.length;
        if (!id) {
            const label = FILTER_LABELS[s.filter];
            showState(null);
            showFilterEmpty(`No cards in "${label}" right now.`,
                { label: 'Show all cards', run: () => setFilter('all') });
            $('fcStage').hidden = true;
            $('fcPosition').textContent = '0 of 0';
            ['fcPrev', 'fcNext', 'fcFlip', 'fcKnow', 'fcLearning'].forEach((b) => { $(b).disabled = true; });
            renderCounts();
            return;
        }
        showState(null);
        showFilterEmpty(null);
        $('fcStage').hidden = false;

        const q = s.questions.get(id);
        $('fcFrontText').textContent = q.text || '';
        const back = $('fcBackList');
        back.replaceChildren();
        cardBack(q).forEach((answer) => {
            // Spans, not <li>: the card is a <button>, which only allows phrasing content.
            const li = doc.createElement('span');
            li.className = 'fc-answer';
            li.setAttribute('role', 'listitem');
            const head = doc.createElement('span');
            head.className = 'fc-answer__head';
            const key = doc.createElement('span');
            key.className = 'fc-answer__key';
            key.textContent = answer.key;
            const text = doc.createElement('span');
            text.className = 'fc-answer__text';
            text.textContent = answer.text;
            head.append(key, text);
            li.appendChild(head);
            if (answer.explanation) {
                const p = doc.createElement('span');
                p.className = 'fc-answer__why';
                p.textContent = answer.explanation;
                li.appendChild(p);
            }
            back.appendChild(li);
        });

        const card = $('fcCard');
        card.classList.toggle('is-flipped', s.flipped);
        card.setAttribute('aria-pressed', s.flipped ? 'true' : 'false');
        card.setAttribute('aria-label', s.flipped ? 'Answer side. Activate to show the question.' : 'Question side. Activate to show the answer.');
        $('fcFront').setAttribute('aria-hidden', s.flipped ? 'true' : 'false');
        $('fcBack').setAttribute('aria-hidden', s.flipped ? 'false' : 'true');
        $('fcFlip').textContent = s.flipped ? 'Show question' : 'Show answer';

        $('fcPosition').textContent = `${s.index + 1} of ${total}`;
        $('fcPrev').disabled = s.index === 0;
        $('fcNext').disabled = s.index >= total - 1;
        $('fcFlip').disabled = false;

        const status = statusOf(s.statuses, id);
        [['fcKnow', 'know'], ['fcLearning', 'learning']].forEach(([btnId, value]) => {
            const btn = $(btnId);
            btn.disabled = false;
            btn.setAttribute('aria-pressed', status === value ? 'true' : 'false');
            btn.classList.toggle('is-active', status === value);
        });

        $('fcShuffle').setAttribute('aria-pressed', s.shuffled ? 'true' : 'false');
        renderCounts();
    }

    function announce(text) {
        const live = $('fcLive');
        if (live) live.textContent = text;
    }

    // -- actions --
    function markViewed() {
        const id = currentId();
        if (id) s.viewed.add(id);
    }

    function go(delta) {
        const next = step(s.index, delta, s.view.length);
        if (next === s.index) return;
        stopSpeaking();
        s.index = next;
        s.flipped = false;
        markViewed();
        renderCard();
        announce(`Card ${s.index + 1} of ${s.view.length}`);
        scheduleSave();
    }

    function flip() {
        const id = currentId();
        if (!id) return;
        stopSpeaking();
        s.flipped = !s.flipped;
        if (s.flipped) queueReveal(id);
        renderCard();
        announce(s.flipped ? 'Answer shown' : 'Question shown');
    }

    async function setStatus(value) {
        const id = currentId();
        if (!id) return;
        const previous = statusOf(s.statuses, id);
        const next = previous === value ? null : value; // pressing again clears it
        if (next) s.statuses[id] = next; else delete s.statuses[id];
        renderCard();
        announce(next ? `Marked ${FILTER_LABELS[next]}` : 'Label cleared');
        try {
            await L().api.setFlashcardStatus(s.setId, id, next);
        } catch (e) {
            if (previous) s.statuses[id] = previous; else delete s.statuses[id];
            renderCard();
            announce('Could not save that label. Try again.');
            console.warn('[flashcards] status save failed:', e.message);
        }
    }

    function applyView(keepId) {
        s.view = filterOrder(s.order, s.statuses, s.filter);
        const at = keepId ? s.view.indexOf(keepId) : -1;
        s.index = at >= 0 ? at : 0;
        s.flipped = false;
        markViewed();
    }

    function setFilter(filter) {
        if (!FILTERS.includes(filter)) return;
        stopSpeaking();
        const keep = currentId();
        s.filter = filter;
        applyView(keep);
        renderCard();
        announce(`${FILTER_LABELS[filter]}: ${s.view.length} cards`);
        scheduleSave();
    }

    function shuffle() {
        stopSpeaking();
        const keep = currentId();
        if (s.shuffled) {
            // Turning shuffle off restores the set's own order.
            s.order = Array.from(s.questions.keys());
            s.shuffled = false;
        } else {
            s.order = shuffleOrder(s.order, Math.random, keep);
            s.shuffled = true;
        }
        applyView(keep);
        renderCard();
        announce(s.shuffled ? 'Deck shuffled' : 'Original order restored');
        scheduleSave();
    }

    function restart() {
        stopSpeaking();
        s.viewed = new Set();
        s.revealedThisSession = new Set();
        s.index = 0;
        s.flipped = false;
        applyView(null);
        renderCard();
        announce('Restarted from the first card');
        scheduleSave();
    }

    // -- read aloud (browser speech, no service) --
    function speechSupported() { return 'speechSynthesis' in root && 'SpeechSynthesisUtterance' in root; }

    function stopSpeaking() {
        if (speechSupported()) root.speechSynthesis.cancel();
        s.speaking = false;
        const btn = $('fcSpeak');
        if (btn) btn.setAttribute('aria-pressed', 'false');
    }

    function speak() {
        if (!speechSupported()) return;
        if (s.speaking) { stopSpeaking(); return; }
        const id = currentId();
        if (!id) return;
        const q = s.questions.get(id);
        const text = s.flipped
            ? cardBack(q).map((a) => `${a.key}. ${a.text}. ${a.explanation}`).join(' ')
            : q.text;
        const utterance = new root.SpeechSynthesisUtterance(text);
        utterance.onend = utterance.onerror = () => stopSpeaking();
        s.speaking = true;
        $('fcSpeak').setAttribute('aria-pressed', 'true');
        root.speechSynthesis.speak(utterance);
    }

    // -- open / close --
    async function open() {
        if (typeof root.closeModeViews === 'function') root.closeModeViews('flashcards');
        const setId = activeSetId();
        s.open = true;
        showOnly('flashcards');
        if (typeof root.toggleSidebar === 'function') root.toggleSidebar(false);
        root.scrollTo({ top: 0 });
        syncShell();

        if (!setId) {
            s.setId = null;
            $('fcTitle').textContent = 'Flashcards';
            $('fcMeta').textContent = 'Self-paced, no timer';
            showState('empty', 'Choose a question set first. Flashcards use your active set.',
                { label: 'Go to question library', run: () => { close(); root.navigateToSection && root.navigateToSection('questionSetsSection'); } });
            return;
        }

        showState('loading', 'Loading your flashcards…');
        try {
            // A save from the previous close may still be in flight; reading
            // before it lands would resume from an older position.
            await s.lastSave;
            const [set, progress, saved] = await Promise.all([
                L().api.getSet(setId),
                L().api.getProgress(setId),
                L().api.loadSession(setId, 'flashcards').catch(() => null),
            ]);
            if (!s.open) return; // closed while loading
            const questions = (set.questions || []).filter((q) => q && q.id);
            s.setId = setId;
            s.title = set.title || 'Question set';
            s.questions = new Map(questions.map((q) => [q.id, q]));
            s.statuses = {};
            progress.forEach((p) => {
                const st = p.flashcard && p.flashcard.status;
                if (st === 'know' || st === 'learning') s.statuses[p.questionId] = st;
            });

            const state = normalizeState(saved, questions.map((q) => q.id));
            s.order = state.order;
            s.filter = state.filter;
            s.shuffled = state.shuffled;
            s.viewed = new Set(state.viewed);
            s.revealedThisSession = new Set();
            applyView(state.currentId);
            if (!s.view.length && s.filter !== 'all') {
                s.filter = 'all';
                applyView(state.currentId);
            }

            $('fcTitle').textContent = s.title;
            $('fcMeta').textContent = `${questions.length} cards · self-paced, no timer`;
            syncShell();
            if (!questions.length) {
                showState('empty', 'This set has no questions yet.');
                return;
            }
            renderCard();
            const card = $('fcCard');
            if (card) card.focus({ preventScroll: true });
            scheduleSave();
        } catch (e) {
            if (!s.open) return;
            showState('error', 'Could not load your flashcards. ' + e.message,
                { label: 'Try again', run: open });
        }
    }

    function close() {
        if (!s.open) return;
        stopSpeaking();
        flushSave();
        flushAttempts();
        s.open = false;
        showOnly('dashboard');
        syncShell();
        if (typeof root.setActiveNav === 'function') root.setActiveNav('dashboard');
    }

    function syncShell() {
        if (typeof root.syncAppBar === 'function') root.syncAppBar();
        if (s.open && typeof root.setActiveNav === 'function') root.setActiveNav('flashcardsView');
    }

    // -- input --
    function bind() {
        const view = $('flashcardsView');
        if (!view) return;

        $('fcPrev').addEventListener('click', () => go(-1));
        $('fcNext').addEventListener('click', () => go(1));
        $('fcFlip').addEventListener('click', flip);
        $('fcKnow').addEventListener('click', () => setStatus('know'));
        $('fcLearning').addEventListener('click', () => setStatus('learning'));
        $('fcShuffle').addEventListener('click', shuffle);
        $('fcRestart').addEventListener('click', restart);
        $('fcExit').addEventListener('click', close);
        if (speechSupported()) $('fcSpeak').addEventListener('click', speak);
        else $('fcSpeak').hidden = true;
        doc.querySelectorAll('[data-fc-filter]').forEach((btn) => {
            btn.addEventListener('click', () => setFilter(btn.dataset.fcFilter));
        });

        // Tap flips; a horizontal swipe moves between cards.
        const card = $('fcCard');
        let startX = null; let startY = null; let swiped = false;
        card.addEventListener('pointerdown', (e) => { startX = e.clientX; startY = e.clientY; swiped = false; });
        card.addEventListener('pointerup', (e) => {
            if (startX === null) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            startX = null;
            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                swiped = true;
                go(dx < 0 ? 1 : -1);
            }
        });
        card.addEventListener('click', (e) => {
            if (swiped) { swiped = false; e.preventDefault(); return; }
            flip();
        });

        doc.addEventListener('keydown', (e) => {
            if (!s.open || e.altKey || e.ctrlKey || e.metaKey) return;
            const tag = (e.target && e.target.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            const onOtherButton = tag === 'BUTTON' && e.target !== card;
            if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
            else if ((e.key === ' ' || e.key === 'Enter') && !onOtherButton) {
                if (e.target === card) return; // the card's own click handles it
                e.preventDefault(); flip();
            }
            else if (e.key === 'k' || e.key === 'K') setStatus('know');
            else if (e.key === 'l' || e.key === 'L') setStatus('learning');
            else if (e.key === 'Escape') close();
        });

        root.addEventListener('pagehide', () => { if (s.open) { flushSave(); flushAttempts(); } });

        doc.querySelectorAll('[data-open-view="flashcards"]').forEach((el) => {
            el.addEventListener('click', (e) => { e.preventDefault(); open(); });
        });

        // The library re-renders after sign-in and whenever the active set
        // changes: refresh the dashboard tile's counts at the same moments.
        const original = root.renderQuestionSets;
        if (typeof original === 'function') {
            root.renderQuestionSets = function () {
                const result = original.apply(this, arguments);
                refreshTileFromServer();
                return result;
            };
        }
    }

    let tileRequest = 0;
    async function refreshTileFromServer() {
        const setId = activeSetId();
        if (!setId) { renderTileMeta(null); return; }
        const ticket = ++tileRequest;
        try {
            const [set, progress] = await Promise.all([L().api.getSet(setId), L().api.getProgress(setId)]);
            if (ticket !== tileRequest) return; // a newer refresh won
            const ids = (set.questions || []).filter((q) => q && q.id).map((q) => q.id);
            const statuses = {};
            progress.forEach((p) => { if (p.flashcard && p.flashcard.status) statuses[p.questionId] = p.flashcard.status; });
            renderTileMeta(countDeck(ids, statuses, []));
        } catch (_) {
            if (ticket === tileRequest) renderTileMeta(null);
        }
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind);
    else bind();

    const controller = {
        open,
        close,
        isOpen: () => s.open,
        title: () => s.title,
        refreshTile: renderTileMeta,
    };
    return { deck, controller };
});
