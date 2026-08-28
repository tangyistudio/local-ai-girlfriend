# Running it: the failures that actually happen

Every failure here was hit in production. None of them is exotic, and most of
them share a shape: **the system tells you it is fine while it is not.**

---

## The one that matters most: your site is up and your product is dead

The web frontend and the GPU services are different machines (see
`02-architecture.md`). The frontend is on always-on hosting. The models are on
whatever box has the card.

So when the GPU box dies, the site keeps answering **200**. Uptime monitoring is
green. The homepage loads. Everything looks perfect right up until someone tries
to have a conversation and the character cannot speak.

This happened **3 times in one day** - a reboot took out the services and the
tunnel, they were restarted by hand, they went down again - and **nobody was
notified any of those times**, because nothing that was being monitored had
changed.

**Health-check the GPU services from outside, and alert on those.** A check that
hits your web tier is checking your hosting provider, not your product. The
check that matters is the one that asks the model process a question and waits
for an answer.

## Only one lip-sync engine at a time

Two lip-sync models and a speech model on one card: **17.9 of 23 GB, GPU at
97%**. The speech process stayed alive and answered nothing - its `/health`
never responded, because it could not get scheduled. The lip-sync service then
failed every request with "voice service unavailable", the frontend waited
forever, and the input box locked.

Two things make this hard to diagnose:

**It is cumulative, so it looks random.** One conversation would hang
immediately, another would run fine for several turns. There is no clean
reproduction, which sends you looking for a race condition that is not there.

**The dead process is not dead.** It is running, it is on the process list, it
holds its port. It just never answers. Any liveness check that looks for the
process rather than for a reply says everything is fine.

The rule is simply: **one lip-sync engine at a time.** Stop one before starting
the other.

⚠️ See `00-hardware.md` for the nuance: a model that is merely *resident* costs
almost nothing. It is concurrent *computation* that starves things. The failure
above needed all three actively working.

## The watchdog that eats the card

A watchdog restarts a service when `/health` does not answer. Reasonable, and it
has a fatal interaction with a full GPU:

1. The service cannot start, because there is not enough VRAM.
2. It begins loading anyway. **It is now holding VRAM and has not opened its
   port.**
3. The watchdog sees no `/health` and starts another one.
4. Go to 1.

Observed at **38 processes**, 22 of 23 GB consumed, fully deadlocked. Every
process is waiting for memory that the other processes are holding.

Two fixes, both needed:

- **Check whether the process exists before starting another one.** A
  non-responding `/health` on a process that is running means "still loading",
  not "dead".
- **Back off on repeated failures.** A watchdog with no backoff is a fork bomb
  with a timer.

## `/health` returning 200 does not mean ready

The other half of the same problem. Our lip-sync service answered `/health` with
200 within **5 seconds** of launch, then spent nearly **4 minutes** moving
between 10,945 and 11,796 MiB before settling.

So the two states you actually care about - "still loading" and "ready" - are
both indistinguishable from each other through a naive health endpoint, in
opposite directions:

| Reality | Naive `/health` says |
|---|---|
| Loading, holding VRAM, no port yet | down (so the watchdog forks another) |
| Port open, model not loaded | up (so traffic arrives and times out) |

Make readiness mean readiness: have the endpoint report whether the model is
actually loaded, and have the watchdog read that rather than inferring from a
connection succeeding.

## Cache keys: the change you made did not take effect

Hit **3 times in one day**. You change something, re-run, and get the old
behaviour, because the thing you changed is not part of the cache key.

Caught with: overlay parameters, source file path, and amplitude. The key
eventually had to include the source key, the source file path, the source
file's size and mtime, the clip-library fingerprint, the voice, the rate, the
text and the amplitude.

**Anything that changes the output belongs in the key.** The failure is silent -
you get a valid old file, not an error - so the symptom is "my change did
nothing" and you go looking in the wrong place. If a parameter can alter the
result, it is part of the identity of the result.

A related one: **file paths are not enough.** Two different source videos at the
same path produce the same key. Include size and mtime, or hash the content.

## Counting processes will lie to you, twice

Both of these produced confident wrong answers:

**`CommandLine -match 'keyword'` counts your own query.** The command you just
typed contains the keyword, so it appears in its own results. This produced a
count of 10 speech processes competing for the card when there were far fewer,
and sent an afternoon in the wrong direction.

**Parent/child pairs look like duplicate instances.** A service launched through
a venv shows two processes: the launcher and the actual server. Listing by name
shows what appears to be two copies of everything. Check `ParentProcessId`
before concluding you have duplicates - we nearly reported a bug that was not
there.

Match on the executable path and the full command line together, and resolve the
process tree.

## The GPU was on the public internet for 4 minutes

The auth check was written as:

```python
if SERVICE_SECRET and secret != SERVICE_SECRET:
    reject()
```

The code is correct. The service was started without the environment variable
set, so `SERVICE_SECRET` was the empty string, **the whole check became a no-op**,
and the inference endpoint answered 200 to anyone with no header at all. It was
reachable through a tunnel for four minutes.

The hostname was new and had never been published, so the practical exposure was
small. It was still a real exposure, and the lesson is structural:

**Refuse to start without the secret.** Not "warn", not "default to open" -
refuse. A missing secret is a configuration error, and a service that treats it
as "no authentication required" will eventually be started that way by someone
in a hurry.

Two supporting habits:

- **Never launch these with a bare `uvicorn` command.** Use a start script that
  reads the secret from your config file and injects it, and that exits if it
  cannot find one.
- **Have the start script verify its own work**: after startup, call the
  service's OWN probe route with no auth header and require a rejection.

⚠️ 401 or 403 both pass. A 404, or a probe that cannot be reached, now STOPS the
service instead of reporting success - probing a route the service does not
serve verifies nothing, and the earlier version hard-coded one service's route
for both, so it 404'd, fell through to "answered without auth" and killed the
service it had just started.

## Restart on boot, not on a schedule

The recovery job was scheduled daily at a fixed time. A machine that reboots at
01:40 stays broken until that time comes around.

Trigger recovery **at startup**, not at an hour. This is the difference between
"down for a few minutes" and "down until someone notices", and on a home machine
nobody is watching at 01:40.

## Windows-specific traps

These cost real time and none of them are interesting:

**PowerShell 5.1 writes a BOM with `-Encoding utf8`.** A config file written
that way was rejected in full by the tunnel daemon. Use
`[System.IO.File]::WriteAllText` with a `UTF8Encoding($false)`.

**PowerShell reads script files as ANSI.** A script with non-ASCII characters in
its comments had its quotes mangled and failed to parse - the whole file, not
the comment. **Write anything PowerShell will read as pure ASCII.**

**CJK text through a shell whose code page is not UTF-8 arrives corrupted.**
The service answers 400, which reads as a broken service rather than a broken
request. Write the payload to a UTF-8 file and post the file, or escape it to
ASCII before it reaches the shell. This one recurs; it caught us in benchmarking
for this repo as well.

**Console output dies on non-ASCII.** A tool that prints a warning symbol raises
`UnicodeEncodeError` on a cp950 console and takes the whole run with it - so the
tool crashes at the exact moment it has something to tell you. Keep tool output
ASCII, or set `PYTHONIOENCODING=utf-8`.

---

## The shape they share

Almost every failure above is the same bug in different clothes: **a signal that
means "fine" when the truth is "not fine".**

- HTTP 200 from a frontend whose backend is dead
- A process that is running and never answers
- `/health` that is up before the model is
- A cache that returns valid old output for a changed input
- An auth check that passes because the secret is empty
- A process count that includes the command doing the counting

When you add monitoring to this kind of system, the question to ask is not "will
this tell me when something breaks". It is **"what is this checking, exactly,
and what could be broken while it still passes"**.
