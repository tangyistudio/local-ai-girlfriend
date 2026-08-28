/**
 * The demo clip library, shared by the project page and the standalone demo.
 *
 * ⚠️ EVERYTHING HERE IS PRE-RENDERED. Nothing is generated when you click.
 *
 * The questions and answers were produced in advance by the same pipeline the
 * documentation describes — speech synthesis, then lip-sync, one sentence at a
 * time — and saved as files. Clicking a question plays a video that already
 * existed. There is no model running in your browser and no server being
 * called.
 *
 * That matters for reading the demo honestly: it shows you what the OUTPUT of
 * this architecture looks like and how the playback behaves. It does not show
 * you the latency, because the latency is exactly what pre-rendering removes.
 * For what the wait actually is, see docs/04-latency.md — end to end, one
 * sentence, nothing cached: 11.9 s.
 *
 * ⚠️ THERE ARE NO FILLER CLIPS HERE ANY MORE, AND THAT IS THE POINT.
 *
 * An earlier version played a "let me think" clip before every answer, because
 * that is what the production system does: it covers an 11.9 s render with
 * something the character is plausibly doing. Nothing is being rendered here,
 * so the filler was covering nothing — it just made every answer arrive four
 * seconds late, and it read as the system being slow rather than as the system
 * being polite.
 *
 * The general rule it came from: a filler is worth exactly as much as the wait
 * it hides. Put your model behind a fast enough backend and the filler stops
 * paying for itself, so take it out. docs/04-latency.md has the local numbers
 * that make it worth having on one consumer card.
 *
 * ⚠️ EVERY CLIP HERE - idle and answer alike - is a render from the
 * same lip-sync engine over a 124-frame base clip, with the audio padded to
 * exactly that length. Both halves of that matter and both were arrived at by
 * measuring a library that failed:
 *
 *   Padding to the base length is what makes a talking clip END on the pivot.
 *   The engine renders ceil(audio_seconds * fps) frames of the base starting at
 *   frame 0, so an unpadded clip stops on whatever frame the speech ran out on.
 *   Leading silence is what makes it START on the pivot - without it frame 0
 *   already carries the first phoneme's mouth shape.
 *
 *   Rendering the IDLE clips through the same engine is what makes the two
 *   families match. The engine regenerates the mouth region on every frame,
 *   silence included; that generated neutral mouth is consistent across renders
 *   (1.93-2.01 apart) but sits 6.22 from the original mouth in the untouched
 *   source footage. A library mixing rendered talking clips with raw reaction
 *   clips has two different mouths in it and steps the jaw at every join
 *   between them.
 *
 * Measured across all 18 clips, each against its OWN look's reference frame -
 * the checker groups by filename prefix, because three looks are three pivot
 * frames and they are not supposed to match. First frames land 0.00-6.6 worst
 * block out of 255; last frames 7.4-8.1 for the rotation clips.
 *
 * Two checkers, measuring different things, neither a substitute for the
 * other: check-clips.sh for alignment, check-mouth.py for whether a clip with
 * no audio keeps its mouth shut.
 */

// ⚠️ Resolved against THIS module's own URL, not against a base handed in by
// the caller. It was the latter, and the project page passed its own location -
// so the clips resolved to /clips/ at the site root and every one 404'd, while
// the page rendered fine and the link checker passed. This file lives beside
// the clips; nothing else needs to know where that is.
const at = (name) => new URL(`./clips/${name}`, import.meta.url).href;

/**
 * The pivot frame of a look, as a still.
 *
 * ⚠️ Extracted from frame 0 of that look's own clips - NOT the character's
 * poster image. They are not the same picture: measured, one look's poster sat
 * 4.6 out of 255 from every clip in that look while the clips sat within 2.9 of
 * each other. This still sits behind both video layers, so any moment neither
 * has a frame shows the pivot frame instead of the page background. Being 4.6
 * off would make that moment a visible jump; being frame 0 makes it invisible.
 */
const pivotAt = (name) => new URL(`../../site/img/${name}`, import.meta.url).href;

/**
 * Three looks, named for what she is wearing. Each has:
 *   still     the rest clip — the rotation returns to it and replays it in place
 *   motion    everything else in the idle rotation
 *   poster    that look's pivot frame, as a still, behind both video layers
 *   answers   one per question below
 *
 * ⚠️ `still` is not a naming convention, it is a measurement. A clip that is
 * named idle but actually moves as much as the gestures breaks the rotation,
 * and it breaks it in the assets rather than in the player — see
 * docs/05-assets.md, where three attempts to fix it in the playback rules all
 * failed.
 */
export function library() {
  const c = at;
  return {
    knit: {
      label: 'Knit sweater', labelZh: '針織衫',
      poster: pivotAt('pivot-knit.jpg'),
      still: c('knit_still.mp4'),
      motion: [c('knit_nod.mp4'), c('knit_listen.mp4')],
      answers: [c('knit_ans1.mp4'), c('knit_ans2.mp4'), c('knit_ans3.mp4')],
    },
    shirt: {
      label: 'Blouse', labelZh: '襯衫',
      poster: pivotAt('pivot-shirt.jpg'),
      still: c('shirt_still.mp4'),
      motion: [c('shirt_nod.mp4'), c('shirt_listen.mp4')],
      answers: [c('shirt_ans1.mp4'), c('shirt_ans2.mp4'), c('shirt_ans3.mp4')],
    },
    pj: {
      label: 'Nightwear', labelZh: '睡衣',
      poster: pivotAt('pivot-pj.jpg'),
      still: c('pj_still.mp4'),
      motion: [c('pj_nod.mp4'), c('pj_listen.mp4')],
      answers: [c('pj_ans1.mp4'), c('pj_ans2.mp4'), c('pj_ans3.mp4')],
    },
  };
}

/**
 * The demo character's name.
 *
 * She is named because a companion without a name is a widget, and every
 * write-up this project is answering names theirs. It costs nothing and it is
 * the difference between "the demo clip" and "asking her a question".
 *
 * ⚠️ The name belongs to THIS repository's demo, not to any product. Nothing
 * here is a character sheet: no backstory, no personality spec, no dialogue
 * rules. The three exchanges below are the entire script, and they exist to
 * show the playback, not the character.
 */
export const NAME = { en: 'Xiaoxian', zh: '小嫻' };

/** Look keys in the order they should be offered. */
export const LOOKS = ['knit', 'shirt', 'pj'];

/** The three canned exchanges, in both languages. */
export const QUESTIONS = [
  { en: 'What are you doing right now?', zh: '你現在在做什麼？',
    answerEn: 'I was waiting for you — wondering when you would show up.',
    answerZh: '我在這裡等你啊，剛剛還在想你什麼時候會來。' },
  { en: 'Do you ever get tired?', zh: '你會覺得累嗎？',
    answerEn: 'No. Stay as long as you like, I am here.',
    answerZh: '不會喔，你想聊多久都可以，我都在。' },
  { en: 'Do you like talking like this?', zh: '你喜歡這樣聊天嗎？',
    answerEn: 'I do. It beats sitting on my own.',
    answerZh: '喜歡啊，比一個人待著好多了。' },
];

/** Every clip in one flat list, for the rotation pool. */
export function poolFor(look) {
  return [look.still, ...look.motion];
}
