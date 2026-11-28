// The terminals' GPU question, asked off the page's main thread (webglSupport.ts, BUILDFLAKE): a context made on an
// OffscreenCanvas here waits on a busy GPU process without freezing the page. Posts the renderer's name, '' when the
// host hides it, or null when there is no WebGL2 context.
import { probeRenderer } from './webglSupport'

postMessage(probeRenderer(() => new OffscreenCanvas(1, 1).getContext('webgl2') as WebGL2RenderingContext | null))
