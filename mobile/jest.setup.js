// `SafeAreaProvider` measures its own frame and renders `null` until the layout
// event arrives. jsdom never fires one, so without this every test that mounts
// the app shell sees an empty provider and reports the screens as missing
// rather than as unrendered. The library ships this mock for exactly that, on
// its default export.
jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default,
)
