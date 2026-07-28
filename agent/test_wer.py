"""WER scorer tests — the number that reports accent robustness must be right."""

import wer


def test_normalization_ignores_case_and_punctuation():
    assert wer.normalize("The Quick, Brown Fox!") == "the quick brown fox"
    assert wer.score("dog.", "Dog")["wer"] == 0.0


def test_apostrophes_are_kept_as_part_of_the_word():
    assert wer.normalize("don't stop") == "don't stop"
    assert wer.score("don't stop", "dont stop")["wer"] == 0.5   # a real difference


def test_perfect_match():
    s = wer.score("mic test one two", "mic test one two")
    assert s["wer"] == 0.0 and s["edits"] == 0 and s["ref_words"] == 4


def test_substitution_deletion_insertion():
    assert wer.score("a b c d", "a x c d")["wer"] == 0.25       # 1 substitution
    assert wer.score("a b c d", "a c d")["wer"] == 0.25         # 1 deletion
    assert wer.score("a b c d", "a b c d e")["wer"] == 0.25     # 1 insertion


def test_empty_hypothesis_is_a_total_miss():
    assert wer.score("a b c d", "")["wer"] == 1.0


def test_empty_reference_is_undefined_not_a_crash():
    s = wer.score("", "anything at all")
    assert s["wer"] is None and s["ref_words"] == 0


def test_wer_can_exceed_one_on_runaway_insertions():
    """Standard WER is not capped — an over-long hypothesis says so."""
    assert wer.score("a", "a b c d e")["wer"] == 4.0


def test_edit_distance_is_symmetric_in_length():
    assert wer.edit_distance("kitten", "sitting") == 3


def test_best_match_picks_the_closest_drill_line():
    lines = ["The quick brown fox jumps over the lazy dog.", "Mic test one two."]
    line, s = wer.best_match("mic test one too", lines)
    assert line == "Mic test one two."
    assert s["wer"] == 0.25


def test_best_match_on_empty_script():
    assert wer.best_match("anything", []) == (None, None)


def test_aggregate_is_corpus_wer_not_a_mean_of_rates():
    """One error in a 2-word line and one in a 20-word line are not equally
    bad; averaging the rates would say they were."""
    scores = [wer.score("a b", "a x"), wer.score(" ".join("abcdefghijklmnopqrst"),
                                                 " ".join("xbcdefghijklmnopqrst"))]
    agg = wer.aggregate(scores)
    assert agg["total_edits"] == 2
    assert agg["total_ref_words"] == 22
    assert agg["corpus_wer"] == round(2 / 22, 4)
    assert agg["corpus_wer"] < (scores[0]["wer"] + scores[1]["wer"]) / 2


def test_aggregate_ignores_unscorable_entries():
    assert wer.aggregate([None, wer.score("", "x")]) is None


def test_load_script_skips_blanks_and_comments(tmp_path):
    path = tmp_path / "drill.txt"
    path.write_text("# the drill\n\nLine one.\n\n  Line two.  \n# trailing\n")
    assert wer.load_script(str(path)) == ["Line one.", "Line two."]
