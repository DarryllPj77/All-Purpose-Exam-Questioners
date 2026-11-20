// Run with: node --test tests/js
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../js/progress.js');

test('niceMax rounds the axis up to 1, 2, 5 or 10 times a power of ten', () => {
    assert.equal(P.niceMax([0, 0]), 1);
    assert.equal(P.niceMax([3]), 5);
    assert.equal(P.niceMax([7, 12]), 20);
    assert.equal(P.niceMax([50]), 50);
    assert.equal(P.niceMax([51]), 100);
});

test('relativeTime reads naturally', () => {
    const now = new Date('2026-11-18T12:00:00Z');
    assert.equal(P.relativeTime('2026-11-18T11:59:30Z', now), 'just now');
    assert.equal(P.relativeTime('2026-11-18T11:55:00Z', now), '5 minutes ago');
    assert.equal(P.relativeTime('2026-11-18T09:00:00Z', now), '3 hours ago');
    assert.equal(P.relativeTime('2026-11-17T10:00:00Z', now), 'yesterday');
    assert.equal(P.relativeTime('2026-11-14T12:00:00Z', now), '4 days ago');
    assert.equal(P.relativeTime(null, now), '');
});

test('activitySummary: accuracy only from graded answers, never from all answers', () => {
    const sum = P.activitySummary([
        { answers: 10, graded: 4, correct: 3 },
        { answers: 0, graded: 0, correct: 0 },
        { answers: 5, graded: 0, correct: 0 },
    ]);
    assert.deepEqual(sum, { answers: 15, graded: 4, correct: 3, activeDays: 2, accuracy: 75 });
    assert.equal(P.activitySummary([{ answers: 3, graded: 0, correct: 0 }]).accuracy, null);
});

test('practiceSummary uses each test\'s own pass mark and skips tests without one', () => {
    assert.equal(P.practiceSummary([]), null);
    const s = P.practiceSummary([
        { score: 60, passPercent: 70 },
        { score: 90, passPercent: 70 },
        { score: 55, passPercent: 50 },
        { score: 80, passPercent: null },
    ]);
    assert.deepEqual(s, { latest: 80, best: 90, passed: 2, withMark: 3 });
});

test('shortDay keeps the learner\'s calendar day', () => {
    assert.equal(P.shortDay('2026-11-18'), 'Wed 18 Nov');
});

test('every continue mode names a controller', () => {
    Object.values(P.MODES).forEach((m) => assert.ok(m.controller && m.label));
    assert.equal(P.modeLabel('code'), 'Code challenge');
});

test('continue rows: removed ones stay hidden until studied again, and the list refills to 4', () => {
    const items = [
        { mode: 'flashcards', setId: 'qs_a', at: '2026-11-20T10:05:00Z' },
        { mode: 'flashcards', setId: 'qs_b', at: '2026-11-20T10:04:00Z' },
        { mode: 'practice', setId: 'qs_b', at: '2026-11-20T10:03:00Z' },
        { mode: 'recall', setId: 'qs_b', at: '2026-11-20T10:02:00Z' },
        { mode: 'mistakes', setId: 'qs_c', at: '2026-11-20T10:01:00Z' },
    ];
    assert.equal(P.continueKey(items[0]), 'qs_a|flashcards');
    assert.equal(P.continueKey(items[4]), 'mistakes'); // spans every set
    assert.deepEqual(P.visibleContinue(items, {}).map(P.continueKey),
        ['qs_a|flashcards', 'qs_b|flashcards', 'qs_b|practice', 'qs_b|recall']);
    // Removing one brings the fifth up, so 4 still show.
    const hidden = { 'qs_b|flashcards': '2026-11-20T10:06:00Z' };
    assert.deepEqual(P.visibleContinue(items, hidden).map(P.continueKey),
        ['qs_a|flashcards', 'qs_b|practice', 'qs_b|recall', 'mistakes']);
    // Studying it again after it was removed brings it back.
    const again = items.map((it, i) => (i === 1 ? Object.assign({}, it, { at: '2026-11-20T10:30:00Z' }) : it));
    assert.ok(P.visibleContinue(again, hidden).some((it) => P.continueKey(it) === 'qs_b|flashcards'));
    // Removing a set-wide mode hides it for every set.
    assert.ok(!P.visibleContinue(items, { mistakes: '2026-11-20T11:00:00Z' }, 10).some((it) => it.mode === 'mistakes'));
});

test('old hide records expire after 90 days and bad values are dropped', () => {
    const now = new Date('2026-11-20T00:00:00Z');
    assert.deepEqual(P.pruneHidden({ a: '2026-11-01T00:00:00Z', b: '2026-07-01T00:00:00Z', c: 'nonsense' }, now),
        { a: '2026-11-01T00:00:00Z' });
});
