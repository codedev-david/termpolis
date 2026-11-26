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
