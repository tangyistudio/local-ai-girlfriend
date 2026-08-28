"""Turn a reply into a stream of finished talking-head clips, one sentence at
a time.

This is the whole orchestration layer. It holds no models - it splits text,
calls the TTS service, calls the lip-sync service, and yields each clip as soon
as it exists. Standard library only.

WHY PER-SENTENCE, AND WHAT IT IS WORTH
--------------------------------------
Measured on the source project, same content:

    one unsplit sentence, 34 characters   first clip 21.9 s   total 21.9 s
    split into 3                          first clip  3.6 s   total 18.1 s

6x on the number the user actually feels, and the total got shorter too.

⚠️ The total does NOT always improve, and pretending otherwise would be the
kind of claim this repo exists to argue against. On a slower engine the same
change took the first clip from 34 s to 16.3 s and pushed the total from 34 s to
42.4 s, because every sentence pays the fixed cost again. Whether pipelining
helps overall depends on your per-call overhead against your work. It always
helps the first clip.

⚠️ And none of it matters if your lip-sync engine is slower than realtime. Below
1.0x, generation outruns playback and the character can speak continuously.
Above it, no amount of pipelining saves you - see docs/04-latency.md.
"""
import json
import re
import urllib.error
import urllib.request

# ⚠️ THIS CONSTANT IS A LATENCY KNOB, not a formatting preference.
#
# The rule is: break at sentence-final punctuation, and only break at a comma
# once a clause has run this long. Language models write long sentences, so a
# whole reply frequently arrives as one unsplittable unit - which is exactly the
# 21.9 s row above.
#
# The source project shipped 40 and measured 18 as the better value. That is a
# one-line change worth 6x on time-to-first-word, and it is the first thing to
# try if your character is slow to start talking.
MAX_CLAUSE = 18

# ⚠️ Do not chase this below a couple of seconds of audio. Generation cost tracks
# AUDIO LENGTH, not character count: measured, a 3-character sentence and a
# 7-character one both took about 4.5 s because both produced over 2 s of audio.
# Going from 13 characters to 7 saved 1.7 s; going below that saved nothing.
MIN_CLAUSE = 6

_END = "。！？!?…"
_SOFT = "，,、；;：:"


def split_sentences(text, max_clause=MAX_CLAUSE, min_clause=MIN_CLAUSE):
    """Split a reply into clips-worth of text.

    Always breaks at sentence-final punctuation. Breaks at a soft separator only
    once the current clause has reached `max_clause`, so short natural sentences
    stay whole and long run-ons still get cut.

    ⚠️ `min_clause` deliberately does NOT gate sentence-final breaks. An earlier
    version required a minimum length before breaking at all, which is backwards:
    a short first sentence is exactly what you want, because it reaches the user
    soonest. Its only job is to stop a trailing fragment becoming a call of its
    own, and that is where it is applied.

    ⚠️ A bare "." is a sentence end only when a space or the end of the string
    follows it. Without that check, "3.5 GB" splits mid-number. Found by test,
    not by review.
    """
    text = re.sub(r"\s+", " ", (text or "").strip())
    if not text:
        return []

    out, buf = [], ""
    for i, ch in enumerate(text):
        buf += ch
        nxt = text[i + 1] if i + 1 < len(text) else ""
        is_end = ch in _END or (ch == "." and (nxt == "" or nxt == " "))
        if is_end and buf.strip():
            out.append(buf.strip())
            buf = ""
        elif ch in _SOFT and len(buf.strip()) >= max_clause:
            out.append(buf.strip())
            buf = ""
    if buf.strip():
        # A trailing fragment too short to stand alone joins the previous clip
        # rather than paying a whole call's fixed overhead for a few characters.
        # Generation cost tracks audio length, and a fragment still produces a
        # floor of audio - so a tiny extra call buys nothing.
        if out and len(buf.strip()) < min_clause:
            out[-1] += buf.strip()
        else:
            out.append(buf.strip())
    return out


class Services:
    """HTTP clients for the two model services. See services/CONTRACT.md."""

    def __init__(self, tts_url, lipsync_url, secret, auth_header="X-Auth-Secret",
                 timeout=300):
        self.tts_url = tts_url.rstrip("/")
        self.lipsync_url = lipsync_url.rstrip("/")
        self.secret = secret
        self.auth_header = auth_header
        self.timeout = timeout

    def _post(self, url, payload):
        # ⚠️ ensure_ascii on purpose. Passing CJK text through a shell whose code
        # page is not UTF-8 corrupts the bytes and the service answers 400, which
        # reads as a broken service rather than a broken request. Escaping puts
        # the question beyond doubt.
        body = json.dumps(payload, ensure_ascii=True).encode("ascii")
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type": "application/json",
                     self.auth_header: self.secret})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            return r.read(), dict(r.headers)

    def tts(self, text, lead_ms=200, sr=16000):
        return self._post(self.tts_url + "/tts",
                          {"text": text, "lead_ms": lead_ms, "sr": sr})

    def lipsync_from_audio(self, audio_url, source=None):
        """Lip-sync audio the service did not generate.

        ⚠️ This is the endpoint that makes the 8 GB tier possible, and it is the
        one the source implementation did not have. Without it, TTS cannot move
        off the box - the lip-sync service calls it internally on every cache
        miss, so "run the TTS elsewhere" is not a configuration you can select.
        """
        payload = {"audio_url": audio_url}
        if source:
            payload["source"] = source
        return self._post(self.lipsync_url + "/lipsync", payload)

    def speak(self, text, source=None):
        """Text in, finished clip out. The service does its own TTS."""
        payload = {"text": text}
        if source:
            payload["source"] = source
        return self._post(self.lipsync_url + "/speak", payload)

    def health(self):
        out = {}
        for name, url in (("tts", self.tts_url), ("lipsync", self.lipsync_url)):
            try:
                with urllib.request.urlopen(url + "/health", timeout=5) as r:
                    out[name] = json.loads(r.read())
            except Exception as e:                              # noqa: BLE001
                out[name] = {"ok": False, "error": str(e)}
        return out


def stream_clips(services, reply_text, source=None, on_clip=None,
                 max_clause=MAX_CLAUSE):
    """Yield one finished clip per sentence, in order, as soon as each exists.

    ⚠️ Yields IN ORDER on purpose. Clips must reach the player in the order they
    will be spoken, and a faster later sentence overtaking an earlier one would
    put the reply out of sequence - which is the kind of defect that reads as
    the model being incoherent rather than as a bug.
    """
    for i, sentence in enumerate(split_sentences(reply_text, max_clause)):
        try:
            data, headers = services.speak(sentence, source)
        except urllib.error.HTTPError as e:
            # ⚠️ Surface it. Do not substitute a fallback voice or skip the
            # sentence quietly - a reply missing its middle is worse than a
            # visible failure, and a different voice is worse than both.
            yield {"index": i, "text": sentence, "error": "HTTP %d" % e.code}
            continue
        except Exception as e:                                  # noqa: BLE001
            yield {"index": i, "text": sentence, "error": str(e)}
            continue
        clip = {"index": i, "text": sentence, "bytes": len(data),
                "cache": headers.get("X-Cache", "?")}
        if on_clip:
            on_clip(clip, data)
        yield clip
