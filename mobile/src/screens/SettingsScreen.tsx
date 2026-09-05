import Constants from 'expo-constants'
import React from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import { useRemoteStore } from '../state/remoteStore'
import type { Capabilities } from '../wire/protocol'

/** The capabilities, in the order they escalate: reading, then starting, then
 *  typing, then closing. Listing them from a literal rather than from
 *  `Object.keys` keeps the wording and the order under this file's control --
 *  and makes a capability the desktop adds show up as a compile error here
 *  rather than as an unlabelled row. */
const CAPABILITY_LABEL: Array<[keyof Capabilities, string]> = [
  ['read', 'Read terminal output'],
  ['createTerminal', 'Start new AI terminals'],
  ['writeToTerminal', 'Type into terminals'],
  ['closeTerminal', 'Close terminals'],
]

/** How the relay states read. `attached` is the only one that means the desktop
 *  is actually on the other end; the rest are degrees of not-yet. */
const CONNECTION_LABEL: Record<string, string> = {
  connecting: 'Connecting',
  online: 'Waiting for the desktop',
  attached: 'Connected',
  offline: 'Offline',
  blocked: 'Refused by the relay',
}

/**
 * What this phone is paired to, and the one control that ends it.
 *
 * The capabilities are reported, not offered. The desktop grants them and
 * re-checks every request against its own record, so a switch here would be a
 * lie the moment it disagreed. They are text.
 *
 * Unpair is local and unconditional. It drops this phone's key whether or not
 * the relay is reachable -- a phone that can only be unpaired while online is
 * a phone that cannot be unpaired at the moment it matters, which is usually
 * the moment it is not in the owner's hand. The desktop keeps its own revoke,
 * and either side is sufficient: the session key cannot be re-derived without
 * both identities.
 */
export default function SettingsScreen(): React.JSX.Element {
  const paired = useRemoteStore((s) => s.paired)
  const phrase = useRemoteStore((s) => s.safetyPhrase)
  const capabilities = useRemoteStore((s) => s.capabilities)
  const status = useRemoteStore((s) => s.status)
  const stale = useRemoteStore((s) => s.stale)
  const unpair = useRemoteStore((s) => s.unpair)

  const [asking, setAsking] = React.useState(false)
  const version = Constants.expoConfig?.version ?? 'unknown'

  function onUnpair(): void {
    setAsking(false)
    // The store clears storage and closes the socket. A rejection here means
    // the keychain refused, which the store has already recorded; swallowing it
    // keeps a failed erase from taking the screen down with it.
    void unpair().catch(() => undefined)
  }

  return (
    <ScrollView testID="settings-page" style={styles.page} contentContainerStyle={styles.content}>
      {paired === null ? (
        <Text testID="settings-unpaired" style={styles.body}>
          This phone is not paired with a desktop.
        </Text>
      ) : (
        <>
          <View style={styles.card}>
            <Text style={styles.label}>Paired with</Text>
            <Text style={styles.value}>{paired.label}</Text>

            <Text style={styles.label}>Connection</Text>
            <Text testID="settings-connection" style={styles.value}>
              {CONNECTION_LABEL[status] ?? status}
            </Text>
            <Text style={styles.mono}>{paired.relayUrl}</Text>

            {stale ? (
              <Text testID="settings-offline" style={styles.offline}>
                The desktop is offline. Nothing on this phone is being kept current.
              </Text>
            ) : null}

            <Text style={styles.label}>This phone</Text>
            <Text style={styles.mono}>{paired.deviceId}</Text>
            <Text style={styles.hint}>
              Termpolis lists this phone under that id, in Settings on the desktop.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>Safety words</Text>
            <Text testID="settings-safety-phrase" style={styles.mono}>
              {phrase ?? 'Not derived yet.'}
            </Text>
            <Text style={styles.hint}>
              These must match the desktop&apos;s. They do not change while the pairing lasts, so
              they can be compared again at any time.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>What the desktop allows</Text>
            {CAPABILITY_LABEL.map(([key, label]) => (
              <View key={key} style={styles.capRow}>
                <Text style={styles.capName}>{label}</Text>
                <Text
                  testID={`settings-capability-${key}`}
                  style={capabilities[key] ? styles.capOn : styles.capOff}
                >
                  {capabilities[key] ? 'Granted' : 'Not granted'}
                </Text>
              </View>
            ))}
            <Text style={styles.hint}>
              Granted on the desktop, in Settings &rsaquo; Remote. This phone can only report them.
            </Text>
          </View>

          {asking ? (
            <View style={styles.card}>
              <Text style={styles.body}>
                Unpair from {paired.label}? This phone will forget its key, and pairing again means
                scanning a new code on the desktop.
              </Text>
              <Pressable
                testID="settings-unpair-confirm"
                accessibilityRole="button"
                style={styles.danger}
                onPress={onUnpair}
              >
                <Text style={styles.dangerText}>Unpair</Text>
              </Pressable>
              <Pressable
                testID="settings-unpair-cancel"
                accessibilityRole="button"
                style={styles.secondary}
                onPress={() => setAsking(false)}
              >
                <Text style={styles.secondaryText}>Keep it</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              testID="settings-unpair"
              accessibilityRole="button"
              style={styles.danger}
              onPress={() => setAsking(true)}
            >
              <Text style={styles.dangerText}>Unpair this phone</Text>
            </Pressable>
          )}
        </>
      )}

      <Text style={styles.label}>Termpolis Remote</Text>
      <Text style={styles.mono}>{version}</Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#1e1e1e' },
  content: { padding: 20, gap: 16 },
  card: {
    backgroundColor: '#252526',
    borderWidth: 1,
    borderColor: '#3c3c3c',
    borderRadius: 10,
    padding: 14,
    gap: 6,
  },
  label: { color: '#9ca3af', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6 },
  value: { color: '#e0e0e0', fontSize: 16, fontWeight: '600' },
  mono: { color: '#e0e0e0', fontSize: 13, fontFamily: 'monospace', lineHeight: 20 },
  body: { color: '#9ca3af', fontSize: 14, lineHeight: 20 },
  hint: { color: '#6b7280', fontSize: 12, lineHeight: 18 },
  offline: { color: '#e5e510', fontSize: 13, lineHeight: 18 },
  capRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  capName: { color: '#e0e0e0', fontSize: 14, flexShrink: 1 },
  capOn: { color: '#4ec9b0', fontSize: 13, fontWeight: '600' },
  capOff: { color: '#6b7280', fontSize: 13 },
  danger: {
    borderWidth: 1,
    borderColor: '#f14c4c',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  dangerText: { color: '#f14c4c', fontSize: 15, fontWeight: '600' },
  secondary: {
    borderWidth: 1,
    borderColor: '#3c3c3c',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryText: { color: '#e0e0e0', fontSize: 15, fontWeight: '600' },
})
