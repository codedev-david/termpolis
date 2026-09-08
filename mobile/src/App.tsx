import {
  DarkTheme,
  NavigationContainer,
  useNavigationContainerRef,
} from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { StatusBar } from 'expo-status-bar'
import React from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import type { RootStackParamList } from './navigation/routes'
import DesktopsScreen from './screens/DesktopsScreen'
import PairScreen from './screens/PairScreen'
import SafetyNumberScreen from './screens/SafetyNumberScreen'
import SettingsScreen from './screens/SettingsScreen'
import TerminalListScreen from './screens/TerminalListScreen'
import TerminalScreen from './screens/TerminalScreen'
import { pairingStamp } from './state/pairingStamp'
import { useRemoteStore } from './state/remoteStore'

const Stack = createNativeStackNavigator<RootStackParamList>()

const THEME = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: '#1e1e1e',
    card: '#252526',
    text: '#e0e0e0',
    border: '#3c3c3c',
    primary: '#0e9cd6',
  },
}

/**
 * The shell.
 *
 * Which screens exist is decided by whether ANY desktop is paired, not by
 * guarding each screen at its own top. An unpaired phone has no terminal
 * screens in its navigator at all, so there is no route for a stale link or a
 * mistimed `navigate` to reach.
 *
 * Nothing is rendered until `boot()` has answered. The alternative -- assume
 * unpaired, correct later -- flashes the pairing screen at someone who is
 * already paired, and a pairing screen is exactly where a phone should not
 * teach its owner to tap through.
 *
 * A pairing that appears while the app is running is one the user just made, so
 * the safety words are pushed on top of the list. Which pairing is "new" is read
 * off `pairingStamp` rather than off a single stored key, because pairing a
 * second desktop -- or re-pairing one already on the list, which mints a fresh
 * key for it -- has to show its words too. A pairing that was already there at
 * boot was compared when it was made, and re-showing it every launch is how a
 * verification step becomes a splash screen.
 */
export default function App(): React.JSX.Element {
  const paired = useRemoteStore((s) => s.paired)
  const pairings = useRemoteStore((s) => s.pairings)
  const boot = useRemoteStore((s) => s.boot)
  const navigation = useNavigationContainerRef<RootStackParamList>()

  const [ready, setReady] = React.useState(false)
  const started = React.useRef(false)
  /** The newest pairing as of the last render, so a new one can be told from a
   *  restored one. Seeded when boot answers, before anything is drawn. */
  const seen = React.useRef(0)

  React.useEffect(() => {
    if (started.current) return
    started.current = true
    void boot()
      // A keychain that refused to answer is a phone with no pairing, not a
      // dead app. The store recorded the failure; the pairing screen is next.
      .catch(() => undefined)
      .finally(() => {
        seen.current = pairingStamp(useRemoteStore.getState().pairings)
        setReady(true)
      })
  }, [boot])

  React.useEffect(() => {
    if (!ready) return
    const now = pairingStamp(pairings)
    const before = seen.current
    seen.current = now
    if (now <= before || !navigation.isReady()) return
    // Reset rather than push. The new pairing may have been made from the Pair
    // screen INSIDE the paired stack, and "they match" ends in goBack -- which
    // would otherwise land the user back on a camera pointed at a code that has
    // already been spent.
    navigation.reset({ index: 1, routes: [{ name: 'Terminals' }, { name: 'SafetyNumber' }] })
  }, [ready, pairings, navigation])

  if (!ready) {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <View testID="app-loading" style={styles.loading}>
          <ActivityIndicator color="#0e9cd6" />
        </View>
      </SafeAreaProvider>
    )
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer ref={navigation} theme={THEME}>
        <Stack.Navigator>
          {paired === null ? (
            <Stack.Screen
              name="Pair"
              component={PairScreen}
              options={{ title: 'Pair with your desktop' }}
            />
          ) : (
            <>
              <Stack.Screen
                name="Terminals"
                component={TerminalListScreen}
                options={({ navigation: nav }) => ({
                  // The desktop's own name, so a phone paired with several says
                  // which one is on screen without being asked.
                  title: paired.label,
                  headerLeft: () => (
                    <Pressable
                      testID="header-desktops"
                      accessibilityRole="button"
                      accessibilityLabel="Desktops"
                      onPress={() => nav.navigate('Desktops')}
                    >
                      <Text style={styles.headerAction}>Desktops</Text>
                    </Pressable>
                  ),
                  headerRight: () => (
                    <Pressable
                      testID="header-settings"
                      accessibilityRole="button"
                      accessibilityLabel="Settings"
                      onPress={() => nav.navigate('Settings')}
                    >
                      <Text style={styles.headerAction}>Settings</Text>
                    </Pressable>
                  ),
                })}
              />
              <Stack.Screen
                name="Terminal"
                component={TerminalScreen}
                options={({ route }) => ({ title: route.params.name })}
              />
              <Stack.Screen
                name="SafetyNumber"
                component={SafetyNumberScreen}
                options={{ title: 'Safety words' }}
              />
              <Stack.Screen
                name="Settings"
                component={SettingsScreen}
                options={{ title: 'Settings' }}
              />
              <Stack.Screen
                name="Desktops"
                component={DesktopsScreen}
                options={{ title: 'Desktops' }}
              />
              {/* Also in the paired stack, not only the empty one: adding a
                  second desktop is a thing an already-paired phone does. */}
              <Stack.Screen
                name="Pair"
                component={PairScreen}
                options={{ title: 'Pair another desktop' }}
              />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: '#1e1e1e', alignItems: 'center', justifyContent: 'center' },
  headerAction: { color: '#0e9cd6', fontSize: 15 },
})
