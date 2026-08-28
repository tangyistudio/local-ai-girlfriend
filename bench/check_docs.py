"""Fail the build if the English and Chinese docs disagree about a number.

WHY THIS EXISTS
---------------
This repo is bilingual and its entire value is that the numbers are
trustworthy. Those two facts fight each other: the moment someone re-measures
and updates `00-hardware.md` without touching `00-hardware.zh-TW.md`, half the
readers are looking at a stale figure and nothing tells them so.

Translation drift in prose is survivable. Translation drift in a VRAM table is
the failure this project exists to argue against.

So: every measurement-bearing document must have its numbers match its
translation, exactly, and CI enforces it.

WHAT IT COMPARES
----------------
Numbers, not words. It pulls every numeric token out of both files and compares
the multisets. That is deliberately crude, and crude is right here - a real
parser would need to understand two languages of prose, and the thing we
actually care about is "does 7,498 appear in both files the same number of
times".

Normalisation handles the differences that are not drift:
  - thousands separators: 7,498 and 7498 are the same number
  - full-width digits, which CJK input methods produce
  - trailing zeros in decimals: 2.40 and 2.4 are the same number

HOUSE RULE THIS IMPLIES
-----------------------
A numeric claim is written with digits on BOTH sides. English prose prefers
"five seconds" and Chinese prefers a CJK numeral, and both are invisible to
this check - so a figure can drift on one side and nothing catches it. If a
number is a measurement, write it as a number: "5 seconds", "3 次", not "five"
and not "三". Prose counts that are not measurements can be spelled out freely.

TWO HOLES THIS USED TO HAVE
---------------------------
Both were found by an audit, not by the check itself, which is the point.

1. **Fenced blocks were skipped entirely.** That is right for commands and
   version pins and wrong for data: two documents put measurement tables inside
   fences, so a whole budget breakdown and a whole threshold table were
   invisible. Fenced content is now compared in its own bucket, so a drift
   there fails, and a genuine difference in a shell example is reported as
   "fenced" rather than being confused with prose drift.

2. **A multiset cannot see a transposition.** Swap two table rows in one
   language and the digits are all still present; the check passed. Table rows
   are now compared as an ordered sequence as well.

Still ignored, because they are language artifacts rather than data:
  - numbers inside inline `code spans`
  - markdown link targets and heading anchors

USAGE
-----
    python bench/check_docs.py
    python bench/check_docs.py --pair docs/00-hardware.md docs/00-hardware.zh-TW.md

Exit code 1 on any mismatch, so it can go straight into CI.
"""
import argparse
import glob
import os
import re
import sys
import unicodedata
from collections import Counter

# A number, optionally with thousands separators and a decimal part.
#
# The boundary assertions are ASCII-only ON PURPOSE. The obvious `(?![\w])`
# looks right and is wrong for a bilingual repo: Python's \w matches CJK, so
# "3 個" matched in English prose but "3個" did not match in Chinese, and the
# checker reported a mismatch that was entirely its own doing. Units and CJK
# may follow a number; another ASCII alphanumeric may not.
#
# The trailing dot is excluded only when a DIGIT follows it. Excluding a bare
# "." looked safer and silently broke the check: "Apache-2.0." at the end of an
# English sentence was skipped, while the Chinese "Apache-2.0。" - full-width
# period, not in the exclusion set - was counted. The checker then reported two
# phantom extra numbers on the Chinese side. A checker that fails on its own
# punctuation handling is worse than no checker, because you learn to ignore it.
NUM = re.compile(r"(?<![0-9A-Za-z_.])(\d[\d,，]*(?:\.\d+)?)(?![0-9A-Za-z_]|\.\d)")

# "1.6x" is a number in English and "1.6 倍" is the same number in Chinese.
# Ordinals are the same class of problem: "19th" is 19, but the trailing
# letters trip the ASCII boundary assertion and the number vanishes from the
# English side only. Detach both suffixes before matching.
MULT = re.compile("(\d)(?:x|st|nd|rd|th)\\b")

FENCE = re.compile(r"```.*?```", re.S)
INLINE_CODE = re.compile(r"`[^`\n]*`")
LINK_TARGET = re.compile(r"\]\([^)]*\)")


def normalise(tok):
    """Make '７,４９８' and '7498' compare equal, and '2.40' equal '2.4'."""
    tok = unicodedata.normalize("NFKC", tok)      # full-width -> ASCII
    tok = tok.replace(",", "").replace("，", "")
    if "." in tok:
        tok = tok.rstrip("0").rstrip(".")
    return tok


def _scan(text):
    text = INLINE_CODE.sub(" ", text)
    text = LINK_TARGET.sub(" ", text)
    text = MULT.sub("\\1 ", text)
    return [normalise(m.group(1)) for m in NUM.finditer(text)]


def numbers(path):
    """Prose numbers: everything outside fenced blocks."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    return Counter(_scan(FENCE.sub(" ", text)))


def fenced(path):
    """Numbers inside fenced blocks, compared in their own bucket.

    ⚠️ These used to be skipped entirely. That is right for shell commands and
    version pins and wrong for data, and two of this repo's own documents put
    measurement tables inside fences - a whole budget breakdown and a whole
    threshold table were invisible to a check that reported "all numbers match".
    Keeping them in a separate bucket means a drift here fails, while a genuine
    difference in a command example is reported as "fenced" rather than being
    mistaken for prose drift.
    """
    with open(path, encoding="utf-8") as f:
        text = f.read()
    return Counter(n for block in FENCE.findall(text) for n in _scan(block))


def table_rows(path):
    """Numbers per table row, in order.

    ⚠️ Catches what a whole-file multiset cannot: two rows swapped between
    languages. Every digit is still present and every count still matches, while
    the table now tells the reader that the TTS costs what the lip-sync costs.

    ⚠️ Each row is compared as a SORTED set, not in written order. The first
    version compared written order and immediately produced a false positive:
    English "7,052 - 7,615 of 8,192 MiB" against Chinese "8,192 MiB 之中的
    7,052 - 7,615" is the same claim with the languages' natural word order.
    A checker that cries wolf on grammar gets muted, and then it is not checking
    anything. Row ORDER is the real risk; word order inside a row is not.
    """
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("|") and set(line) - set("|-: "):
                got = _scan(line)
                if got:
                    rows.append(sorted(got))
    return rows


def compare(en_path, zh_path):
    if not os.path.exists(zh_path):
        print("  SKIP  %s has no translation yet" % os.path.basename(en_path))
        return True
    name = os.path.basename(en_path)
    problems = []

    for bucket, fn in (("prose", numbers), ("fenced", fenced)):
        en, zh = fn(en_path), fn(zh_path)
        oe, oz = en - zh, zh - en
        if oe:
            problems.append("        %s, in EN but not ZH: %s"
                            % (bucket, ", ".join("%s(x%d)" % (k, v)
                                                 for k, v in sorted(oe.items()))))
        if oz:
            problems.append("        %s, in ZH but not EN: %s"
                            % (bucket, ", ".join("%s(x%d)" % (k, v)
                                                 for k, v in sorted(oz.items()))))

    er, zr = table_rows(en_path), table_rows(zh_path)
    if len(er) != len(zr):
        problems.append("        table rows: EN has %d numeric rows, ZH has %d"
                        % (len(er), len(zr)))
    else:
        for i, (a, b) in enumerate(zip(er, zr)):
            if a != b:
                problems.append("        table row %d differs in order or value: "
                                "EN %s vs ZH %s -- a swap here keeps every digit "
                                "present and still misinforms the reader"
                                % (i + 1, a, b))
                break

    if not problems:
        total = sum(numbers(en_path).values()) + sum(fenced(en_path).values())
        print("  OK    %-34s %d numbers match (prose + fenced + %d table rows)"
              % (name, total, len(er)))
        return True

    print("  FAIL  %s" % name)
    for line in problems:
        print(line)
    print("        A number that changed on one side only is exactly the bug "
          "this check exists for. Re-measure or re-translate; do not silence it.")
    return False


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--pair", nargs=2, metavar=("EN", "ZH"),
                   help="check one pair instead of scanning docs/")
    p.add_argument("--docs", default="docs")
    args = p.parse_args()

    if args.pair:
        return 0 if compare(*args.pair) else 1

    ens = sorted(f for f in glob.glob(os.path.join(args.docs, "*.md"))
                 if ".zh-TW." not in f)
    if not ens:
        print("no documents found in %s" % args.docs)
        return 1
    print("checking %d document pair(s)" % len(ens))
    ok = True
    for en in ens:
        zh = en.replace(".md", ".zh-TW.md")
        ok = compare(en, zh) and ok
    print("\n%s" % ("all pairs consistent" if ok else "MISMATCH - see above"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
