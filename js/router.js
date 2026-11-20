/* ============================================================
   Page router.

   The app has no front-end framework, so this is a small router on the
   browser History API. Each page (Dashboard, Question library, ...) is its
   own module in js/pages/ with its own route and its own markup
   (`<section class="page" data-page="...">`). The shared shell (sidebar,
   header) stays put; only the active page is attached to the page outlet
   (`<main id="dashboard">`, kept under its old id because the exam and
   study modes show and hide it). Inactive pages are detached from the
   document, not hidden.

   * Back, Forward, Refresh and typed URLs work: Flask serves the app at
     every page path, and the router reads location.pathname on start.
   * Old in-page links (#questionSetsSection, ...) and the ids existing code
     passes to navigateToSection() map to the new routes.
   * Existing code looks elements up with document.getElementById, often for
     a page that is not on screen (a PDF generation finishing after you
     moved on, the library refreshing after sign-in). So getElementById
     also searches detached pages; it only does so when the normal lookup
     finds nothing, so nothing else changes.

   Top half: pure logic (exported for `node --test`).
   Bottom half: browser controller (window.Quizer.router).
   ============================================================ */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api.logic;
    if (root) root.Quizer = Object.assign(root.Quizer || {}, { router: api.controller });
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    // ---- Pure logic ------------------------------------------------------------

    const ROUTES = [
        { name: 'dashboard', path: '/dashboard', title: 'Dashboard' },
        { name: 'questions', path: '/questions', title: 'Question library' },
        { name: 'performance', path: '/performance', title: 'Performance history' },
        { name: 'progress', path: '/progress', title: 'Your progress' },
        { name: 'study', path: '/study', title: 'Study session' },
        { name: 'generate-pdf', path: '/generate-pdf', title: 'Generate from PDF' },
        { name: 'import', path: '/import', title: 'Import a set' },
    ];
    const DEFAULT_ROUTE = 'dashboard';

    // Section ids and hashes from the single-page layout, still used by
    // existing code and old bookmarks.
    const LEGACY = {
        dashboard: 'dashboard',
        progresssection: 'progress',
        studycard: 'study',
        generatecard: 'generate-pdf',
        importcard: 'import',
        questionsetssection: 'questions',
        sessionhistory: 'performance',
        studymodes: 'dashboard',
    };

    function byName(name) { return ROUTES.find((r) => r.name === name) || null; }

    /**
     * The route for a URL: its path (trailing slash, case and index.html
     * ignored), else an old #section hash, else the default.
     * Returns { route, redirect } where redirect says the URL should be
     * replaced with the route's canonical path.
     */
    function resolve(pathname, hash) {
        const clean = String(pathname || '/').toLowerCase().replace(/\/index\.html$/, '/').replace(/\/+$/, '') || '/';
        const direct = ROUTES.find((r) => r.path === clean);
        if (direct) return { route: direct, redirect: pathname !== direct.path };
        const legacy = LEGACY[String(hash || '').replace(/^#/, '').toLowerCase()];
        if (legacy) return { route: byName(legacy), redirect: true };
        return { route: byName(DEFAULT_ROUTE), redirect: true, unknown: clean !== '/' };
    }

    /** A route for a name, a path, or an old section id. */
    function lookup(target) {
        if (!target) return null;
        const t = String(target);
        if (t.startsWith('/')) return resolve(t, '').route;
        return byName(t) || byName(LEGACY[t.toLowerCase()]) || null;
    }

    const logic = { ROUTES, DEFAULT_ROUTE, resolve, lookup };

    // ---- Browser controller ----------------------------------------------------

    if (!root || typeof root.document === 'undefined') return { logic, controller: null };
    const doc = root.document;
    const SITE_TITLE = 'Exam Review & Practice Suite';

    const pages = new Map();   // route name -> { route, el, onEnter, onLeave, focus }
    let current = null;        // route name
    let started = false;

    // getElementById also finds elements on detached pages (see header).
    const nativeGetById = doc.getElementById.bind(doc);
    doc.getElementById = function (id) {
        const found = nativeGetById(id);
        if (found || !started) return found;
        for (const page of pages.values()) {
            if (page.el && !page.el.isConnected) {
                if (page.el.id === id) return page.el;
                const inside = page.el.querySelector('#' + CSS.escape(id));
                if (inside) return inside;
            }
        }
        return null;
    };

    function outlet() { return nativeGetById('dashboard'); }

    /** Pages call this to register their component. */
    function register(def) {
        const route = byName(def.name);
        if (!route) throw new Error('Unknown page: ' + def.name);
        pages.set(def.name, Object.assign({ route }, def));
    }

    function reducedMotion() {
        return root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function show(name, opts) {
        const page = pages.get(name);
        if (!page || !page.el) return;
        const box = outlet();
        const prev = current && pages.get(current);
        if (prev && prev !== page && typeof prev.onLeave === 'function') prev.onLeave();
        if (prev !== page) {
            if (prev && prev.el && prev.el.isConnected) prev.el.remove();
            box.appendChild(page.el);
            page.el.classList.remove('page--enter');
            if (!reducedMotion() && opts.animate) {
                void page.el.offsetWidth; // restart the entrance animation
                page.el.classList.add('page--enter');
            }
        }
        current = name;
        doc.title = page.route.name === DEFAULT_ROUTE ? SITE_TITLE : `${page.route.title} · ${SITE_TITLE}`;
        doc.body.dataset.page = name;
        if (typeof root.setActiveNav === 'function') root.setActiveNav(name);
        if (typeof root.syncAppBar === 'function') root.syncAppBar();
        if (opts.scroll !== false) root.scrollTo({ top: 0 });
        if (opts.focus) {
            // Move focus to the page's heading so keyboard and screen-reader
            // users land on the new content.
            const heading = page.el.querySelector('h1');
            if (heading) {
                if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
                heading.focus({ preventScroll: true });
            }
        }
        if (typeof page.onEnter === 'function') page.onEnter();
    }

    /** Leave the exam, a study mode or the training feedback before changing page. */
    function leaveScreens() {
        if (typeof root.isExamVisible === 'function' && root.isExamVisible() && typeof root.backToDashboard === 'function') {
            root.backToDashboard();
        }
        const mode = typeof root.openModeView === 'function' ? root.openModeView() : null;
        if (mode) mode.ctl.close();
        const feedback = nativeGetById('fullscreenFeedback');
        if (feedback && feedback.style.display !== 'none' && typeof root.closeFeedback === 'function') root.closeFeedback();
    }

    /** Go to a page by name, path or old section id. */
    function navigate(target, opts) {
        const o = opts || {};
        const route = lookup(target);
        if (!route) return false;
        leaveScreens();
        if (typeof root.toggleSidebar === 'function') root.toggleSidebar(false);
        if (route.name !== current || root.location.pathname !== route.path) {
            const state = { page: route.name };
            if (o.replace) root.history.replaceState(state, '', route.path);
            else root.history.pushState(state, '', route.path);
        }
        show(route.name, { animate: true, focus: o.focus !== false });
        return true;
    }

    function start() {
        // Every page's markup is in the document until now, so each module's
        // event bindings found its elements. Detach all but the current page.
        doc.querySelectorAll('.page[data-page]').forEach((el) => {
            const page = pages.get(el.dataset.page);
            if (page) page.el = el;
        });
        const { route, redirect } = resolve(root.location.pathname, root.location.hash);
        pages.forEach((page) => { if (page.el && page.route.name !== route.name) page.el.remove(); });
        started = true;
        if (redirect) root.history.replaceState({ page: route.name }, '', route.path);
        else root.history.replaceState({ page: route.name }, '', root.location.pathname);
        show(route.name, { animate: false, focus: false, scroll: false });

        root.addEventListener('popstate', () => {
            const next = resolve(root.location.pathname, '').route;
            leaveScreens();
            show(next.name, { animate: true, focus: true });
        });

        // Links and buttons that go to a page: <a href="/questions" data-route>
        // and <button data-go="/dashboard"> (runs after the button's own action).
        doc.addEventListener('click', (e) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            const link = e.target.closest && e.target.closest('a[data-route]');
            if (link) {
                e.preventDefault();
                navigate(link.getAttribute('href'));
                return;
            }
            const go = e.target.closest && e.target.closest('[data-go]');
            if (go) navigate(go.dataset.go);
        });
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
    else root.setTimeout(start, 0);

    const controller = {
        register,
        navigate,
        lookup,
        current: () => (current ? pages.get(current).route : null),
        routes: () => ROUTES.slice(),
    };
    return { logic, controller };
});
