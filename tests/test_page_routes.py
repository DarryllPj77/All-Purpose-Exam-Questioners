"""Every page route serves the app shell; the server and the browser router
agree on the list; nothing else becomes public."""

import re
import unittest
from pathlib import Path

import server

ROOT = Path(__file__).resolve().parents[1]


class PageRoutesTest(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()

    def test_each_page_url_serves_the_app(self):
        for path in server.PAGE_ROUTES:
            res = self.client.get(path)
            self.assertEqual(res.status_code, 200, path)
            self.assertIn(b'data-page="', res.data, path)
            self.assertIn(b'/js/router.js', res.data, path)
            res.close()

    def test_server_and_router_list_the_same_pages(self):
        router = (ROOT / "js" / "router.js").read_text(encoding="utf-8")
        paths = re.findall(r"path: '(/[a-z-]+)'", router)
        self.assertEqual(sorted(paths), sorted(server.PAGE_ROUTES))
        html = (ROOT / "Index.html").read_text(encoding="utf-8")
        pages = re.findall(r'data-page="([a-z-]+)"', html)
        self.assertEqual(sorted("/" + p for p in pages), sorted(server.PAGE_ROUTES))
        for p in pages:
            self.assertTrue((ROOT / "js" / "pages" / f"{p}.js").is_file(), p)

    def test_unknown_paths_and_private_files_stay_hidden(self):
        for path in ("/settings", "/questions/extra", "/.env", "/server.py", "/js/pages/../../server.py"):
            res = self.client.get(path)
            self.assertEqual(res.status_code, 404, path)
            res.close()

    def test_page_scripts_are_served(self):
        for name in ("router", "pages/dashboard", "pages/generate-pdf"):
            res = self.client.get(f"/js/{name}.js")
            self.assertEqual(res.status_code, 200, name)
            res.close()


if __name__ == "__main__":
    unittest.main()
