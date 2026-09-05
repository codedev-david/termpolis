import { useNavigation } from '@react-navigation/native'
import React from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import { useRemoteStore } from '../state/remoteStore'

/**
 * The eight words, and the two answers.
 *
 * A safety number nobody compares is decoration, and a screen whose only
 * control is "Continue" teaches the user to tap through it. So both answers
 * are here, and the wrong one is not a warning: it unpairs on the spot. The
 * phone can do that alone -- the session key cannot be re-derived without both
 * identities, so dropping ours ends the relationship whether or not the relay
 * or the desktop is reachable.
 */
export default function SafetyNumberScreen(): React.JSX.Element {
  const navigation = useNavigation()
  const phrase = useRemoteStore((s) => s.safetyPhrase)
  const unpair = useRemoteStore((s) => s.unpair)
  const words = phrase === null ? [] : phrase.split(' ').filter((word) => word.length > 0)

  if (words.length === 0) {
    return (
      <ScrollView style={styles.page} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Safety words</Text>
        <Text testID="safety-none" style={styles.body}>
          There is no paired desktop, so there is nothing to compare yet.
        </Text>
      </ScrollView>
    )
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Safety words</Text>
      <Text testID="safety-instruction" style={styles.body}>
        Compare these words with the ones Termpolis is showing on your desktop. If they match,
        nobody is sitting in the middle of the connection. If they do not, unpair and pair again.
      </Text>

      <View style={styles.grid}>
        {words.map((word, index) => (
          <View key={`${index}-${word}`} style={styles.chip}>
            <Text testID={`safety-word-${index}`} style={styles.word}>
              {word}
            </Text>
          </View>
        ))}
      </View>

      <Pressable
        testID="safety-match"
        accessibilityRole="button"
        style={styles.primary}
        onPress={() => navigation.goBack()}
      >
        <Text style={styles.primaryText}>They match</Text>
      </Pressable>

      <Pressable
        testID="safety-mismatch"
        accessibilityRole="button"
        style={styles.danger}
        onPress={() => void unpair()}
      >
        <Text style={styles.dangerText}>They do not match — unpair</Text>
      </Pressable>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#1e1e1e' },
  content: { padding: 20, gap: 16 },
  title: { color: '#e0e0e0', fontSize: 20, fontWeight: '600' },
  body: { color: '#9ca3af', fontSize: 14, lineHeight: 20 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    backgroundColor: '#252526',
    borderWidth: 1,
    borderColor: '#3c3c3c',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  word: { color: '#e0e0e0', fontSize: 15, fontFamily: 'monospace' },
  primary: {
    backgroundColor: '#0e639c',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  danger: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#f14c4c',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  dangerText: { color: '#f14c4c', fontSize: 15, fontWeight: '600' },
})
