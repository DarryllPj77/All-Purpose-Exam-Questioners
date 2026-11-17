// Run with: node --test tests/js
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../js/modes/mistakes.js');

const items = [
    { setId: 's1', questionId: 'q_a', open: true, timesWrong: 1, lastWrongAt: '2026-11-10T10:00:00Z', reviewAttempts: 2, reviewCorrect: 1 },
    { setId: 's1', questionId: 'q_b', open: true, timesWrong: 3, lastWrongAt: '2026-11-01T10:00:00Z', reviewAttempts: 0, reviewCorrect: 0 },
    { setId: 's2', questionId: 'q_c', open: true, timesWrong: 1, lastWrongAt: '2026-11-15T10:00:00Z', reviewAttempts: 1, reviewCorrect: 0 },
    { setId: 's2', questionId: 'q_d', open: false, timesWrong: 2, lastWrongAt: '2026-11-02T10:00:00Z', reviewAttempts: 2, reviewCorrect: 2 },
];

test('filterItems by set and tab', () => {
    assert.deepEqual(M.filterItems(items, '', 'open').map((i) => i.questionId), ['q_a', 'q_b', 'q_c']);
    assert.deepEqual(M.filterItems(items, 's2', 'open').map((i) => i.questionId), ['q_c']);
    assert.deepEqual(M.filterItems(items, '', 'resolved').map((i) => i.questionId), ['q_d']);
});

test('buildQueue: open only, most-missed first, then most recent', () => {
    assert.deepEqual(M.buildQueue(items), ['s1|q_b', 's2|q_c', 's1|q_a']);
});

test('counts and retry accuracy, overall and per set', () => {
    assert.deepEqual(M.counts(items, ''), { open: 3, resolved: 1, attempts: 5, correct: 3, accuracy: 60 });
    assert.deepEqual(M.counts(items, 's1'), { open: 2, resolved: 0, attempts: 2, correct: 1, accuracy: 50 });
    assert.equal(M.counts([], '').accuracy, null);
});

test('relativeDay', () => {
    const now = new Date('2026-11-17T12:00:00');
    assert.equal(M.relativeDay('2026-11-17T08:00:00', now), 'today');
    assert.equal(M.relativeDay('2026-11-16T23:00:00', now), 'yesterday');
    assert.equal(M.relativeDay('2026-11-12T08:00:00', now), '5 days ago');
    assert.equal(M.relativeDay('2026-10-27T08:00:00', now), '3 weeks ago');
    assert.equal(M.relativeDay('', now), '');
    assert.equal(M.relativeDay('not a date', now), '');
});

test('retryMessage covers every outcome', () => {
    assert.match(M.retryMessage({ resolved: true, needed: 2, correct: true }), /Resolved: 2 correct in a row/);
    assert.match(M.retryMessage({ correct: true, open: true, streak: 1, needed: 2 }), /once more/);
    assert.match(M.retryMessage({ correct: true, open: true, streak: 1, needed: 3 }), /2 more times/);
    assert.match(M.retryMessage({ correct: false, open: true, streak: 0, needed: 2 }), /streak is reset/);
    assert.match(M.retryMessage({ correct: true, open: false, streak: 3, needed: 2 }), /already resolved/);
});

test('modeLabel names every logging mode', () => {
    assert.equal(M.modeLabel('practice'), 'Practice test');
    assert.equal(M.modeLabel('exam'), 'Exam');
    assert.equal(M.modeLabel('nope'), 'Another mode');
});

test('toggleChoice respects the selection limit', () => {
    assert.deepEqual(M.toggleChoice(['A'], 'B', 1), ['B']);
    assert.deepEqual(M.toggleChoice(['A', 'C'], 'D', 2), ['A', 'C']);
});
