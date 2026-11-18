/* ============================================================
   Learn mode: adaptive, self-paced rounds.

   * A round takes up to N unmastered questions: missed ("learning")
     first, then new, then familiar.
   * A miss comes back later in the same round (after K others); a
     correct answer leaves the round and returns in a later one. Mastery
     needs several correct answers in a row across rounds (config).
   * The format gets harder as a question matures: multiple choice while
     new or learning; typed answer (or recall with self-check) once
     familiar. Multi-answer questions always use multi-select.
   * Every answer is graded on the server (learn_routes.py).
   * The round resumes from study_sessions (mode "learn").

   Top half: pure logic (exported for `node --test`).
   Bottom half: browser controller (window.Quizer.learn).
   ============================================================ */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api.logic;
    if (root) root.Quizer = Object.assign(root.Quizer || {}, { learn: api.controller });
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    const STATE_VERSION = 1;
    const STAGES = ['new', 'learning', 'familiar', 'mastered'];
    const MAX_WRITTEN = 80;
    const VAGUE = /(of the above|^both\b|^neither\b|^all\b|^none\b)/;

    // ---- Pure logic ------------------------------------------------------------

    // One text rule for every mode: the shared core (js/core/learning.js),
    // which mirrors normalize_text() in learn_routes.py.
    const core = (root && root.Quizer && root.Quizer.learning)
        || (typeof require === 'function' ? require('../core/learning.js') : null);
    function normalizeText(value) { return core.normalizeText(value); }

    function answerList(answer) {
        return Array.isArray(answer) ? answer.map(String) : (answer == null ? [] : [String(answer)]);
    }

    /** Mirrors written_answer(): the text to type, or null when typing makes no sense. */
    function writtenAnswer(question) {
        const answers = answerList(question && question.answer);
        if (answers.length !== 1) return null;
        const choices = (question && question.choices) || {};
        const text = choices[answers[0]];
        if (typeof text !== 'string') return null;
        const norm = normalizeText(text);
        if (!norm || text.trim().length > MAX_WRITTEN || VAGUE.test(norm)) return null;
        const clash = Object.keys(choices).some((k) => k !== answers[0] && normalizeText(choices[k]) === norm);
        return clash ? null : text.trim();
    }

    function stageOf(stages, id) {
        const st = stages && stages[id];
        return STAGES.includes(st) ? st : 'new';
    }

    function countStages(ids, stages) {
        const c = { new: 0, learning: 0, familiar: 0, mastered: 0 };
        ids.forEach((id) => { c[stageOf(stages, id)]++; });
        return c;
    }

    /** Up to `size` unmastered ids: learning, then new, then familiar (set order within each). */
    function buildRound(ids, stages, size, includeMastered) {
        const rank = { learning: 0, new: 1, familiar: 2, mastered: 3 };
        const pool = ids.filter((id) => includeMastered || stageOf(stages, id) !== 'mastered');
        return pool
            .map((id, i) => ({ id, i, r: rank[stageOf(stages, id)] }))
            .sort((a, b) => a.r - b.r || a.i - b.i)
            .slice(0, Math.max(1, size | 0))
            .map((x) => x.id);
    }

    /** Put `id` back `after` places past the current position (clamped to the end). */
    function requeue(queue, index, id, after) {
        const out = queue.slice();
        const at = Math.min(out.length, index + 1 + Math.max(0, after | 0));
        out.splice(at, 0, id);
        return out;
    }

    /** Harder formats for more mature questions, limited to what's enabled and possible. */
    function chooseFormat(question, stage, enabled) {
        const on = enabled || {};
        if (answerList(question && question.answer).length > 1) return 'choice';
        if (stage === 'familiar' || stage === 'mastered') {
            if (on.written && writtenAnswer(question)) return 'written';
            if (on.recall) return 'recall';
        }
        return 'choice';
    }

    /** A saved round is only trusted when every queued question still exists. */
    function normalizeLearnState(raw, ids) {
        if (!raw || typeof raw !== 'object' || raw.v !== STATE_VERSION) return null;
        const present = new Set(ids);
        if (!Array.isArray(raw.queue) || !raw.queue.length || !raw.queue.every((id) => present.has(id))) return null;
        if (!Array.isArray(raw.roundIds) || !raw.roundIds.every((id) => present.has(id))) return null;
        const index = Math.max(0, Math.min(raw.queue.length, raw.index | 0));
        const settings = Object.assign({ written: true, recall: true, size: 10 }, raw.settings || {});
        return Object.assign({}, raw, { index, settings, results: raw.results && typeof raw.results === 'object' ? raw.results : {} });
    }

    /** Round summary from per-question results. */
    function summarizeRound(roundIds, results) {
        let firstTry = 0;
        let retried = 0;
        roundIds.forEach((id) => {
            const r = results[id];
            if (!r) return;
            if (r.misses === 0 && r.done) firstTry++;
            else if (r.misses > 0) retried++;
        });
        return { total: roundIds.length, firstTry, retried };
    }

    const logic = {
        normalizeText, writtenAnswer, stageOf, countStages, buildRound, requeue,
        chooseFormat, normalizeLearnState, summarizeRound, STATE_VERSION,
    };

    // ---- Browser controller ----------------------------------------------------

    if (!root || typeof root.document === 'undefined') return { logic, controller: null };
    const doc = root.document;
    const L = () => root.Quizer.learning;
    const $ = (id) => doc.getElementById(id);
    const MODE = 'learn';
    const STAGE_LABEL = { new: 'New', learning: 'Learning', familiar: 'Familiar', mastered: 'Mastered' };

    function activeSetId() {
        // QSetStore is a top-level const in Cert.js: not a window property.
        // eslint-disable-next-line no-undef
        return (typeof QSetStore !== 'undefined' && QSetStore) ? QSetStore.getActiveId() : null;
    }

    const s = {
        open: false,
        setId: null,
        title: '',
        questions: [],
        byId: new Map(),
        stages: {},
        cfg: { correctStreakForMastered: 3, requeueAfterIncorrect: 3 },
        run: null,          // saved round state
        settings: { written: true, recall: true, size: 10 },
        current: null,      // { id, format, selected, typed, revealed, result, busy }
        saveTimer: null,
        lastSave: Promise.resolve(),
    };

    function announce(t) { const el = $('lnLive'); if (el) el.textContent = t; }
    function syncShell() {
        if (typeof root.syncAppBar === 'function') root.syncAppBar();
        if (s.open && typeof root.setActiveNav === 'function') root.setActiveNav('learnView');
    }
    function showScreen(name) {
        ['lnIntro', 'lnQuestion', 'lnRound', 'lnDone'].forEach((id) => { $(id).hidden = id !== name; });
        $('lnState').hidden = true;
    }
    function showState(kind, message, action) {
        ['lnIntro', 'lnQuestion', 'lnRound', 'lnDone'].forEach((id) => { $(id).hidden = true; });
        const box = $('lnState');
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

    // -- persistence --
    function saveNow() {
        if (!s.setId) return s.lastSave;
        clearTimeout(s.saveTimer);
        s.saveTimer = null;
        s.lastSave = (s.run
            ? L().api.saveSession(s.setId, MODE, s.run)
            : L().api.clearSession(s.setId, MODE)
        ).catch((e) => console.warn('[learn] could not save progress:', e.message));
        return s.lastSave;
    }
    function scheduleSave() { clearTimeout(s.saveTimer); s.saveTimer = setTimeout(saveNow, 400); }

    // ================= Intro =================
    function ids() { return s.questions.map((q) => q.id); }

    function renderStageBar(prefix) {
        const c = countStages(ids(), s.stages);
        const total = s.questions.length || 1;
        STAGES.forEach((st) => {
            const seg = $(prefix + 'Seg_' + st);
            if (seg) seg.style.width = ((c[st] / total) * 100) + '%';
            const num = $(prefix + 'Count_' + st);
            if (num) num.textContent = String(c[st]);
        });
        const bar = $(prefix + 'Bar');
        if (bar) {
            bar.setAttribute('aria-valuenow', String(Math.round((c.mastered / total) * 100)));
            bar.setAttribute('aria-valuetext', `${c.mastered} of ${s.questions.length} mastered`);
        }
        return c;
    }

    function renderIntro() {
        showScreen('lnIntro');
        const c = renderStageBar('ln');
        const allMastered = c.mastered === s.questions.length;
        $('lnRuleText').textContent = `A question is mastered after ${s.cfg.correctStreakForMastered} correct answers in a row. `
            + 'Misses come back in the same round; correct answers come back in a later one.';
        $('lnWritten').checked = !!s.settings.written;
        $('lnRecall').checked = !!s.settings.recall;
        $('lnSize').value = String(s.settings.size);
        const resumable = !!s.run;
        $('lnResume').hidden = !resumable;
        if (resumable) {
            const left = s.run.queue.length - s.run.index;
            $('lnResume').textContent = `Continue round ${s.run.round} (${left} left)`;
        }
        $('lnStart').textContent = allMastered ? 'Practice mastered questions' : (resumable ? 'Start a new round' : 'Start learning');
        $('lnStart').classList.toggle('btn--primary', !resumable);
        $('lnStart').classList.toggle('btn--secondary', resumable);
        $('lnAllDone').hidden = !allMastered;
        renderTile(c);
    }

    function readSettings() {
        s.settings = {
            written: $('lnWritten').checked,
            recall: $('lnRecall').checked,
            size: Math.max(1, parseInt($('lnSize').value, 10) || 10),
        };
    }

    function startRound(fromIntro) {
        if (fromIntro) readSettings();
        const c = countStages(ids(), s.stages);
        const includeMastered = c.mastered === s.questions.length;
        const queue = buildRound(ids(), s.stages, s.settings.size, includeMastered);
        s.run = {
            v: STATE_VERSION,
            round: (s.run && s.run.round ? s.run.round : 0) + 1,
            queue,
            roundIds: queue.slice(),
            index: 0,
            results: {},
            settings: s.settings,
            practiceMastered: includeMastered,
        };
        saveNow();
        showQuestion();
        announce(`Round ${s.run.round} started. ${queue.length} questions.`);
    }

    // ================= Question =================
    function showQuestion() {
        const run = s.run;
        if (run.index >= run.queue.length) { finishRound(); return; }
        const id = run.queue[run.index];
        const q = s.byId.get(id);
        const stage = stageOf(s.stages, id);
        s.current = { id, format: chooseFormat(q, stage, run.settings), selected: [], typed: '', revealed: false, result: null, busy: false };
        showScreen('lnQuestion');
        renderQuestion();
        const focusTarget = s.current.format === 'written' ? $('lnTyped')
            : s.current.format === 'recall' ? $('lnReveal') : $('lnChoices').querySelector('.choice');
        if (focusTarget) focusTarget.focus();
    }

    function renderQuestion() {
        const run = s.run;
        const cur = s.current;
        const q = s.byId.get(cur.id);
        const stage = stageOf(s.stages, cur.id);
        const max = Math.max(1, q.maxSelections || answerList(q.answer).length || 1);
        const done = Object.values(run.results).filter((r) => r.done).length;

        $('lnPos').textContent = `Round ${run.round} · ${done} of ${run.roundIds.length} learned`;
        const pct = Math.round((done / run.roundIds.length) * 100);
        $('lnFill').style.width = pct + '%';
        $('lnFill').parentElement.setAttribute('aria-valuenow', String(pct));
        $('lnStage').textContent = STAGE_LABEL[stage];
        $('lnStage').dataset.stage = stage;
        $('lnFormat').textContent = cur.format === 'written' ? 'Type the answer'
            : cur.format === 'recall' ? 'Recall, then check yourself'
                : (max > 1 ? `Choose ${max}` : 'Choose 1');
        $('lnText').textContent = q.text || '';

        // Format panes
        $('lnChoicePane').hidden = cur.format !== 'choice';
        $('lnWrittenPane').hidden = cur.format !== 'written';
        $('lnRecallPane').hidden = cur.format !== 'recall';

        if (cur.format === 'choice') renderChoices(q, max);
        if (cur.format === 'written') {
            $('lnTyped').disabled = !!cur.result || cur.busy;
            $('lnCheckWritten').disabled = !!cur.result || cur.busy;
            $('lnDontKnow').disabled = !!cur.result || cur.busy;
            $('lnWrittenActions').hidden = !!cur.result;
        }
        if (cur.format === 'recall') {
            $('lnReveal').hidden = cur.revealed;
            $('lnRecallAnswer').hidden = !cur.revealed;
            $('lnRateRow').hidden = !cur.revealed || !!cur.result;
            if (cur.revealed) renderRecallAnswer(q);
        }
        $('lnCheckChoice').hidden = cur.format !== 'choice' || !!cur.result;
        $('lnCheckChoice').disabled = !cur.selected.length || cur.busy;
        renderFeedback(q);
        $('lnContinue').hidden = !cur.result;
    }

    function renderChoices(q, max) {
        const cur = s.current;
        const box = $('lnChoices');
        box.setAttribute('role', max > 1 ? 'group' : 'radiogroup');
        box.setAttribute('aria-label', max > 1 ? `Choose ${max} answers` : 'Choose one answer');
        box.replaceChildren();
        const chosen = new Set(cur.selected);
        const correctKeys = new Set(cur.result ? cur.result.correctAnswer : []);
        Object.keys(q.choices || {}).forEach((key, i) => {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'choice';
            btn.dataset.key = key;
            btn.setAttribute('role', max > 1 ? 'checkbox' : 'radio');
            btn.setAttribute('aria-checked', chosen.has(key) ? 'true' : 'false');
            if (chosen.has(key)) btn.classList.add('selected');
            if (cur.result) {
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
    }

    function renderRecallAnswer(q) {
        const box = $('lnRecallAnswer');
        box.replaceChildren();
        const label = doc.createElement('p');
        label.className = 'fc-face__label';
        label.textContent = 'Answer';
        box.appendChild(label);
        answerList(q.answer).forEach((k) => {
            const p = doc.createElement('p');
            p.className = 'ln-recall__answer';
            p.textContent = (q.choices || {})[k] || k;
            box.appendChild(p);
            const why = q.answerDescriptions && q.answerDescriptions[k];
            if (why) {
                const w = doc.createElement('p');
                w.className = 'ln-recall__why';
                w.textContent = why;
                box.appendChild(w);
            }
        });
    }

    function stageMessage(r) {
        const need = r.masteredAt;
        if (!r.correct) return 'This one comes back later in this round. Your streak is reset.';
        if (r.stage === 'mastered' && r.previousStage !== 'mastered') return `Mastered: ${need} correct in a row.`;
        if (r.stage === 'mastered') return 'Still mastered.';
        return `${r.streak} of ${need} correct in a row toward mastered. It returns in a later round.`;
    }

    function renderFeedback(q) {
        const cur = s.current;
        const fb = $('lnFeedback');
        if (!cur.result) { fb.hidden = true; fb.replaceChildren(); return; }
        const r = cur.result;
        fb.hidden = false;
        fb.className = 'pt-feedback ' + (r.correct ? 'pt-feedback--correct' : 'pt-feedback--incorrect');
        fb.replaceChildren();
        const head = doc.createElement('p');
        head.className = 'pt-feedback__status';
        head.textContent = r.correct ? '✓ Correct' : '✗ Not quite';
        const msg = doc.createElement('p');
        msg.textContent = stageMessage(r);
        fb.append(head, msg);
        if (cur.format === 'written' && cur.typed && !r.correct) {
            const yours = doc.createElement('p');
            yours.className = 'pt-feedback__answer';
            yours.textContent = 'You typed: ' + cur.typed;
            fb.appendChild(yours);
        }
        if (cur.format !== 'recall') {
            answerList(q.answer).forEach((k) => {
                const p = doc.createElement('p');
                p.className = 'pt-feedback__answer';
                const strong = doc.createElement('strong');
                strong.textContent = (q.choices || {})[k] || k;
                p.appendChild(strong);
                const why = q.answerDescriptions && q.answerDescriptions[k];
                if (why) p.appendChild(doc.createTextNode(' — ' + why));
                fb.appendChild(p);
            });
        }
    }

    function choose(key) {
        const cur = s.current;
        if (!cur || cur.result || cur.busy || cur.format !== 'choice') return;
        const q = s.byId.get(cur.id);
        const max = Math.max(1, q.maxSelections || answerList(q.answer).length || 1);
        if (max === 1) cur.selected = [key];
        else {
            const at = cur.selected.indexOf(key);
            if (at >= 0) cur.selected.splice(at, 1);
            else if (cur.selected.length < max) cur.selected.push(key);
        }
        renderQuestion();
        const again = $('lnChoices').querySelector(`[data-key="${CSS.escape(key)}"]`);
        if (again) again.focus();
    }

    async function submit(body) {
        const cur = s.current;
        if (!cur || cur.result || cur.busy) return;
        cur.busy = true;
        renderQuestion();
        try {
            const res = await fetch(root.quizApiUrl(`/api/learn/${encodeURIComponent(s.setId)}/${encodeURIComponent(cur.id)}/answer`), {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({ format: cur.format, clientAttemptId: L().newClientId('l') }, body)),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
            cur.result = data;
            s.stages[cur.id] = data.stage;
            const run = s.run;
            const rec = run.results[cur.id] || { misses: 0, done: false };
            if (data.correct) {
                rec.done = true;
            } else {
                rec.misses++;
                run.queue = requeue(run.queue, run.index, cur.id, s.cfg.requeueAfterIncorrect);
            }
            run.results[cur.id] = rec;
            scheduleSave();
            announce((data.correct ? 'Correct. ' : 'Not quite. ') + stageMessage(data));
        } catch (e) {
            announce('Could not check that answer. ' + e.message);
            root.alert('Could not check that answer: ' + e.message);
        } finally {
            cur.busy = false;
            renderQuestion();
            if (cur.result) $('lnContinue').focus();
        }
    }

    function checkChoice() { if (s.current && s.current.selected.length) submit({ selected: s.current.selected }); }
    function checkWritten(giveUp) {
        const cur = s.current;
        if (!cur) return;
        cur.typed = giveUp ? '' : $('lnTyped').value;
        if (!giveUp && !normalizeText(cur.typed)) { $('lnTyped').focus(); return; }
        submit({ text: cur.typed });
    }
    function reveal() {
        if (!s.current) return;
        s.current.revealed = true;
        renderQuestion();
        $('lnKnew').focus();
    }
    function rate(knew) { submit({ rating: knew ? 'correct' : 'incorrect' }); }

    function next() {
        if (!s.current || !s.current.result) return;
        s.run.index++;
        scheduleSave();
        if ($('lnTyped')) $('lnTyped').value = '';
        showQuestion();
    }

    // ================= Round / done =================
    function finishRound() {
        const run = s.run;
        const sum = summarizeRound(run.roundIds, run.results);
        const c = countStages(ids(), s.stages);
        s.run = null;
        saveNow();
        if (c.mastered === s.questions.length && !run.practiceMastered) {
            showScreen('lnDone');
            renderStageBar('lnDone');
            $('lnDoneText').textContent = `All ${s.questions.length} questions in "${s.title}" are mastered.`;
            $('lnDoneHeading').focus();
            announce('Every question is mastered.');
            renderTile(c);
            return;
        }
        s.lastRound = run.round;
        showScreen('lnRound');
        renderStageBar('lnRound');
        $('lnRoundTitle').textContent = `Round ${run.round} complete`;
        $('lnRoundFirst').textContent = String(sum.firstTry);
        $('lnRoundRetried').textContent = String(sum.retried);
        $('lnRoundMastered').textContent = String(c.mastered);
        $('lnRoundText').textContent = `${c.mastered} of ${s.questions.length} mastered. `
            + (c.new + c.learning + c.familiar ? `${c.new + c.learning + c.familiar} still to master.` : 'Everything is mastered.');
        $('lnRoundTitle').focus();
        announce(`Round ${run.round} complete.`);
        renderTile(c);
    }

    function nextRound() {
        s.run = { round: s.lastRound || 0 };
        startRound(false);
    }

    // ================= Open / close =================
    async function open() {
        if (typeof root.closeModeViews === 'function') root.closeModeViews('learn');
        s.open = true;
        root.showModeView('learnView');
        if (typeof root.toggleSidebar === 'function') root.toggleSidebar(false);
        root.scrollTo({ top: 0 });
        syncShell();
        const setId = activeSetId();
        if (!setId) {
            s.setId = null;
            $('lnTitle').textContent = 'Learn';
            showState('empty', 'Choose a question set first. Learn uses your active set.',
                { label: 'Go to question library', run: () => { close(); root.navigateToSection && root.navigateToSection('questionSetsSection'); } });
            return;
        }
        showState('loading', 'Loading Learn…');
        try {
            await s.lastSave;
            const [set, progress, config, saved] = await Promise.all([
                L().api.getSet(setId),
                L().api.getProgress(setId),
                L().api.getConfig().catch(() => null),
                L().api.loadSession(setId, MODE).catch(() => null),
            ]);
            if (!s.open) return;
            s.setId = setId;
            s.title = set.title || 'Question set';
            s.questions = (set.questions || []).filter((q) => q && q.id && q.choices);
            s.byId = new Map(s.questions.map((q) => [q.id, q]));
            s.stages = {};
            progress.forEach((p) => { if (p.learn && p.learn.stage) s.stages[p.questionId] = p.learn.stage; });
            if (config && config.learn) s.cfg = Object.assign({}, s.cfg, config.learn);
            s.run = normalizeLearnState(saved, ids());
            if (s.run) s.settings = s.run.settings;
            $('lnTitle').textContent = s.title;
            $('lnMeta').textContent = `${s.questions.length} questions · self-paced, no timer`;
            syncShell();
            if (!s.questions.length) { showState('empty', 'This set has no questions yet.'); return; }
            renderIntro();
        } catch (e) {
            if (!s.open) return;
            showState('error', 'Could not load Learn. ' + e.message, { label: 'Try again', run: open });
        }
    }

    function close() {
        if (!s.open) return;
        if (s.run) saveNow();
        s.open = false;
        s.current = null;
        root.showModeView(null);
        syncShell();
        if (typeof root.setActiveNav === 'function') root.setActiveNav('dashboard');
        refreshTile();
    }

    // -- dashboard tile --
    function renderTile(c) {
        const meta = $('lnTileMeta');
        if (!meta) return;
        if (!c) { meta.textContent = 'Uses your active question set'; return; }
        const total = c.new + c.learning + c.familiar + c.mastered;
        meta.textContent = total ? `${c.mastered} of ${total} mastered` : 'Uses your active question set';
    }
    let tileTicket = 0;
    async function refreshTile() {
        const setId = activeSetId();
        if (!setId) { renderTile(null); return; }
        const ticket = ++tileTicket;
        try {
            const [set, progress] = await Promise.all([L().api.getSet(setId), L().api.getProgress(setId)]);
            if (ticket !== tileTicket) return;
            const stages = {};
            progress.forEach((p) => { if (p.learn && p.learn.stage) stages[p.questionId] = p.learn.stage; });
            renderTile(countStages((set.questions || []).filter((q) => q && q.id).map((q) => q.id), stages));
        } catch (_) { if (ticket === tileTicket) renderTile(null); }
    }

    // -- input --
    function bind() {
        if (!$('learnView')) return;
        $('lnStart').addEventListener('click', () => startRound(true));
        $('lnResume').addEventListener('click', () => { showQuestion(); announce('Round resumed.'); });
        $('lnCheckChoice').addEventListener('click', checkChoice);
        $('lnWrittenPane').addEventListener('submit', (e) => { e.preventDefault(); checkWritten(false); });
        $('lnDontKnow').addEventListener('click', () => checkWritten(true));
        $('lnReveal').addEventListener('click', reveal);
        $('lnKnew').addEventListener('click', () => rate(true));
        $('lnDidnt').addEventListener('click', () => rate(false));
        $('lnContinue').addEventListener('click', next);
        $('lnPause').addEventListener('click', () => { saveNow(); renderIntro(); announce('Paused. Your round is saved.'); });
        $('lnNextRound').addEventListener('click', nextRound);
        $('lnRoundExit').addEventListener('click', close);
        $('lnDoneExit').addEventListener('click', close);
        $('lnExit').addEventListener('click', close);
        doc.querySelectorAll('[data-open-view="learn"]').forEach((el) => {
            el.addEventListener('click', (e) => { e.preventDefault(); open(); });
        });
        doc.addEventListener('keydown', (e) => {
            if (!s.open || !s.current || $('lnQuestion').hidden) return;
            if (e.altKey || e.ctrlKey || e.metaKey) return;
            const tag = (e.target && e.target.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA') return; // the typed-answer form handles Enter
            const cur = s.current;
            if (e.key === 'Enter' && tag !== 'BUTTON') {
                e.preventDefault();
                if (cur.result) next();
                else if (cur.format === 'choice') checkChoice();
                return;
            }
            if (cur.format === 'choice' && !cur.result && /^[a-z]$/i.test(e.key)) {
                const keys = Object.keys(s.byId.get(cur.id).choices || {});
                const at = e.key.toUpperCase().charCodeAt(0) - 65;
                if (at >= 0 && at < keys.length) { e.preventDefault(); choose(keys[at]); }
            }
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
