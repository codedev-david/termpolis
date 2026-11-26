import { Component, createRef, lazy, Suspense, type ComponentProps, type LazyExoticComponent } from 'react'
import type { WorldView } from './WorldView'
import {
  WORLD_OPENING_BACKGROUND, WorldPaneOpening, worldPaneStyle, type WorldPaneOverlay,
} from './worldPane'

type Props = ComponentProps<typeof WorldView> & {
  load: () => Promise<{ default: typeof WorldView }>
  width: number
  overlay: WorldPaneOverlay | null
}

interface State {
  failed: boolean
  View: LazyExoticComponent<typeof WorldView>
  /** The focus was in the failure when the pane started over: the opening's Close takes it, so it is not lost. */
  refocus: boolean
}

export class WorldPaneBoundary extends Component<Props, State> {
  state: State = { failed: false, View: lazy(this.props.load), refocus: false }
  private failure = createRef<HTMLDivElement>()

  // React logs the caught error to console.error when it commits this fallback.
  static getDerivedStateFromError(): Pick<State, 'failed'> {
    return { failed: true }
  }

  componentDidUpdate(prev: Props): void {
    // A pane stuck on "couldn't open" tries again when another world or terminal is asked for.
    if (this.state.failed && (prev.request !== this.props.request || prev.root !== this.props.root)) this.retry()
  }

  private retry = (): void => {
    // React caches rejections on the lazy component, so each retry needs a fresh one.
    const refocus = this.failure.current?.contains(document.activeElement) === true
    this.setState({ failed: false, View: lazy(this.props.load), refocus })
  }

  private focusHeading = (heading: HTMLHeadingElement | null): void => {
    heading?.focus()
  }

  render(): JSX.Element {
    const { load: _load, ...viewProps } = this.props
    const { width, overlay, onClose } = viewProps
    const { failed, View, refocus } = this.state
    if (failed) {
      // The heading takes the focus and is read with the line under it (A11Y M2): no alert as well, which a screen
      // reader would read a second time.
      return (
        <div style={worldPaneStyle(WORLD_OPENING_BACKGROUND, width, overlay)}>
          <div ref={this.failure} data-testid="world-pane-failed" className="m-auto flex flex-col items-center gap-3 p-4 text-center">
            <h2 tabIndex={-1} ref={this.focusHeading} aria-describedby="world-pane-failed-text" className="text-lg font-semibold">
              Lumopolis couldn't open
            </h2>
            <p id="world-pane-failed-text" className="text-sm text-[#9ca3af]">Something stopped Lumopolis from loading. Your terminals are fine.</p>
            <div className="flex gap-3">
              <button type="button" className="rounded bg-[#0078d4] px-3 py-1.5 text-xs text-white hover:bg-[#106ebe]" onClick={this.retry}>Try again</button>
              <button type="button" className="rounded bg-[#3c3c3c] px-3 py-1.5 text-xs hover:bg-[#4c4c4c]" onClick={onClose}>Close</button>
            </div>
          </div>
        </div>
      )
    }

    return (
      <Suspense fallback={<WorldPaneOpening width={width} overlay={overlay} onClose={onClose} takeFocus={refocus} />}>
        <View {...viewProps} />
      </Suspense>
    )
  }
}
