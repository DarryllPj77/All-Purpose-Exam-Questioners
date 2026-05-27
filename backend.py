"""Generate quiz questions from a PDF via OpenRouter and write them to questions.js.

Pipeline:
  1. Extract text per page, drop common noise (page numbers, stray short lines).
  2. Group pages into ~4.5k-word chunks that respect page boundaries.
  3. Distribute the requested question count across chunks weighted by word count.
  4. Call OpenRouter in parallel per chunk asking for that chunk's share of questions.
  5. Parse each response's question objects, dedupe by normalized question text,
     renumber 1..N, assemble the final `const questions = [...]`, validate, atomic-write.

A `progress` callback (phase, message, percent) is invoked at each phase boundary
and on per-chunk completion. The Flask server uses this to drive its polling API.

Usage:
    python backend.py                            # reads module.pdf, writes questions.js
    python backend.py path/to/file.pdf           # custom input PDF
    python backend.py file.pdf out.js            # custom input + output
    python backend.py file.pdf out.js 30         # target 30 questions

Requires OPENROUTER_API_KEY in the environment (or a .env file alongside this script).
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

import requests
from PyPDF2 import PdfReader
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_PDF = SCRIPT_DIR / "module.pdf"
DEFAULT_OUTPUT = SCRIPT_DIR / "questions.js"
MODEL_NAME = "deepseek/deepseek-chat"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
OPENROUTER_CHAT_URL = f"{OPENROUTER_BASE_URL}/chat/completions"

# Tuning knobs
WORDS_PER_QUESTION = 180       # heuristic for analyze()
CHUNK_TARGET_WORDS = 4500      # ~6k tokens — comfortable for the model, respects context
MAX_PARALLEL_CHUNKS = 4        # cap on concurrent OpenRouter calls

ProgressFn = Callable[[str, str, int], None]


# ============================================================
# PDF text extraction + cleaning
# ============================================================

_PAGE_NUMBER_RE = re.compile(r"^(page\s*)?\d+(\s*of\s*\d+)?$", re.IGNORECASE)


def _clean_page_text(raw: str) -> str:
    """Collapse whitespace, drop lines that look like page numbers / running headers."""
    out_lines = []
    for line in raw.split("\n"):
        s = line.strip()
        if not s:
            continue
        # Tiny purely-numeric lines are almost always page numbers.
        if len(s) <= 5 and _PAGE_NUMBER_RE.match(s):
            continue
        out_lines.append(s)
    # Collapse internal whitespace
    return re.sub(r"\s+", " ", " ".join(out_lines)).strip()


def _extract_pages(pdf_path: Path) -> list[tuple[int, str]]:
    """Return [(page_number, cleaned_text), ...] for non-empty pages."""
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")
    reader = PdfReader(str(pdf_path))
    pages: list[tuple[int, str]] = []
    for idx, page in enumerate(reader.pages, start=1):
        raw = page.extract_text() or ""
        cleaned = _clean_page_text(raw)
        if cleaned:
            pages.append((idx, cleaned))
    return pages


def extract_pdf_text(pdf_path: Path) -> str:
    """Backwards-compatible single-string extraction (used by analyze() and CLI fallbacks)."""
    pages = _extract_pages(pdf_path)
    if not pages:
        raise ValueError(f"No extractable text in {pdf_path}")
    return "\n".join(text for _, text in pages)


# ============================================================
# analyze() — suitability + recommended count
# ============================================================

def _round_to_step(value: float, step: int) -> int:
    return max(step, int(round(value / step) * step))


def analyze(pdf_path: Path) -> dict:
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    pages = _extract_pages(pdf_path)
    if not pages:
        raise ValueError("Could not extract any text from this PDF.")

    page_count = len(PdfReader(str(pdf_path)).pages)
    word_count = sum(len(t.split()) for _, t in pages)

    raw_high = word_count / WORDS_PER_QUESTION
    recommended_high = max(10, min(_round_to_step(raw_high, 5), 100))
    recommended_low = _round_to_step(raw_high * 0.65, 5)
    if recommended_high > 10:
        recommended_low = max(5, min(recommended_low, recommended_high - 5))
    else:
        recommended_low = max(5, min(recommended_low, recommended_high))
    max_count = min(150, max(40, recommended_high * 2))

    message = (
        f"This PDF (~{page_count} page{'s' if page_count != 1 else ''}, "
        f"~{word_count:,} words) is suitable for around "
        f"{recommended_low}–{recommended_high} quality questions."
    )

    return {
        "ok": True,
        "pageCount": page_count,
        "wordCount": word_count,
        "recommendedLow": recommended_low,
        "recommendedHigh": recommended_high,
        "max": max_count,
        "message": message,
    }


# ============================================================
# Chunking & count distribution
# ============================================================

@dataclass
class Chunk:
    index: int
    pages: list[int]
    text: str
    word_count: int


def _chunk_pages(pages: list[tuple[int, str]], target_words: int = CHUNK_TARGET_WORDS) -> list[Chunk]:
    """Pack pages into chunks of ~target_words words each. Page boundaries are respected."""
    chunks: list[Chunk] = []
    cur_pages: list[int] = []
    cur_text: list[str] = []
    cur_words = 0
    for page_num, text in pages:
        words = len(text.split())
        # If this page alone exceeds target_words and we already have content, flush first.
        if cur_pages and cur_words + words > target_words:
            chunks.append(Chunk(
                index=len(chunks),
                pages=list(cur_pages),
                text="\n\n".join(cur_text),
                word_count=cur_words,
            ))
            cur_pages, cur_text, cur_words = [], [], 0
        cur_pages.append(page_num)
        cur_text.append(text)
        cur_words += words
    if cur_pages:
        chunks.append(Chunk(
            index=len(chunks),
            pages=list(cur_pages),
            text="\n\n".join(cur_text),
            word_count=cur_words,
        ))
    return chunks


def _distribute_count(total: int, chunks: list[Chunk]) -> list[int]:
    """Apportion `total` questions across chunks proportional to word count (largest-remainder)."""
    if total <= 0 or not chunks:
        return [0] * len(chunks)
    total_words = sum(c.word_count for c in chunks) or 1
    raw = [total * c.word_count / total_words for c in chunks]
    floors = [int(r) for r in raw]
    remainder = total - sum(floors)
    # Hand out the leftover to the chunks with the largest fractional parts.
    fractional = sorted(
        ((raw[i] - floors[i], i) for i in range(len(chunks))),
        key=lambda t: t[0],
        reverse=True,
    )
    for k in range(remainder):
        floors[fractional[k % len(fractional)][1]] += 1
    return floors


# ============================================================
# Prompt building
# ============================================================

def _build_chunk_prompt(chunk_text: str, n_questions: int, idx: int, total: int) -> str:
    if total > 1:
        intro = (
            f"You are reading section {idx + 1} of {total} from a larger study document. "
            f"Generate exactly {n_questions} distinct multiple-choice questions from THIS section's material. "
            f"Spread the questions across different topics within the section — do not cluster on a single paragraph or example."
        )
    else:
        intro = (
            f"Generate exactly {n_questions} distinct multiple-choice questions from the study material below. "
            f"Cover a broad range of topics from the whole document."
        )

    return f"""{intro}

Return ONLY a JavaScript array (no `const`, no comments, no markdown fences) matching this exact shape:

[
  {{
    number: 1,
    text: `Question text`,
    choices: {{
      A: `Choice A`,
      B: `Choice B`,
      C: `Choice C`,
      D: `Choice D`
    }},
    answer: ["A"],
    maxSelections: 1
  }}
]

Rules:
- Multiple-choice ONLY with 4 distinct choices labelled A, B, C, D.
- `answer` is an array of choice letters, e.g. ["A"] or ["A","C"].
- `maxSelections` is 1 unless multiple correct answers are clearly required (then equal to the count of correct answers).
- Use backticks (`) around all string values exactly as shown.
- Each question must be DISTINCT in topic and wording from every other.
- Number questions sequentially starting at 1 within this array.
- No explanations, no commentary, no markdown fences — just the array literal.

Section content:
{chunk_text}
"""


# ============================================================
# Response parsing
# ============================================================

def strip_markdown_fences(raw: str) -> str:
    cleaned = raw.strip()
    fence = re.match(r"^```[a-zA-Z]*\s*\n(.*)\n```\s*$", cleaned, flags=re.DOTALL)
    if fence:
        cleaned = fence.group(1).strip()
    return cleaned


def _scan_balanced(src: str, start: int, open_ch: str, close_ch: str) -> int:
    """Return the index of the close char matching src[start], honouring backtick/quote strings.
    Returns -1 if not found."""
    if start >= len(src) or src[start] != open_ch:
        return -1
    depth = 0
    in_str: Optional[str] = None
    i = start
    while i < len(src):
        ch = src[i]
        if in_str:
            if ch == "\\" and i + 1 < len(src):
                i += 2
                continue
            if ch == in_str:
                in_str = None
        else:
            if ch in "\"'`":
                in_str = ch
            elif ch == open_ch:
                depth += 1
            elif ch == close_ch:
                depth -= 1
                if depth == 0:
                    return i
        i += 1
    return -1


def parse_questions_from_js(js_text: str) -> list[str]:
    """Extract individual question object literal sources from a model response.

    Tolerates a leading `const questions = ` or stray text before the array.
    Returns a list of `{ ... }` source blocks (strings) — NOT parsed Python objects;
    we keep them as JS source so we can reassemble byte-for-byte into questions.js.
    """
    start = js_text.find("[")
    if start == -1:
        return []
    end = _scan_balanced(js_text, start, "[", "]")
    if end == -1:
        return []

    body = js_text[start + 1 : end]
    objects: list[str] = []
    depth = 0
    in_str: Optional[str] = None
    cur_start: Optional[int] = None
    i = 0
    while i < len(body):
        ch = body[i]
        if in_str:
            if ch == "\\" and i + 1 < len(body):
                i += 2
                continue
            if ch == in_str:
                in_str = None
        else:
            if ch in "\"'`":
                in_str = ch
            elif ch == "{":
                if depth == 0:
                    cur_start = i
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0 and cur_start is not None:
                    objects.append(body[cur_start : i + 1].strip())
                    cur_start = None
        i += 1
    return objects


def _extract_question_text(obj_src: str) -> Optional[str]:
    """Pull the `text: \`...\`` content from a question object literal."""
    m = re.search(r"text\s*:\s*`((?:[^`\\]|\\.)*)`", obj_src, flags=re.DOTALL)
    return m.group(1).strip() if m else None


def _normalize_for_dedupe(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower()).strip()[:80]


def _dedupe_and_trim(blocks: list[str], target: int) -> list[str]:
    """Drop near-duplicates (by normalized question text), renumber sequentially, cap at target."""
    seen: set[str] = set()
    kept: list[str] = []
    for blk in blocks:
        qt = _extract_question_text(blk)
        if not qt:
            continue
        key = _normalize_for_dedupe(qt)
        if not key or key in seen:
            continue
        seen.add(key)
        kept.append(blk)
        if target > 0 and len(kept) >= target:
            break
    # Renumber sequentially
    renumbered: list[str] = []
    for i, blk in enumerate(kept, start=1):
        new_blk = re.sub(r"\bnumber\s*:\s*\d+", f"number: {i}", blk, count=1)
        renumbered.append(new_blk)
    return renumbered


def _assemble_questions_js(blocks: list[str]) -> str:
    if not blocks:
        return "const questions = [];\n"
    body = ",\n  ".join(blk for blk in blocks)
    return "const questions = [\n  " + body + "\n];\n"


_BACKTICK_STR = r"`((?:[^`\\]|\\.)*)`"


def _block_to_dict(block: str) -> Optional[dict]:
    """Convert one JS question object literal (as produced by the LLM) into a
    Python dict matching the same shape the frontend already consumes:
        { number, text, choices: {A,B,C,D}, answer: [..], maxSelections }
    Returns None if the block is missing required fields."""
    m = re.search(r"\bnumber\s*:\s*(\d+)", block)
    number = int(m.group(1)) if m else None

    m = re.search(rf"\btext\s*:\s*{_BACKTICK_STR}", block, flags=re.DOTALL)
    text = m.group(1).strip() if m else None

    choices: dict[str, str] = {}
    for label in ("A", "B", "C", "D"):
        m = re.search(rf"\b{label}\s*:\s*{_BACKTICK_STR}", block, flags=re.DOTALL)
        if m:
            choices[label] = m.group(1).strip()

    m = re.search(r"\banswer\s*:\s*\[([^\]]*)\]", block, flags=re.DOTALL)
    answer: list[str] = []
    if m:
        for v in re.findall(r"""["']([^"']+)["']""", m.group(1)):
            answer.append(v)

    m = re.search(r"\bmaxSelections\s*:\s*(\d+)", block)
    max_sel = int(m.group(1)) if m else 1

    if not number or not text or len(choices) != 4 or not answer:
        return None
    return {
        "number": number,
        "text": text,
        "choices": choices,
        "answer": answer,
        "maxSelections": max_sel,
    }


# ============================================================
# Validation & atomic write
# ============================================================

def validate_questions_js(code: str) -> None:
    if "const questions" not in code:
        raise ValueError("Output is missing `const questions` declaration.")
    if not re.search(r"const\s+questions\s*=\s*\[", code):
        raise ValueError("`const questions` is not assigned an array.")
    if code.count("[") != code.count("]"):
        raise ValueError("Unbalanced square brackets in generated output.")
    if code.count("{") != code.count("}"):
        raise ValueError("Unbalanced curly braces in generated output.")

    required_keys = ("number", "text", "choices", "answer", "maxSelections")
    missing = [k for k in required_keys if not re.search(rf"\b{k}\s*:", code)]
    if missing:
        raise ValueError(f"Generated output is missing required keys: {missing}")
    if not re.search(r"\bnumber\s*:\s*1\b", code):
        raise ValueError("Generated output does not appear to start at question 1.")


def write_atomically(path: Path, content: str) -> None:
    fd, tmp_name = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=str(path.parent)
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
        os.replace(tmp_path, path)
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise


# ============================================================
# generate() pipeline
# ============================================================

def _noop_progress(phase: str, message: str, percent: int) -> None:
    return None


def _openrouter_generate(prompt: str, api_key: str) -> str:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://127.0.0.1:5000",
        "X-Title": "All Purpose Exam Questioners",
    }

    payload = {
        "model": MODEL_NAME,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You generate high-quality multiple-choice reviewer questions "
                    "from study material and must follow formatting instructions exactly."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.3,
        "stream": False,
    }

    response = requests.post(
        OPENROUTER_CHAT_URL,
        headers=headers,
        json=payload,
        timeout=180,
    )
    response.raise_for_status()
    data = response.json()

    try:
        return (data["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"Unexpected OpenRouter response: {data}") from exc


def generate(
    pdf_path: Path,
    output_path: Optional[Path] = None,
    count: Optional[int] = None,
    progress: Optional[ProgressFn] = None,
) -> dict:
    """Run the full pipeline. Returns a small result dict.

    Phases reported via `progress(phase, message, percent)`:
        extracting   →  reading PDF
        chunking     →  planning sections
        generating   →  OpenRouter calls (per-chunk completion bumps the bar)
        merging      →  dedupe + renumber
        writing      →  atomic write
        done         →  success
    """
    emit = progress or _noop_progress

    emit("extracting", "Reading and cleaning PDF text…", 4)
    load_dotenv(SCRIPT_DIR / ".env")
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("Missing OPENROUTER_API_KEY environment variable.")

    pages = _extract_pages(pdf_path)
    if not pages:
        raise ValueError("Could not extract any text from this PDF.")
    total_words = sum(len(t.split()) for _, t in pages)

    emit("chunking", "Splitting document into balanced sections…", 12)
    chunks = _chunk_pages(pages)
    target = int(count) if count else max(20, min(50, total_words // WORDS_PER_QUESTION))
    counts = _distribute_count(target, chunks)

    active_chunks = [(c, n) for c, n in zip(chunks, counts) if n > 0]
    if not active_chunks:
        active_chunks = [(chunks[0], target)]

    n_active = len(active_chunks)
    if n_active > 1:
        emit("generating", f"Generating across {n_active} sections in parallel…", 20)
    else:
        emit("generating", f"Generating {target} questions…", 20)

    blocks_by_chunk: list[Optional[list[str]]] = [None] * len(chunks)
    completed = 0
    lock = threading.Lock()

    def run_chunk(chunk: Chunk, n: int) -> tuple[int, list[str]]:
        prompt = _build_chunk_prompt(chunk.text, n, chunk.index, len(chunks))
        raw = _openrouter_generate(prompt, api_key)
        cleaned = strip_markdown_fences(raw)
        return chunk.index, parse_questions_from_js(cleaned)

    workers = min(MAX_PARALLEL_CHUNKS, n_active)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(run_chunk, c, n): c.index for c, n in active_chunks}
        for fut in as_completed(futures):
            idx, blks = fut.result()
            blocks_by_chunk[idx] = blks
            with lock:
                completed += 1
                pct = 20 + int(65 * (completed / n_active))
                page_range = ""
                ch = chunks[idx]
                if ch.pages:
                    page_range = f" (pages {ch.pages[0]}–{ch.pages[-1]})"
                emit("generating", f"Section {completed}/{n_active}{page_range} done.", pct)

    # Preserve chunk order so questions roughly follow document flow.
    all_blocks = [blk for chunk_blocks in blocks_by_chunk if chunk_blocks for blk in chunk_blocks]
    if not all_blocks:
        raise RuntimeError("OpenRouter returned no parseable questions.")

    emit("merging", "Deduplicating and renumbering…", 88)
    final_blocks = _dedupe_and_trim(all_blocks, target)
    if not final_blocks:
        raise RuntimeError("All generated questions were duplicates or unparseable.")

    js_body = _assemble_questions_js(final_blocks)
    validate_questions_js(js_body)

    # Parse each JS block into a Python dict for callers (e.g. the server)
    # that need the structured questions rather than the JS source string.
    parsed_questions: list[dict] = []
    for blk in final_blocks:
        d = _block_to_dict(blk)
        if d:
            parsed_questions.append(d)
    # Renumber to be safe — dedupe already renumbered the blocks, but if the
    # block parser dropped any malformed entry, the numbering would skip.
    for i, q in enumerate(parsed_questions, start=1):
        q["number"] = i

    if output_path is not None:
        emit("writing", "Writing questions.js…", 96)
        header_lines = [
            "// AUTO-GENERATED by backend.py. Rerun the script (or use the upload UI) to regenerate.",
            f"// Source: {pdf_path.name}",
            f"// Sections processed: {n_active}",
            f"// Requested: {target}  Produced: {len(final_blocks)}",
            "// Consumed by Cert.js as the global `questions` array.",
        ]
        write_atomically(output_path, "\n".join(header_lines) + "\n\n" + js_body)

    emit("done", f"Generated {len(parsed_questions)} of {target} requested questions.", 100)

    return {
        "requested": target,
        "produced": len(parsed_questions),
        "sections": n_active,
        "totalWords": total_words,
        "questions": parsed_questions,
    }


# ============================================================
# CLI
# ============================================================

def _cli_progress(phase: str, message: str, percent: int) -> None:
    bar_len = 24
    filled = int(bar_len * percent / 100)
    bar = "█" * filled + "·" * (bar_len - filled)
    sys.stdout.write(f"\r[{bar}] {percent:3d}%  {phase:<11s} {message}")
    sys.stdout.flush()
    if phase in ("done", "error"):
        sys.stdout.write("\n")


def main(argv: list[str]) -> None:
    pdf_path = Path(argv[1]).resolve() if len(argv) > 1 else DEFAULT_PDF
    output_path = Path(argv[2]).resolve() if len(argv) > 2 else DEFAULT_OUTPUT
    count = int(argv[3]) if len(argv) > 3 else None
    try:
        generate(pdf_path, output_path, count=count, progress=_cli_progress)
    except (RuntimeError, FileNotFoundError, ValueError) as e:
        print(f"\nError: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv)
