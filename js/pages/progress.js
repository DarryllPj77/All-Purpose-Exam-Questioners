/* Page: Your progress (/progress). Its markup is <section class="page" data-page="progress">
   in Index.html; js/router.js attaches it when this route is active. */
Quizer.router.register({
    name: 'progress',
    onEnter() {
        // Fresh numbers every visit (the card keeps its last data on failure).
        if (window.Quizer && Quizer.progress) Quizer.progress.refresh();
    },
});
