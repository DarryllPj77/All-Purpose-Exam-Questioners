/* ============================================================
   Practice Test mode.

   Setup → test → results, under exam-like conditions the learner
   configures: question count and types, optional timer, pass mark,
   shuffling, feedback timing and navigation.

   Integrity rules
   * Scoring uses Quizer.learning.isCorrectAnswer (same as every mode);
     unanswered questions are reported separately and score as wrong.
   * The timer only decides WHEN the test ends, never how it is scored.
   * Each test has one attemptId. History and answer-log writes reuse it,
     so a refresh or retry can never record the same test twice.
   * State lives in study_sessions (mode "practice"); a finished test
     reloads into its results instead of running again.

   Top half: pure logic (exported for `node --test`).
   Bottom half: browser controller (window.Quizer.practice).
   ============================================================ */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api.logic;
    if (root) root.Quizer = Object.assign(root.Quizer || {}, { practice: api.controller });
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    const STATE_VERSION = 1;
    const DEFAULTS = {
        defaultQuestionCount: 20, maxQuestionCount: 200, defaultPassPercent: 70,
        defaultMinutes: 30, maxMinutes: 300,
        shuffleQuestionsByDefault: true, shuffleAnswersByDefault: false,
    };

    // ---- Pure logic -----------------------------------------------------------

    function answerList(answer) {
        return Array.isArray(answer) ? answer.map(String) : (answer == null ? [] : [String(answer)]);
    }

    /** 'multiple' when more than one choice is correct or required. */
    function questionType(q) {
        return (answerList(q && q.answer).length > 1 || (q && q.maxSelections > 1)) ? 'multiple' : 'single';
    }

    function countTypes(questions) {
        const c = { single: 0, multiple: 0 };
        questions.forEach((q) => { c[questionType(q)]++; });
        return c;
    }

    function toInt(value) {
        const n = typeof value === 'number' ? value : parseInt(String(value == null ? '' : value).trim(), 10);
        return Number.isFinite(n) ? Math.trunc(n) : NaN;
    }

    /**
     * Checks setup input against the set. Returns { config, errors } where
     * errors maps a field name to a message the form shows under that field.
     */
    function validateConfig(raw, questions, limits) {
        const lim = Object.assign({}, DEFAULTS, limits || {});
        const input = raw || {};
        const errors = {};

        const types = ['single', 'multiple'].filter((t) => Array.isArray(input.types) && input.types.includes(t));
        if (!types.length) errors.types = 'Choose at least one question type.';
        const available = questions.filter((q) => types.includes(questionType(q))).length;

        const count = toInt(input.count);
        const cap = Math.min(available, lim.maxQuestionCount);
        if (!Number.isFinite(count) || count < 1) errors.count = 'Enter a number of questions, 1 or more.';
        else if (types.length && count > cap) errors.count = `Only ${cap} question${cap === 1 ? '' : 's'} match the types you chose.`;

        let timerMinutes = null;
        if (input.timerOn) {
            timerMinutes = toInt(input.timerMinutes);
            if (!Number.isFinite(timerMinutes) || timerMinutes < 1 || timerMinutes > lim.maxMinutes) {
                errors.timerMinutes = `Enter a time limit from 1 to ${lim.maxMinutes} minutes.`;
            }
        }

        const passPercent = toInt(input.passPercent);
        if (!Number.isFinite(passPercent) || passPercent < 1 || passPercent > 100) {
            errors.passPercent = 'Enter a passing score from 1 to 100.';
        }

        const config = {
            count, types, timerMinutes, passPercent,
            shuffleQuestions: input.shuffleQuestions !== false,
            shuffleAnswers: input.shuffleAnswers === true,
            feedback: input.feedback === 'immediate' ? 'immediate' : 'end',
            navigation: input.navigation === 'forward' ? 'forward' : 'free',
        };
        return { config, errors, available };
    }

    function shuffled(list, random) {
        const rng = typeof random === 'function' ? random : Math.random;
        const out = list.slice();
        for (let i = out.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [out[i], out[j]] = [out[j], out[i]];
        }
        return out;
    }

    /** The test: which questions, in which order, with which choice order. */
    function buildTest(questions, config, random) {
        let pool = questions.filter((q) => q && q.id && config.types.includes(questionType(q)));
        if (config.shuffleQuestions) pool = shuffled(pool, random);
        return pool.slice(0, config.count).map((q) => {
            const keys = Object.keys(q.choices || {});
            return { id: q.id, choiceOrder: config.shuffleAnswers ? shuffled(keys, random) : keys };
        });
    }

    /** Choices as shown: labelled A, B, C... by position, keeping original keys. */
    function displayChoices(question, choiceOrder) {
        const choices = (question && question.choices) || {};
        const order = (choiceOrder || []).filter((k) => Object.prototype.hasOwnProperty.call(choices, k));
        return order.map((key, i) => ({ label: String.fromCharCode(65 + i), key, text: String(choices[key]) }));
    }

    function isAnswered(answers, id) {
        return Array.isArray(answers && answers[id]) && answers[id].length > 0;
    }

    /**
     * Scores a finished test. Pass/fail compares exact ratios, so 69.6%
     * never rounds up past a 70% pass mark.
     */
    function scoreTest(items, answers, questionsById, passPercent, isCorrect) {
        const check = typeof isCorrect === 'function' ? isCorrect : defaultIsCorrect;
        const perQuestion = items.map((item) => {
            const q = questionsById.get ? questionsById.get(item.id) : questionsById[item.id];
            if (!isAnswered(answers, item.id)) return { id: item.id, status: 'unanswered' };
            return { id: item.id, status: check(q, answers[item.id]) ? 'correct' : 'incorrect' };
        });
        const total = items.length;
        const correct = perQuestion.filter((r) => r.status === 'correct').length;
        const unanswered = perQuestion.filter((r) => r.status === 'unanswered').length;
        return {
            total,
            correct,
            incorrect: total - correct - unanswered,
            unanswered,
            percent: total ? Math.round((correct / total) * 100) : 0,
            passed: total > 0 && correct * 100 >= passPercent * total,
            perQuestion,
        };
    }

    function defaultIsCorrect(question, selected) {
        const a = answerList(question && question.answer).sort();
        const b = Array.from(new Set(answerList(selected))).sort();
        return a.length > 0 && a.length === b.length && a.every((k, i) => k === b[i]);
    }

    /** Whole seconds left before the deadline (null = no timer). */
    function remainingSeconds(deadlineAt, now) {
        if (deadlineAt == null) return null;
        return Math.max(0, Math.ceil((deadlineAt - now) / 1000));
    }

    /** Elapsed test time in seconds; a timed-out test counts as the full limit. */
    function durationSeconds(startedAt, endedAt, deadlineAt) {
        const end = deadlineAt != null ? Math.min(endedAt, deadlineAt) : endedAt;
        return Math.max(0, Math.round((end - startedAt) / 1000));
    }

    function formatClock(seconds) {
        const s = Math.max(0, seconds | 0);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        const mm = String(m).padStart(h ? 2 : 1, '0');
        return (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
    }

    /**
     * Saved state is only trusted when every question still exists with the
     * same choices; otherwise the test is discarded rather than mis-scored.
     */
    function normalizeRunState(raw, questionsById) {
        if (!raw || typeof raw !== 'object' || raw.v !== STATE_VERSION) return null;
        if (!Array.isArray(raw.items) || !raw.items.length || typeof raw.attemptId !== 'string') return null;
        if (raw.status !== 'running' && raw.status !== 'submitted') return null;
        const has = (id) => (questionsById.get ? questionsById.has(id) : Object.prototype.hasOwnProperty.call(questionsById, id));
        const get = (id) => (questionsById.get ? questionsById.get(id) : questionsById[id]);
        for (const item of raw.items) {
            if (!item || !has(item.id) || !Array.isArray(item.choiceOrder)) return null;
            const keys = Object.keys(get(item.id).choices || {});
            if (item.choiceOrder.length !== keys.length || item.choiceOrder.some((k) => !keys.includes(k))) return null;
        }
        const ids = new Set(raw.items.map((i) => i.id));
        const answers = {};
        Object.entries(raw.answers || {}).forEach(([id, keys]) => {
            if (ids.has(id) && Array.isArray(keys)) answers[id] = keys.map(String);
        });
        const checked = {};
        Object.keys(raw.checked || {}).forEach((id) => { if (ids.has(id)) checked[id] = true; });
        const last = raw.items.length - 1;
        const current = Math.max(0, Math.min(last, toInt(raw.current) || 0));
        return Object.assign({}, raw, {
            answers, checked, current,
            maxReached: Math.max(current, Math.min(last, toInt(raw.maxReached) || 0)),
        });
    }

    /** Selecting a choice: radio for one answer, capped checkboxes for several. */
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

    const logic = {
        questionType, countTypes, validateConfig, buildTest, displayChoices, scoreTest,
        remainingSeconds, durationSeconds, formatClock, normalizeRunState, toggleChoice, isAnswered,
        STATE_VERSION,
    };

    // ---- Browser controller ----------------------------------------------------

    if (!root || typeof root.document === 'undefined') return { logic, controller: null };
    const doc = root.document;
    const L = () => root.Quizer.learning;
    const $ = (id) => doc.getElementById(id);
    const MODE = 'practice';

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
        limits: Object.assign({}, DEFAULTS),
        run: null,           // the saved/active test state
        lastConfig: null,
        timer: null,
        saveTimer: null,
        lastSave: Promise.resolve(),
        submitting: false,
        warned: {},
    };

    // -- persistence --
    function saveNow() {
        if (!s.setId || !s.run) return s.lastSave;
        clearTimeout(s.saveTimer);
        s.saveTimer = null;
        s.lastSave = L().api.saveSession(s.setId, MODE, s.run)
            .catch((e) => console.warn('[practice] could not save the test:', e.message));
        return s.lastSave;
    }
    function scheduleSave() {
        clearTimeout(s.saveTimer);
        s.saveTimer = setTimeout(saveNow, 500);
    }

    // -- view switching --
    function showOnly(view) {
        root.showModeView(view === 'practice' ? 'practiceView' : null);
    }

    function showScreen(name) {
        ['ptSetup', 'ptRun', 'ptResults'].forEach((id) => { $(id).hidden = id !== name; });
        if (name) $('ptState').hidden = true;
        syncShell();
    }

    function showState(kind, message, action) {
        ['ptSetup', 'ptRun', 'ptResults'].forEach((id) => { $(id).hidden = true; });
        const box = $('ptState');
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

    function announce(text) { const live = $('ptLive'); if (live) live.textContent = text; }

    function syncShell() {
        if (typeof root.syncAppBar === 'function') root.syncAppBar();
        if (s.open && typeof root.setActiveNav === 'function') root.setActiveNav('practiceView');
    }

    // ================= Setup =================
    function fillSetup(config) {
        const counts = countTypes(s.questions);
        const lim = s.limits;
        const c = config || {
            count: Math.min(lim.defaultQuestionCount, s.questions.length),
            types: ['single', 'multiple'].filter((t) => counts[t] > 0),
            timerMinutes: null, passPercent: lim.defaultPassPercent,
            shuffleQuestions: lim.shuffleQuestionsByDefault, shuffleAnswers: lim.shuffleAnswersByDefault,
            feedback: 'end', navigation: 'free',
        };
        $('ptCount').value = String(c.count);
        $('ptCount').max = String(Math.min(s.questions.length, lim.maxQuestionCount));
        $('ptTypeSingle').checked = c.types.includes('single');
        $('ptTypeMultiple').checked = c.types.includes('multiple');
        $('ptTypeSingle').disabled = counts.single === 0;
        $('ptTypeMultiple').disabled = counts.multiple === 0;
        $('ptTypeSingleCount').textContent = String(counts.single);
        $('ptTypeMultipleCount').textContent = String(counts.multiple);
        $('ptTimerOn').checked = c.timerMinutes != null;
        $('ptMinutes').value = String(c.timerMinutes || lim.defaultMinutes);
        $('ptMinutes').max = String(lim.maxMinutes);
        $('ptPass').value = String(c.passPercent);
        $('ptShuffleQ').checked = !!c.shuffleQuestions;
        $('ptShuffleA').checked = !!c.shuffleAnswers;
        doc.querySelector(`input[name="ptFeedback"][value="${c.feedback}"]`).checked = true;
        doc.querySelector(`input[name="ptNav"][value="${c.navigation}"]`).checked = true;
        syncSetupState();
        clearErrors();
    }

    function readSetup() {
        return {
            count: $('ptCount').value,
            types: [$('ptTypeSingle').checked && 'single', $('ptTypeMultiple').checked && 'multiple'].filter(Boolean),
            timerOn: $('ptTimerOn').checked,
            timerMinutes: $('ptMinutes').value,
            passPercent: $('ptPass').value,
            shuffleQuestions: $('ptShuffleQ').checked,
            shuffleAnswers: $('ptShuffleA').checked,
            feedback: doc.querySelector('input[name="ptFeedback"]:checked').value,
            navigation: doc.querySelector('input[name="ptNav"]:checked').value,
        };
    }

    function syncSetupState() {
        $('ptMinutes').disabled = !$('ptTimerOn').checked;
        const { available } = validateConfig(readSetup(), s.questions, s.limits);
        $('ptCountHint').textContent = `of ${Math.min(available, s.limits.maxQuestionCount)} available`;
    }

    const ERROR_FIELDS = { count: 'ptCount', types: 'ptTypeSingle', timerMinutes: 'ptMinutes', passPercent: 'ptPass' };
    function clearErrors() {
        Object.entries(ERROR_FIELDS).forEach(([field, inputId]) => {
            const el = $('ptErr_' + field);
            el.hidden = true;
            el.textContent = '';
            $(inputId).removeAttribute('aria-invalid');
        });
    }
    function showErrors(errors) {
        clearErrors();
        let first = null;
        // Visit fields in on-screen order so focus lands on the first problem a reader meets.
        ['count', 'passPercent', 'types', 'timerMinutes'].forEach((field) => {
            const message = errors[field];
            const el = $('ptErr_' + field);
            if (!message || !el) return;
            el.textContent = message;
            el.hidden = false;
            $(ERROR_FIELDS[field]).setAttribute('aria-invalid', 'true');
            if (!first) first = $(ERROR_FIELDS[field]);
        });
        if (first) first.focus();
    }

    function startTest(event) {
        if (event) event.preventDefault();
        const { config, errors } = validateConfig(readSetup(), s.questions, s.limits);
        if (Object.keys(errors).length) { showErrors(errors); announce('Please fix the highlighted fields.'); return; }
        const now = Date.now();
        s.lastConfig = config;
        s.run = {
            v: STATE_VERSION,
            attemptId: L().newClientId('p'),
            setId: s.setId,
            config,
            items: buildTest(s.questions, config, Math.random),
            answers: {},
            checked: {},
            current: 0,
            maxReached: 0,
            startedAt: now,
            deadlineAt: config.timerMinutes ? now + config.timerMinutes * 60 * 1000 : null,
            status: 'running',
            result: null,
        };
        s.warned = {};
        saveNow();
        showScreen('ptRun');
        renderQuestion();
        startClock();
        const first = $('ptChoices').querySelector('.choice');
        if (first) first.focus();
        announce(`Test started. ${s.run.items.length} questions.`);
    }

    // ================= Running =================
    function item() { return s.run.items[s.run.current]; }
    function question(it) { return s.byId.get((it || item()).id); }
    function isLocked(id) { return s.run.config.feedback === 'immediate' && !!s.run.checked[id]; }

    function renderQuestion() {
        const run = s.run;
        const it = item();
        const q = question(it);
        const total = run.items.length;
        const max = Math.max(1, q.maxSelections || answerList(q.answer).length || 1);
        const multi = max > 1;

        $('ptNumber').textContent = `Question ${run.current + 1} of ${total}`;
        $('ptTypeTag').textContent = multi ? `Choose ${max}` : 'Choose 1';
        $('ptText').textContent = q.text || '';
        if (root.Quizer.code) root.Quizer.code.attach($('ptText'), q);

        const box = $('ptChoices');
        box.setAttribute('role', multi ? 'group' : 'radiogroup');
        box.setAttribute('aria-label', multi ? `Choose ${max} answers` : 'Choose one answer');
        box.replaceChildren();
        const selected = new Set(run.answers[it.id] || []);
        const locked = isLocked(it.id);
        const correctKeys = new Set(answerList(q.answer));
        displayChoices(q, it.choiceOrder).forEach((c) => {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'choice';
            btn.dataset.key = c.key;
            btn.setAttribute('role', multi ? 'checkbox' : 'radio');
            const isSel = selected.has(c.key);
            btn.setAttribute('aria-checked', isSel ? 'true' : 'false');
            if (isSel) btn.classList.add('selected');
            if (locked) {
                btn.disabled = true;
                if (correctKeys.has(c.key)) btn.classList.add('choice--correct');
                else if (isSel) btn.classList.add('choice--incorrect');
            }
            const label = doc.createElement('span');
            label.className = 'choice-label';
            label.textContent = c.label;
            const text = doc.createElement('span');
            text.className = 'choice-content';
            text.textContent = c.text;
            btn.append(label, text);
            btn.addEventListener('click', () => choose(c.key));
            box.appendChild(btn);
        });

        renderFeedback();
        renderNav();
        renderProgress();
    }

    function choose(key) {
        const it = item();
        if (isLocked(it.id) || s.run.status !== 'running') return;
        const q = question(it);
        const max = Math.max(1, q.maxSelections || answerList(q.answer).length || 1);
        s.run.answers[it.id] = toggleChoice(s.run.answers[it.id], key, max);
        if (!s.run.answers[it.id].length) delete s.run.answers[it.id];
        renderQuestion();
        const again = $('ptChoices').querySelector(`[data-key="${CSS.escape(key)}"]`);
        if (again) again.focus();
        scheduleSave();
    }

    function renderFeedback() {
        const it = item();
        const box = $('ptFeedback');
        const immediate = s.run.config.feedback === 'immediate';
        const q = question(it);
        const answered = isAnswered(s.run.answers, it.id);
        const locked = isLocked(it.id);
        $('ptCheck').hidden = !immediate || locked;
        $('ptCheck').disabled = !answered;
        if (!locked) { box.hidden = true; box.replaceChildren(); return; }

        const correct = L().isCorrectAnswer(q, s.run.answers[it.id]);
        box.hidden = false;
        box.replaceChildren();
        box.className = 'pt-feedback ' + (correct ? 'pt-feedback--correct' : 'pt-feedback--incorrect');
        const head = doc.createElement('p');
        head.className = 'pt-feedback__status';
        head.textContent = correct ? '✓ Correct' : '✗ Not quite';
        box.appendChild(head);
        const labelOf = {};
        displayChoices(q, it.choiceOrder).forEach((c) => { labelOf[c.key] = c.label; });
        answerList(q.answer).forEach((key) => {
            const p = doc.createElement('p');
            p.className = 'pt-feedback__answer';
            const strong = doc.createElement('strong');
            strong.textContent = `${labelOf[key] || key}. ${(q.choices || {})[key] || ''}`;
            p.appendChild(strong);
            const why = q.answerDescriptions && q.answerDescriptions[key];
            if (why) p.appendChild(doc.createTextNode(' — ' + why));
            box.appendChild(p);
        });
    }

    function checkAnswer() {
        const it = item();
        if (!isAnswered(s.run.answers, it.id)) return;
        s.run.checked[it.id] = true;
        renderQuestion();
        const correct = L().isCorrectAnswer(question(it), s.run.answers[it.id]);
        announce(correct ? 'Correct.' : 'Not quite. The correct answer is shown.');
        $('ptNext').hidden ? $('ptSubmitInline').focus() : $('ptNext').focus();
        scheduleSave();
    }

    function canGoTo(index) {
        const run = s.run;
        if (index < 0 || index >= run.items.length || index === run.current) return false;
        if (run.config.navigation === 'forward') return index === run.current + 1;
        return true;
    }

    function goTo(index) {
        if (!canGoTo(index)) return;
        s.run.current = index;
        s.run.maxReached = Math.max(s.run.maxReached, index);
        renderQuestion();
        const first = $('ptChoices').querySelector('.choice');
        if (first) first.focus();
        announce(`Question ${index + 1} of ${s.run.items.length}`);
        scheduleSave();
    }

    function renderNav() {
        const run = s.run;
        const last = run.current === run.items.length - 1;
        const forward = run.config.navigation === 'forward';
        $('ptPrev').hidden = forward;
        $('ptPrev').disabled = run.current === 0;
        $('ptNext').hidden = last;
        $('ptSubmitInline').hidden = !last;

        const nav = $('ptNav');
        nav.replaceChildren();
        run.items.forEach((it, i) => {
            const b = doc.createElement('button');
            b.type = 'button';
            const answered = isAnswered(run.answers, it.id);
            const current = i === run.current;
            b.className = 'qn-btn' + (answered ? ' qn-btn--answered' : '') + (current ? ' qn-btn--current' : '');
            b.textContent = String(i + 1);
            b.setAttribute('aria-label', `Question ${i + 1}, ${answered ? 'answered' : 'not answered'}${current ? ', current' : ''}`);
            if (current) b.setAttribute('aria-current', 'step');
            if (forward) b.disabled = !current;
            else b.addEventListener('click', () => goTo(i));
            nav.appendChild(b);
        });
        $('ptNavNote').hidden = !forward;
    }

    function renderProgress() {
        const run = s.run;
        const answered = run.items.filter((it) => isAnswered(run.answers, it.id)).length;
        const total = run.items.length;
        $('ptPanelCount').textContent = `${run.current + 1} / ${total}`;
        $('ptSummary').textContent = answered === total
            ? `All ${total} questions answered`
            : `${answered} of ${total} answered · ${total - answered} left`;
        const pct = Math.round(((run.current + 1) / total) * 100);
        $('ptProgressFill').style.width = pct + '%';
        $('ptProgressFill').parentElement.setAttribute('aria-valuenow', String(pct));
        $('ptProgressText').textContent = `Question ${run.current + 1} of ${total}`;
    }

    // -- timer: decides when the test ends, never how it is scored --
    function startClock() {
        stopClock();
        const pill = $('ptTimer');
        if (s.run.deadlineAt == null) { pill.hidden = true; return; }
        pill.hidden = false;
        tick();
        s.timer = setInterval(tick, 1000);
    }
    function stopClock() { clearInterval(s.timer); s.timer = null; }
    function tick() {
        if (!s.run || s.run.status !== 'running') { stopClock(); return; }
        const left = remainingSeconds(s.run.deadlineAt, Date.now());
        $('ptClock').textContent = formatClock(left);
        const pill = $('ptTimer');
        pill.classList.toggle('is-warning', left <= 300 && left > 60);
        pill.classList.toggle('is-danger', left <= 60);
        if (left <= 300 && left > 60 && !s.warned.five) { s.warned.five = true; announce('5 minutes left.'); }
        if (left <= 60 && !s.warned.one) { s.warned.one = true; announce('1 minute left.'); }
        if (left === 0) submit('timeout');
    }

    function requestSubmit() {
        const run = s.run;
        const left = run.items.filter((it) => !isAnswered(run.answers, it.id)).length;
        const msg = left
            ? `Submit your test? ${left} question${left === 1 ? ' is' : 's are'} unanswered and will be marked unanswered.`
            : 'Submit your test? You cannot change answers afterwards.';
        if (root.confirm(msg)) submit('submitted');
    }

    // ================= Submit =================
    async function submit(reason) {
        const run = s.run;
        if (!run || run.status !== 'running' || s.submitting) return;
        s.submitting = true;
        stopClock();
        const endedAt = Date.now();
        const score = scoreTest(run.items, run.answers, s.byId, run.config.passPercent, L().isCorrectAnswer);
        run.status = 'submitted';
        run.result = Object.assign({}, score, {
            reason,
            finishedAt: endedAt,
            durationSeconds: durationSeconds(run.startedAt, endedAt, run.deadlineAt),
            saved: false,
        });
        // Persist the submitted state first: a refresh now shows results
        // instead of running (or scoring) the test again.
        await saveNow();
        showResults();
        announce(reason === 'timeout' ? 'Time is up. Your test was submitted.' : 'Test submitted.');
        await recordResult();
        s.submitting = false;
    }

    function reviewSnapshot(run) {
        return {
            questions: run.items.map((it) => {
                const q = s.byId.get(it.id);
                return {
                    text: q.text,
                    choices: q.choices,
                    answer: answerList(q.answer),
                    userAnswer: run.answers[it.id] || [],
                    answerDescriptions: q.answerDescriptions || {},
                };
            }),
        };
    }

    async function recordResult() {
        const run = s.run;
        if (!run || !run.result || run.result.saved) return;
        const r = run.result;
        $('ptSaveStatus').hidden = true;
        try {
            const res = await fetch(root.quizApiUrl('/api/history'), {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: 'Practice', setId: run.setId, score: r.percent, correct: r.correct, total: r.total,
                    review: reviewSnapshot(run),
                    config: Object.assign({}, run.config, { reason: r.reason }),
                    durationSeconds: r.durationSeconds,
                    clientAttemptId: run.attemptId,
                }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);

            // One answer-log row per question, idempotent by attempt id.
            await L().api.recordAttempts(run.setId, run.items.map((it, i) => {
                const pq = r.perQuestion[i];
                return {
                    questionId: it.id, mode: MODE,
                    outcome: pq.status === 'unanswered' ? 'skipped' : pq.status,
                    response: { selected: run.answers[it.id] || [] },
                    clientAttemptId: `${run.attemptId}_${i}`,
                };
            }));

            if (!data.duplicate) {
                try {
                    // eslint-disable-next-line no-undef
                    if (typeof QSetStore !== 'undefined') QSetStore.updateStats(run.setId, r.percent);
                } catch (_) { /* stats are best-effort */ }
            }
            run.result.saved = true;
            run.result.historyId = data.entry && data.entry.id;
            await saveNow();
            if (typeof root.bootstrapSessionHistory === 'function') {
                root.bootstrapSessionHistory().then(() => {
                    if (typeof root.renderSessionHistory === 'function') root.renderSessionHistory();
                }).catch(() => {});
            }
        } catch (e) {
            console.warn('[practice] could not save the result:', e.message);
            $('ptSaveStatus').hidden = false;
        }
    }

    // ================= Results =================
    let reviewFilter = 'all';

    function showResults() {
        const run = s.run;
        const r = run.result;
        showScreen('ptResults');
        const hero = $('ptHero');
        hero.dataset.tone = r.passed ? 'passed' : 'review';
        $('ptVerdict').textContent = r.passed ? 'Passed' : 'Not passed yet';
        $('ptVerdictText').textContent = `You answered ${r.correct} of ${r.total} correctly. The pass mark was ${run.config.passPercent}%.`
            + (r.reason === 'timeout' ? ' Time ran out, so the test was submitted automatically.' : '');
        $('ptRing').style.setProperty('--score-angle', (r.percent * 3.6) + 'deg');
        $('ptRingValue').textContent = r.percent + '%';
        $('ptStatTotal').textContent = String(r.total);
        $('ptStatCorrect').textContent = String(r.correct);
        $('ptStatIncorrect').textContent = String(r.incorrect);
        $('ptStatUnanswered').textContent = String(r.unanswered);
        $('ptStatTime').textContent = formatClock(r.durationSeconds);
        $('ptStatTimeNote').textContent = run.config.timerMinutes ? `of ${run.config.timerMinutes}:00 allowed` : 'No time limit';
        $('ptSaveStatus').hidden = r.saved !== false || s.submitting;
        reviewFilter = 'all';
        renderReview();
        const heading = $('ptVerdict');
        if (heading) heading.focus({ preventScroll: false });
    }

    function renderReview() {
        const run = s.run;
        const r = run.result;
        const counts = { all: r.total, incorrect: r.incorrect, unanswered: r.unanswered, correct: r.correct };
        doc.querySelectorAll('[data-pt-filter]').forEach((b) => {
            const f = b.dataset.ptFilter;
            b.querySelector('span').textContent = String(counts[f]);
            b.classList.toggle('review-filter--active', f === reviewFilter);
            b.setAttribute('aria-pressed', f === reviewFilter ? 'true' : 'false');
        });
        const list = $('ptReview');
        list.replaceChildren();
        run.items.forEach((it, i) => {
            const status = r.perQuestion[i].status;
            if (reviewFilter !== 'all' && status !== reviewFilter) return;
            const q = s.byId.get(it.id);
            const choices = displayChoices(q, it.choiceOrder);
            const labelOf = {};
            choices.forEach((c) => { labelOf[c.key] = c.label; });
            const fmt = (keys) => keys.length
                ? keys.map((k) => `${labelOf[k] || k} — ${(q.choices || {})[k]}`).join('; ')
                : 'No answer';

            const art = doc.createElement('article');
            art.className = 'review-item ' + (status === 'correct' ? 'correct' : 'incorrect');
            const head = doc.createElement('header');
            head.className = 'review-item__header';
            const num = doc.createElement('span');
            num.className = 'review-item__number';
            num.textContent = `Question ${i + 1}`;
            const badge = doc.createElement('span');
            badge.className = 'review-status ' + (status === 'correct' ? 'correct' : 'incorrect');
            badge.textContent = status === 'correct' ? '✓ Correct' : status === 'unanswered' ? '○ Unanswered' : '✗ Incorrect';
            head.append(num, badge);
            const text = doc.createElement('p');
            text.className = 'review-question';
            text.textContent = q.text;
            const grid = doc.createElement('div');
            grid.className = 'review-answer-grid';
            const panel = (label, value, cls) => {
                const d = doc.createElement('div');
                d.className = 'review-answer-panel ' + cls;
                const l = doc.createElement('span'); l.className = 'answer-label'; l.textContent = label;
                const v = doc.createElement('span'); v.className = 'answer-value'; v.textContent = value;
                d.append(l, v);
                return d;
            };
            grid.append(
                panel('Your answer', fmt(run.answers[it.id] || []),
                    status === 'correct' ? 'review-answer-panel--correct' : 'review-answer-panel--submitted'),
                panel('Correct answer', fmt(answerList(q.answer)), 'review-answer-panel--expected'),
            );
            art.append(head, text, grid);
            const why = answerList(q.answer).map((k) => q.answerDescriptions && q.answerDescriptions[k]).filter(Boolean);
            if (why.length) {
                const p = doc.createElement('p');
                p.className = 'pt-why';
                p.textContent = why.join(' ');
                art.appendChild(p);
            }
            list.appendChild(art);
        });
        if (!list.children.length) {
            const empty = doc.createElement('div');
            empty.className = 'ui-state ui-state--empty';
            empty.textContent = 'No questions in this group.';
            list.appendChild(empty);
        }
    }

    async function newTest(sameSettings) {
        const config = sameSettings && s.run ? s.run.config : s.lastConfig;
        if (s.setId) await L().api.clearSession(s.setId, MODE).catch(() => {});
        s.run = null;
        if (sameSettings && config) {
            fillSetup(config);
            startTest();
        } else {
            fillSetup(config);
            showScreen('ptSetup');
            $('ptCount').focus();
        }
    }

    // ================= Open / close =================
    async function open() {
        if (typeof root.closeModeViews === 'function') root.closeModeViews('practice');
        s.open = true;
        showOnly('practice');
        if (typeof root.toggleSidebar === 'function') root.toggleSidebar(false);
        root.scrollTo({ top: 0 });
        syncShell();
        const setId = activeSetId();
        if (!setId) {
            s.setId = null;
            $('ptTitle').textContent = 'Practice test';
            showState('empty', 'Choose a question set first. Practice tests use your active set.',
                { label: 'Go to question library', run: () => { close(); root.navigateToSection && root.navigateToSection('questionSetsSection'); } });
            return;
        }
        showState('loading', 'Loading your practice test…');
        try {
            await s.lastSave;
            const [set, config, saved] = await Promise.all([
                L().api.getSet(setId),
                L().api.getConfig().catch(() => null),
                L().api.loadSession(setId, MODE).catch(() => null),
            ]);
            if (!s.open) return;
            s.setId = setId;
            s.title = set.title || 'Question set';
            s.questions = (set.questions || []).filter((q) => q && q.id && q.choices);
            s.byId = new Map(s.questions.map((q) => [q.id, q]));
            if (config && config.practice) s.limits = Object.assign({}, DEFAULTS, config.practice);
            $('ptTitle').textContent = s.title;
            $('ptMeta').textContent = `${s.questions.length} questions in this set`;
            syncShell();
            if (!s.questions.length) { showState('empty', 'This set has no questions yet.'); return; }

            s.run = normalizeRunState(saved, s.byId);
            if (saved && !s.run) {
                // The set changed under a saved test; never score a mismatched test.
                await L().api.clearSession(setId, MODE).catch(() => {});
                announce('Your previous test no longer matches this set, so it was cleared.');
            }
            if (s.run && s.run.status === 'running') {
                s.lastConfig = s.run.config;
                if (s.run.deadlineAt != null && remainingSeconds(s.run.deadlineAt, Date.now()) === 0) {
                    await submit('timeout'); // ran out while away: submit what was saved
                    return;
                }
                showScreen('ptRun');
                renderQuestion();
                startClock();
                announce(`Test resumed at question ${s.run.current + 1}.`);
            } else if (s.run && s.run.status === 'submitted') {
                s.lastConfig = s.run.config;
                showResults();
                if (!s.run.result.saved) recordResult(); // retry a save that failed earlier
            } else {
                fillSetup(s.lastConfig);
                showScreen('ptSetup');
            }
        } catch (e) {
            if (!s.open) return;
            showState('error', 'Could not load the practice test. ' + e.message, { label: 'Try again', run: open });
        }
    }

    function close() {
        if (!s.open) return;
        stopClock();
        if (s.run && s.run.status === 'running') saveNow();
        s.open = false;
        showOnly('dashboard');
        syncShell();
        if (typeof root.setActiveNav === 'function') root.setActiveNav('dashboard');
        refreshTile();
    }

    // -- dashboard tile --
    let tileTicket = 0;
    async function refreshTile() {
        const meta = $('ptTileMeta');
        if (!meta) return;
        const setId = activeSetId();
        if (!setId) { meta.textContent = 'Uses your active question set'; return; }
        const ticket = ++tileTicket;
        try {
            const saved = await L().api.loadSession(setId, MODE);
            if (ticket !== tileTicket) return;
            if (saved && saved.status === 'running' && Array.isArray(saved.items)) {
                const answered = saved.items.filter((it) => isAnswered(saved.answers, it.id)).length;
                meta.textContent = `Test in progress · ${answered} of ${saved.items.length} answered`;
            } else {
                meta.textContent = 'Timed or untimed, with a pass mark';
            }
        } catch (_) {
            if (ticket === tileTicket) meta.textContent = 'Uses your active question set';
        }
    }

    // -- input --
    function bind() {
        if (!$('practiceView')) return;
        $('ptSetup').addEventListener('submit', startTest);
        ['ptTimerOn', 'ptTypeSingle', 'ptTypeMultiple'].forEach((id) => $(id).addEventListener('change', syncSetupState));
        $('ptPrev').addEventListener('click', () => goTo(s.run.current - 1));
        $('ptNext').addEventListener('click', () => goTo(s.run.current + 1));
        $('ptCheck').addEventListener('click', checkAnswer);
        $('ptSubmitInline').addEventListener('click', requestSubmit);
        $('ptSubmitPanel').addEventListener('click', requestSubmit);
        $('ptExitRun').addEventListener('click', close);
        $('ptExit').addEventListener('click', close);
        $('ptRetake').addEventListener('click', () => newTest(true));
        $('ptNewTest').addEventListener('click', () => newTest(false));
        $('ptDone').addEventListener('click', close);
        $('ptRetrySave').addEventListener('click', recordResult);
        doc.querySelectorAll('[data-pt-filter]').forEach((b) => b.addEventListener('click', () => {
            reviewFilter = b.dataset.ptFilter;
            renderReview();
        }));
        doc.querySelectorAll('[data-open-view="practice"]').forEach((el) => {
            el.addEventListener('click', (e) => { e.preventDefault(); open(); });
        });
        doc.addEventListener('keydown', (e) => {
            if (!s.open || !s.run || s.run.status !== 'running' || $('ptRun').hidden) return;
            if (e.altKey || e.ctrlKey || e.metaKey) return;
            const tag = (e.target && e.target.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            if (e.key === 'ArrowRight') { e.preventDefault(); goTo(s.run.current + 1); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(s.run.current - 1); }
            else if (/^[a-z]$/i.test(e.key) && e.key.length === 1) {
                // Letter keys pick the choice with that label (A, B, C...).
                const it = item();
                const match = displayChoices(question(it), it.choiceOrder).find((c) => c.label === e.key.toUpperCase());
                if (match) { e.preventDefault(); choose(match.key); }
            }
        });
        root.addEventListener('pagehide', () => { if (s.open && s.run && s.run.status === 'running') saveNow(); });

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
