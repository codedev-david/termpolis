import { Component, lazy, Suspense, type ComponentProps, type LazyExoticComponent } from 'react'
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
}

export class WorldPaneBoundary extends Component<Props, State> {
  state: State = { failed: false, View: lazy(this.props.load) }

  // React logs the caught error to console.error when it commits this fallback.
  static getDerivedStateFromError(): Pick<State, 'failed'> {
    return { failed: true }
  }

  private retry = (): void => {
    // React caches rejections on the lazy component, so each retry needs a fresh one.
    this.setState({ failed: false, View: lazy(this.props.load) })
  }

  private focusHeading = (heading: HTMLHeadingElement | null): void => {
    heading?.focus()
  }

  render(): JSX.Element {
    const { load: _load, ...viewProps } = this.props
    const { width, overlay, onClose } = viewProps
    const { failed, View } = this.state
    if (failed) {
      return (
        <div style={worldPaneStyle(WORLD_OPENING_BACKGROUND, width, overlay)}>
          <div role="alert" className="m-auto flex flex-col items-center gap-3 p-4 text-center">
            <h2 tabIndex={-1} ref={this.focusHeading} className="text-lg font-semibold">
              Lumopolis couldn't open
            </h2>
            <p className="text-sm text-[#9ca3af]">Something stopped Lumopolis from loading. Your terminals are fine.</p>
            <div className="flex gap-3">
              <button type="button" className="rounded bg-[#0078d4] px-3 py-1.5 text-xs text-white hover:bg-[#106ebe]" onClick={this.retry}>Try again</button>
              <button type="button" className="rounded bg-[#3c3c3c] px-3 py-1.5 text-xs hover:bg-[#4c4c4c]" onClick={onClose}>Close</button>
            </div>
          </div>
        </div>
      )
    }

    return (
      <Suspense fallback={<WorldPaneOpening width={width} overlay={overlay} onClose={onClose} />}>
        <View {...viewProps} />
      </Suspense>
    )
  }
}
