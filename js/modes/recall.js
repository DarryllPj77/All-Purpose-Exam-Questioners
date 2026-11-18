/* ============================================================
   Active Recall mode.

   The question is shown without choices. The learner types (optional),
   reveals the reference answer and rates themselves: Incorrect,
   Partially correct or Correct. A typed answer that matches an accepted
   answer is pointed out, but the learner's rating is what counts.
   Hardest questions come first next time. No timer.

   Top half: pure logic (exported for `node --test`).
   Bottom half: browser controller (window.Quizer.recall).
   ============================================================ */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api.logic;
    if (root) root.Quizer = Object.assign(root.Quizer || {}, { recall: api.controller });
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    const STATE_VERSION = 1;
    const RATINGS = ['incorrect', 'partial', 'correct'];

    // ---- Pure logic ------------------------------------------------------------

    function ratingOf(recall, id) {
        const r = recall && recall[id];
        return r && RATINGS.includes(r.rating) ? r.rating : null;
    }

    /** Hardest first: incorrect, partial, not yet tried, correct; oldest first within each. */
    function priorityOrder(ids, recall) {
        const rank = { incorrect: 0, partial: 1, none: 2, correct: 3 };
        return ids
            .map((id, i) => {
                const rating = ratingOf(recall, id);
                const at = rating && recall[id].updatedAt ? String(recall[id].updatedAt) : '';
                return { id, i, r: rank[rating || 'none'], at };
            })
            .sort((a, b) => a.r - b.r || a.at.localeCompare(b.at) || a.i - b.i)
            .map((x) => x.id);
    }

    function ratingCounts(ids, recall) {
        const c = { incorrect: 0, partial: 0, unseen: 0, correct: 0 };
        ids.forEach((id) => { c[ratingOf(recall, id) || 'unseen']++; });
        return c;
    }

    function normalizeRecallState(raw, ids) {
        if (!raw || typeof raw !== 'object' || raw.v !== STATE_VERSION) return null;
        const present = new Set(ids);
        if (!Array.isArray(raw.queue) || !raw.queue.length || !raw.queue.every((id) => present.has(id))) return null;
        const index = Math.max(0, Math.min(raw.queue.length, raw.index | 0));
        const results = {};
        Object.entries(raw.results || {}).forEach(([id, r]) => {
            if (present.has(id) && RATINGS.includes(r)) results[id] = r;
        });
        return Object.assign({}, raw, { index, results });
    }

    function summarize(results) {
        const c = { incorrect: 0, partial: 0, correct: 0 };
        Object.values(results).forEach((r) => { if (c[r] !== undefined) c[r]++; });
        return Object.assign(c, { total: c.incorrect + c.partial + c.correct, revisit: c.incorrect + c.partial });
    }

    const logic = { priorityOrder, ratingCounts, normalizeRecallState, summarize, STATE_VERSION };

    // ---- Browser controller ----------------------------------------------------

    if (!root || typeof root.document === 'undefined') return { logic, controller: null };
    const doc = root.document;
    const L = () => root.Quizer.learning;
    const $ = (id) => doc.getElementById(id);
    const MODE = 'recall';
    const LABEL = { incorrect: 'Incorrect', partial: 'Partially correct', correct: 'Correct' };

    function activeSetId() {
        // eslint-disable-next-line no-undef
        return (typeof QSetStore !== 'undefined' && QSetStore) ? QSetStore.getActiveId() : null;
    }

    const s = {
        open: false, setId: null, title: '', questions: [], byId: new Map(),
        recall: {}, run: null, card: null, size: 10,
        saveTimer: null, lastSave: Promise.resolve(),
    };

    function announce(t) { const el = $('rcLive'); if (el) el.textContent = t; }
    function syncShell() {
        if (typeof root.syncAppBar === 'function') root.syncAppBar();
        if (s.open && typeof root.setActiveNav === 'function') root.setActiveNav('recallView');
    }
    function showScreen(name) {
        ['rcIntro', 'rcCard', 'rcDone'].forEach((id) => { $(id).hidden = id !== name; });
        $('rcState').hidden = true;
    }
    function showState(kind, message, action) {
        ['rcIntro', 'rcCard', 'rcDone'].forEach((id) => { $(id).hidden = true; });
        const box = $('rcState');
        box.hidden = false;
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

    function saveNow() {
        if (!s.setId) return s.lastSave;
        clearTimeout(s.saveTimer);
        s.saveTimer = null;
        s.lastSave = (s.run ? L().api.saveSession(s.setId, MODE, s.run) : L().api.clearSession(s.setId, MODE))
            .catch((e) => console.warn('[recall] could not save progress:', e.message));
        return s.lastSave;
    }
    function scheduleSave() { clearTimeout(s.saveTimer); s.saveTimer = setTimeout(saveNow, 400); }

    const ids = () => s.questions.map((q) => q.id);

    // ================= Intro =================
    function renderCounts(prefix) {
        const c = ratingCounts(ids(), s.recall);
        const total = s.questions.length || 1;
        ['correct', 'partial', 'incorrect', 'unseen'].forEach((k) => {
            const seg = $(prefix + 'Seg_' + k);
            if (seg) seg.style.width = ((c[k] / total) * 100) + '%';
            const n = $(prefix + 'Count_' + k);
            if (n) n.textContent = String(c[k]);
        });
        const bar = $(prefix + 'Bar');
        if (bar) {
            bar.setAttribute('aria-valuenow', String(Math.round((c.correct / total) * 100)));
            bar.setAttribute('aria-valuetext', `${c.correct} of ${s.questions.length} last recalled correctly`);
        }
        return c;
    }

    function renderIntro() {
        showScreen('rcIntro');
        const c = renderCounts('rc');
        $('rcSize').value = String(s.size);
        const resumable = !!s.run;
        $('rcResume').hidden = !resumable;
        if (resumable) $('rcResume').textContent = `Continue (${s.run.queue.length - s.run.index} left)`;
        $('rcStart').textContent = resumable ? 'Start over' : 'Start recalling';
        $('rcStart').classList.toggle('btn--primary', !resumable);
        $('rcStart').classList.toggle('btn--secondary', resumable);
        $('rcOrderNote').textContent = (c.incorrect + c.partial)
            ? `${c.incorrect + c.partial} question${c.incorrect + c.partial === 1 ? '' : 's'} you found hard come first.`
            : 'Questions you find hard will come first next time.';
        renderTile(c);
    }

    function start() {
        s.size = parseInt($('rcSize').value, 10) || 10;
        const ordered = priorityOrder(ids(), s.recall);
        s.run = { v: STATE_VERSION, queue: s.size > 0 ? ordered.slice(0, s.size) : ordered, index: 0, results: {}, size: s.size };
        saveNow();
        showCard();
        announce(`Started. ${s.run.queue.length} questions.`);
    }

    // ================= Card =================
    function showCard() {
        const run = s.run;
        if (run.index >= run.queue.length) { finish(); return; }
        s.card = { id: run.queue[run.index], revealed: false, busy: false, match: null };
        showScreen('rcCard');
        $('rcTyped').value = '';
        renderCard();
        $('rcTyped').focus();
    }

    function renderCard() {
        const run = s.run;
        const card = s.card;
        const q = s.byId.get(card.id);
        const last = ratingOf(s.recall, card.id);
        $('rcPos').textContent = `Question ${run.index + 1} of ${run.queue.length}`;
        const pct = Math.round((run.index / run.queue.length) * 100);
        $('rcFill').style.width = pct + '%';
        $('rcFill').parentElement.setAttribute('aria-valuenow', String(pct));
        $('rcLast').textContent = last ? 'Last time: ' + LABEL[last] : 'First time';
        $('rcLast').dataset.rating = last || 'none';
        $('rcText').textContent = q.text || '';

        $('rcTyped').disabled = card.revealed;
        $('rcReveal').hidden = card.revealed;
        $('rcAnswerBox').hidden = !card.revealed;
        $('rcRate').hidden = !card.revealed;
        if (!card.revealed) return;

        // Reference answer and explanations
        const box = $('rcAnswerList');
        box.replaceChildren();
        const answers = Array.isArray(q.answer) ? q.answer : [q.answer];
        answers.forEach((k) => {
            const p = doc.createElement('p');
            p.className = 'ln-recall__answer';
            p.textContent = (q.choices || {})[k] || String(k);
            box.appendChild(p);
            const why = q.answerDescriptions && q.answerDescriptions[k];
            if (why) {
                const w = doc.createElement('p');
                w.className = 'ln-recall__why';
                w.textContent = why;
                box.appendChild(w);
            }
        });
        const extra = Array.isArray(q.acceptedAnswers) ? q.acceptedAnswers : [];
        $('rcAlso').hidden = !extra.length;
        $('rcAlso').textContent = extra.length ? 'Also accepted: ' + extra.join('; ') : '';

        const typed = $('rcTyped').value;
        const note = $('rcMatch');
        note.hidden = card.match === null && !typed.trim();
        note.className = 'rc-match' + (card.match === true ? ' rc-match--yes' : card.match === false ? ' rc-match--no' : '');
        note.textContent = card.match === true ? '✓ Your answer matches the reference answer.'
            : card.match === false ? 'Your wording differs from the reference. Judge whether you knew it.'
                : (typed.trim() ? 'This answer can’t be checked automatically. Compare it yourself.' : '');

        $('rcRateCorrect').classList.toggle('is-suggested', card.match === true);
        ['rcRateIncorrect', 'rcRatePartial', 'rcRateCorrect'].forEach((id) => { $(id).disabled = card.busy; });
    }

    function reveal() {
        const card = s.card;
        if (!card || card.revealed) return;
        card.revealed = true;
        card.match = L().matchesAccepted(s.byId.get(card.id), $('rcTyped').value);
        renderCard();
        $(card.match === true ? 'rcRateCorrect' : 'rcRatePartial').focus();
        announce('Answer shown. Rate yourself: incorrect, partially correct or correct.');
    }

    async function rate(rating) {
        const card = s.card;
        if (!card || !card.revealed || card.busy) return;
        card.busy = true;
        renderCard();
        try {
            const res = await fetch(root.quizApiUrl(`/api/recall/${encodeURIComponent(s.setId)}/${encodeURIComponent(card.id)}/rate`), {
                method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rating, text: $('rcTyped').value, clientAttemptId: L().newClientId('r') }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
            s.recall[card.id] = { rating, updatedAt: new Date().toISOString() };
            s.run.results[card.id] = rating;
            s.run.index++;
            scheduleSave();
            announce('Saved as ' + LABEL[rating] + '.');
            showCard();
        } catch (e) {
            card.busy = false;
            renderCard();
            announce('Could not save that rating. ' + e.message);
            root.alert('Could not save that rating: ' + e.message);
        }
    }

    // ================= Done =================
    function finish() {
        const sum = summarize(s.run.results);
        s.run = null;
        saveNow();
        showScreen('rcDone');
        $('rcDoneCorrect').textContent = String(sum.correct);
        $('rcDonePartial').textContent = String(sum.partial);
        $('rcDoneIncorrect').textContent = String(sum.incorrect);
        $('rcDoneText').textContent = sum.revisit
            ? `${sum.revisit} question${sum.revisit === 1 ? '' : 's'} you found hard will come first next time.`
            : `You recalled all ${sum.total} correctly.`;
        renderCounts('rcDone');
        $('rcDoneHeading').focus();
        announce('Session finished.');
        renderTile(ratingCounts(ids(), s.recall));
    }

    // ================= Open / close =================
    async function open() {
        if (typeof root.closeModeViews === 'function') root.closeModeViews('recall');
        s.open = true;
        root.showModeView('recallView');
        if (typeof root.toggleSidebar === 'function') root.toggleSidebar(false);
        root.scrollTo({ top: 0 });
        syncShell();
        const setId = activeSetId();
        if (!setId) {
            s.setId = null;
            $('rcTitle').textContent = 'Active recall';
            showState('empty', 'Choose a question set first. Active recall uses your active set.',
                { label: 'Go to question library', run: () => { close(); root.navigateToSection && root.navigateToSection('questionSetsSection'); } });
            return;
        }
        showState('loading', 'Loading active recall…');
        try {
            await s.lastSave;
            const [set, progress, saved] = await Promise.all([
                L().api.getSet(setId),
                L().api.getProgress(setId),
                L().api.loadSession(setId, MODE).catch(() => null),
            ]);
            if (!s.open) return;
            s.setId = setId;
            s.title = set.title || 'Question set';
            s.questions = (set.questions || []).filter((q) => q && q.id);
            s.byId = new Map(s.questions.map((q) => [q.id, q]));
            s.recall = {};
            progress.forEach((p) => {
                if (p.recall && p.recall.rating) s.recall[p.questionId] = { rating: p.recall.rating, updatedAt: p.recall.updatedAt };
            });
            s.run = normalizeRecallState(saved, ids());
            if (s.run) s.size = s.run.size || s.size;
            $('rcTitle').textContent = s.title;
            $('rcMeta').textContent = `${s.questions.length} questions · no choices, no timer`;
            syncShell();
            if (!s.questions.length) { showState('empty', 'This set has no questions yet.'); return; }
            renderIntro();
        } catch (e) {
            if (!s.open) return;
            showState('error', 'Could not load active recall. ' + e.message, { label: 'Try again', run: open });
        }
    }

    function close() {
        if (!s.open) return;
        if (s.run) saveNow();
        s.open = false;
        s.card = null;
        root.showModeView(null);
        syncShell();
        if (typeof root.setActiveNav === 'function') root.setActiveNav('dashboard');
        refreshTile();
    }

    // -- dashboard tile --
    function renderTile(c) {
        const meta = $('rcTileMeta');
        if (!meta) return;
        if (!c) { meta.textContent = 'Uses your active question set'; return; }
        const hard = c.incorrect + c.partial;
        meta.textContent = hard ? `${hard} hard question${hard === 1 ? '' : 's'} to revisit` : `${c.correct} recalled correctly`;
    }
    let tileTicket = 0;
    async function refreshTile() {
        const setId = activeSetId();
        if (!setId) { renderTile(null); return; }
        const ticket = ++tileTicket;
        try {
            const [set, progress] = await Promise.all([L().api.getSet(setId), L().api.getProgress(setId)]);
            if (ticket !== tileTicket) return;
            const recall = {};
            progress.forEach((p) => { if (p.recall && p.recall.rating) recall[p.questionId] = { rating: p.recall.rating }; });
            renderTile(ratingCounts((set.questions || []).filter((q) => q && q.id).map((q) => q.id), recall));
        } catch (_) { if (ticket === tileTicket) renderTile(null); }
    }

    // -- input --
    function bind() {
        if (!$('recallView')) return;
        $('rcStart').addEventListener('click', start);
        $('rcResume').addEventListener('click', () => { showCard(); announce('Resumed.'); });
        $('rcReveal').addEventListener('click', reveal);
        $('rcRateIncorrect').addEventListener('click', () => rate('incorrect'));
        $('rcRatePartial').addEventListener('click', () => rate('partial'));
        $('rcRateCorrect').addEventListener('click', () => rate('correct'));
        $('rcPause').addEventListener('click', () => { saveNow(); renderIntro(); announce('Paused. Your place is saved.'); });
        $('rcAgain').addEventListener('click', () => renderIntro());
        $('rcDoneExit').addEventListener('click', close);
        $('rcExit').addEventListener('click', close);
        // Ctrl/Cmd+Enter in the answer box reveals; Enter stays a new line.
        $('rcTyped').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); reveal(); }
        });
        doc.querySelectorAll('[data-open-view="recall"]').forEach((el) => {
            el.addEventListener('click', (e) => { e.preventDefault(); open(); });
        });
        doc.addEventListener('keydown', (e) => {
            if (!s.open || !s.card || $('rcCard').hidden || !s.card.revealed) return;
            if (e.altKey || e.ctrlKey || e.metaKey) return;
            if (e.key === '1') rate('incorrect');
            else if (e.key === '2') rate('partial');
            else if (e.key === '3') rate('correct');
        });
        root.addEventListener('pagehide', () => { if (s.open && s.run) saveNow(); });
        const original = root.renderQuestionSets;
        if (typeof original === 'function') {
            root.renderQuestionSets = function () {
                const result = original.apply(this, arguments);
                refreshTile();
                return result;
            };
        }
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind);
    else bind();

    const controller = { open, close, isOpen: () => s.open, title: () => s.title };
    return { logic, controller };
});
