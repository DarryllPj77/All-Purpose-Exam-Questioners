// Run with: node --test tests/js
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../js/router.js');

test('seven pages, each with its own path', () => {
    assert.deepEqual(R.ROUTES.map((r) => r.path),
        ['/dashboard', '/questions', '/performance', '/progress', '/study', '/generate-pdf', '/import']);
});

test('resolve: exact paths, tolerant of case and a trailing slash', () => {
    assert.deepEqual(R.resolve('/questions', ''), { route: R.ROUTES[1], redirect: false });
    assert.equal(R.resolve('/Questions/', '').route.name, 'questions');
    assert.equal(R.resolve('/Questions/', '').redirect, true);
    assert.equal(R.resolve('/generate-pdf', '').route.name, 'generate-pdf');
});

test('resolve: the root, old bookmarks and unknown paths', () => {
    assert.equal(R.resolve('/', '').route.name, 'dashboard');
    assert.equal(R.resolve('/index.html', '').route.name, 'dashboard');
    assert.equal(R.resolve('/', '#questionSetsSection').route.name, 'questions');
    assert.equal(R.resolve('/', '#sessionHistory').route.name, 'performance');
    const unknown = R.resolve('/nope', '');
    assert.equal(unknown.route.name, 'dashboard');
    assert.equal(unknown.unknown, true);
});

test('lookup: route names, paths and the section ids existing code still passes', () => {
    assert.equal(R.lookup('import').path, '/import');
    assert.equal(R.lookup('/progress').name, 'progress');
    assert.equal(R.lookup('questionSetsSection').name, 'questions');
    assert.equal(R.lookup('studyCard').name, 'study');
    assert.equal(R.lookup('generateCard').name, 'generate-pdf');
    assert.equal(R.lookup('flashcardsView'), null); // study modes are not pages
});
