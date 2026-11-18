/* ============================================================
   Code Challenge mode.

   Uses questions from the active set that carry a `code` snippet or a
   `challenge` kind (see js/core/code.js). Seven kinds: predict the output,
   find the syntax error, find the bug, complete the code, explain the code,
   identify the concept, multiple choice.

   * Nothing is executed. Answers are graded on the server against the
     stored answer (POST /api/code/...): choices must match exactly; typed
     output is compared after normalising line endings and trailing spaces.
   * Each answer is logged with mode "code", so misses reach Mistake Review.
   * The session (queue, position, results) is saved after every answer
     (study_sessions "code") and can be continued later.

   Top half: pure logic (exported for `node --test`).
   Bottom half: browser controller (window.Quizer.codeChallenge).
   ============================================================ */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api.logic;
    if (root) root.Quizer = Object.assign(root.Quizer || {}, { codeChallenge: api.controller });
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    const C = (root && root.Quizer && root.Quizer.code)
        || (typeof require === 'function' ? require('../core/code.js') : null);
    const KINDS = Object.keys(C.CHALLENGES);

    // ---- Pure logic ------------------------------------------------------------

    function answerList(a) { return Array.isArray(a) ? a.map(String) : (a == null ? [] : [String(a)]); }

    /** Questions this mode can use: code or a challenge kind, plus gradable choices. */
    function codeQuestions(questions) {
        return (questions || []).filter((q) => q && q.id && C.isCodeQuestion(q)
            && q.choices && typeof q.choices === 'object' && answerList(q.answer).length > 0);
    }

    function countByKind(questions) {
        const out = {};
        KINDS.forEach((k) => { out[k] = 0; });
        questions.forEach((q) => { out[C.challengeOf(q)]++; });
        return out;
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

    /** Question ids for a session. count 0 = all. Keeps set order unless shuffled. */
    function buildQueue(questions, opts, random) {
        const kinds = new Set(opts && opts.kinds && opts.kinds.length ? opts.kinds : KINDS);
        let pool = questions.filter((q) => kinds.has(C.challengeOf(q)));
        if (opts && opts.shuffle) pool = shuffled(pool, random);
        const n = opts && opts.count > 0 ? opts.count : pool.length;
        return pool.slice(0, n).map((q) => q.id);
    }

    /** Is a saved session still usable with this set? */
    function restorable(saved, byId) {
        if (!saved || saved.v !== 1 || !Array.isArray(saved.queue) || !saved.queue.length) return false;
        if (!Array.isArray(saved.results) || typeof saved.index !== 'number') return false;
        if (saved.index < 0 || saved.index >= saved.queue.length) return false;
        return saved.queue.every((id) => byId.has(id));
    }

    function summarize(results) {
        const byKind = {};
        let correct = 0;
        results.forEach((r) => {
            const k = byKind[r.kind] || (byKind[r.kind] = { kind: r.kind, label: C.challengeLabel(r.kind), correct: 0, total: 0 });
            k.total++;
            if (r.outcome === 'correct') { k.correct++; correct++; }
        });
        const total = results.length;
        return {
            total, correct, incorrect: total - correct,
            percent: total ? Math.round((correct / total) * 100) : 0,
            byKind: KINDS.filter((k) => byKind[k]).map((k) => byKind[k]),
            missed: results.filter((r) => r.outcome !== 'correct').map((r) => r.id),
        };
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

    // A small C# starter set so the mode can be tried without writing questions.
    const lines = (...l) => l.join('\n');
    const SAMPLE_SET = {
        title: 'C# code challenges (sample)',
        questions: [
            {
                challenge: 'output', language: 'csharp',
                text: 'What does this program print?',
                code: lines('int total = 0;', 'for (int i = 1; i <= 4; i++)', '{', '    if (i % 2 == 0) continue;', '    total += i;', '}', 'Console.WriteLine(total);'),
                choices: { A: '4', B: '6', C: '10', D: '9' },
                answer: ['A'],
                answerDescriptions: { A: 'continue skips the even values 2 and 4, so only 1 + 3 is added: 4.' },
            },
            {
                challenge: 'output', language: 'csharp',
                text: 'What does this program print?',
                code: lines('string[] names = { "Ana", "Ben", "Cy" };', 'foreach (var name in names)', '{', '    Console.WriteLine($"{name}:{name.Length}");', '}'),
                choices: { A: 'Ana:3\nBen:3\nCy:2', B: 'Ana:3 Ben:3 Cy:2', C: 'Ana:2\nBen:2\nCy:1', D: 'It does not compile.' },
                answer: ['A'],
                answerDescriptions: { A: 'WriteLine ends each name on its own line, and Length counts characters: 3, 3 and 2.' },
            },
            {
                challenge: 'output', language: 'csharp',
                text: 'What does this program print?',
                code: lines('int x = 7;', 'int y = x++ + ++x;', 'Console.WriteLine($"{x} {y}");'),
                choices: { A: '9 16', B: '8 15', C: '9 15', D: '8 16' },
                answer: ['A'],
                answerDescriptions: { A: 'x++ gives 7 then makes x 8; ++x makes x 9 and gives 9. So y = 7 + 9 = 16 and x ends at 9.' },
            },
            {
                challenge: 'syntax', language: 'csharp',
                text: 'Where is the syntax error?',
                code: lines('public class Counter', '{', '    private int count = 0', '    public void Increment() => count++;', '}'),
                choices: {
                    A: 'Line 3: the field declaration is missing its semicolon.',
                    B: 'Line 4: => cannot be used to define a method.',
                    C: 'Line 1: a class with fields must be static.',
                    D: 'Line 4: count++ must be wrapped in parentheses.',
                },
                answer: ['A'],
                answerDescriptions: { A: 'Every field declaration ends with ;. Expression-bodied methods (=>) are valid C#.' },
            },
            {
                challenge: 'bug', language: 'csharp',
                text: 'This method should add up every value in the array. What is the bug?',
                code: lines('static int Sum(int[] values)', '{', '    int sum = 0;', '    for (int i = 0; i <= values.Length; i++)', '    {', '        sum += values[i];', '    }', '    return sum;', '}'),
                choices: {
                    A: 'The loop condition should be i < values.Length; <= reads past the end and throws IndexOutOfRangeException.',
                    B: 'sum must be declared as long, otherwise the method does not compile.',
                    C: 'The loop should start at i = 1 because arrays start at index 1.',
                    D: 'There is no bug; the method returns the correct total.',
                },
                answer: ['A'],
                answerDescriptions: { A: 'Valid indexes run from 0 to Length - 1, so the last pass with i == Length is out of range.' },
            },
            {
                challenge: 'complete', language: 'csharp',
                text: 'Which LINQ method fills the blank so that evens holds only the even numbers?',
                code: lines('List<int> numbers = new() { 1, 2, 3, 4, 5, 6 };', 'List<int> evens = numbers.____(n => n % 2 == 0).ToList();'),
                choices: { A: 'Where', B: 'Select', C: 'Any', D: 'OrderBy' },
                answer: ['A'],
                answerDescriptions: { A: 'Where keeps the items for which the condition is true. Select would map each item to true or false instead.' },
            },
            {
                challenge: 'explain', language: 'csharp',
                text: 'Which explanation of this code is correct?',
                code: lines('string? name = null;', 'int length = name?.Length ?? 0;', 'Console.WriteLine(length);'),
                choices: {
                    A: '?. gives null instead of throwing because name is null, and ?? replaces that null with 0, so it prints 0.',
                    B: 'It throws a NullReferenceException because name is null.',
                    C: 'It prints an empty line because the length of null is empty.',
                    D: 'It does not compile because an int can never be assigned from a nullable expression.',
                },
                answer: ['A'],
                answerDescriptions: { A: 'The null-conditional operator stops at null and the null-coalescing operator supplies the fallback value.' },
            },
            {
                challenge: 'concept', language: 'csharp',
                text: 'Which programming concept does this code demonstrate?',
                code: lines('public interface IShape { double Area(); }', '', 'public class Circle : IShape', '{', '    public double Radius { get; init; }', '    public double Area() => Math.PI * Radius * Radius;', '}', '', 'public class Square : IShape', '{', '    public double Side { get; init; }', '    public double Area() => Side * Side;', '}', '', 'IShape shape = new Circle { Radius = 1 };', 'Console.WriteLine(shape.Area());'),
                choices: { A: 'Polymorphism through an interface', B: 'Recursion', C: 'Operator overloading', D: 'Generic type constraints' },
                answer: ['A'],
                answerDescriptions: { A: 'Different classes implement the same interface, and code calls Area() through the IShape type without knowing the concrete class.' },
            },
            {
                challenge: 'choice', language: 'csharp',
                text: 'Which two variables hold value types? (Choose exactly two.)',
                code: lines('int a = 5;', 'string b = "hi";', 'DateTime c = DateTime.Now;', 'int[] d = { 1, 2 };'),
                choices: { A: 'a', B: 'b', C: 'c', D: 'd' },
                answer: ['A', 'C'],
                responseType: 'multiple-select',
                maxSelections: 2,
                answerDescriptions: {
                    A: 'int is a struct (System.Int32), so it is a value type.',
                    C: 'DateTime is a struct, so it is a value type. string and arrays are reference types.',
                },
            },
        ],
    };

    const logic = { codeQuestions, countByKind, buildQueue, restorable, summarize, toggleChoice, SAMPLE_SET };

    // ---- Browser controller ----------------------------------------------------

    if (!root || typeof root.document === 'undefined') return { logic, controller: null };
    const doc = root.document;
    const L = () => root.Quizer.learning;
    const $ = (id) => doc.getElementById(id);
    const MODE = 'code';

    function activeSetId() {
        // eslint-disable-next-line no-undef
        return (typeof QSetStore !== 'undefined' && QSetStore) ? QSetStore.getActiveId() : null;
    }

    const s = {
        open: false, setId: null, title: '', questions: [], byId: new Map(),
        settings: { kinds: KINDS.slice(), count: 10, shuffle: true, typeOutput: true },
        saved: null,
        run: null, // { queue, index, results, selected, typed, result, busy }
        lastSummary: null,
    };

    function announce(t) { const el = $('ccLive'); if (el) el.textContent = t; }
    function syncShell() {
        if (typeof root.syncAppBar === 'function') root.syncAppBar();
        if (s.open && typeof root.setActiveNav === 'function') root.setActiveNav('codeView');
    }
    function showScreen(name) {
        ['ccIntro', 'ccSession', 'ccDone'].forEach((id) => { $(id).hidden = id !== name; });
        $('ccState').hidden = true;
    }
    function showState(kind, message, actions) {
        ['ccIntro', 'ccSession', 'ccDone'].forEach((id) => { $(id).hidden = true; });
        const box = $('ccState');
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
        (actions || []).forEach((a) => {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn--' + (a.primary ? 'primary' : 'secondary') + ' btn--sm';
            btn.textContent = a.label;
            btn.addEventListener('click', a.run);
            box.appendChild(btn);
        });
    }

    // ================= Intro =================
    function renderIntro() {
        showScreen('ccIntro');
        const counts = countByKind(s.questions);
        const box = $('ccKinds');
        box.replaceChildren();
        KINDS.forEach((k) => {
            const label = doc.createElement('label');
            label.className = 'pt-check';
            const input = doc.createElement('input');
            input.type = 'checkbox';
            input.value = k;
            input.checked = s.settings.kinds.includes(k) && counts[k] > 0;
            input.disabled = counts[k] === 0;
            input.addEventListener('change', updateStartState);
            const name = doc.createElement('span');
            name.textContent = C.challengeLabel(k);
            const n = doc.createElement('span');
            n.className = 'pt-count';
            n.textContent = String(counts[k]);
            label.append(input, ' ', name, n);
            box.appendChild(label);
        });
        $('ccSummary').textContent = `${s.questions.length} code question${s.questions.length === 1 ? '' : 's'} in this set. Nothing is run: you read the code and answer.`;
        $('ccCount').value = String(s.settings.count);
        $('ccShuffle').checked = !!s.settings.shuffle;
        $('ccTypeOutput').checked = !!s.settings.typeOutput;
        const canResume = restorable(s.saved, s.byId);
        $('ccResume').hidden = !canResume;
        if (canResume) $('ccResume').textContent = `Continue (question ${s.saved.index + 1} of ${s.saved.queue.length})`;
        updateStartState();
    }

    function readSettings() {
        return {
            kinds: [...$('ccKinds').querySelectorAll('input:checked')].map((i) => i.value),
            count: parseInt($('ccCount').value, 10) || 0,
            shuffle: $('ccShuffle').checked,
            typeOutput: $('ccTypeOutput').checked,
        };
    }

    function updateStartState() {
        const set = readSettings();
        const n = buildQueue(s.questions, set).length;
        $('ccStart').disabled = n === 0;
        $('ccStart').textContent = n ? `Start ${n} question${n === 1 ? '' : 's'}` : 'Choose at least one kind';
    }

    function startWith(queue) {
        s.run = { queue, index: 0, results: [], selected: [], typed: '', result: null, busy: false };
        s.saved = null;
        showScreen('ccSession');
        renderQuestion();
        save();
        focusAnswer();
        announce(`Session started. ${queue.length} question${queue.length === 1 ? '' : 's'}.`);
    }

    function start() {
        s.settings = readSettings();
        const queue = buildQueue(s.questions, s.settings, Math.random);
        if (!queue.length) return;
        startWith(queue);
    }

    function resume() {
        const sv = s.saved;
        if (!restorable(sv, s.byId)) { renderIntro(); return; }
        if (sv.settings) s.settings = Object.assign({}, s.settings, sv.settings);
        s.run = { queue: sv.queue, index: sv.index, results: sv.results.slice(), selected: [], typed: '', result: null, busy: false };
        s.saved = null;
        showScreen('ccSession');
        renderQuestion();
        focusAnswer();
        announce(`Continuing at question ${s.run.index + 1}.`);
    }

    function save() {
        const r = s.run;
        if (!r || !s.setId) return Promise.resolve();
        // Store the position of the next unanswered question.
        const index = r.result ? r.index + 1 : r.index;
        if (index >= r.queue.length) return L().api.clearSession(s.setId, MODE).catch(() => {});
        return L().api.saveSession(s.setId, MODE, {
            v: 1, settings: s.settings, queue: r.queue, index, results: r.results,
        }).catch((e) => console.warn('[code] could not save progress:', e.message));
    }

    // ================= Question =================
    function current() { return s.byId.get(s.run.queue[s.run.index]); }
    function typingMode(q) { return s.settings.typeOutput && C.expectedOutput(q) !== null; }

    function renderQuestion() {
        const r = s.run;
        const q = current();
        const kind = C.challengeOf(q);
        const typing = typingMode(q);
        const max = Math.max(1, q.maxSelections || answerList(q.answer).length || 1);

        $('ccPos').textContent = `Question ${r.index + 1} of ${r.queue.length}`;
        const pct = Math.round(((r.index + (r.result ? 1 : 0)) / r.queue.length) * 100);
        $('ccFill').style.width = pct + '%';
        $('ccFill').parentElement.setAttribute('aria-valuenow', String(pct));
        $('ccKind').textContent = C.challengeLabel(kind);
        $('ccLang').textContent = q.code ? C.languageLabel(q.language) : '';
        $('ccLang').hidden = !q.code;
        $('ccText').textContent = q.text || '';
        C.attach($('ccText'), q);

        $('ccChoicePane').hidden = typing;
        $('ccOutputPane').hidden = !typing;
        if (typing) {
            const ta = $('ccOutput');
            if (ta.value !== r.typed) ta.value = r.typed;
            ta.readOnly = !!r.result;
            $('ccCheck').disabled = !r.typed.trim() || r.busy;
        } else {
            const box = $('ccChoices');
            box.setAttribute('role', max > 1 ? 'group' : 'radiogroup');
            box.setAttribute('aria-label', max > 1 ? `Choose ${max} answers` : 'Choose one answer');
            box.replaceChildren();
            const chosen = new Set(r.selected);
            const right = new Set(r.result ? r.result.correctAnswer : []);
            Object.keys(q.choices).forEach((key, i) => {
                const btn = doc.createElement('button');
                btn.type = 'button';
                btn.className = 'choice';
                btn.dataset.key = key;
                btn.setAttribute('role', max > 1 ? 'checkbox' : 'radio');
                btn.setAttribute('aria-checked', chosen.has(key) ? 'true' : 'false');
                if (chosen.has(key)) btn.classList.add('selected');
                if (r.result) {
                    btn.disabled = true;
                    if (right.has(key)) btn.classList.add('choice--correct');
                    else if (chosen.has(key)) btn.classList.add('choice--incorrect');
                }
                const label = doc.createElement('span');
                label.className = 'choice-label';
                label.textContent = String.fromCharCode(65 + i);
                const text = doc.createElement('span');
                text.className = 'choice-content';
                const value = String(q.choices[key]);
                if (value.includes('\n') || kind === 'output') text.classList.add('choice-content--code');
                text.textContent = value;
                btn.append(label, text);
                btn.addEventListener('click', () => choose(key, max));
                box.appendChild(btn);
            });
            $('ccCheck').disabled = !r.selected.length || r.busy;
        }
        $('ccCheck').hidden = !!r.result;
        renderFeedback(q, typing);
        $('ccNext').hidden = !r.result;
        $('ccNext').textContent = r.index === r.queue.length - 1 ? 'See results' : 'Next question';
    }

    function outputBox(title, text) {
        const wrap = doc.createElement('div');
        wrap.className = 'cc-output';
        const h = doc.createElement('p');
        h.className = 'cc-output__label';
        h.textContent = title;
        const pre = doc.createElement('pre');
        pre.className = 'cc-output__pre';
        pre.tabIndex = 0;
        pre.textContent = text;
        wrap.append(h, pre);
        return wrap;
    }

    function renderFeedback(q, typing) {
        const r = s.run;
        const fb = $('ccFeedback');
        if (!r.result) { fb.hidden = true; fb.replaceChildren(); return; }
        const res = r.result;
        fb.hidden = false;
        fb.className = 'pt-feedback pt-feedback--' + res.outcome;
        fb.replaceChildren();
        const head = doc.createElement('p');
        head.className = 'pt-feedback__status';
        head.textContent = res.outcome === 'correct' ? '✓ Correct' : '✗ Incorrect';
        fb.appendChild(head);
        if (typing) {
            if (res.outcome !== 'correct') fb.appendChild(outputBox('Your output', r.typed));
            fb.appendChild(outputBox('Expected output', res.expectedOutput || ''));
            const hint = doc.createElement('p');
            hint.className = 'pt-hint';
            hint.textContent = 'Spaces at the ends of lines and blank lines at the start or end are ignored. Everything else, including capital letters, must match.';
            fb.appendChild(hint);
        }
        res.correctAnswer.forEach((k) => {
            const why = q.answerDescriptions && q.answerDescriptions[k];
            if (typing && !why) return;
            const p = doc.createElement('div');
            p.className = 'pt-feedback__answer';
            const value = String(q.choices[k] != null ? q.choices[k] : k);
            if (value.includes('\n')) {
                p.appendChild(outputBox(typing ? 'Why' : 'Correct answer', value));
            } else {
                const strong = doc.createElement('strong');
                strong.textContent = value;
                p.appendChild(strong);
            }
            if (why) p.appendChild(doc.createTextNode((value.includes('\n') ? '' : ' — ') + why));
            fb.appendChild(p);
        });
    }

    function choose(key, max) {
        const r = s.run;
        if (!r || r.result || r.busy) return;
        r.selected = toggleChoice(r.selected, key, max);
        renderQuestion();
        const again = $('ccChoices').querySelector(`[data-key="${CSS.escape(key)}"]`);
        if (again) again.focus();
    }

    function focusAnswer() {
        const q = current();
        if (typingMode(q)) $('ccOutput').focus();
        else {
            const first = $('ccChoices').querySelector('button');
            if (first) first.focus();
        }
    }

    async function check() {
        const r = s.run;
        if (!r || r.result || r.busy) return;
        const q = current();
        const typing = typingMode(q);
        if (typing ? !r.typed.trim() : !r.selected.length) return;
        r.busy = true;
        renderQuestion();
        const body = typing ? { format: 'output', text: r.typed } : { format: 'choice', selected: r.selected };
        body.clientAttemptId = L().newClientId('c');
        try {
            const res = await fetch(root.quizApiUrl(`/api/code/${encodeURIComponent(s.setId)}/${encodeURIComponent(q.id)}/answer`), {
                method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
            r.result = data;
            r.results.push({ id: q.id, kind: C.challengeOf(q), outcome: data.outcome });
            announce(data.outcome === 'correct' ? 'Correct.' : 'Incorrect. The correct answer is shown.');
            save();
        } catch (e) {
            announce('Could not check that answer. ' + e.message);
            root.alert('Could not check that answer: ' + e.message);
        } finally {
            r.busy = false;
            renderQuestion();
            if (r.result) $('ccNext').focus();
        }
    }

    function next() {
        const r = s.run;
        if (!r || !r.result) return;
        if (r.index >= r.queue.length - 1) { finish(); return; }
        r.index++;
        r.selected = [];
        r.typed = '';
        r.result = null;
        renderQuestion();
        root.scrollTo({ top: 0 });
        focusAnswer();
    }

    async function stop() {
        // Progress is already saved after each answer.
        const r = s.run;
        if (r) {
            await save();
            if (r.results.length < r.queue.length) {
                s.saved = { v: 1, settings: s.settings, queue: r.queue, index: r.result ? r.index + 1 : r.index, results: r.results };
                if (s.saved.index >= r.queue.length) s.saved = null;
            }
        }
        s.run = null;
        renderIntro();
        announce('Session paused. You can continue later.');
    }

    function finish() {
        const r = s.run;
        const sum = summarize(r.results);
        s.lastSummary = sum;
        s.run = null;
        s.saved = null;
        L().api.clearSession(s.setId, MODE).catch(() => {});
        showScreen('ccDone');
        $('ccDoneScore').textContent = sum.percent + '%';
        $('ccDoneCorrect').textContent = String(sum.correct);
        $('ccDoneIncorrect').textContent = String(sum.incorrect);
        $('ccDoneText').textContent = sum.incorrect
            ? `${sum.correct} of ${sum.total} correct. Missed questions are in Mistake review too.`
            : `All ${sum.total} correct.`;
        const list = $('ccDoneByKind');
        list.replaceChildren();
        sum.byKind.forEach((k) => {
            const li = doc.createElement('li');
            const name = doc.createElement('span');
            name.textContent = k.label;
            const val = doc.createElement('strong');
            val.textContent = `${k.correct} / ${k.total}`;
            li.append(name, val);
            list.appendChild(li);
        });
        $('ccRetry').hidden = !sum.missed.length;
        $('ccRetry').textContent = `Retry ${sum.missed.length} missed`;
        $('ccDoneHeading').focus();
        announce(`Session complete. ${sum.correct} of ${sum.total} correct.`);
    }

    // ================= Open / close =================
    async function addSample() {
        // eslint-disable-next-line no-undef
        if (typeof QSetStore === 'undefined' || typeof root.normalizeImportedQuestion !== 'function') return;
        showState('loading', 'Adding the C# sample set…');
        try {
            const questions = SAMPLE_SET.questions.map((q, i) => root.normalizeImportedQuestion(Object.assign({ number: i + 1 }, q), i));
            // eslint-disable-next-line no-undef
            const record = QSetStore.save({ title: SAMPLE_SET.title, source: { type: 'sample' }, questions });
            if (typeof root.renderQuestionSets === 'function') root.renderQuestionSets();
            const ok = typeof root.activateQuestionSet === 'function' ? await root.activateQuestionSet(record.id) : false;
            if (!ok) throw new Error('The sample set was saved but could not be made active. Choose it in the question library.');
            await open();
        } catch (e) {
            showState('error', e.message, [{ label: 'Try again', run: addSample }]);
        }
    }

    async function open() {
        if (typeof root.closeModeViews === 'function') root.closeModeViews('codeChallenge');
        s.open = true;
        root.showModeView('codeView');
        if (typeof root.toggleSidebar === 'function') root.toggleSidebar(false);
        root.scrollTo({ top: 0 });
        syncShell();
        const sampleAction = { label: 'Add a C# sample set', run: addSample, primary: true };
        const setId = activeSetId();
        if (!setId) {
            s.setId = null;
            $('ccTitle').textContent = 'Code challenge';
            showState('empty', 'Choose a question set first, or try the built-in C# sample set.', [
                sampleAction,
                { label: 'Go to question library', run: () => { close(); root.navigateToSection && root.navigateToSection('questionSetsSection'); } },
            ]);
            return;
        }
        showState('loading', 'Loading code challenges…');
        try {
            const [set, saved] = await Promise.all([
                L().api.getSet(setId),
                L().api.loadSession(setId, MODE).catch(() => null),
            ]);
            if (!s.open) return;
            s.setId = setId;
            s.title = set.title || 'Question set';
            s.questions = codeQuestions(set.questions || []);
            s.byId = new Map(s.questions.map((q) => [q.id, q]));
            s.saved = saved || null;
            if (saved && saved.settings) s.settings = Object.assign({}, s.settings, saved.settings);
            $('ccTitle').textContent = s.title;
            syncShell();
            if (!s.questions.length) {
                showState('empty', 'This set has no code questions. Add questions with a code field (see "Code challenge" in the import prompt types), or try the built-in C# sample set.', [sampleAction]);
                return;
            }
            renderIntro();
        } catch (e) {
            if (!s.open) return;
            showState('error', 'Could not load Code challenge. ' + e.message, [{ label: 'Try again', run: open }]);
        }
    }

    function close() {
        if (!s.open) return;
        s.open = false;
        s.run = null;
        root.showModeView(null);
        syncShell();
        if (typeof root.setActiveNav === 'function') root.setActiveNav('dashboard');
    }

    // -- input --
    function bind() {
        if (!$('codeView')) return;
        $('ccStart').addEventListener('click', start);
        $('ccResume').addEventListener('click', resume);
        ['ccCount', 'ccShuffle', 'ccTypeOutput'].forEach((id) => $(id).addEventListener('change', updateStartState));
        $('ccCheck').addEventListener('click', check);
        $('ccNext').addEventListener('click', next);
        $('ccStop').addEventListener('click', stop);
        $('ccOutput').addEventListener('input', (e) => {
            if (!s.run || s.run.result) return;
            s.run.typed = e.target.value;
            $('ccCheck').disabled = !s.run.typed.trim() || s.run.busy;
        });
        $('ccOutput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); check(); }
        });
        $('ccRetry').addEventListener('click', () => { if (s.lastSummary && s.lastSummary.missed.length) startWith(s.lastSummary.missed.slice()); });
        $('ccAgain').addEventListener('click', renderIntro);
        $('ccDoneExit').addEventListener('click', close);
        $('ccExit').addEventListener('click', close);
        doc.querySelectorAll('[data-open-view="code"]').forEach((el) => {
            el.addEventListener('click', (e) => { e.preventDefault(); open(); });
        });
        doc.addEventListener('keydown', (e) => {
            if (!s.open || !s.run || $('ccSession').hidden) return;
            if (e.altKey || e.ctrlKey || e.metaKey) return;
            const tag = (e.target && e.target.tagName) || '';
            if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
            const r = s.run;
            // Enter checks and continues. On a choice it checks too (Space
            // still toggles that choice); on other buttons it clicks them.
            const onChoice = tag === 'BUTTON' && e.target.classList.contains('choice') && !r.result && r.selected.length;
            if (e.key === 'Enter' && (tag !== 'BUTTON' || onChoice)) {
                e.preventDefault();
                if (r.result) next(); else check();
                return;
            }
            const q = current();
            if (!r.result && !typingMode(q) && /^[a-z]$/i.test(e.key)) {
                const keys = Object.keys(q.choices);
                const at = e.key.toUpperCase().charCodeAt(0) - 65;
                if (at >= 0 && at < keys.length) {
                    e.preventDefault();
                    choose(keys[at], Math.max(1, q.maxSelections || answerList(q.answer).length));
                }
            }
        });
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind);
    else bind();

    const controller = { open, close, isOpen: () => s.open, title: () => s.title };
    return { logic, controller };
});
