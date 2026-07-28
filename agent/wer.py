"""Transcript fidelity scoring against the fixed drill script.

Transcript fidelity is a first-class result of this spike, not a nicety: in
TTS mode the STT transcript is the ONLY thing that survives of what was
actually said. An RVC pipeline that mishears still returns the speaker's own
acoustics; this one re-speaks whatever the recognizer decided it heard. Accent
robustness therefore shows up here, as WER, and nowhere else.

Scoring is standard word-level Levenshtein: WER = (S + D + I) / N_reference.
Normalization lowercases, strips punctuation and collapses whitespace, so
"dog." vs "dog" is not counted as an error while a genuinely wrong word is.
A character-level ratio is reported alongside it because at these utterance
lengths a single-word slip is a coarse 1/9 jump in WER.

Utterances arrive one at a time and the drill script is a known list of lines,
so best_match() scores a transcript against whichever line it is closest to
rather than assuming the speaker kept to the running order.
"""

import re

_PUNCT = re.compile(r"[^\w\s']")
_WS = re.compile(r"\s+")


def normalize(text):
    """lowercase, drop punctuation (apostrophes kept), collapse whitespace."""
    return _WS.sub(" ", _PUNCT.sub(" ", (text or "").lower())).strip()


def tokens(text):
    return normalize(text).split()


def edit_distance(a, b):
    """Levenshtein over any two sequences (word lists or strings)."""
    if len(a) < len(b):
        a, b = b, a
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1,          # deletion
                           cur[j - 1] + 1,       # insertion
                           prev[j - 1] + (x != y)))  # substitution
        prev = cur
    return prev[-1]


def score(reference, hypothesis):
    """Word-error rate + character-error rate of `hypothesis` against `reference`.

    An empty reference yields wer=None (undefined) rather than a divide-by-zero;
    an empty hypothesis against a real reference is a total miss (wer=1.0).
    """
    ref_w, hyp_w = tokens(reference), tokens(hypothesis)
    ref_c, hyp_c = normalize(reference), normalize(hypothesis)
    if not ref_w:
        return {"wer": None, "cer": None, "edits": None,
                "ref_words": 0, "hyp_words": len(hyp_w)}
    edits = edit_distance(ref_w, hyp_w)
    cer_edits = edit_distance(ref_c, hyp_c)
    return {
        "wer": round(edits / len(ref_w), 4),
        "cer": round(cer_edits / len(ref_c), 4) if ref_c else None,
        "edits": edits,
        "ref_words": len(ref_w),
        "hyp_words": len(hyp_w),
    }


OFF_SCRIPT_WER = 0.5


def best_match(hypothesis, script_lines, off_script_wer=OFF_SCRIPT_WER):
    """Score against the closest drill line; returns (line, score_dict) or (None, None).

    Ties break toward the earlier line, which keeps repeated drill lines
    (e.g. "mic test one two" x3) attributing to a stable reference.

    OFF-SCRIPT DETECTION: free conversation is not a failed drill reading. A
    live session where the speaker just talked scored every utterance at
    WER 0.9–1.0 against the nearest drill line and reported a corpus WER of
    0.90 — a number that described nothing except that the words were not on
    the script. Anything worse than `off_script_wer` is therefore marked
    `off_script` and excluded from aggregation, so the drill measurement stays
    a drill measurement and casual speech does not poison it.
    """
    if not script_lines:
        return None, None
    best_line, best = None, None
    for line in script_lines:
        s = score(line, hypothesis)
        if s["wer"] is None:
            continue
        if best is None or s["wer"] < best["wer"]:
            best_line, best = line, s
    if best is not None and best["wer"] > off_script_wer:
        best["off_script"] = True
    return best_line, best


def load_script(path):
    """One drill line per file line; blanks and #-comments ignored."""
    lines = []
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if line and not line.startswith("#"):
                lines.append(line)
    return lines


def aggregate(scores):
    """Corpus WER: total edits / total reference words — NOT a mean of per-
    utterance WERs, which would over-weight short utterances."""
    usable = [s for s in scores
              if s and s.get("wer") is not None and not s.get("off_script")]
    if not usable:
        return None
    total_edits = sum(s["edits"] for s in usable)
    total_words = sum(s["ref_words"] for s in usable)
    return {
        "corpus_wer": round(total_edits / total_words, 4) if total_words else None,
        "utterances": len(usable),
        "total_edits": total_edits,
        "total_ref_words": total_words,
    }
