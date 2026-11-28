// When the 3D map's drawing buffer is fitted to its view (threeRenderer's fitBufferFor), in a module of its own: the
// e2e specs read it without loading three.

/**
 * How long the view's size must hold before the drawing buffer is fitted to it, once the view has drawn (resize).
 * Fitting the buffer gives the canvas a new size, which waits for the frames the GPU still has to draw (in software
 * rendering, a frame of a big world: 250 ms and more), so a pane divider dragged, which resizes the view every frame,
 * stretches the buffer it has over the new size and has it fitted once, when the drag holds still.
 */
export const BUFFER_SETTLE_MS = 150

/**
 * The performance measure each settled fit records (performance.measure, from the timer's call to the end of the
 * fit), so a check of the page's own work can leave out the fit by its name and count everything else.
 */
export const BUFFER_FIT_MEASURE = 'world-buffer-fit'

/**
 * The performance measure each resize records inside a frame-time window (perfBegin to perfEnd, the e2e harness's
 * __worldPerf), from the resize's start to its end: a check can then find it in a trace of the page and read its own
 * work on the thread's clock. Outside a window nothing is named, so a session's resizes leave nothing on the timeline.
 */
export const RESIZE_MEASURE = 'world-resize'

/**
 * The performance measure each look check after a settle records (threeRenderer's settleCheck in the task after the
 * fit's), so a check of the page's own work can log the look check's own and wall time apart (look plan A2.1 note (10),
 * Round 10): it is a task like any other, under the ordinary limits.
 */
export const LOOK_CHECK_MEASURE = 'world-look-check'
