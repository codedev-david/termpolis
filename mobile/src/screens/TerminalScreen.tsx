import { useRoute } from '@react-navigation/native'
import type { RouteProp } from '@react-navigation/native'
import React from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import OutputView from '../components/OutputView'
import type { RootStackParamList } from '../navigation/routes'
import { useRemoteStore } from '../state/remoteStore'

/** How the desktop's agent states read on a phone. See TerminalListScreen: an
 *  unnamed state falls back to the raw word rather than to nothing, because a
 *  blank line reads as "idle" and idle is a claim. */
const STATUS_LABEL: Record<string, string> = {
  starting: 'Starting',
  thinking: 'Thinking',
  waiting_for_input: 'Waiting for you',
  working: 'Working',
  idle: 'Idle',
  errored: 'Error',
  completed: 'Done',
  blocked: 'Blocked',
}

/**
 * One terminal: its scrollback, and a box to type into.
 *
 * The subscription is the screen's own. It is opened on mount and closed on
 * unmount -- including when the open failed, because the desktop is the
 * authority on whether a subscription exists and a one-sided assumption here
 * would leave output streaming to a screen nobody is looking at.
 *
 * The view keeps itself pinned to the bottom while the user is already there,
 * and stops following the moment they scroll up. Yanking someone back to the
 * end of a build log they are reading is worse than the missed line.
 *
 * The composer is present only with `writeToTerminal`. It is a separate grant
 * from `createTerminal` on the desktop precisely because it bypasses the
 * command sanitiser, so the phone must not infer one from the other.
 */
export default function TerminalScreen(): React.JSX.Element {
  const route = useRoute<RouteProp<RootStackParamList, 'Terminal'>>()
  const { terminalId } = route.params

  const text = useRemoteStore((s) => s.output[terminalId] ?? '')
  const status = useRemoteStore((s) => s.agentStatus[terminalId])
  const canWrite = useRemoteStore((s) => s.capabilities.writeToTerminal)
  const stale = useRemoteStore((s) => s.stale)
  const error = useRemoteStore((s) => s.error)
  const subscribe = useRemoteStore((s) => s.subscribe)
  const unsubscribe = useRemoteStore((s) => s.unsubscribe)
  const send = useRemoteStore((s) => s.send)

  const [draft, setDraft] = React.useState('')
  const scrollRef = React.useRef<ScrollView>(null)
  const pinned = React.useRef(true)

  React.useEffect(() => {
    void subscribe(terminalId).catch(() => undefined)
    return () => {
      void unsubscribe(terminalId).catch(() => undefined)
    }
  }, [terminalId, subscribe, unsubscribe])

  function onSend(): void {
    if (draft.length === 0 || stale) return
    const outgoing = draft
    // Sent exactly as typed. A terminal is not a form: indentation is meaningful
    // to whatever REPL is on the far end, so nothing here trims it.
    send(terminalId, outgoing)
      .then(() => setDraft(''))
      // Left in the box on failure -- clearing it would lose the text at the one
      // moment the user has to type it again.
      .catch(() => undefined)
  }

  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {stale ? (
        <Text testID="terminal-offline" style={styles.offline}>
          The desktop is offline. This is the last thing it sent.
        </Text>
      ) : null}

      {status === undefined ? null : (
        <View testID="terminal-agent-status" style={styles.statusBar}>
          <Text style={styles.statusLabel}>{STATUS_LABEL[status.status] ?? status.status}</Text>
          {status.summary.length === 0 ? null : (
            <Text style={styles.statusSummary} numberOfLines={2}>
              {status.summary}
            </Text>
          )}
        </View>
      )}

      {error === null ? null : (
        <Text testID="terminal-error" style={styles.error}>
          {error}
        </Text>
      )}

      <ScrollView
        testID="terminal-output"
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
          // A small slack, so a pixel of rubber-banding does not read as
          // "the user scrolled up".
          pinned.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (pinned.current) scrollRef.current?.scrollToEnd({ animated: false })
        }}
      >
        <OutputView text={text} />
      </ScrollView>

      {canWrite ? (
        <View style={styles.composer}>
          <TextInput
            testID="terminal-input"
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            editable={!stale}
            placeholder={stale ? 'Offline' : 'Type here'}
            placeholderTextColor="#6b7280"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            onSubmitEditing={onSend}
          />
          <Pressable
            testID="terminal-send"
            accessibilityRole="button"
            style={[styles.primary, stale ? styles.primaryDisabled : null]}
            onPress={onSend}
          >
            <Text style={styles.primaryText}>Send</Text>
          </Pressable>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#1e1e1e' },
  offline: { color: '#e5e510', fontSize: 13, paddingHorizontal: 12, paddingTop: 8 },
  error: { color: '#f14c4c', fontSize: 13, paddingHorizontal: 12, paddingTop: 8 },
  statusBar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 2,
  },
  statusLabel: { color: '#0e9cd6', fontSize: 12, fontWeight: '600' },
  statusSummary: { color: '#9ca3af', fontSize: 12 },
  scroll: { flex: 1 },
  scrollContent: { padding: 12 },
  composer: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#3c3c3c',
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    maxHeight: 120,
    backgroundColor: '#252526',
    borderWidth: 1,
    borderColor: '#3c3c3c',
    borderRadius: 8,
    color: '#e0e0e0',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: 'monospace',
  },
  primary: {
    backgroundColor: '#0e639c',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  primaryDisabled: { backgroundColor: '#3c3c3c' },
  primaryText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
})
