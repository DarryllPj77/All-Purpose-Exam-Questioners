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

test('client ids are unique and match the server format', () => {
    const ids = new Set(Array.from({ length: 200 }, () => L.newClientId('a')));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{8,64}$/);
});
