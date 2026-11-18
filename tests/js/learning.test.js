// Run with: node --test tests/js
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../../js/core/learning.js');

const single = { answer: ['B'] };
const multi = { answer: ['A', 'C'] };

test('single answer: right, wrong, empty', () => {
    assert.equal(L.isCorrectAnswer(single, ['B']), true);
    assert.equal(L.isCorrectAnswer(single, ['A']), false);
    assert.equal(L.isCorrectAnswer(single, []), false);
    assert.equal(L.isCorrectAnswer(single, undefined), false);
});

test('multiple answers: order does not matter', () => {
    assert.equal(L.isCorrectAnswer(multi, ['C', 'A']), true);
    assert.equal(L.isCorrectAnswer(multi, ['A', 'C']), true);
});

test('multiple answers: partial or extra selections are wrong', () => {
    assert.equal(L.isCorrectAnswer(multi, ['A']), false);
    assert.equal(L.isCorrectAnswer(multi, ['A', 'B', 'C']), false);
    assert.equal(L.isCorrectAnswer(multi, ['A', 'B']), false);
});

test('legacy scalar answers still grade', () => {
    assert.equal(L.isCorrectAnswer({ answer: 'B' }, ['B']), true);
    assert.equal(L.isCorrectAnswer({ answer: 'B' }, 'B'), true);
});

test('a question with no answer is never correct', () => {
    assert.equal(L.isCorrectAnswer({ answer: [] }, []), false);
    assert.equal(L.isCorrectAnswer(null, ['A']), false);
});

test('normalizeAnswerList sorts, de-duplicates and stringifies', () => {
    assert.deepEqual(L.normalizeAnswerList(['C', 'A', 'C']), ['A', 'C']);
    assert.deepEqual(L.normalizeAnswerList(null), []);
    assert.deepEqual(L.normalizeAnswerList(3), ['3']);
});

test('saved exam sessions are keyed per user', () => {
    assert.equal(L.examSessionKey(7), 'examSessionData:u7');
    assert.notEqual(L.examSessionKey(7), L.examSessionKey(8));
    assert.equal(L.examSessionKey(null), null);
    assert.equal(L.examSessionKey(undefined), null);
});

// Shared with tests/test_recall_api.py MATCH_CASES: server and browser must agree.
const SINGLE = { choices: { A: 'Paris', B: 'Rome' }, answer: ['A'], acceptedAnswers: ['City of Light'] };
const VAGUE = { choices: { A: 'All of the above', B: 'x' }, answer: ['A'] };
const MULTI = { choices: { A: '2', B: '3', C: '4' }, answer: ['A', 'C'], acceptedAnswers: ['2 and 4'] };
const MULTI_PLAIN = { choices: { A: '2', B: '3', C: '4' }, answer: ['A', 'C'] };
const MATCH_CASES = [
    [SINGLE, 'paris', true],
    [SINGLE, '  The PARIS. ', true],
    [SINGLE, 'city of light!', true],
    [SINGLE, 'Rome', false],
    [SINGLE, '', null],
    [VAGUE, 'all of the above', null],
    [MULTI, '2 AND 4', true],
    [MULTI, '2', false],
    [MULTI_PLAIN, '2 and 4', null],
];

test('acceptedAnswers: specific single answers plus explicit variants', () => {
    assert.deepEqual(L.acceptedAnswers(SINGLE), ['Paris', 'City of Light']);
    assert.deepEqual(L.acceptedAnswers(VAGUE), []);
    assert.deepEqual(L.acceptedAnswers(MULTI), ['2 and 4']);
    assert.deepEqual(L.acceptedAnswers(MULTI_PLAIN), []);
});

test('matchesAccepted agrees with the server', () => {
    for (const [question, typed, expected] of MATCH_CASES) {
        assert.equal(L.matchesAccepted(question, typed), expected, typed);
    }
});

test('client ids are unique and match the server format', () => {
    const ids = new Set(Array.from({ length: 200 }, () => L.newClientId('a')));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{8,64}$/);
});
