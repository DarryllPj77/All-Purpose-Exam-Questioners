/* ============================================================
   Code display: shared by every mode that shows a question.

   A question may carry optional fields:
     code            the snippet (shown, never run)
     language        csharp, java, javascript, python, c, cpp, sql, text
     challenge       output, syntax, bug, complete, explain, concept, choice
     expectedOutput  for "output" challenges answered by typing

   The highlighter is a small tokenizer (no library). Tokens become DOM
   text nodes inside <span>s, so code is never parsed as HTML. Adding a
   language means adding one entry to LANGS.

   Top half: pure logic (exported for `node --test`).
   Bottom half: browser helpers (window.Quizer.code).
   ============================================================ */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api.logic;
    if (root) root.Quizer = Object.assign(root.Quizer || {}, { code: Object.assign({}, api.logic, api.browser) });
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    const CHALLENGES = {
        output: 'Predict the output',
        syntax: 'Find the syntax error',
        bug: 'Find the bug',
        complete: 'Complete the code',
        explain: 'Explain the code',
        concept: 'Identify the concept',
        choice: 'Multiple choice',
    };

    const words = (s) => new Set(s.split(/\s+/).filter(Boolean));
    const C_FAMILY = { line: ['//'], block: ['/*', '*/'] };
    const LANGS = {
        csharp: Object.assign({
            label: 'C#',
            strings: ['@"', '$"', '"', "'"],
            keywords: words(`abstract as base bool break byte case catch char checked class const continue decimal default
                delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in
                int interface internal is lock long namespace new null object operator out override params private protected
                public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try
                typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await record get set init
                yield nameof when where dynamic`),
            preprocessor: true,
        }, C_FAMILY),
        java: Object.assign({
            label: 'Java',
            strings: ['"', "'"],
            keywords: words(`abstract assert boolean break byte case catch char class const continue default do double else
                enum extends final finally float for goto if implements import instanceof int interface long native new
                package private protected public return short static strictfp super switch synchronized this throw throws
                transient try void volatile while var record true false null`),
        }, C_FAMILY),
        javascript: Object.assign({
            label: 'JavaScript',
            strings: ['`', '"', "'"],
            keywords: words(`async await break case catch class const continue debugger default delete do else export extends
                false finally for function if import in instanceof let new null of return static super switch this throw true
                try typeof undefined var void while with yield`),
        }, C_FAMILY),
        c: Object.assign({
            label: 'C',
            strings: ['"', "'"],
            keywords: words(`auto break case char const continue default do double else enum extern float for goto if inline
                int long register restrict return short signed sizeof static struct switch typedef union unsigned void
                volatile while NULL true false bool`),
            preprocessor: true,
        }, C_FAMILY),
        cpp: Object.assign({
            label: 'C++',
            strings: ['"', "'"],
            keywords: words(`auto bool break case catch char class const constexpr continue default delete do double else enum
                explicit extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator
                private protected public return short signed sizeof static struct switch template this throw true try typedef
                typename union unsigned using virtual void volatile while std cout cin endl string vector`),
            preprocessor: true,
        }, C_FAMILY),
        python: {
            label: 'Python',
            line: ['#'],
            block: null,
            strings: ['"""', "'''", 'f"', "f'", '"', "'"],
            keywords: words(`and as assert async await break class continue def del elif else except False finally for from
                global if import in is lambda None nonlocal not or pass raise return True try while with yield print len
                range self`),
        },
        sql: {
            label: 'SQL',
            line: ['--'],
            block: ['/*', '*/'],
            strings: ["'"],
            caseInsensitive: true,
            keywords: words(`select from where and or not insert into values update set delete create table alter drop index
                view join inner left right outer full on group by order having limit offset as distinct union all null is
                in between like exists case when then else end primary key foreign references default count sum avg min max
                asc desc int integer varchar text boolean date true false`),
        },
        text: { label: 'Code', line: [], block: null, strings: [], keywords: new Set() },
    };

    const ALIASES = {
        'c#': 'csharp', cs: 'csharp', csharp: 'csharp', dotnet: 'csharp',
        java: 'java',
        js: 'javascript', javascript: 'javascript', ts: 'javascript', typescript: 'javascript', node: 'javascript',
        py: 'python', python: 'python', python3: 'python',
        c: 'c', h: 'c',
        'c++': 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp',
        sql: 'sql', postgres: 'sql', postgresql: 'sql', mysql: 'sql', tsql: 'sql',
        text: 'text', plain: 'text', plaintext: 'text', '': 'text',
    };

    /** Canonical language id; unknown names fall back to plain text. */
    function languageOf(name) {
        const key = String(name == null ? '' : name).trim().toLowerCase();
        return ALIASES[key] || 'text';
    }
    function languageLabel(name) { return LANGS[languageOf(name)].label; }

    function challengeOf(q) {
        return q && Object.prototype.hasOwnProperty.call(CHALLENGES, q.challenge) ? q.challenge : 'choice';
    }
    function challengeLabel(kind) { return CHALLENGES[kind] || CHALLENGES.choice; }

    /** A question belongs in Code Challenge when it has code or a challenge kind. */
    function isCodeQuestion(q) {
        return !!q && ((typeof q.code === 'string' && q.code.trim() !== '')
            || Object.prototype.hasOwnProperty.call(CHALLENGES, q.challenge));
    }

    function answerList(a) { return Array.isArray(a) ? a.map(String) : (a == null ? [] : [String(a)]); }

    /** Output to type for an "output" challenge, or null. Mirrors code_routes.expected_output. */
    function expectedOutput(q) {
        if (challengeOf(q) !== 'output') return null;
        if (typeof q.expectedOutput === 'string' && q.expectedOutput.trim()) return q.expectedOutput;
        const keys = answerList(q.answer);
        if (keys.length === 1) {
            const t = q.choices && q.choices[keys[0]];
            if (typeof t === 'string' && t.trim()) return t;
        }
        return null;
    }

    /** Mirrors code_routes.normalize_output: line endings, trailing spaces, edge blank lines. */
    function normalizeOutput(text) {
        const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
        while (lines.length && !lines[0]) lines.shift();
        while (lines.length && !lines[lines.length - 1]) lines.pop();
        return lines.join('\n');
    }

    // ---- Tokenizer -----------------------------------------------------------

    const IDENT_START = /[A-Za-z_$]/;
    const IDENT = /[A-Za-z0-9_$]/;
    const NUMBER = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?)[fFdDmMlLuU]*/;

    function readString(src, i, delim) {
        // Returns the index just past the string.
        const verbatim = delim === '@"';
        const triple = delim.length === 3;
        const close = triple ? delim : delim[delim.length - 1];
        let j = i + delim.length;
        while (j < src.length) {
            if (triple) {
                if (src.startsWith(close, j)) return j + 3;
                if (src[j] === '\\') { j += 2; continue; }
                j++;
                continue;
            }
            const ch = src[j];
            if (verbatim) {
                if (ch === '"') { if (src[j + 1] === '"') { j += 2; continue; } return j + 1; }
                j++;
                continue;
            }
            if (ch === '\\') { j += 2; continue; }
            if (ch === close) return j + 1;
            if (ch === '\n' && close !== '`') return j; // unterminated: stop at the line end
            j++;
        }
        return src.length;
    }

    /** Split code into [{ type, text }]; types: keyword, string, comment, number, meta, plain. */
    function tokenize(code, language) {
        const src = String(code == null ? '' : code).replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
        const lang = LANGS[languageOf(language)];
        const out = [];
        const push = (type, text) => {
            if (!text) return;
            const last = out[out.length - 1];
            if (last && last.type === type && type === 'plain') last.text += text;
            else out.push({ type, text });
        };
        let i = 0;
        let lineStart = true;
        while (i < src.length) {
            const ch = src[i];
            if (ch === '\n') { push('plain', ch); i++; lineStart = true; continue; }
            if (lineStart && (ch === ' ')) { push('plain', ch); i++; continue; }
            if (lineStart && lang.preprocessor && ch === '#') {
                const end = src.indexOf('\n', i);
                const stop = end < 0 ? src.length : end;
                push('meta', src.slice(i, stop));
                i = stop;
                continue;
            }
            lineStart = false;
            const line = lang.line && lang.line.find((m) => src.startsWith(m, i));
            if (line) {
                const end = src.indexOf('\n', i);
                const stop = end < 0 ? src.length : end;
                push('comment', src.slice(i, stop));
                i = stop;
                continue;
            }
            if (lang.block && src.startsWith(lang.block[0], i)) {
                const end = src.indexOf(lang.block[1], i + lang.block[0].length);
                const stop = end < 0 ? src.length : end + lang.block[1].length;
                push('comment', src.slice(i, stop));
                i = stop;
                continue;
            }
            const delim = lang.strings.find((d) => src.startsWith(d, i));
            if (delim && !(delim.length > 1 && /[A-Za-z0-9_]/.test(delim[0]) && i > 0 && IDENT.test(src[i - 1]))) {
                const stop = readString(src, i, delim);
                push('string', src.slice(i, stop));
                i = stop;
                continue;
            }
            if (/[0-9]/.test(ch) && !(i > 0 && IDENT.test(src[i - 1]))) {
                const m = NUMBER.exec(src.slice(i, i + 64));
                if (m) { push('number', m[0]); i += m[0].length; continue; }
            }
            if (IDENT_START.test(ch)) {
                let j = i + 1;
                while (j < src.length && IDENT.test(src[j])) j++;
                const word = src.slice(i, j);
                const isKw = lang.keywords.has(lang.caseInsensitive ? word.toLowerCase() : word);
                push(isKw ? 'keyword' : 'plain', word);
                i = j;
                continue;
            }
            push('plain', ch);
            i++;
        }
        return out;
    }

    /** Tokens grouped per line (tokens spanning lines are split), for line numbers. */
    function toLines(tokens) {
        const lines = [[]];
        tokens.forEach((t) => {
            const parts = t.text.split('\n');
            parts.forEach((p, k) => {
                if (k > 0) lines.push([]);
                if (p) lines[lines.length - 1].push({ type: t.type, text: p });
            });
        });
        return lines;
    }

    const logic = {
        CHALLENGES, LANGUAGES: Object.keys(LANGS),
        languageOf, languageLabel, challengeOf, challengeLabel, isCodeQuestion,
        expectedOutput, normalizeOutput, tokenize, toLines,
    };

    // ---- Browser helpers -------------------------------------------------------

    if (!root || typeof root.document === 'undefined') return { logic, browser: {} };
    const doc = root.document;

    function copyText(text) {
        if (root.navigator && root.navigator.clipboard && root.isSecureContext) {
            return root.navigator.clipboard.writeText(text);
        }
        // Plain-HTTP pages (LAN testing) have no clipboard API: use a hidden textarea.
        return new Promise((resolve, reject) => {
            const ta = doc.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            doc.body.appendChild(ta);
            ta.select();
            let ok = false;
            try { ok = doc.execCommand('copy'); } catch (_) { ok = false; }
            ta.remove();
            if (ok) resolve(); else reject(new Error('Copy is not available in this browser.'));
        });
    }

    /** A <figure> with a header (language, copy) and a numbered, highlighted code block. */
    function renderBlock(code, language) {
        const source = String(code == null ? '' : code).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
        const lines = toLines(tokenize(source, language));
        const fig = doc.createElement('figure');
        fig.className = 'code-block';

        const head = doc.createElement('figcaption');
        head.className = 'code-block__head';
        const lang = doc.createElement('span');
        lang.className = 'code-block__lang';
        lang.textContent = languageLabel(language);
        const copy = doc.createElement('button');
        copy.type = 'button';
        copy.className = 'code-block__copy';
        copy.textContent = 'Copy';
        copy.setAttribute('aria-label', `Copy ${languageLabel(language)} code`);
        const status = doc.createElement('span');
        status.className = 'sr-only';
        status.setAttribute('aria-live', 'polite');
        let reset = null;
        copy.addEventListener('click', (e) => {
            e.stopPropagation(); // flashcards flip on click
            copyText(source).then(() => {
                copy.textContent = 'Copied';
                status.textContent = 'Code copied.';
            }).catch((err) => {
                copy.textContent = 'Copy failed';
                status.textContent = err.message;
            }).finally(() => {
                clearTimeout(reset);
                reset = setTimeout(() => { copy.textContent = 'Copy'; status.textContent = ''; }, 1800);
            });
        });
        head.append(lang, copy, status);

        const pre = doc.createElement('pre');
        pre.className = 'code-block__pre';
        pre.tabIndex = 0; // scrollable region must be reachable by keyboard
        pre.setAttribute('aria-label', `${languageLabel(language)} code, ${lines.length} line${lines.length === 1 ? '' : 's'}`);
        const codeEl = doc.createElement('code');
        lines.forEach((line) => {
            const row = doc.createElement('span');
            row.className = 'code-line';
            line.forEach((t) => {
                if (t.type === 'plain') { row.appendChild(doc.createTextNode(t.text)); return; }
                const span = doc.createElement('span');
                span.className = 'tok-' + t.type;
                span.textContent = t.text;
                row.appendChild(span);
            });
            row.appendChild(doc.createTextNode('\n'));
            codeEl.appendChild(row);
        });
        pre.appendChild(codeEl);
        fig.append(head, pre);
        return fig;
    }

    /**
     * Show a question's code block right after its text element (or remove a
     * stale one). Safe to call on every render.
     */
    function attach(textEl, question) {
        if (!textEl || !textEl.parentNode) return null;
        const key = textEl.id || '';
        let next = textEl.nextElementSibling;
        if (next && next.classList.contains('code-block') && next.dataset.codeFor === key) next.remove();
        const code = question && typeof question.code === 'string' ? question.code : '';
        if (!code.trim()) return null;
        const block = renderBlock(code, question.language);
        block.dataset.codeFor = key;
        textEl.insertAdjacentElement('afterend', block);
        return block;
    }

    return { logic, browser: { renderBlock, attach, copyText } };
});
