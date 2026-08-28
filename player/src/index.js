/**
 * pivot-frame player: cut between short clips of the same subject without a
 * visible seam.
 *
 * Requires a clip library where every clip starts and ends on the same frame.
 * See docs/05-assets.md for how to verify yours does, and docs/06-playback.md
 * for the measurements behind the constants here.
 */
export { PivotStage } from './stage.js';
export { MoodPicker, pickOther, defaultIsStill } from './picker.js';
export { SpeakQueue } from './queue.js';
export { whenPaintable, afterFirstFrame, crossfade, play } from './handover.js';
