/* ============================================================
   Unified progress on the dashboard (Phase 10).

   Reads GET /api/dashboard and shows each mode's measure side by side,
   never merged into one score (see dashboard_routes.py):
     answers      graded answers from every mode (self-ratings excluded)
     flashcards   the learner's own Know / Still learning labels
     learn        mastery stages
     mistakes     open / resolved review items
     review       spaced-repetition schedule
   Every figure is a count of stored records; nothing is estimated.

   Top half: pure logic (exported for `node --test`).
   Bottom half: browser controller (window.Quizer.progress).
   ============================================================ */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api.logic;
    if (root) root.Quizer = Object.assign(root.Quizer || {}, { progress: api.controller });
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    // ---- Pure logic ------------------------------------------------------------

    const MODES = {
        flashcards: { label: 'Flashcards', controller: 'flashcards', perSet: true },
        learn: { label: 'Learn', controller: 'learn', perSet: true },
        recall: { label: 'Active recall', controller: 'recall', perSet: true },
        practice: { label: 'Practice test', controller: 'practice', perSet: true },
        matching: { label: 'Matching', controller: 'matching', perSet: true },
        code: { label: 'Code challenge', controller: 'codeChallenge', perSet: true },
        mistakes: { label: 'Mistake review', controller: 'mistakes', perSet: false },
        review: { label: 'Smart review', controller: 'review', perSet: false },
    };
    function modeLabel(mode) { return (MODES[mode] && MODES[mode].label) || mode; }

    /** "just now", "5 minutes ago", "yesterday", "3 days ago", "12 Nov". */
    function relativeTime(iso, now) {
        if (!iso) return '';
        const then = new Date(iso);
        const ref = now instanceof Date ? now : new Date();
        const secs = Math.max(0, Math.round((ref - then) / 1000));
        if (secs < 60) return 'just now';
        const mins = Math.round(secs / 60);
        if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
        const hours = Math.round(mins / 60);
        if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
        const days = Math.round(hours / 24);
        if (days === 1) return 'yesterday';
        if (days < 7) return `${days} days ago`;
        return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    }

    /** A round axis maximum: 1, 2, 5, 10, 20, 50 ... at or above the largest value. */
    function niceMax(values) {
        const top = Math.max(0, ...values);
        if (top <= 1) return 1;
        const pow = Math.pow(10, Math.floor(Math.log10(top)));
        for (const step of [1, 2, 5, 10]) if (step * pow >= top) return step * pow;
        return 10 * pow;
    }

    function percent(part, whole) { return whole ? Math.round((part / whole) * 100) : null; }

    /** "Tue 18 Nov" from "2026-11-18" (no timezone shift: it is already the learner's day). */
    function shortDay(isoDate) {
        const [y, m, d] = isoDate.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        return dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    }

    /** Totals for the activity chart caption: only graded answers count toward accuracy. */
    function activitySummary(days) {
        const t = days.reduce((a, d) => ({ answers: a.answers + d.answers, graded: a.graded + d.graded, correct: a.correct + d.correct }),
            { answers: 0, graded: 0, correct: 0 });
        return Object.assign(t, { activeDays: days.filter((d) => d.answers > 0).length, accuracy: percent(t.correct, t.graded) });
    }

    /** Latest and best practice score, and how many of the shown tests passed their own mark. */
    function practiceSummary(recent) {
        if (!recent.length) return null;
        const withMark = recent.filter((r) => r.passPercent != null);
        return {
            latest: recent[recent.length - 1].score,
            best: Math.max(...recent.map((r) => r.score)),
            passed: withMark.filter((r) => r.score >= r.passPercent).length,
            withMark: withMark.length,
        };
    }

    // ---- "Continue studying" rows the learner removed -------------------------
    // Removing a row only hides it; saved progress is untouched. A hidden row
    // comes back as soon as that mode is studied again (newer activity).
    const CONTINUE_SHOWN = 4;
    const HIDDEN_DAYS = 90;

    function continueKey(item) {
        const m = MODES[item.mode];
        return m && !m.perSet ? item.mode : `${item.setId}|${item.mode}`;
    }

    /** Rows to show: not hidden, or studied again after they were hidden. */
    function visibleContinue(items, hidden, limit) {
        const h = hidden || {};
        return (items || []).filter((it) => {
            const at = h[continueKey(it)];
            return !at || (it.at && new Date(it.at) > new Date(at));
        }).slice(0, limit == null ? CONTINUE_SHOWN : limit);
    }

    /** Drop hide records older than HIDDEN_DAYS so storage stays small. */
    function pruneHidden(hidden, now) {
        const ref = now instanceof Date ? now : new Date();
        const out = {};
        Object.entries(hidden || {}).forEach(([k, at]) => {
            const t = new Date(at);
            if (!Number.isNaN(t.getTime()) && ref - t < HIDDEN_DAYS * 864e5) out[k] = at;
        });
        return out;
    }

    const logic = { MODES, modeLabel, relativeTime, niceMax, percent, shortDay, activitySummary, practiceSummary,
        continueKey, visibleContinue, pruneHidden, CONTINUE_SHOWN };

    // ---- Browser controller ----------------------------------------------------

    if (!root || typeof root.document === 'undefined') return { logic, controller: null };
    const doc = root.document;
    const $ = (id) => doc.getElementById(id);
    const el = (tag, cls, text) => {
        const n = doc.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    };

    const s = { data: null, selected: null, loading: null, timer: null };

    function showState(kind, message, action) {
        $('pgBody').hidden = kind !== 'ready';
        const box = $('pgState');
        box.hidden = kind === 'ready';
        if (kind === 'ready') return;
        box.className = 'ui-state ui-state--' + (kind === 'error' ? 'error' : kind === 'loading' ? 'loading' : 'empty');
        box.replaceChildren();
        if (kind === 'loading') {
            const spin = el('span', 'ui-spinner');
            spin.setAttribute('aria-hidden', 'true');
            box.appendChild(spin);
        }
        box.appendChild(el('span', '', message));
        if (action) {
            const b = el('button', 'btn btn--secondary btn--sm', action.label);
            b.type = 'button';
            b.addEventListener('click', action.run);
            box.appendChild(b);
        }
    }

    async function load() {
        if (typeof root.currentUser !== 'undefined' && !root.currentUser) return;
        if (s.loading) return s.loading;
        if (!s.data) showState('loading', 'Loading your progress…');
        s.loading = (async () => {
            try {
                const res = await fetch(root.quizApiUrl('/api/dashboard?tzOffset=' + new Date().getTimezoneOffset()), { credentials: 'include' });
                const data = await res.json().catch(() => null);
                if (res.status === 401) return;
                if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
                s.data = data;
                render();
            } catch (e) {
                if (!s.data) showState('error', 'Could not load your progress. ' + e.message, { label: 'Try again', run: load });
            } finally {
                s.loading = null;
            }
        })();
        return s.loading;
    }

    function refreshSoon() {
        clearTimeout(s.timer);
        s.timer = setTimeout(load, 350);
    }

    // ================= Render =================
    function render() {
        const d = s.data;
        if (!d.sets.length) {
            showState('empty', 'Import a question set or generate one from a PDF, and your progress will show here.');
            return;
        }
        showState('ready');
        renderTotals(d.totals);
        renderContinue(d.continue);
        renderActivity(d.activity);
        if (!s.selected || !d.sets.some((x) => x.setId === s.selected)) s.selected = d.sets[0].setId;
        renderSets(d.sets, d.rules);
        renderPractice(d.practice);
    }

    function renderTotals(t) {
        $('pgStudied').textContent = String(t.studied);
        $('pgStudiedNote').textContent = `of ${t.questions} question${t.questions === 1 ? '' : 's'}, in any mode`;
        $('pgAttention').textContent = String(t.needsAttention);
        $('pgMastered').textContent = String(t.mastered);
        $('pgDue').textContent = String(t.reviewDue);
    }

    // Hidden rows are kept per user in this browser.
    function hiddenKey() {
        // eslint-disable-next-line no-undef
        const user = typeof currentUser !== 'undefined' ? currentUser : null;
        return user && user.id != null ? 'quizer:continueHidden:u' + user.id : null;
    }
    function loadHidden() {
        const key = hiddenKey();
        if (!key) return {};
        try { return pruneHidden(JSON.parse(root.localStorage.getItem(key) || '{}')); } catch (_) { return {}; }
    }
    function saveHidden(hidden) {
        const key = hiddenKey();
        if (!key) return;
        try { root.localStorage.setItem(key, JSON.stringify(hidden)); } catch (_) { /* storage full or blocked */ }
    }

    function removeContinue(it) {
        const hidden = loadHidden();
        const key = continueKey(it);
        const previous = Object.prototype.hasOwnProperty.call(hidden, key) ? hidden[key] : undefined;
        hidden[key] = new Date().toISOString();
        saveHidden(hidden);
        const rows = [...$('pgContinue').children];
        const at = rows.findIndex((li) => li.dataset.key === key);
        renderContinue(s.data.continue);
        const label = modeLabel(it.mode) + (MODES[it.mode] && MODES[it.mode].perSet ? ' · ' + it.setTitle : '');
        showContinueStatus(`Removed ${label}. It comes back when you study it again.`, () => {
            const h = loadHidden();
            if (previous === undefined) delete h[key]; else h[key] = previous;
            saveHidden(h);
            renderContinue(s.data.continue);
            hideContinueStatus();
            const back = $('pgContinue').querySelector(`[data-key="${CSS.escape(key)}"] .btn`);
            if (back) back.focus();
        });
        // Keep keyboard focus nearby: the row that moved up, else Undo.
        const next = $('pgContinue').children[Math.min(at, $('pgContinue').children.length - 1)];
        const target = next ? next.querySelector('.pg-remove') : $('pgContinueUndo');
        if (target) target.focus();
    }

    function showContinueStatus(message, undo) {
        const box = $('pgContinueStatus');
        $('pgContinueStatusText').textContent = message;
        const btn = $('pgContinueUndo');
        btn.onclick = undo;
        box.hidden = false;
    }
    function hideContinueStatus() {
        $('pgContinueStatus').hidden = true;
        $('pgContinueStatusText').textContent = '';
    }

    function renderContinue(allItems) {
        const items = visibleContinue(allItems, loadHidden());
        const list = $('pgContinue');
        list.replaceChildren();
        $('pgContinueEmpty').hidden = items.length > 0;
        $('pgContinueEmpty').textContent = (allItems || []).length && !items.length
            ? 'You removed everything here. Rows come back when you study again.'
            : 'Nothing to continue yet. Pick a study mode below to start.';
        items.forEach((it) => {
            const li = el('li', 'pg-row');
            const text = el('div', 'pg-row__text');
            text.append(el('span', 'pg-row__title', modeLabel(it.mode)),
                el('span', 'pg-row__meta', (MODES[it.mode] && !MODES[it.mode].perSet ? 'All your sets' : it.setTitle) + ' · ' + relativeTime(it.at)));
            const btn = el('button', 'btn btn--secondary btn--sm', 'Continue');
            btn.type = 'button';
            btn.setAttribute('aria-label', `Continue ${modeLabel(it.mode)}${MODES[it.mode] && MODES[it.mode].perSet ? ' with ' + it.setTitle : ''}`);
            btn.addEventListener('click', () => continueWith(it, btn));
            const remove = el('button', 'pg-remove');
            remove.type = 'button';
            remove.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>';
            const what = modeLabel(it.mode) + (MODES[it.mode] && MODES[it.mode].perSet ? ', ' + it.setTitle : '');
            remove.setAttribute('aria-label', `Remove ${what} from Continue studying`);
            remove.title = 'Remove from this list';
            remove.addEventListener('click', () => removeContinue(it));
            const actions = el('div', 'pg-row__actions');
            actions.append(btn, remove);
            li.dataset.key = continueKey(it);
            li.append(text, actions);
            list.appendChild(li);
        });
    }

    async function continueWith(it, btn) {
        const mode = MODES[it.mode];
        const ctl = mode && root.Quizer[mode.controller];
        if (!ctl) return;
        btn.disabled = true;
        try {
            // Per-set modes study the active set: switch to this one first.
            // eslint-disable-next-line no-undef
            const active = typeof QSetStore !== 'undefined' ? QSetStore.getActiveId() : null;
            if (mode.perSet && active !== it.setId && typeof root.activateQuestionSet === 'function') {
                const ok = await root.activateQuestionSet(it.setId);
                if (!ok) return;
            }
            await ctl.open();
        } finally {
            btn.disabled = false;
        }
    }

    // A tooltip shared by the bars of one chart; it follows hover and focus.
    function attachTip(chart, tip) {
        const show = (bar) => {
            tip.textContent = bar.dataset.tip;
            tip.hidden = false;
            const cr = chart.getBoundingClientRect();
            const br = bar.getBoundingClientRect();
            const x = br.left - cr.left + br.width / 2;
            tip.style.left = Math.min(Math.max(x, 90), cr.width - 90) + 'px';
        };
        const hide = () => { tip.hidden = true; };
        chart.querySelectorAll('[data-tip]').forEach((bar) => {
            bar.addEventListener('mouseenter', () => show(bar));
            bar.addEventListener('focus', () => show(bar));
            bar.addEventListener('mouseleave', hide);
            bar.addEventListener('blur', hide);
        });
    }

    function renderActivity(days) {
        const sum = activitySummary(days);
        const max = niceMax(days.map((d) => d.answers));
        $('pgActMax').textContent = String(max);
        $('pgActMid').textContent = max >= 2 ? String(max / 2) : '';
        const bars = $('pgActBars');
        bars.replaceChildren();
        days.forEach((d, i) => {
            const col = el('div', 'pg-col');
            const bar = el('span', 'pg-bar');
            bar.style.height = d.answers ? Math.max(2, (d.answers / max) * 100) + '%' : '0';
            const label = i === days.length - 1 ? 'Today' : shortDay(d.date);
            const acc = percent(d.correct, d.graded);
            const tip = `${label}: ${d.answers} answer${d.answers === 1 ? '' : 's'}`
                + (d.graded ? `, ${d.correct} of ${d.graded} graded correct (${acc}%)` : d.answers ? ', none graded' : '');
            col.dataset.tip = tip;
            col.tabIndex = 0;
            col.setAttribute('aria-label', tip);
            col.appendChild(bar);
            bars.appendChild(col);
        });
        $('pgActFirst').textContent = shortDay(days[0].date);
        $('pgActLast').textContent = 'Today';
        $('pgActSummary').textContent = sum.answers
            ? `${sum.answers} answer${sum.answers === 1 ? '' : 's'} on ${sum.activeDays} day${sum.activeDays === 1 ? '' : 's'}.`
              + (sum.graded ? ` ${sum.accuracy}% of ${sum.graded} graded answers correct.` : ' None of them graded.')
            : 'No answers in the last 14 days.';
        const body = $('pgActTable');
        body.replaceChildren();
        days.slice().reverse().forEach((d, i) => {
            const tr = el('tr');
            tr.append(el('td', '', i === 0 ? 'Today' : shortDay(d.date)), el('td', '', String(d.answers)),
                el('td', '', String(d.graded)), el('td', '', d.graded ? percent(d.correct, d.graded) + '%' : '—'));
            body.appendChild(tr);
        });
        attachTip($('pgActChart'), $('pgActTip'));
    }

    function measure(title, def, rows, bar) {
        const card = el('section', 'pg-measure');
        const h = el('h4', 'pg-measure__title', title);
        card.append(h, el('p', 'pg-measure__def', def));
        if (bar) card.appendChild(bar);
        const dl = el('dl', 'pg-measure__list');
        rows.forEach(([k, v, dot]) => {
            const div = el('div');
            const dt = el('dt', '', k);
            if (dot) {
                const d = el('span', 'ln-dot ln-dot--' + dot);
                d.setAttribute('aria-hidden', 'true');
                dt.prepend(d);
            }
            div.append(dt, el('dd', '', v));
            dl.appendChild(div);
        });
        card.appendChild(dl);
        return card;
    }

    function learnBar(l, total) {
        const bar = el('div', 'ln-bar pg-measure__bar');
        bar.setAttribute('role', 'img');
        bar.setAttribute('aria-label', `Learn: ${l.mastered} mastered, ${l.familiar} familiar, ${l.learning} learning, ${l.new} new`);
        ['mastered', 'familiar', 'learning', 'new'].forEach((k) => {
            const seg = el('span', 'ln-bar__seg ln-bar__seg--' + k);
            seg.style.width = total ? (l[k] / total) * 100 + '%' : '0';
            bar.appendChild(seg);
        });
        return bar;
    }

    function renderSets(sets, rules) {
        const list = $('pgSets');
        list.replaceChildren();
        sets.slice(0, 5).forEach((set) => {
            const li = el('li');
            const b = el('button', 'pg-set');
            b.type = 'button';
            b.setAttribute('aria-pressed', set.setId === s.selected ? 'true' : 'false');
            b.append(el('span', 'pg-row__title', set.title),
                el('span', 'pg-row__meta', (set.lastStudiedAt ? 'Studied ' + relativeTime(set.lastStudiedAt) : 'Not studied yet')
                    + ` · ${set.answers.studied} of ${set.questions} studied`));
            b.addEventListener('click', () => {
                s.selected = set.setId;
                renderSets(sets, rules);
                const again = $('pgSets').querySelector('[aria-pressed="true"]');
                if (again) again.focus();
            });
            li.appendChild(b);
            list.appendChild(li);
        });
        $('pgSetsMore').hidden = sets.length <= 5;
        $('pgSetsMore').textContent = `All ${sets.length} sets in the library`;

        const set = sets.find((x) => x.setId === s.selected);
        $('pgSetTitle').textContent = set.title;
        const a = set.answers;
        const box = $('pgMeasures');
        box.replaceChildren(
            measure('Answers', 'Graded answers from every mode. Self-ratings and flashcard flips are not counted.', [
                ['Studied', `${a.studied} of ${set.questions}`],
                ['Graded answers', String(a.graded)],
                ['Correct', a.accuracy == null ? '—' : `${a.correct} (${a.accuracy}%)`],
            ]),
            measure('Flashcards', 'Your own labels, not a test result.', [
                ['Know', String(set.flashcards.know)],
                ['Still learning', String(set.flashcards.learning)],
                ['Not marked', String(set.flashcards.unmarked)],
            ]),
            measure('Learn mastery', `Mastered after ${rules.masteredStreak} correct answers in a row in Learn.`, [
                ['Mastered', String(set.learn.mastered), 'mastered'],
                ['Familiar', String(set.learn.familiar), 'familiar'],
                ['Learning', String(set.learn.learning), 'learning'],
                ['New', String(set.learn.new), 'new'],
            ], learnBar(set.learn, set.questions)),
            measure('Mistake review', `Missed anywhere; resolved after ${rules.retriesToResolve} correct retries in a row.`, [
                ['Open', String(set.mistakes.open)],
                ['Resolved', String(set.mistakes.resolved)],
            ]),
            measure('Smart review', 'Spaced repetition. Questions join once studied.', [
                ['Due by tonight', String(set.review.due)],
                ['Scheduled', String(set.review.scheduled)],
                [`Mature (${rules.matureDays}+ days)`, String(set.review.mature)],
            ]),
        );
    }

    function renderPractice(p) {
        const recent = p.recent;
        $('pgPracticeEmpty').hidden = recent.length > 0;
        $('pgPracticeChart').hidden = !recent.length;
        $('pgPracticeSummary').hidden = !recent.length;
        $('pgPracticeTableWrap').hidden = !recent.length;
        if (!recent.length) return;
        const sum = practiceSummary(recent);
        const bars = $('pgPracticeBars');
        bars.replaceChildren();
        recent.forEach((r, i) => {
            const col = el('div', 'pg-col');
            const bar = el('span', 'pg-bar');
            bar.style.height = Math.max(2, r.score) + '%';
            col.appendChild(bar);
            if (r.passPercent != null) {
                const mark = el('span', 'pg-mark');
                mark.style.bottom = r.passPercent + '%';
                mark.setAttribute('aria-hidden', 'true');
                col.appendChild(mark);
            }
            const when = new Date(r.finishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
            const pass = r.passPercent == null ? '' : (r.score >= r.passPercent ? `, passed (pass mark ${r.passPercent}%)` : `, below the pass mark of ${r.passPercent}%`);
            const tip = `Test ${i + 1}, ${when}: ${r.score}% (${r.correct} of ${r.total})${pass}. ${r.setTitle || ''}`.trim();
            col.dataset.tip = tip;
            col.tabIndex = 0;
            col.setAttribute('aria-label', tip);
            bars.appendChild(col);
        });
        $('pgPracticeSummary').textContent = `Latest ${sum.latest}% · best ${sum.best}%`
            + (sum.withMark ? ` · ${sum.passed} of ${sum.withMark} passed` : '')
            + (p.count > recent.length ? ` · last ${recent.length} of ${p.count} tests` : ` · ${p.count} test${p.count === 1 ? '' : 's'}`);
        const body = $('pgPracticeTable');
        body.replaceChildren();
        recent.slice().reverse().forEach((r) => {
            const tr = el('tr');
            tr.append(el('td', '', new Date(r.finishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })),
                el('td', '', r.setTitle || ''), el('td', '', r.score + '%'),
                el('td', '', r.passPercent == null ? '—' : r.passPercent + '%'));
            body.appendChild(tr);
        });
        attachTip($('pgPracticeChart'), $('pgPracticeTip'));
    }

    // ================= Wiring =================
    function bind() {
        if (!$('progressSection')) return;
        $('pgSetsMore').addEventListener('click', () => root.navigateToSection && root.navigateToSection('questionSetsSection'));
        $('pgPracticeAll').addEventListener('click', () => root.navigateToSection && root.navigateToSection('sessionHistory'));
        // Refresh when the dashboard comes back into view (a mode closed, an exam ended).
        const dash = $('dashboard');
        let wasVisible = dash && dash.style.display !== 'none';
        if (dash) {
            new MutationObserver(() => {
                const visible = dash.style.display !== 'none';
                if (visible && !wasVisible) refreshSoon();
                wasVisible = visible;
            }).observe(dash, { attributes: true, attributeFilter: ['style'] });
        }
        // ...and when sign-in, imports or history re-render the library.
        ['renderQuestionSets', 'renderSessionHistory'].forEach((name) => {
            const original = root[name];
            if (typeof original !== 'function') return;
            root[name] = function () {
                const result = original.apply(this, arguments);
                refreshSoon();
                return result;
            };
        });
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind);
    else bind();

    return { logic, controller: { load, refresh: refreshSoon } };
});
