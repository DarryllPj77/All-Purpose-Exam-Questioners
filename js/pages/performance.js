/* Page: Performance history (/performance). Its markup is <section class="page" data-page="performance">
   in Index.html; js/router.js attaches it when this route is active. */
Quizer.router.register({
    name: 'performance',
    onEnter() {
        if (typeof renderSessionHistory === 'function') renderSessionHistory();
    },
});
