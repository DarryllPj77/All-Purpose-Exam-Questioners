# All Purpose Exam Questioners (Quizer)

A study platform built with Flask and PostgreSQL. Turn a PDF into a question
set (through OpenRouter), or paste one in, then study it in eight modes that
each keep their own progress.

## Features

- **Accounts:** sign-up and sign-in; every set, answer and score belongs to
  one user.
- **Question sets:** generate from a PDF, import a pasted array (read as data
  only, never run), or try the built-in C# code sample set.
- **Exam and Training:** the original timed exam and guided training, with a
  detailed review of every session in Performance history.
- **Eight study modes:**
  - **Flashcards:** flip, label Know / Still learning, swipe or use the keyboard.
  - **Learn:** adaptive rounds; a question is mastered after 3 correct answers
    in a row across rounds.
  - **Active recall:** answer without choices, reveal, rate yourself.
  - **Smart review:** spaced repetition at 1, 3, 7, 14 and 30 days, then
    longer, due at your local midnight.
  - **Practice test:** length, timer, pass mark, shuffling and navigation
    rules of your choice.
  - **Mistake review:** every question you missed anywhere, until you get it
    right twice in a row.
  - **Matching:** pair questions with answers, relaxed or against the clock.
  - **Code challenge:** predict output, find bugs and syntax errors, complete
    code. Code is shown with highlighting and never executed.
- **Separate pages:** Dashboard (`/dashboard`), Question library
  (`/questions`), Performance history (`/performance`), Your progress
  (`/progress`), Study session (`/study`), Generate from PDF
  (`/generate-pdf`) and Import a set (`/import`), each with its own URL, so
  Back, Forward, Refresh and bookmarks work.
- **Your progress:** each mode's measure side by side, a "continue
  studying" list, 14-day activity and practice scores.
- **Calm blue design:** one dark theme with tested contrast, keyboard access
  throughout, and reduced-motion support.

How it all works (architecture, data model, scoring, review algorithm,
design tokens, tests and limits):
**[docs/learning-platform.md](docs/learning-platform.md)**.

## Tech stack

- Python 3, Flask, psycopg2, gunicorn (production)
- PostgreSQL
- Plain HTML, CSS and JavaScript (no build step, no front-end framework;
  a small History API router in `js/router.js`)
- OpenRouter API (PDF to questions only)

## Project setup

### 1. Clone the repository

```bash
git clone https://github.com/DarryllPj77/All-Purpose-Exam-Questioners.git
cd All-Purpose-Exam-Questioners
```

### 2. Create and activate a virtual environment

```bash
python -m venv venv
```

Windows (PowerShell):

```powershell
.\venv\Scripts\Activate.ps1
```

macOS / Linux:

```bash
source venv/bin/activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Create your environment file

Copy `.env.example` to `.env` and fill in real values. `.env` is git-ignored;
never commit it.

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

| Variable | Required | Purpose |
|---|---|---|
| `POSTGRES_DSN` | Yes (local) | e.g. `postgresql://apeq:apeq@localhost:5432/apeq` |
| `FLASK_SECRET_KEY` | Yes | Long random secret for sessions |
| `OPENROUTER_API_KEY` | For PDF generation | Everything else works without it |
| `DATABASE_URL` | On Render | Used when `POSTGRES_DSN` is not set |
| `DB_POOL_MAX` | No | Database connection pool size per process (default 10; `0` turns pooling off) |
| `PORT` | No | Server port (default 5001) |

### 5. Create the PostgreSQL database

Create a database and user that match your DSN, for example database `apeq`,
user `apeq`, password `apeq`. The tables are created automatically when the
server starts (`schema.sql`, applied by `init_schema()`).

### 6. Run the server

```bash
python server.py
```

Then open <http://127.0.0.1:5001/>.

## Running tests

```bash
python -m unittest discover -s tests -t .
```

```bash
node --test tests/js
```

The Python API tests use the database in `.env`, create throwaway
`apitest_*` users and delete them afterwards; they are skipped if no database
is reachable. The JavaScript tests need Node 18 or later and no database.

## Environment notes

- Commit `.env.example`, not `.env`.
- Never upload real API keys or database passwords; rotate a key at once if
  it was exposed.
- Only the files listed in `PUBLIC_FILES` in `server.py` are served to the
  browser, so `.env`, source files and `.git` are never public. Add new
  front-end files to that list.

## Troubleshooting

### HTTP 405 on Create Account

The page is calling the wrong address or method. Open the app from the Flask
server itself (<http://127.0.0.1:5001/>), not from a file or another web
server, and check that the request goes to `/api/auth/register` with `POST`.

### The app loads but every request fails

Opened from `localhost` or `127.0.0.1`, the page calls the API on port 5001.
If you run the server on another port, open it by the machine's network
address instead (for example `http://192.168.x.x:5002/`), or set
`window.QUIZ_API_BASE`.

## Render deployment

### 1. Push these files

- `requirements.txt` (includes `gunicorn` and `psycopg2-binary`)
- `server.py` (reads `PORT`)
- `schema.sql` (applied automatically on start)

### 2. Create PostgreSQL on Render

1. Render Dashboard -> `New +` -> `PostgreSQL`
2. Copy the generated `Internal Database URL`

### 3. Create a Web Service on Render

1. Render Dashboard -> `New +` -> `Web Service`
2. Connect your repository and branch
3. Set:
   - Build command: `pip install -r requirements.txt`
   - Start command: `gunicorn server:app`

### 4. Environment variables

- `DATABASE_URL`: your Render PostgreSQL internal URL
- `FLASK_SECRET_KEY`: a long random secret
- `OPENROUTER_API_KEY`: your key (for PDF generation)
- Optional: `PYTHON_VERSION`, `DB_POOL_MAX`

The app reads `POSTGRES_DSN` first and falls back to `DATABASE_URL`. The
schema is applied on boot, so running `psql -f schema.sql` by hand is not
needed. Each gunicorn worker keeps its own small connection pool.

## License

Add your preferred license here.
