import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import React from 'react'
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import type { RootStackParamList } from '../navigation/routes'
import { useRemoteStore } from '../state/remoteStore'
import type { TerminalSummary } from '../wire/protocol'

type Nav = NativeStackNavigationProp<RootStackParamList>

/** How the desktop's agent states read on a phone. Anything the desktop adds
 *  that this does not name falls back to the raw word, which is wrong-looking
 *  rather than missing -- a blank badge would read as "idle". */
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
 * What the desktop is running.
 *
 * Capability-gated controls are absent, not disabled. The desktop is the
 * authority on what this phone may do and re-checks every request against its
 * own record, so a control the phone renders anyway is a control that reports a
 * refusal the user cannot act on. Hiding it says the same thing without the
 * error.
 *
 * `stale` hides them too. It is not a permission, but the outcome is the same:
 * a request now would be refused before it reached the wire.
 */
export default function TerminalListScreen(): React.JSX.Element {
  const navigation = useNavigation<Nav>()
  const terminals = useRemoteStore((s) => s.terminals)
  const agentStatus = useRemoteStore((s) => s.agentStatus)
  const canCreate = useRemoteStore((s) => s.capabilities.createTerminal)
  const stale = useRemoteStore((s) => s.stale)
  const error = useRemoteStore((s) => s.error)
  const refreshTerminals = useRemoteStore((s) => s.refreshTerminals)
  const createTerminal = useRemoteStore((s) => s.createTerminal)

  const [refreshing, setRefreshing] = React.useState(false)
  const [composing, setComposing] = React.useState(false)
  const [name, setName] = React.useState('')

  async function onRefresh(): Promise<void> {
    setRefreshing(true)
    // The store records the failure; letting it escape would cost the user the
    // whole screen for something already on it.
    await refreshTerminals().catch(() => undefined)
    setRefreshing(false)
  }

  function onCreate(): void {
    const wanted = name.trim()
    if (wanted.length === 0) return
    setName('')
    setComposing(false)
    void createTerminal(wanted).catch(() => undefined)
  }

  function renderRow(terminal: TerminalSummary): React.JSX.Element {
    const status = agentStatus[terminal.id]
    return (
      <Pressable
        testID={`terminal-row-${terminal.id}`}
        accessibilityRole="button"
        style={styles.row}
        onPress={() => navigation.navigate('Terminal', { terminalId: terminal.id, name: terminal.name })}
      >
        <View style={styles.rowHead}>
          <Text style={styles.rowName}>{terminal.name}</Text>
          {status === undefined ? null : (
            <View testID={`terminal-status-${terminal.id}`} style={styles.badge}>
              <Text style={styles.badgeText}>{STATUS_LABEL[status.status] ?? status.status}</Text>
            </View>
          )}
        </View>
        <Text style={styles.rowCwd} numberOfLines={1}>
          {terminal.cwd}
        </Text>
        {status === undefined || status.summary.length === 0 ? null : (
          <Text style={styles.rowSummary} numberOfLines={2}>
            {status.summary}
          </Text>
        )}
      </Pressable>
    )
  }

  return (
    <View style={styles.page}>
      {stale ? (
        <Text testID="terminal-list-offline" style={styles.offline}>
          The desktop is offline. This is the last thing it told us.
        </Text>
      ) : null}

      {error === null ? null : (
        <Text testID="terminal-list-error" style={styles.error}>
          {error}
        </Text>
      )}

      {canCreate && !stale ? (
        composing ? (
          <View style={styles.composer}>
            <TextInput
              testID="terminal-new-name"
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="claude, codex, gemini..."
              placeholderTextColor="#6b7280"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable
              testID="terminal-new-submit"
              accessibilityRole="button"
              style={styles.primary}
              onPress={onCreate}
            >
              <Text style={styles.primaryText}>Start</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            testID="terminal-new"
            accessibilityRole="button"
            style={styles.primary}
            onPress={() => setComposing(true)}
          >
            <Text style={styles.primaryText}>New AI terminal</Text>
          </Pressable>
        )
      ) : null}

      <FlatList
        testID="terminal-list"
        data={terminals}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => renderRow(item)}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor="#9ca3af"
          />
        }
        ListEmptyComponent={
          <Text testID="terminal-list-empty" style={styles.empty}>
            {stale
              ? 'Nothing was running when the desktop last answered.'
              : 'The desktop is not running any terminals.'}
          </Text>
        }
      />
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#1e1e1e', padding: 16, gap: 12 },
  offline: { color: '#e5e510', fontSize: 13 },
  error: { color: '#f14c4c', fontSize: 13 },
  listContent: { gap: 10, paddingBottom: 24 },
  empty: { color: '#9ca3af', fontSize: 14, lineHeight: 20 },
  row: {
    backgroundColor: '#252526',
    borderWidth: 1,
    borderColor: '#3c3c3c',
    borderRadius: 10,
    padding: 12,
    gap: 4,
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowName: { color: '#e0e0e0', fontSize: 16, fontWeight: '600', flexShrink: 1 },
  rowCwd: { color: '#9ca3af', fontSize: 12, fontFamily: 'monospace' },
  rowSummary: { color: '#9ca3af', fontSize: 13 },
  badge: {
    backgroundColor: '#0e639c',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: { color: '#ffffff', fontSize: 11, fontWeight: '600' },
  composer: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    flex: 1,
    backgroundColor: '#252526',
    borderWidth: 1,
    borderColor: '#3c3c3c',
    borderRadius: 8,
    color: '#e0e0e0',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  primary: {
    backgroundColor: '#0e639c',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  primaryText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
})
