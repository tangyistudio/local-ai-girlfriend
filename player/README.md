# pivot-frame-player

Cut between short video clips of the same subject without a visible seam.

**Precondition, and it is not optional:** every clip must begin and end on the
same frame. Generate them that way, then verify it - `examples/check-clips.sh`
does exactly that. Without the invariant, none of this helps.

```js
import { PivotStage } from 'pivot-frame-player';

const stage = new PivotStage({
  a: document.querySelector('#a'),        // two stacked <video> elements
  b: document.querySelector('#b'),
  poster: document.querySelector('#poster'),   // still pivot frame, behind both
  reactionFadeMs: 0,     // 0 only if YOUR clips are aligned - measure first
  speechFadeMs: 200,     // clips that end anywhere: fade
});

stage.on('speakstart', (url, ms) => showCaption(url, ms));
stage.on('idle', () => backToRotation());
stage.setPool(clips);
stage.start();

stage.setSpeakQueue([clipA, clipB]);   // plays each exactly once, then idles
stage.interrupt();                      // drop the queue, fade back
```

Zero dependencies. React is optional.

## Why the code is so heavily commented

Every constant and every guard here exists because of a specific visible defect
in a shipped product. The comments say which. If you are tempted to simplify
something, the comment is the argument you have to beat.

The measurements behind the constants are in `docs/06-playback.md`.

## Run the demo

```sh
python -m http.server 8790
# open http://127.0.0.1:8790/examples/demo.html
```

Serve from anywhere - the demo resolves its clips against its own URL and they
ship beside it.

⚠️ They did not, at first. They lived at the repository root, so the demo only
worked if the server happened to be rooted there; from `player/` every clip
404'd while the page still loaded, which reads as a broken player rather than a
broken path. Resolving against `import.meta.url` was not enough on its own -
the files were genuinely outside the served root. A package's demo has to be
self-contained.

Eighteen clips of the demo character - no models, no GPU, no download. Those
clips are not under this package's licence; see the repository LICENSE. The
demo has
buttons for the two paths that are easiest to get wrong: a speech queue, and a
clip that fails to load.

⚠️ That second button is not decoration. Running it is how we found that a
broken clip in the QUEUE froze the player permanently - the rotation pool was
filtered for unloadable clips and the queue was not. The unit tests passed. The
demo did not.

## Test

```sh
npm test
```
