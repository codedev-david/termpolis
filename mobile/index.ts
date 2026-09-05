// MUST be first. `@noble` reads `globalThis.crypto.getRandomValues` at call time
// and React Native does not provide one. Importing this after any module that
// generates a key means the key was drawn from something that is not a CSPRNG --
// a total break that passes every test you would think to write.
import 'react-native-get-random-values'

import { registerRootComponent } from 'expo'
import App from './src/App'

registerRootComponent(App)
