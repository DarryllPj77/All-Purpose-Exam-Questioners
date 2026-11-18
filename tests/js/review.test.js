// Run with: node --test tests/js
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../../js/modes/review.js');

test('shortDate and dayLabel use the learner\'s calendar', () => {
    assert.equal(V.shortDate('2026-11-21'), 'Sat 21 Nov');
    assert.equal(V.dayLabel('2026-11-18', '2026-11-18'), 'Today');
    assert.equal(V.dayLabel('2026-11-19', '2026-11-18'), 'Tomorrow');
    assert.equal(V.dayLabel('2026-11-25', '2026-11-18'), 'In 7 days');
    assert.equal(V.dayLabel('2026-12-01', '2026-11-30'), 'Tomorrow'); // across a month
});

test('localDate converts a UTC instant with getTimezoneOffset()', () => {
    // Local midnight in Manila (UTC+8, offset -480) is 16:00 UTC the day before.
    assert.equal(V.localDate('2026-11-19T16:00:00+00:00', -480), '2026-11-20');
    assert.equal(V.localDate('2026-11-19T03:00:00+00:00', 300), '2026-11-18'); // New York
});

test('nextReviewText reads naturally', () => {
    assert.equal(V.nextReviewText('2026-11-19T16:00:00+00:00', '2026-11-19', -480), 'tomorrow (Fri 20 Nov)');
    assert.equal(V.nextReviewText('2026-11-21T16:00:00+00:00', '2026-11-19', -480), 'in 3 days (Sun 22 Nov)');
});

test('maturityLabel bands', () => {
    assert.deepEqual([null, 3, 7, 14, 21, 60].map(V.maturityLabel),
        ['Learning', 'Learning', 'Young', 'Young', 'Mature', 'Mature']);
});

test('dailyProgress counts done against done plus still due', () => {
    assert.deepEqual(V.dailyProgress({ reviewedToday: 3, due: 9 }), { done: 3, total: 12, percent: 25 });
    assert.deepEqual(V.dailyProgress({ reviewedToday: 0, due: 0 }), { done: 0, total: 0, percent: 0 });
});
