"""Fail the build if a page links to something that is not there.

WHY THIS EXISTS
---------------
The site links to documents, stylesheets, scripts and video clips by relative
path. Every one of those is a chance to ship a link that 404s for a reader and
works for whoever wrote it.

⚠️ This check exists because one already did. The demo referenced its clips two
directories up, which resolved correctly only when the server happened to be
rooted at the repository - serve the package on its own and every clip 404'd
while the page still rendered, so it read as a broken player rather than a
broken path.

Two more traps this catches, both of which bit this repo:

  - **A path that resolves is not a file that exists.** Fixing the resolution
    without moving the files changed nothing; the browser fetched a perfectly
    well-formed URL and got a 404.
  - **Markdown links from HTML.** A static host serves .md as an octet-stream,
    so a "Docs" link downloads a file instead of opening one. Local .md targets
    are reported, because on a plain static host they are a bad link even when
    the file is present.

USAGE
    python site/check_links.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = ["index.html", "qa.html",
         os.path.join("player", "examples", "demo.html"),
         # ⚠️ JS modules too. Runtime-built URLs moved out of the pages and into
         # a module, and the checker - which scanned only pages - reported "all
         # local links resolve" while every clip 404'd in the browser. A checker
         # that only looks where the bug used to be is not a checker.
         os.path.join("site", "demo.js"),
         os.path.join("player", "examples", "clips.js")]

HREF = re.compile(r'(?:href|src)\s*=\s*"([^"]+)"')
# Paths built at runtime, e.g. new URL(`./clips/${name}`, import.meta.url)
JS_URL = re.compile(r'new URL\(\s*[`\'"]([^`\'"$]*)')


def targets(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as f:
        text = f.read()
    out = [(m.group(1), "href/src") for m in HREF.finditer(text)]
    out += [(m.group(1), "new URL") for m in JS_URL.finditer(text)]
    return out


def main():
    problems, checked = [], 0

    for page in PAGES:
        page_dir = os.path.dirname(os.path.join(ROOT, page))
        for target, kind in targets(page):
            if target.startswith(("http://", "https://", "//", "#", "mailto:", "data:")):
                continue
            clean = target.split("#")[0].split("?")[0]
            if not clean:
                continue
            checked += 1

            resolved = os.path.normpath(os.path.join(page_dir, clean))

            # ⚠️ A `new URL` target is either a directory PREFIX with the
            # filename appended at runtime, or a base FILE that other relative
            # URLs are resolved against. Either is valid; it just has to exist.
            #
            # This check has now false-positived on itself twice - first by
            # demanding an index.html inside a path prefix, then by rejecting a
            # base file because it was not a directory. Both times the code was
            # right and the checker was wrong, which is the fastest way to teach
            # people to ignore it.
            if kind == "new URL":
                if not os.path.exists(resolved):
                    problems.append("%s -> %s : does not exist (%s)"
                                    % (page, target, os.path.relpath(resolved, ROOT)))
                continue

            # A trailing-slash link means that directory's index.
            candidate = os.path.join(resolved, "index.html") if clean.endswith("/") else resolved
            if not os.path.exists(candidate):
                problems.append("%s -> %s (%s) : NOT FOUND at %s"
                                % (page, target, kind,
                                   os.path.relpath(candidate, ROOT)))
                continue

            if clean.endswith(".md"):
                problems.append(
                    "%s -> %s : local .md link. A static host serves this as a "
                    "download, not a page - link to the rendered copy instead."
                    % (page, target))

    # The runtime-built clip URLs name a directory; make sure it has clips in it.
    clips = os.path.join(ROOT, "player", "examples", "clips")
    n_clips = len([f for f in os.listdir(clips)]) if os.path.isdir(clips) else 0
    if n_clips == 0:
        problems.append("player/examples/clips is empty - run make-clips.sh")

    print("checked %d local link(s) across %d page(s), %d demo clip(s)"
          % (checked, len(PAGES), n_clips))
    if problems:
        print("\nFAILED:")
        for p in problems:
            print("  " + p)
        return 1
    print("all local links resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main())
