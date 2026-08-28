"""Tests for the sentence splitter - the one latency knob you can tune offline.

Run: python services/test_orchestrator.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from orchestrator import split_sentences

fails = []
def check(name, got, want):
    if got != want:
        fails.append("%s\n   got  %r\n   want %r" % (name, got, want))

# The 21.9s row from docs/04-latency.md: one long run-on that a punctuation-only
# rule leaves whole, and which a clause limit breaks up.
LONG = "你今天過得好不好，我等你很久了，好想聽聽你說話，真的很想。"

check("long run-on splits at commas once a clause is long enough",
      len(split_sentences(LONG, max_clause=6)) > 1, True)
check("the same text stays whole when the limit is high",
      split_sentences(LONG, max_clause=999), [LONG])

check("sentence-final punctuation always breaks",
      split_sentences("你好嗎？我很好。"), ["你好嗎？", "我很好。"])

check("a short trailing fragment joins the previous clip rather than paying a "
      "whole call's overhead",
      split_sentences("我很好。嗯"), ["我很好。嗯"])

check("empty input yields nothing", split_sentences(""), [])
check("whitespace-only yields nothing", split_sentences("   \n "), [])

check("a single short sentence is not split",
      split_sentences("你好。"), ["你好。"])

check("english sentence punctuation works too",
      split_sentences("Hello there. How are you?"),
      ["Hello there.", "How are you?"])

# Regression: a decimal must not be treated as a sentence end. Caught by test,
# not by review - the first version split "3.5 GB" into "3." and "5 GB".
check("a decimal is not a sentence break",
      split_sentences("It held 3.5 GB at rest."), ["It held 3.5 GB at rest."])

if fails:
    print("FAILED %d:" % len(fails))
    for f in fails: print(" -", f)
    sys.exit(1)
print("orchestrator: all checks passed")
