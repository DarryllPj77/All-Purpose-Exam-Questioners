/* ============================================================
   Quizer core: shared helpers for every study mode.

   Loaded as a plain <script> before Cert.js (exposes window.Quizer),
   and require()-able from Node so the pure helpers can be unit-tested
   with `node --test` (see tests/js/learning.test.js).

   Pure helpers   : no DOM, no network, safe to test.
   Learning API   : thin client for progress_routes.py.
   ============================================================ */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.Quizer = Object.assign(root.Quizer || {}, { learning: api });
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    // ---- Pure helpers ---------------------------------------------------

    /** Answers as a sorted, de-duplicated list of choice keys. */
    function normalizeAnswerList(answer) {
        const list = Array.isArray(answer) ? answer : (answer == null ? [] : [answer]);
        return Array.from(new Set(list.map(String))).sort();
    }

    /**
     * True when the selected choices are exactly the correct ones.
     * Order never matters; a partial multi-answer selection is incorrect.
     */
    function isCorrectAnswer(question, selected) {
        if (!question) return false;
        const expected = normalizeAnswerList(question.answer);
        const given = normalizeAnswerList(selected);
        if (!expected.length || expected.length !== given.length) return false;
        return expected.every((key, i) => key === given[i]);
    }

    /** localStorage key for the in-progress exam of one signed-in user. */
    function examSessionKey(userId) {
        if (userId === null || userId === undefined || userId === '') return null;
        return 'examSessionData:u' + String(userId);
    }

    /** Random id that makes a retried POST idempotent on the server. */
    function newClientId(prefix) {
        const rand = (root && root.crypto && typeof root.crypto.randomUUID === 'function')
            ? root.crypto.randomUUID().replace(/-/g, '')
            : (Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
        return (prefix || 'c') + '_' + rand.slice(0, 32);
    }

    // ---- Learning API client ---------------------------------------------

    function apiUrl(path) {
        return (root && typeof root.quizApiUrl === 'function') ? root.quizApiUrl(path) : path;
    }

    async function request(path, options) {
        const opts = Object.assign({ credentials: 'include' }, options || {});
        if (opts.body && typeof opts.body !== 'string') {
            opts.body = JSON.stringify(opts.body);
            opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        }
        const res = await fetch(apiUrl(path), opts);
        let data = null;
        try { data = await res.json(); } catch (_) { /* non-JSON error page */ }
        if (!res.ok || !data || data.ok === false) {
            const message = (data && data.error) || ('Request failed (HTTP ' + res.status + ')');
            const error = new Error(message);
            error.status = res.status;
            throw error;
        }
        return data;
    }

    const enc = encodeURIComponent;
    let configPromise = null;

    const learningApi = {
        /** Mastery and review rules from learning_config.py (cached). */
        getConfig() {
            if (!configPromise) {
                configPromise = request('/api/learning/config')
                    .then((d) => d.config)
                    .catch((e) => { configPromise = null; throw e; });
            }
            return configPromise;
        },
        /** Full set straight from the server (questions always carry ids). */
        getSet(setId) {
            return request('/api/sets/' + enc(setId)).then((d) => d.set);
        },
        getProgress(setId) {
            return request('/api/progress/' + enc(setId)).then((d) => d.progress);
        },
        /** status: 'know' | 'learning' | null (clears the label). */
        setFlashcardStatus(setId, questionId, status) {
            return request('/api/progress/' + enc(setId) + '/flashcards/' + enc(questionId), {
                method: 'PUT', body: { status },
            });
        },
        /** attempts: [{questionId, mode, outcome, response?, clientAttemptId?}] */
        recordAttempts(setId, attempts) {
            const withIds = attempts.map((a) => Object.assign({ clientAttemptId: newClientId('a') }, a));
            return request('/api/progress/' + enc(setId) + '/attempts', {
                method: 'POST', body: { attempts: withIds },
            });
        },
        listAttempts(setId, filters) {
            const f = filters || {};
            const qs = ['questionId', 'mode', 'limit']
                .filter((k) => f[k] !== undefined && f[k] !== null && f[k] !== '')
                .map((k) => k + '=' + enc(f[k])).join('&');
            return request('/api/progress/' + enc(setId) + '/attempts' + (qs ? '?' + qs : ''))
                .then((d) => d.attempts);
        },
        loadSession(setId, mode) {
            return request('/api/study-sessions/' + enc(setId) + '/' + enc(mode)).then((d) => d.state);
        },
        saveSession(setId, mode, state) {
            return request('/api/study-sessions/' + enc(setId) + '/' + enc(mode), {
                method: 'PUT', body: { state },
            });
        },
        clearSession(setId, mode) {
            return request('/api/study-sessions/' + enc(setId) + '/' + enc(mode), { method: 'DELETE' });
        },
    };

    return {
        normalizeAnswerList,
        isCorrectAnswer,
        examSessionKey,
        newClientId,
        api: learningApi,
    };
});
