import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import React from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

import type { RootStackParamList } from '../navigation/routes'
import { useRemoteStore } from '../state/remoteStore'
import { MAX_PAIRINGS } from '../storage/identity'
import { MAX_DEVICE_LABEL } from '../wire/deviceLabel'

type Nav = NativeStackNavigationProp<RootStackParamList>

/**
 * Every desktop this phone is paired with, and which one is on screen.
 *
 * No connection state is shown per row, because the phone genuinely does not
 * know: it holds one relay socket at a time, so anything drawn next to the
 * other rows would be a guess dressed up as a reading. The desktop on screen
 * reports its connection in Settings and in the terminal list; the others
 * report nothing until they are selected, which is the truth.
 *
 * Names are local to this phone. The desktop is never told what it was called
 * here -- a label is how an owner tells two machines apart, not an identity,
 * and the thing that actually identifies a desktop is its key.
 *
 * Removing is offered per row and confirmed in place. It erases this phone's
 * key for that one desktop and leaves the rest alone, which is the whole reason
 * the keys are per-pairing.
 */
export default function DesktopsScreen(): React.JSX.Element {
  const pairings = useRemoteStore((s) => s.pairings)
  const paired = useRemoteStore((s) => s.paired)
  const selectDesktop = useRemoteStore((s) => s.selectDesktop)
  const renameDesktop = useRemoteStore((s) => s.renameDesktop)
  const forgetDesktop = useRemoteStore((s) => s.forgetDesktop)
  const nav = useNavigation<Nav>()

  /** The row whose name is being edited, and the row whose removal is being
   *  confirmed. Never both, and never two rows at once: a screen with three
   *  open confirmations is one where the wrong Remove gets tapped. */
  const [renaming, setRenaming] = React.useState<string | null>(null)
  const [removing, setRemoving] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState('')

  function onSelect(desktopPublicKey: string): void {
    // Selecting the desktop already on screen is a no-op in the store, so this
    // does not have to ask. Going back either way is what a switcher does.
    void selectDesktop(desktopPublicKey).catch(() => undefined)
    nav.goBack()
  }

  function startRename(desktopPublicKey: string, label: string): void {
    setRemoving(null)
    setDraft(label)
    setRenaming(desktopPublicKey)
  }

  function saveRename(desktopPublicKey: string): void {
    setRenaming(null)
    // The store refuses a blank name and keeps the old one. Swallowing the
    // rejection keeps a keychain that would not write from taking the screen
    // down with it; the list simply still says what it said.
    void renameDesktop(desktopPublicKey, draft).catch(() => undefined)
  }

  function startRemove(desktopPublicKey: string): void {
    setRenaming(null)
    setRemoving(desktopPublicKey)
  }

  function confirmRemove(desktopPublicKey: string): void {
    setRemoving(null)
    void forgetDesktop(desktopPublicKey).catch(() => undefined)
  }

  return (
    <ScrollView testID="desktops-page" style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.hint}>
        This phone talks to one desktop at a time. Pick one to put it on screen.
      </Text>

      {pairings.map((desktop) => {
        const key = desktop.desktopPublicKey
        const isActive = paired !== null && paired.desktopPublicKey === key
        return (
          <View key={key} style={isActive ? styles.cardActive : styles.card}>
            <Pressable
              testID={`desktop-row-${key}`}
              accessibilityRole="button"
              accessibilityLabel={desktop.label}
              onPress={() => onSelect(key)}
            >
              <Text style={styles.name}>{desktop.label}</Text>
              {isActive ? (
                <Text testID={`desktop-active-${key}`} style={styles.badge}>
                  Showing now
                </Text>
              ) : null}
              <Text style={styles.mono}>{desktop.deviceId}</Text>
              <Text style={styles.hint}>
                That is how this phone appears in Settings &rsaquo; Remote on that desktop.
              </Text>
            </Pressable>

            <View style={styles.actions}>
              <Pressable
                testID={`desktop-rename-${key}`}
                accessibilityRole="button"
                style={styles.secondary}
                onPress={() => startRename(key, desktop.label)}
              >
                <Text style={styles.secondaryText}>Rename</Text>
              </Pressable>
              <Pressable
                testID={`desktop-remove-${key}`}
                accessibilityRole="button"
                style={styles.secondary}
                onPress={() => startRemove(key)}
              >
                <Text style={styles.dangerText}>Remove</Text>
              </Pressable>
            </View>

            {renaming === key ? (
              <View style={styles.panel}>
                <Text style={styles.label}>Name on this phone</Text>
                <TextInput
                  testID={`desktop-rename-input-${key}`}
                  style={styles.input}
                  value={draft}
                  onChangeText={setDraft}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={MAX_DEVICE_LABEL}
                  placeholder="Workshop Linux box"
                  placeholderTextColor="#6b7280"
                />
                <View style={styles.actions}>
                  <Pressable
                    testID={`desktop-rename-save-${key}`}
                    accessibilityRole="button"
                    style={styles.secondary}
                    onPress={() => saveRename(key)}
                  >
                    <Text style={styles.secondaryText}>Save</Text>
                  </Pressable>
                  <Pressable
                    testID={`desktop-rename-cancel-${key}`}
                    accessibilityRole="button"
                    style={styles.secondary}
                    onPress={() => setRenaming(null)}
                  >
                    <Text style={styles.secondaryText}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            {removing === key ? (
              <View style={styles.panel}>
                <Text style={styles.body}>
                  Forget {desktop.label}? This phone erases its key for that desktop only. The
                  others stay paired, and pairing this one again means scanning a new code on it.
                </Text>
                <View style={styles.actions}>
                  <Pressable
                    testID={`desktop-remove-confirm-${key}`}
                    accessibilityRole="button"
                    style={styles.danger}
                    onPress={() => confirmRemove(key)}
                  >
                    <Text style={styles.dangerText}>Forget it</Text>
                  </Pressable>
                  <Pressable
                    testID={`desktop-remove-cancel-${key}`}
                    accessibilityRole="button"
                    style={styles.secondary}
                    onPress={() => setRemoving(null)}
                  >
                    <Text style={styles.secondaryText}>Keep it</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
          </View>
        )
      })}

      {pairings.length < MAX_PAIRINGS ? (
        <Pressable
          testID="desktops-add"
          accessibilityRole="button"
          style={styles.primary}
          onPress={() => nav.navigate('Pair')}
        >
          <Text style={styles.primaryText}>Pair another desktop</Text>
        </Pressable>
      ) : (
        <Text testID="desktops-limit" style={styles.hint}>
          This phone is paired with {MAX_PAIRINGS} desktops, which is as many as it holds. Remove
          one to pair another.
        </Text>
      )}
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
    gap: 10,
  },
  cardActive: {
    backgroundColor: '#252526',
    borderWidth: 1,
    borderColor: '#0e9cd6',
    borderRadius: 10,
    padding: 14,
    gap: 10,
  },
  panel: { borderTopWidth: 1, borderTopColor: '#3c3c3c', paddingTop: 10, gap: 8 },
  actions: { flexDirection: 'row', gap: 10 },
  name: { color: '#e0e0e0', fontSize: 17, fontWeight: '600' },
  badge: { color: '#0e9cd6', fontSize: 12, fontWeight: '600' },
  mono: { color: '#e0e0e0', fontSize: 13, fontFamily: 'monospace', lineHeight: 20 },
  label: { color: '#9ca3af', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6 },
  body: { color: '#9ca3af', fontSize: 14, lineHeight: 20 },
  hint: { color: '#6b7280', fontSize: 12, lineHeight: 18 },
  input: {
    borderWidth: 1,
    borderColor: '#3c3c3c',
    borderRadius: 8,
    color: '#e0e0e0',
    fontSize: 15,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  primary: {
    borderWidth: 1,
    borderColor: '#0e9cd6',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryText: { color: '#0e9cd6', fontSize: 15, fontWeight: '600' },
  secondary: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#3c3c3c',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  danger: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#f14c4c',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  secondaryText: { color: '#e0e0e0', fontSize: 14, fontWeight: '600' },
  dangerText: { color: '#f14c4c', fontSize: 14, fontWeight: '600' },
})
