# The service contract

Three services, each in its own process and its own environment, talking over
HTTP on localhost. That shape is forced on you by dependency pins, not chosen -
see `docs/02-architecture.md`.

This file is the interface between them. It is deliberately small, and it
deliberately does **not** name a model: the licence position of every lip-sync
option is unresolved (`docs/07-licenses.md`), so this repo describes a socket
and you decide what to plug into it.

---

## The one endpoint that decides your tiers

```
POST /lipsync
  { "audio_url": "...", "source": "day", "format": "mp4" }
  -> video/mp4
```

**A lip-sync service must accept audio it did not generate.** This is the single
most important line in this document.

The implementation this repo was extracted from could not. It wrote speech to a
temporary directory and called the TTS service on every cache miss, with no way
to hand it an existing file. That is invisible until you want the TTS somewhere
else - and "somewhere else" is exactly the 8 GB configuration, where the whole
point is that one component moves off the card.

So expose two entry points from the start:

| | Takes | Does |
|---|---|---|
| `POST /speak` | text | orchestrates: TTS, then lip-sync |
| `POST /lipsync` | audio | lip-sync only |

The second is what makes a tier a configuration rather than a rewrite.

---

## Speech

```
POST /tts
  { "text": "...", "lead_ms": 200, "sr": 16000 }
  -> audio/wav
```

`lead_ms` prepends silence. It exists because a synthesiser's first syllable
lands at t=0 while a player takes tens of milliseconds to actually produce
sound, so the first syllable gets eaten.

⚠️ **Whatever you cache on, put every parameter that changes the output in the
key.** This was got wrong three times in one day in the source project - overlay
parameters, source path, amplitude - and the failure is silent: you get a valid
old file rather than an error, so the symptom is "my change did nothing" and you
go looking in the wrong place.

⚠️ A file path is not enough of a key. Two different files at the same path
produce the same key. Include size and mtime, or hash the content.

⚠️ **Do not fall back to a different voice** when a cloned-voice service is
down. Failing the request is correct. A fallback gives one character two voices,
which is worse than an error because it breaks the thing the cloning was for.

## Language

```
POST /chat  (SSE)
  { "messages": [...] }
  -> stream of tokens
```

Any OpenAI-compatible endpoint works, local or hosted. On the 8 GB tier this is
the component that moves off the box.

## Health

```
GET /health -> { "ok": true, "model_loaded": true, "engine": "..." }
```

⚠️ **`model_loaded` is not decoration and 200 is not readiness.**

Measured on the source project: a lip-sync service answered `/health` with 200
within 5 seconds of launch and then spent nearly 4 minutes moving between 10,945
and 11,796 MiB before settling. And the opposite case is worse: a process still
loading its model has **not opened its port yet but is already holding VRAM**.

A watchdog that treats "no answer" as "dead" then starts another one, which also
cannot get memory, and so on - observed at **38 processes**, 22 of 23 GB
consumed, fully deadlocked. See `docs/08-ops.md`.

So: report readiness explicitly, and have the watchdog read that field rather
than infer from a connection succeeding.

---

## Authentication

Every service takes a shared secret in a header. The name is yours to pick;
there is no convention.

⚠️ **Refuse to start without it.** Not warn, not default to open - refuse.

The check below is correct code and it exposed an inference endpoint to the
internet for four minutes:

```python
if SERVICE_SECRET and secret != SERVICE_SECRET:
    reject()
```

The service was started without the environment variable set, so the secret was
the empty string and the whole check became a no-op. A missing secret is a
configuration error; a service that reads it as "no authentication required"
will eventually be started that way by someone in a hurry.

Two habits that make this structural rather than remembered:

- Never launch with a bare `uvicorn` command. Use a start script that reads the
  secret from your config and exits if it cannot find one.
- Have that script verify its own work: after startup, call the endpoint with no
  auth header and require 401 or 403. Treat 404 and unreachable as failures:
  a probe against a route the service does not serve verifies nothing, and
  each service here has its own routes - see the table above.

`scripts/` in this repo does both.
