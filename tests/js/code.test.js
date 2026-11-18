// Run with: node --test tests/js
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../js/core/code.js');
const M = require('../../js/modes/code.js');

const kinds = (tokens, type) => tokens.filter((t) => t.type === type).map((t) => t.text);

test('languages: aliases resolve and unknown names fall back to plain text', () => {
    assert.equal(C.languageOf('C#'), 'csharp');
    assert.equal(C.languageOf('py'), 'python');
    assert.equal(C.languageOf('c++'), 'cpp');
    assert.equal(C.languageOf('brainfudge'), 'text');
    assert.equal(C.languageLabel('cs'), 'C#');
    assert.equal(C.languageLabel(undefined), 'Code');
});

test('C# tokens: keywords, strings (incl. verbatim and interpolated), comments, numbers', () => {
    const src = [
        'int x = 42; // answer',
        'string p = @"C:\\temp""s";',
        'var s = $"{x}";',
        '/* block */ return x;',
    ].join('\n');
    const t = C.tokenize(src, 'csharp');
    assert.deepEqual(kinds(t, 'keyword'), ['int', 'string', 'var', 'return']);
    assert.deepEqual(kinds(t, 'string'), ['@"C:\\temp""s"', '$"{x}"']);
    assert.deepEqual(kinds(t, 'comment'), ['// answer', '/* block */']);
    assert.deepEqual(kinds(t, 'number'), ['42']);
    // Nothing is lost: joining the tokens gives back the source.
    assert.equal(t.map((x) => x.text).join(''), src);
});

test('identifiers containing digits are not numbers, and keyword lookalikes stay plain', () => {
    const t = C.tokenize('int value2 = intValue + 3.5f;', 'csharp');
    assert.deepEqual(kinds(t, 'number'), ['3.5f']);
    assert.deepEqual(kinds(t, 'keyword'), ['int']);
});

test('Python and SQL rules', () => {
    const py = C.tokenize('def f():\n    return """doc""" # note', 'python');
    assert.deepEqual(kinds(py, 'keyword'), ['def', 'return']);
    assert.deepEqual(kinds(py, 'string'), ['"""doc"""']);
    assert.deepEqual(kinds(py, 'comment'), ['# note']);
    const sql = C.tokenize("SELECT name FROM users WHERE id = 'x' -- one", 'sql');
    assert.deepEqual(kinds(sql, 'keyword'), ['SELECT', 'FROM', 'WHERE']);
    assert.deepEqual(kinds(sql, 'comment'), ['-- one']);
});

test('an unterminated string stops at the end of its line', () => {
    const t = C.tokenize('string s = "oops;\nint y = 1;', 'csharp');
    assert.deepEqual(kinds(t, 'string'), ['"oops;']);
    assert.ok(kinds(t, 'keyword').includes('int'));
});

test('toLines splits multi-line tokens for line numbers', () => {
    const lines = C.toLines(C.tokenize('/* a\nb */\nx', 'csharp'));
    assert.equal(lines.length, 3);
    assert.deepEqual(lines[1], [{ type: 'comment', text: 'b */' }]);
});

test('normalizeOutput ignores line endings, trailing spaces and edge blank lines only', () => {
    assert.equal(C.normalizeOutput('\r\nAna:3  \r\nBen:3\r\n\r\n'), 'Ana:3\nBen:3');
    assert.notEqual(C.normalizeOutput('ana:3'), C.normalizeOutput('Ana:3'));
    assert.notEqual(C.normalizeOutput('a\n\nb'), C.normalizeOutput('a\nb'));
});

test('expectedOutput: explicit field, else the single correct choice, only for output challenges', () => {
    const q = { challenge: 'output', choices: { A: '4', B: '6' }, answer: ['A'] };
    assert.equal(C.expectedOutput(q), '4');
    assert.equal(C.expectedOutput(Object.assign({}, q, { expectedOutput: '4\n' })), '4\n');
    assert.equal(C.expectedOutput(Object.assign({}, q, { challenge: 'bug' })), null);
    assert.equal(C.expectedOutput({ challenge: 'output', choices: { A: '1', B: '2' }, answer: ['A', 'B'] }), null);
});

test('codeQuestions keeps questions with code or a challenge kind; unknown kinds become "choice"', () => {
    const qs = [
        { id: 'q_1', text: 'a', code: 'x', choices: { A: '1', B: '2' }, answer: ['A'] },
        { id: 'q_2', text: 'b', challenge: 'concept', choices: { A: '1', B: '2' }, answer: ['B'] },
        { id: 'q_3', text: 'c', choices: { A: '1', B: '2' }, answer: ['A'] },
        { id: 'q_4', text: 'd', code: '   ', choices: { A: '1', B: '2' }, answer: ['A'] },
        { id: 'q_5', text: 'e', code: 'y', challenge: 'nonsense', choices: { A: '1', B: '2' }, answer: ['A'] },
    ];
    const got = M.codeQuestions(qs);
    assert.deepEqual(got.map((q) => q.id), ['q_1', 'q_2', 'q_5']);
    assert.equal(C.challengeOf(qs[4]), 'choice');
    assert.equal(M.countByKind(got).choice, 2);
});

test('buildQueue filters by kind, keeps set order unless shuffled, and limits the count', () => {
    const qs = M.codeQuestions(M.SAMPLE_SET.questions.map((q, i) => Object.assign({ id: 'q_' + i }, q)));
    assert.equal(qs.length, 9);
    assert.deepEqual(M.buildQueue(qs, { kinds: ['output'], count: 0 }), ['q_0', 'q_1', 'q_2']);
    assert.deepEqual(M.buildQueue(qs, { kinds: ['output'], count: 2 }), ['q_0', 'q_1']);
    assert.equal(M.buildQueue(qs, { kinds: [], count: 0 }).length, 9); // none ticked = all kinds
    const shuffled = M.buildQueue(qs, { count: 0, shuffle: true }, () => 0);
    assert.equal(new Set(shuffled).size, 9);
});

test('every sample question is well formed and its stated answer exists', () => {
    M.SAMPLE_SET.questions.forEach((q) => {
        assert.ok(C.CHALLENGES[q.challenge], q.text);
        q.answer.forEach((k) => assert.ok(q.choices[k], q.text));
        q.answer.forEach((k) => assert.ok(q.answerDescriptions[k], q.text));
        assert.equal(C.languageOf(q.language), 'csharp');
    });
});

test('restorable rejects stale or changed sessions', () => {
    const byId = new Map([['q_1', {}], ['q_2', {}]]);
    assert.equal(M.restorable({ v: 1, queue: ['q_1', 'q_2'], index: 1, results: [] }, byId), true);
    assert.equal(M.restorable({ v: 1, queue: ['q_1', 'q_9'], index: 0, results: [] }, byId), false);
    assert.equal(M.restorable({ v: 1, queue: ['q_1'], index: 1, results: [] }, byId), false);
    assert.equal(M.restorable(null, byId), false);
});

test('summarize counts per kind and lists misses', () => {
    const sum = M.summarize([
        { id: 'a', kind: 'output', outcome: 'correct' },
        { id: 'b', kind: 'output', outcome: 'incorrect' },
        { id: 'c', kind: 'bug', outcome: 'correct' },
    ]);
    assert.equal(sum.percent, 67);
    assert.deepEqual(sum.missed, ['b']);
    assert.deepEqual(sum.byKind.map((k) => [k.kind, k.correct, k.total]), [['output', 1, 2], ['bug', 1, 1]]);
});
