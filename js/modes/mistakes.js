/* ============================================================
   Mistake Review mode.

   Lists every question answered wrong in another mode, across all sets
   (or one set), and runs retry sessions over the open ones. Retries are
   graded on the server (mistakes_routes.py); a question is resolved only
   after the configured number of correct retries in a row. History is
   never deleted: reset only closes items.

   Top half: pure helpers (exported for `node --test`).
   Bottom half: the browser controller (window.Quizer.mistakes).
   ============================================================ */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api.logic;
    if (root) root.Quizer = Object.assign(root.Quizer || {}, { mistakes: api.controller });
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    // ---- Pure helpers --------------------------------------------------------

    const MODE_LABELS = {
        exam: 'Exam', training: 'Training', practice: 'Practice test', learn: 'Learn',
        recall: 'Active recall', matching: 'Matching', code: 'Code challenge',
        review: 'Smart review', flashcards: 'Flashcards',
    };
    function modeLabel(mode) { return MODE_LABELS[mode] || 'Another mode'; }

    function keyOf(item) { return item.setId + '|' + item.questionId; }

    /** Items for the current set filter and tab. */
    function filterItems(items, setId, tab) {
        return items.filter((i) => (!setId || i.setId === setId) && (tab === 'resolved' ? !i.open : i.open));
    }

    /** Review order: most-missed first, then most recently missed. */
    function buildQueue(items) {
        return items.filter((i) => i.open).slice().sort((a, b) => {
            if ((b.timesWrong || 0) !== (a.timesWrong || 0)) return (b.timesWrong || 0) - (a.timesWrong || 0);
            return String(b.lastWrongAt || '').localeCompare(String(a.lastWrongAt || ''));
        }).map(keyOf);
    }

    function counts(items, setId) {
        const scoped = items.filter((i) => !setId || i.setId === setId);
        const open = scoped.filter((i) => i.open).length;
        const attempts = scoped.reduce((n, i) => n + (i.reviewAttempts || 0), 0);
        const correct = scoped.reduce((n, i) => n + (i.reviewCorrect || 0), 0);
        return {
            open, resolved: scoped.length - open, attempts, correct,
            accuracy: attempts ? Math.round((correct / attempts) * 100) : null,
        };
    }

    /** "today", "yesterday", "3 days ago", "2 weeks ago", "5 months ago". */
    function relativeDay(iso, now) {
        if (!iso) return '';
        const then = new Date(iso);
        if (Number.isNaN(then.getTime())) return '';
        const ref = now instanceof Date ? now : new Date(now || Date.now());
        const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const days = Math.round((day(ref) - day(then)) / 86400000);
        if (days <= 0) return 'today';
        if (days === 1) return 'yesterday';
        if (days < 14) return days + ' days ago';
        if (days < 60) return Math.round(days / 7) + ' weeks ago';
        return Math.round(days / 30) + ' months ago';
    }

    /** Message after a graded retry. */
    function retryMessage(result) {
        if (result.resolved) {
            return `Resolved: ${result.needed} correct in a row. It leaves your review list, and its history is kept.`;
        }
        if (result.correct && result.open) {
            const left = result.needed - result.streak;
            return `${result.streak} of ${result.needed} correct in a row. Get it right ${left === 1 ? 'once more' : left + ' more times'} to resolve it.`;
        }
        if (result.correct) return 'Correct. This question was already resolved.';
        return 'Not quite. Your streak is reset and it stays in review.';
    }

    function toggleChoice(current, key, maxSelections) {
        const list = Array.isArray(current) ? current.slice() : [];
        const limit = Math.max(1, maxSelections | 0);
        if (limit === 1) return [key];
        const at = list.indexOf(key);
        if (at >= 0) { list.splice(at, 1); return list; }
        if (list.length >= limit) return list;
        list.push(key);
        return list;
    }

    const logic = { modeLabel, filterItems, buildQueue, counts, relativeDay, retryMessage, toggleChoice, keyOf };

    // ---- Browser controller ----------------------------------------------------

    if (!root || typeof root.document === 'undefined') return { logic, controller: null };
    const doc = root.document;
    const L = () => root.Quizer.learning;
    const $ = (id) => doc.getElementById(id);

    const s = {
        open: false,
        items: [],
        byKey: new Map(),
        sets: [],
        needed: 2,
        unavailable: 0,
        setFilter: '',
        tab: 'open',
        session: null,   // { queue, index, selected, result, busy, tally }
    };

    function announce(text) { const live = $('mrLive'); if (live) live.textContent = text; }

    function syncShell() {
        if (typeof root.syncAppBar === 'function') root.syncAppBar();
        if (s.open && typeof root.setActiveNav === 'function') root.setActiveNav('mistakesView');
    }

    function showScreen(name) {
        ['mrList', 'mrSession', 'mrDone'].forEach((id) => { $(id).hidden = id !== name; });
        $('mrState').hidden = true;
    }

    function showState(kind, message, action) {
        ['mrList', 'mrSession', 'mrDone'].forEach((id) => { $(id).hidden = true; });
        const box = $('mrState');
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

    // ================= Overview =================
    async function load() {
        const data = await L().api.listMistakes();
        s.items = data.items || [];
        s.byKey = new Map(s.items.map((i) => [keyOf(i), i]));
        s.sets = data.sets || [];
        s.needed = data.needed || 2;
        s.unavailable = (data.summary && data.summary.unavailable) || 0;
        if (s.setFilter && !s.sets.some((x) => x.setId === s.setFilter)) s.setFilter = '';
        renderTile();
    }

    function renderOverview() {
        showScreen('mrList');
        const all = counts(s.items, '');
        const c = counts(s.items, s.setFilter);

        // Set filter
        const select = $('mrSet');
        select.replaceChildren();
        const optAll = doc.createElement('option');
        optAll.value = '';
        optAll.textContent = `All sets (${all.open} to review)`;
        select.appendChild(optAll);
        s.sets.forEach((x) => {
            const o = doc.createElement('option');
            o.value = x.setId;
            o.textContent = `${x.title} (${x.open} to review)`;
            select.appendChild(o);
        });
        select.value = s.setFilter;

        // Tabs
        doc.querySelectorAll('[data-mr-tab]').forEach((b) => {
            const t = b.dataset.mrTab;
            b.querySelector('span').textContent = String(t === 'open' ? c.open : c.resolved);
            b.classList.toggle('review-filter--active', t === s.tab);
            b.setAttribute('aria-pressed', t === s.tab ? 'true' : 'false');
        });

        // Stats
        $('mrStatOpen').textContent = String(c.open);
        $('mrStatResolved').textContent = String(c.resolved);
        $('mrStatAccuracy').textContent = c.accuracy === null ? '—' : c.accuracy + '%';
        $('mrStatAccuracyNote').textContent = c.attempts
            ? `${c.correct} of ${c.attempts} retries correct`
            : 'No retries yet';

        $('mrStart').disabled = c.open === 0;
        $('mrStartLabel').textContent = c.open ? `Review ${c.open} question${c.open === 1 ? '' : 's'}` : 'Nothing to review';
        $('mrReset').disabled = c.open === 0;
        $('mrRule').textContent = `A question leaves this list after ${s.needed} correct retries in a row. Getting it wrong anywhere puts it back.`;
        $('mrUnavailable').hidden = !s.unavailable;
        $('mrUnavailable').textContent = s.unavailable
            ? `${s.unavailable} older mistake${s.unavailable === 1 ? ' is' : 's are'} hidden because the question was edited or removed from its set. Their history is kept.`
            : '';

        renderList();
    }

    function renderList() {
        const list = $('mrItems');
        list.replaceChildren();
        const shown = filterItems(s.items, s.setFilter, s.tab);
        if (!shown.length) {
            const empty = doc.createElement('div');
            empty.className = 'ui-state ui-state--empty';
            const any = s.items.some((i) => !s.setFilter || i.setId === s.setFilter);
            empty.textContent = !any
                ? 'No mistakes yet. Questions you answer wrong in Exam, Training or a practice test show up here.'
                : s.tab === 'open'
                    ? 'Nothing left to review here. Every mistake in this view is resolved.'
                    : 'Nothing resolved yet. Retry a question correctly ' + s.needed + ' times in a row to resolve it.';
            list.appendChild(empty);
            return;
        }
        shown.forEach((item) => list.appendChild(renderItem(item)));
    }

    function renderItem(item) {
        const art = doc.createElement('article');
        art.className = 'mr-item' + (item.open ? '' : ' mr-item--resolved');

        const body = doc.createElement('div');
        body.className = 'mr-item__body';
        const text = doc.createElement('p');
        text.className = 'mr-item__text';
        text.textContent = item.question.text;
        const meta = doc.createElement('p');
        meta.className = 'mr-item__meta';
        const when = relativeDay(item.lastWrongAt);
        meta.textContent = [
            item.setTitle,
            `Missed ${item.timesWrong} time${item.timesWrong === 1 ? '' : 's'}`,
            item.lastWrongMode ? `last in ${modeLabel(item.lastWrongMode)}${when ? ', ' + when : ''}` : '',
            item.reviewAttempts ? `${item.reviewCorrect} of ${item.reviewAttempts} retries correct` : '',
        ].filter(Boolean).join(' · ');
        body.append(text, meta);

        const side = doc.createElement('div');
        side.className = 'mr-item__side';
        if (item.open) {
            const streak = doc.createElement('span');
            streak.className = 'mr-streak';
            streak.setAttribute('aria-label', `${item.retryStreak} of ${item.needed} correct retries in a row`);
            for (let i = 0; i < item.needed; i++) {
                const dot = doc.createElement('span');
                dot.className = 'mr-streak__dot' + (i < item.retryStreak ? ' is-on' : '');
                dot.setAttribute('aria-hidden', 'true');
                streak.appendChild(dot);
            }
            const label = doc.createElement('span');
            label.className = 'mr-streak__label';
            label.setAttribute('aria-hidden', 'true');
            label.textContent = `${item.retryStreak}/${item.needed}`;
            streak.appendChild(label);
            side.appendChild(streak);
        } else {
            const badge = doc.createElement('span');
            badge.className = 'review-status correct';
            badge.textContent = '✓ Resolved';
            side.appendChild(badge);
        }
        const retry = doc.createElement('button');
        retry.type = 'button';
        retry.className = 'btn btn--secondary btn--sm';
        retry.textContent = 'Retry';
        retry.setAttribute('aria-label', 'Retry: ' + item.question.text.slice(0, 80));
        retry.addEventListener('click', () => startSession([keyOf(item)]));
        side.appendChild(retry);

        art.append(body, side);
        return art;
    }

    async function resetScope() {
        const scope = s.setFilter ? { setId: s.setFilter } : {};
        const where = s.setFilter
            ? `in "${(s.sets.find((x) => x.setId === s.setFilter) || {}).title || 'this set'}"`
            : 'in all your sets';
        const c = counts(s.items, s.setFilter);
        const ok = root.confirm(
            `Clear ${c.open} question${c.open === 1 ? '' : 's'} from review ${where}?\n\n`
            + 'Your answer history is kept. A question returns here the next time you answer it wrong.');
        if (!ok) return;
        try {
            const res = await L().api.resetMistakes(scope);
            await load();
            renderOverview();
            announce(`${res.closed} question${res.closed === 1 ? '' : 's'} cleared from review.`);
        } catch (e) {
            announce('Could not reset. ' + e.message);
            root.alert('Could not reset review: ' + e.message);
        }
    }

    // ================= Retry session =================
    function startSession(keys) {
        const queue = (keys || buildQueue(filterItems(s.items, s.setFilter, 'open'))).filter((k) => s.byKey.has(k));
        if (!queue.length) return;
        s.session = { queue, index: 0, selected: [], result: null, busy: false, tally: { correct: 0, resolved: 0, done: 0 } };
        showScreen('mrSession');
        renderRetry();
        announce(`Review started. ${queue.length} question${queue.length === 1 ? '' : 's'}.`);
    }

    function current() {
        const ses = s.session;
        return ses ? s.byKey.get(ses.queue[ses.index]) : null;
    }

    function renderRetry() {
        const ses = s.session;
        const item = current();
        const q = item.question;
        const total = ses.queue.length;
        const max = Math.max(1, q.maxSelections || q.answer.length || 1);
        const multi = max > 1;

        $('mrPos').textContent = `Question ${ses.index + 1} of ${total}`;
        $('mrFill').style.width = Math.round(((ses.index + (ses.result ? 1 : 0)) / total) * 100) + '%';
        $('mrFill').parentElement.setAttribute('aria-valuenow', String(Math.round(((ses.index + (ses.result ? 1 : 0)) / total) * 100)));
        $('mrSetTag').textContent = item.setTitle;
        $('mrNumber').textContent = multi ? `Choose ${max}` : 'Choose 1';
        $('mrText').textContent = q.text;
        if (root.Quizer.code) root.Quizer.code.attach($('mrText'), q);
        $('mrStreakNow').textContent = `Correct in a row: ${item.retryStreak} of ${item.needed}`;

        const box = $('mrChoices');
        box.setAttribute('role', multi ? 'group' : 'radiogroup');
        box.setAttribute('aria-label', multi ? `Choose ${max} answers` : 'Choose one answer');
        box.replaceChildren();
        const chosen = new Set(ses.selected);
        const correctKeys = new Set(ses.result ? ses.result.correctAnswer : []);
        Object.keys(q.choices).forEach((key, i) => {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'choice';
            btn.dataset.key = key;
            btn.setAttribute('role', multi ? 'checkbox' : 'radio');
            btn.setAttribute('aria-checked', chosen.has(key) ? 'true' : 'false');
            if (chosen.has(key)) btn.classList.add('selected');
            if (ses.result) {
                btn.disabled = true;
                if (correctKeys.has(key)) btn.classList.add('choice--correct');
                else if (chosen.has(key)) btn.classList.add('choice--incorrect');
            }
            const label = doc.createElement('span');
            label.className = 'choice-label';
            label.textContent = String.fromCharCode(65 + i);
            const text = doc.createElement('span');
            text.className = 'choice-content';
            text.textContent = String(q.choices[key]);
            btn.append(label, text);
            btn.addEventListener('click', () => choose(key));
            box.appendChild(btn);
        });

        // Feedback
        const fb = $('mrFeedback');
        if (!ses.result) {
            fb.hidden = true;
            fb.replaceChildren();
        } else {
            const r = ses.result;
            fb.hidden = false;
            fb.className = 'pt-feedback ' + (r.correct ? 'pt-feedback--correct' : 'pt-feedback--incorrect');
            fb.replaceChildren();
            const head = doc.createElement('p');
            head.className = 'pt-feedback__status';
            head.textContent = r.correct ? '✓ Correct' : '✗ Not quite';
            const msg = doc.createElement('p');
            msg.textContent = retryMessage(r);
            fb.append(head, msg);
            const labels = {};
            Object.keys(q.choices).forEach((k, i) => { labels[k] = String.fromCharCode(65 + i); });
            r.correctAnswer.forEach((k) => {
                const p = doc.createElement('p');
                p.className = 'pt-feedback__answer';
                const strong = doc.createElement('strong');
                strong.textContent = `${labels[k] || k}. ${q.choices[k] || ''}`;
                p.appendChild(strong);
                const why = q.answerDescriptions && q.answerDescriptions[k];
                if (why) p.appendChild(doc.createTextNode(' — ' + why));
                fb.appendChild(p);
            });
        }

        const last = ses.index === total - 1;
        $('mrCheck').hidden = !!ses.result;
        $('mrCheck').disabled = !ses.selected.length || ses.busy;
        $('mrNext').hidden = !ses.result;
        $('mrNext').textContent = last ? 'See summary' : 'Next question';
    }

    function choose(key) {
        const ses = s.session;
        if (!ses || ses.result || ses.busy) return;
        const q = current().question;
        const max = Math.max(1, q.maxSelections || q.answer.length || 1);
        ses.selected = toggleChoice(ses.selected, key, max);
        renderRetry();
        const again = $('mrChoices').querySelector(`[data-key="${CSS.escape(key)}"]`);
        if (again) again.focus();
    }

    async function check() {
        const ses = s.session;
        if (!ses || ses.result || ses.busy || !ses.selected.length) return;
        const item = current();
        ses.busy = true;
        $('mrCheck').disabled = true;
        try {
            const r = await L().api.retryMistake(item.setId, item.questionId, ses.selected, L().newClientId('m'));
            ses.result = r;
            ses.tally.done++;
            if (r.correct) ses.tally.correct++;
            if (r.resolved) ses.tally.resolved++;
            // Keep the overview in step without refetching.
            item.retryStreak = r.streak;
            item.open = r.open;
            item.reviewAttempts = (item.reviewAttempts || 0) + (r.duplicate ? 0 : 1);
            item.reviewCorrect = (item.reviewCorrect || 0) + (r.correct && !r.duplicate ? 1 : 0);
            renderRetry();
            announce((r.correct ? 'Correct. ' : 'Not quite. ') + retryMessage(r));
            $('mrNext').focus();
        } catch (e) {
            announce('Could not check that answer. ' + e.message);
            root.alert('Could not check that answer: ' + e.message);
        } finally {
            ses.busy = false;
            if (!ses.result) $('mrCheck').disabled = !ses.selected.length;
        }
    }

    function next() {
        const ses = s.session;
        if (!ses || !ses.result) return;
        if (ses.index >= ses.queue.length - 1) { finish(); return; }
        ses.index++;
        ses.selected = [];
        ses.result = null;
        renderRetry();
        const first = $('mrChoices').querySelector('.choice');
        if (first) first.focus();
        announce(`Question ${ses.index + 1} of ${ses.queue.length}`);
    }

    async function finish() {
        const t = s.session.tally;
        s.session = null;
        showScreen('mrDone');
        $('mrDoneDone').textContent = String(t.done);
        $('mrDoneCorrect').textContent = String(t.correct);
        $('mrDoneResolved').textContent = String(t.resolved);
        $('mrDoneText').textContent = t.resolved
            ? `${t.resolved} question${t.resolved === 1 ? '' : 's'} resolved and left your review list.`
            : 'Nothing resolved this round. Correct retries in a row move questions closer.';
        $('mrDoneHeading').focus();
        announce('Review finished.');
        try { await load(); } catch (_) { /* overview refetches on return */ }
    }

    async function backToList() {
        s.session = null;
        showState('loading', 'Updating your mistakes…');
        try {
            await load();
            renderOverview();
        } catch (e) {
            showState('error', 'Could not load your mistakes. ' + e.message, { label: 'Try again', run: backToList });
        }
    }

    // ================= Open / close =================
    async function open() {
        if (typeof root.closeModeViews === 'function') root.closeModeViews('mistakes');
        s.open = true;
        root.showModeView('mistakesView');
        if (typeof root.toggleSidebar === 'function') root.toggleSidebar(false);
        root.scrollTo({ top: 0 });
        syncShell();
        showState('loading', 'Loading your mistakes…');
        try {
            await load();
            if (!s.open) return;
            s.tab = 'open';
            renderOverview();
            syncShell();
        } catch (e) {
            if (!s.open) return;
            showState('error', 'Could not load your mistakes. ' + e.message, { label: 'Try again', run: open });
        }
    }

    function close() {
        if (!s.open) return;
        s.open = false;
        s.session = null;
        root.showModeView(null);
        syncShell();
        if (typeof root.setActiveNav === 'function') root.setActiveNav('dashboard');
        refreshTile();
    }

    // -- dashboard tile --
    function renderTile() {
        const meta = $('mrTileMeta');
        if (!meta) return;
        const c = counts(s.items, '');
        meta.textContent = c.open
            ? `${c.open} question${c.open === 1 ? '' : 's'} to review across your sets`
            : (c.resolved ? 'All caught up' : 'Questions you miss land here');
    }

    let tileTimer = null;
    function refreshTile() {
        clearTimeout(tileTimer);
        tileTimer = setTimeout(async () => {
            try { await load(); } catch (_) { /* signed out or offline: keep the default text */ }
        }, 300);
    }

    // -- input --
    function bind() {
        if (!$('mistakesView')) return;
        $('mrSet').addEventListener('change', (e) => { s.setFilter = e.target.value; renderOverview(); });
        doc.querySelectorAll('[data-mr-tab]').forEach((b) => b.addEventListener('click', () => {
            s.tab = b.dataset.mrTab;
            renderOverview();
        }));
        $('mrStart').addEventListener('click', () => startSession(null));
        $('mrReset').addEventListener('click', resetScope);
        $('mrCheck').addEventListener('click', check);
        $('mrNext').addEventListener('click', next);
        $('mrExitSession').addEventListener('click', backToList);
        $('mrBackToList').addEventListener('click', backToList);
        $('mrDoneDashboard').addEventListener('click', close);
        $('mrExit').addEventListener('click', close);
        doc.querySelectorAll('[data-open-view="mistakes"]').forEach((el) => {
            el.addEventListener('click', (e) => { e.preventDefault(); open(); });
        });
        doc.addEventListener('keydown', (e) => {
            if (!s.open || !s.session || $('mrSession').hidden) return;
            if (e.altKey || e.ctrlKey || e.metaKey) return;
            const tag = (e.target && e.target.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (/^[a-z]$/i.test(e.key)) {
                const keys = Object.keys(current().question.choices);
                const at = e.key.toUpperCase().charCodeAt(0) - 65;
                if (at >= 0 && at < keys.length) { e.preventDefault(); choose(keys[at]); }
            } else if (e.key === 'Enter' && tag !== 'BUTTON') {
                e.preventDefault();
                if (s.session.result) next(); else check();
            }
        });

        // Refresh the tile count after sign-in, set changes and finished sessions.
        ['renderQuestionSets', 'renderSessionHistory'].forEach((name) => {
            const original = root[name];
            if (typeof original !== 'function') return;
            root[name] = function () {
                const result = original.apply(this, arguments);
                refreshTile();
                return result;
            };
        });
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind);
    else bind();

    const controller = { open, close, isOpen: () => s.open, title: () => 'All your sets' };
    return { logic, controller };
});
