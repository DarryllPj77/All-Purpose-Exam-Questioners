/* ============================================================
   Smart Review mode: spaced repetition.

   Overview of what is due (overdue first), today's progress, the next
   seven days, maturity and a 14-day history; then a review session
   over everything due. Each answer is scheduled on the server
   (review_routes.py) the moment it is checked, so stopping never loses
   work: the next visit simply continues with what is still due.

   Top half: pure helpers (exported for `node --test`).
   Bottom half: browser controller (window.Quizer.review).
   ============================================================ */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api.logic;
    if (root) root.Quizer = Object.assign(root.Quizer || {}, { review: api.controller });
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    // ---- Pure helpers ------------------------------------------------------------

    const DAY_MS = 86400000;
    const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function parseDay(iso) {
        const [y, m, d] = String(iso).split('-').map(Number);
        return Date.UTC(y, m - 1, d);
    }

    /** "Fri 21 Nov" for a YYYY-MM-DD local date. */
    function shortDate(iso) {
        const t = new Date(parseDay(iso));
        return `${WEEKDAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
    }

    /** "Today", "Tomorrow", "In 3 days" relative to the learner's today. */
    function dayLabel(iso, todayIso) {
        const days = Math.round((parseDay(iso) - parseDay(todayIso)) / DAY_MS);
        if (days <= 0) return 'Today';
        if (days === 1) return 'Tomorrow';
        return `In ${days} days`;
    }

    /** Local calendar date (YYYY-MM-DD) of a UTC instant, given getTimezoneOffset(). */
    function localDate(isoInstant, tzOffset) {
        const t = new Date(new Date(isoInstant).getTime() - tzOffset * 60000);
        return t.toISOString().slice(0, 10);
    }

    /** "tomorrow (Thu 19 Nov)" / "in 3 days (Sat 21 Nov)" for a scheduled review. */
    function nextReviewText(dueAtIso, todayIso, tzOffset) {
        const day = localDate(dueAtIso, tzOffset);
        const rel = dayLabel(day, todayIso);
        return `${rel === 'Tomorrow' ? 'tomorrow' : rel.toLowerCase()} (${shortDate(day)})`;
    }

    function maturityLabel(intervalDays) {
        if (!intervalDays || intervalDays < 7) return 'Learning';
        if (intervalDays < 21) return 'Young';
        return 'Mature';
    }

    /** Today's progress: reviewed so far out of reviewed + still due. */
    function dailyProgress(counts) {
        const done = counts.reviewedToday || 0;
        const total = done + (counts.due || 0);
        return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
    }

    function toggleChoice(current, key, max) {
        const list = Array.isArray(current) ? current.slice() : [];
        const limit = Math.max(1, max | 0);
        if (limit === 1) return [key];
        const at = list.indexOf(key);
        if (at >= 0) { list.splice(at, 1); return list; }
        if (list.length >= limit) return list;
        list.push(key);
        return list;
    }

    const logic = { shortDate, dayLabel, localDate, nextReviewText, maturityLabel, dailyProgress, toggleChoice };

    // ---- Browser controller ----------------------------------------------------

    if (!root || typeof root.document === 'undefined') return { logic, controller: null };
    const doc = root.document;
    const L = () => root.Quizer.learning;
    const $ = (id) => doc.getElementById(id);
    const tzOffset = () => new Date().getTimezoneOffset();
    const OUTCOME = { correct: 'Correct', partial: 'Partially correct', incorrect: 'Incorrect' };

    const s = {
        open: false, setFilter: '', format: 'choice', data: null,
        session: null, // { items, index, selected, revealed, result, busy, tally }
    };

    function announce(t) { const el = $('rvLive'); if (el) el.textContent = t; }
    function syncShell() {
        if (typeof root.syncAppBar === 'function') root.syncAppBar();
        if (s.open && typeof root.setActiveNav === 'function') root.setActiveNav('reviewView');
    }
    function showScreen(name) {
        ['rvOverview', 'rvSession', 'rvDone'].forEach((id) => { $(id).hidden = id !== name; });
        $('rvState').hidden = true;
    }
    function showState(kind, message, action) {
        ['rvOverview', 'rvSession', 'rvDone'].forEach((id) => { $(id).hidden = true; });
        const box = $('rvState');
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

    async function load() {
        const qs = `tzOffset=${tzOffset()}` + (s.setFilter ? `&setId=${encodeURIComponent(s.setFilter)}` : '');
        const res = await fetch(root.quizApiUrl('/api/review/overview?' + qs), { credentials: 'include' });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
        s.data = data;
        if (!s.setFilter) renderTile(data.counts);
        return data;
    }

    // ================= Overview =================
    function renderOverview() {
        const d = s.data;
        const c = d.counts;
        showScreen('rvOverview');

        const sel = $('rvSet');
        sel.replaceChildren();
        const all = doc.createElement('option');
        all.value = '';
        all.textContent = 'All sets';
        sel.appendChild(all);
        d.sets.forEach((x) => {
            const o = doc.createElement('option');
            o.value = x.setId;
            o.textContent = `${x.title} (${x.due} due)`;
            sel.appendChild(o);
        });
        sel.value = s.setFilter;
        $('rvFormat').value = s.format;

        $('rvStatOverdue').textContent = String(c.overdue);
        $('rvStatToday').textContent = String(c.dueToday);
        $('rvStatDone').textContent = String(c.reviewedToday);
        $('rvStatDoneNote').textContent = c.reviewedToday ? `${c.correctToday} correct` : 'None yet today';
        const week = d.upcoming.reduce((n, u) => n + u.count, 0);
        $('rvStatWeek').textContent = String(week);

        const p = dailyProgress(c);
        $('rvDailyFill').style.width = p.percent + '%';
        $('rvDaily').setAttribute('aria-valuenow', String(p.percent));
        $('rvDailyLabel').textContent = p.total
            ? `${p.done} of ${p.total} reviewed today`
            : 'Nothing due today';

        $('rvStart').disabled = c.due === 0;
        $('rvStartLabel').textContent = c.due ? `Review ${c.due} due question${c.due === 1 ? '' : 's'}` : 'Nothing due';
        const next = d.upcoming.find((u) => u.count > 0);
        $('rvCaughtUp').hidden = c.due !== 0 || !c.scheduled;
        $('rvCaughtUp').textContent = next
            ? `All caught up. Next reviews: ${dayLabel(next.date, d.today).toLowerCase()} (${next.count}).`
            : 'All caught up. Nothing is scheduled in the next 7 days.';
        $('rvEmpty').hidden = c.scheduled !== 0;

        // Upcoming 7 days
        const up = $('rvUpcoming');
        up.replaceChildren();
        const maxUp = Math.max(1, ...d.upcoming.map((u) => u.count));
        d.upcoming.forEach((u) => {
            const col = doc.createElement('li');
            col.className = 'rv-day';
            col.setAttribute('aria-label', `${shortDate(u.date)}: ${u.count} due`);
            const bar = doc.createElement('span');
            bar.className = 'rv-day__bar';
            bar.style.height = Math.round((u.count / maxUp) * 100) + '%';
            const n = doc.createElement('span');
            n.className = 'rv-day__count';
            n.textContent = String(u.count);
            const label = doc.createElement('span');
            label.className = 'rv-day__label';
            label.textContent = shortDate(u.date).split(' ')[0];
            const track = doc.createElement('span');
            track.className = 'rv-day__track';
            track.setAttribute('aria-hidden', 'true');
            track.appendChild(bar);
            col.append(n, track, label);
            up.appendChild(col);
        });

        // Maturity
        const m = d.mastery;
        const total = Math.max(1, m.notStarted + m.learning + m.young + m.mature);
        ['mature', 'young', 'learning', 'notStarted'].forEach((k) => {
            $('rvSeg_' + k).style.width = ((m[k] / total) * 100) + '%';
            $('rvCount_' + k).textContent = String(m[k]);
        });

        // 14-day history
        const hist = $('rvHistory');
        hist.replaceChildren();
        const maxH = Math.max(1, ...d.history.map((h) => h.reviews));
        d.history.forEach((h) => {
            const col = doc.createElement('li');
            col.className = 'rv-hist';
            col.setAttribute('aria-label', `${shortDate(h.date)}: ${h.reviews} review${h.reviews === 1 ? '' : 's'}, ${h.correct} correct`);
            const track = doc.createElement('span');
            track.className = 'rv-hist__track';
            track.setAttribute('aria-hidden', 'true');
            const good = doc.createElement('span');
            good.className = 'rv-hist__good';
            good.style.height = Math.round((h.correct / maxH) * 100) + '%';
            const other = doc.createElement('span');
            other.className = 'rv-hist__other';
            other.style.height = Math.round(((h.reviews - h.correct) / maxH) * 100) + '%';
            track.append(other, good);
            col.appendChild(track);
            hist.appendChild(col);
        });
        const totalReviews = d.history.reduce((n, h) => n + h.reviews, 0);
        const totalCorrect = d.history.reduce((n, h) => n + h.correct, 0);
        $('rvHistorySummary').textContent = totalReviews
            ? `${totalReviews} review${totalReviews === 1 ? '' : 's'} in 14 days, ${Math.round((totalCorrect / totalReviews) * 100)}% correct`
            : 'No reviews in the last 14 days';
    }

    // ================= Session =================
    function startSession() {
        s.format = $('rvFormat').value;
        const items = s.data.dueItems.slice();
        if (!items.length) return;
        s.session = { items, index: 0, selected: [], revealed: false, result: null, busy: false, tally: { correct: 0, partial: 0, incorrect: 0 } };
        showScreen('rvSession');
        renderCard();
        focusFirst();
        announce(`Review started. ${items.length} due.`);
    }

    function focusFirst() {
        const el = s.format === 'recall' ? $('rvReveal') : $('rvChoices').querySelector('.choice');
        if (el) el.focus();
    }

    function item() { return s.session.items[s.session.index]; }

    function renderCard() {
        const ses = s.session;
        const it = item();
        const q = it.question;
        const max = Math.max(1, q.maxSelections || q.answer.length || 1);
        const recall = s.format === 'recall';
        $('rvPos').textContent = `Question ${ses.index + 1} of ${ses.items.length}`;
        const pct = Math.round(((ses.index + (ses.result ? 1 : 0)) / ses.items.length) * 100);
        $('rvFill').style.width = pct + '%';
        $('rvFill').parentElement.setAttribute('aria-valuenow', String(pct));
        $('rvDueTag').textContent = it.overdue ? 'Overdue' : 'Due today';
        $('rvDueTag').dataset.overdue = it.overdue ? 'true' : 'false';
        $('rvMaturity').textContent = it.intervalDays ? `${maturityLabel(it.intervalDays)} · every ${it.intervalDays} day${it.intervalDays === 1 ? '' : 's'}` : 'First review';
        $('rvSetTitle').textContent = it.setTitle;
        $('rvText').textContent = q.text;
        if (root.Quizer.code) root.Quizer.code.attach($('rvText'), q);

        $('rvChoicePane').hidden = recall;
        $('rvRecallPane').hidden = !recall;
        $('rvCheck').hidden = recall || !!ses.result;
        $('rvCheck').disabled = !ses.selected.length || ses.busy;

        if (!recall) {
            const box = $('rvChoices');
            box.setAttribute('role', max > 1 ? 'group' : 'radiogroup');
            box.setAttribute('aria-label', max > 1 ? `Choose ${max} answers` : 'Choose one answer');
            box.replaceChildren();
            const chosen = new Set(ses.selected);
            const right = new Set(ses.result ? ses.result.correctAnswer : []);
            Object.keys(q.choices).forEach((key, i) => {
                const btn = doc.createElement('button');
                btn.type = 'button';
                btn.className = 'choice';
                btn.dataset.key = key;
                btn.setAttribute('role', max > 1 ? 'checkbox' : 'radio');
                btn.setAttribute('aria-checked', chosen.has(key) ? 'true' : 'false');
                if (chosen.has(key)) btn.classList.add('selected');
                if (ses.result) {
                    btn.disabled = true;
                    if (right.has(key)) btn.classList.add('choice--correct');
                    else if (chosen.has(key)) btn.classList.add('choice--incorrect');
                }
                const label = doc.createElement('span');
                label.className = 'choice-label';
                label.textContent = String.fromCharCode(65 + i);
                const text = doc.createElement('span');
                text.className = 'choice-content';
                text.textContent = String(q.choices[key]);
                btn.append(label, text);
                btn.addEventListener('click', () => choose(key, max));
                box.appendChild(btn);
            });
        } else {
            $('rvReveal').hidden = ses.revealed;
            $('rvRecallBox').hidden = !ses.revealed;
            $('rvRate').hidden = !ses.revealed || !!ses.result;
            if (ses.revealed) {
                const box = $('rvRecallAnswer');
                box.replaceChildren();
                q.answer.forEach((k) => {
                    const p = doc.createElement('p');
                    p.className = 'ln-recall__answer';
                    p.textContent = q.choices[k] || k;
                    box.appendChild(p);
                });
            }
        }

        const fb = $('rvFeedback');
        if (!ses.result) { fb.hidden = true; fb.replaceChildren(); }
        else {
            const r = ses.result;
            fb.hidden = false;
            fb.className = 'pt-feedback pt-feedback--' + r.outcome;
            fb.replaceChildren();
            const head = doc.createElement('p');
            head.className = 'pt-feedback__status';
            head.textContent = (r.outcome === 'correct' ? '✓ ' : r.outcome === 'partial' ? '◐ ' : '✗ ') + OUTCOME[r.outcome];
            const next = doc.createElement('p');
            next.textContent = `Next review: ${nextReviewText(r.dueAt, s.data.today, tzOffset())}.`
                + (r.outcome === 'incorrect' ? ' The interval starts over.' : r.outcome === 'partial' ? ' Same interval as before.' : '');
            fb.append(head, next);
            q.answer.forEach((k) => {
                const why = q.answerDescriptions && q.answerDescriptions[k];
                if (!why && !recall) return;
                const p = doc.createElement('p');
                p.className = 'pt-feedback__answer';
                const strong = doc.createElement('strong');
                strong.textContent = q.choices[k] || k;
                p.appendChild(strong);
                if (why) p.appendChild(doc.createTextNode(' — ' + why));
                fb.appendChild(p);
            });
        }
        $('rvNext').hidden = !ses.result;
        $('rvNext').textContent = ses.index === ses.items.length - 1 ? 'See summary' : 'Next question';
    }

    function choose(key, max) {
        const ses = s.session;
        if (!ses || ses.result || ses.busy) return;
        ses.selected = toggleChoice(ses.selected, key, max);
        renderCard();
        const again = $('rvChoices').querySelector(`[data-key="${CSS.escape(key)}"]`);
        if (again) again.focus();
    }

    async function submit(body) {
        const ses = s.session;
        if (!ses || ses.result || ses.busy) return;
        const it = item();
        ses.busy = true;
        renderCard();
        try {
            const res = await fetch(root.quizApiUrl(`/api/review/${encodeURIComponent(it.setId)}/${encodeURIComponent(it.questionId)}/answer`), {
                method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({ tzOffset: tzOffset(), clientAttemptId: L().newClientId('v') }, body)),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
            ses.result = data;
            ses.tally[data.outcome]++;
            announce(`${OUTCOME[data.outcome]}. Next review ${nextReviewText(data.dueAt, s.data.today, tzOffset())}.`);
        } catch (e) {
            announce('Could not save that review. ' + e.message);
            root.alert('Could not save that review: ' + e.message);
        } finally {
            ses.busy = false;
            renderCard();
            if (ses.result) $('rvNext').focus();
        }
    }

    function next() {
        const ses = s.session;
        if (!ses || !ses.result) return;
        if (ses.index >= ses.items.length - 1) { finish(); return; }
        ses.index++;
        ses.selected = [];
        ses.revealed = false;
        ses.result = null;
        renderCard();
        focusFirst();
    }

    async function finish() {
        const t = s.session.tally;
        s.session = null;
        showScreen('rvDone');
        $('rvDoneCorrect').textContent = String(t.correct);
        $('rvDonePartial').textContent = String(t.partial);
        $('rvDoneIncorrect').textContent = String(t.incorrect);
        try { await load(); } catch (_) { /* summary still shows the tally */ }
        const n = s.data ? s.data.upcoming.find((u) => u.count > 0) : null;
        $('rvDoneText').textContent = n
            ? `Next reviews: ${dayLabel(n.date, s.data.today).toLowerCase()} (${n.count}).`
            : 'Everything is scheduled further out.';
        $('rvDoneHeading').focus();
        announce('Review finished.');
    }

    async function backToOverview() {
        s.session = null;
        showState('loading', 'Updating your schedule…');
        try { await load(); renderOverview(); }
        catch (e) { showState('error', 'Could not load Smart Review. ' + e.message, { label: 'Try again', run: backToOverview }); }
    }

    // ================= Open / close =================
    async function open() {
        if (typeof root.closeModeViews === 'function') root.closeModeViews('review');
        s.open = true;
        root.showModeView('reviewView');
        if (typeof root.toggleSidebar === 'function') root.toggleSidebar(false);
        root.scrollTo({ top: 0 });
        syncShell();
        showState('loading', 'Loading your review schedule…');
        try {
            await load();
            if (!s.open) return;
            renderOverview();
            syncShell();
        } catch (e) {
            if (!s.open) return;
            showState('error', 'Could not load Smart Review. ' + e.message, { label: 'Try again', run: open });
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
    function renderTile(c) {
        const meta = $('rvTileMeta');
        if (!meta) return;
        if (!c) { meta.textContent = 'Spaced reviews across your sets'; return; }
        meta.textContent = c.due ? `${c.due} due today across your sets`
            : (c.scheduled ? 'All caught up for today' : 'Questions join once you study them');
    }
    let tileTimer = null;
    function refreshTile() {
        clearTimeout(tileTimer);
        tileTimer = setTimeout(async () => {
            try {
                const saved = s.setFilter;
                s.setFilter = '';
                await load();
                s.setFilter = saved;
            } catch (_) { /* signed out or offline */ }
        }, 300);
    }

    // -- input --
    function bind() {
        if (!$('reviewView')) return;
        $('rvSet').addEventListener('change', async (e) => {
            s.setFilter = e.target.value;
            try { await load(); renderOverview(); } catch (err) { showState('error', err.message); }
        });
        $('rvFormat').addEventListener('change', (e) => { s.format = e.target.value; });
        $('rvStart').addEventListener('click', startSession);
        $('rvCheck').addEventListener('click', () => { if (s.session && s.session.selected.length) submit({ format: 'choice', selected: s.session.selected }); });
        $('rvReveal').addEventListener('click', () => { s.session.revealed = true; renderCard(); $('rvRateGood').focus(); });
        $('rvRateAgain').addEventListener('click', () => submit({ format: 'recall', rating: 'incorrect' }));
        $('rvRateHard').addEventListener('click', () => submit({ format: 'recall', rating: 'partial' }));
        $('rvRateGood').addEventListener('click', () => submit({ format: 'recall', rating: 'correct' }));
        $('rvNext').addEventListener('click', next);
        $('rvStop').addEventListener('click', backToOverview);
        $('rvDoneBack').addEventListener('click', backToOverview);
        $('rvDoneExit').addEventListener('click', close);
        $('rvExit').addEventListener('click', close);
        doc.querySelectorAll('[data-open-view="review"]').forEach((el) => {
            el.addEventListener('click', (e) => { e.preventDefault(); open(); });
        });
        doc.addEventListener('keydown', (e) => {
            if (!s.open || !s.session || $('rvSession').hidden) return;
            if (e.altKey || e.ctrlKey || e.metaKey) return;
            const tag = (e.target && e.target.tagName) || '';
            if (tag === 'SELECT' || tag === 'INPUT') return;
            const ses = s.session;
            // Enter on a chosen answer checks it (Space still toggles the choice).
            const onChoice = tag === 'BUTTON' && e.target.classList.contains('choice') && !ses.result && ses.selected.length > 0;
            if (e.key === 'Enter' && (tag !== 'BUTTON' || onChoice)) {
                e.preventDefault();
                if (ses.result) next();
                else if (s.format === 'choice' && ses.selected.length) submit({ format: 'choice', selected: ses.selected });
                return;
            }
            if (s.format === 'choice' && !ses.result && /^[a-z]$/i.test(e.key)) {
                const q = item().question;
                const keys = Object.keys(q.choices);
                const at = e.key.toUpperCase().charCodeAt(0) - 65;
                if (at >= 0 && at < keys.length) { e.preventDefault(); choose(keys[at], Math.max(1, q.maxSelections || q.answer.length)); }
            }
            if (s.format === 'recall' && ses.revealed && !ses.result) {
                if (e.key === '1') submit({ format: 'recall', rating: 'incorrect' });
                if (e.key === '2') submit({ format: 'recall', rating: 'partial' });
                if (e.key === '3') submit({ format: 'recall', rating: 'correct' });
            }
        });
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
