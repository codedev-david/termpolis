import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import React from 'react'
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'

import type { RootStackParamList } from '../navigation/routes'
import { useRemoteStore } from '../state/remoteStore'
import type { DirectoryEntry, RemoteAgent } from '../wire/protocol'

type Nav = NativeStackNavigationProp<RootStackParamList, 'FolderPicker'>
type Route = RouteProp<RootStackParamList, 'FolderPicker'>

/** The agent's name for the start button. The wire key is what the desktop maps
 *  to a binary; this is only ever shown. */
const AGENT_LABEL: Record<RemoteAgent, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }

/**
 * Pick a desktop folder, then launch the chosen agent in it.
 *
 * The tree is the desktop's, home-rooted and fenced there by the bridge, so this
 * screen only ever hands back paths the desktop itself just offered -- it never
 * builds one. It opens at the home root every time rather than resuming a past
 * spot, which is what "a folder picker from the desktop location" means.
 *
 * The controls follow the same rule as the terminal list: capability-gated and
 * `stale`-gated things are ABSENT, not disabled, because the desktop re-checks
 * every request and a control that reports a refusal the user cannot act on is
 * worse than one that is not there. The one exception is the fleeting moment
 * before the first listing lands, when the start button is shown but does
 * nothing -- there is no folder to start in yet.
 */
export default function FolderPickerScreen(): React.JSX.Element {
  const navigation = useNavigation<Nav>()
  const { agent } = useRoute<Route>().params
  const directory = useRemoteStore((s) => s.directory)
  const directoryLoading = useRemoteStore((s) => s.directoryLoading)
  const canCreate = useRemoteStore((s) => s.capabilities.createTerminal)
  const stale = useRemoteStore((s) => s.stale)
  const error = useRemoteStore((s) => s.error)
  const listDirectory = useRemoteStore((s) => s.listDirectory)
  const launchAgent = useRemoteStore((s) => s.launchAgent)

  const [launching, setLaunching] = React.useState(false)

  // Open at the desktop home, even if an earlier visit left the store deeper in
  // the tree. The store records any failure on the banner; nothing to add here.
  React.useEffect(() => {
    void listDirectory().catch(() => undefined)
  }, [listDirectory])

  async function onStart(): Promise<void> {
    // The button can be on screen before the first listing arrives; with no
    // folder there is nothing to launch in yet.
    if (directory === null) return
    setLaunching(true)
    // A refusal (offline, grant pulled, or a desktop that named no terminal) is
    // already on the banner via the store; null just keeps the user on the
    // picker rather than navigating nowhere.
    const launched = await launchAgent(agent, directory.path).catch(() => null)
    setLaunching(false)
    if (launched !== null) {
      // replace, not navigate: Back from the running agent returns to the list,
      // not to a folder picker whose job is done.
      navigation.replace('Terminal', { terminalId: launched.terminalId, name: launched.name })
    }
  }

  function renderEntry(entry: DirectoryEntry): React.JSX.Element {
    return (
      <Pressable
        testID={`folder-entry-${entry.name}`}
        accessibilityRole="button"
        style={styles.row}
        onPress={() => void listDirectory(entry.path).catch(() => undefined)}
      >
        <Text style={styles.rowName} numberOfLines={1}>
          {entry.name}
        </Text>
        <Text style={styles.chevron}>{'›'}</Text>
      </Pressable>
    )
  }

  // The parent to climb to, or null at the root. A const, so its narrowing to a
  // string survives into the row's onPress.
  const up = directory?.parent ?? null
  const upRow =
    up === null ? null : (
      <Pressable
        testID="folder-up"
        accessibilityRole="button"
        style={styles.row}
        onPress={() => void listDirectory(up).catch(() => undefined)}
      >
        <Text style={styles.rowName}>..</Text>
      </Pressable>
    )

  return (
    <View testID="folder-picker" style={styles.page}>
      {stale ? (
        <Text testID="folder-picker-offline" style={styles.offline}>
          The desktop is offline. Reconnect to choose a folder.
        </Text>
      ) : null}

      {error === null ? null : (
        <Text testID="folder-picker-error" style={styles.error}>
          {error}
        </Text>
      )}

      <Text testID="folder-path" style={styles.path} numberOfLines={1} ellipsizeMode="head">
        {directory === null ? 'Loading…' : directory.path}
      </Text>

      <FlatList
        testID="folder-list"
        data={directory === null ? [] : directory.entries}
        keyExtractor={(e) => e.path}
        renderItem={({ item }) => renderEntry(item)}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={upRow}
        ListEmptyComponent={
          directoryLoading ? (
            <ActivityIndicator testID="folder-loading" color="#0e9cd6" />
          ) : (
            <Text testID="folder-empty" style={styles.empty}>
              No subfolders here.
            </Text>
          )
        }
      />

      {canCreate && !stale ? (
        <Pressable
          testID="folder-start"
          accessibilityRole="button"
          style={styles.primary}
          onPress={() => void onStart()}
        >
          <Text style={styles.primaryText}>
            {launching ? 'Starting…' : `Start ${AGENT_LABEL[agent]} here`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#1e1e1e', padding: 16, gap: 12 },
  offline: { color: '#e5e510', fontSize: 13 },
  error: { color: '#f14c4c', fontSize: 13 },
  path: { color: '#9ca3af', fontSize: 12, fontFamily: 'monospace' },
  listContent: { gap: 8, paddingBottom: 24 },
  empty: { color: '#9ca3af', fontSize: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#252526',
    borderWidth: 1,
    borderColor: '#3c3c3c',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  rowName: { color: '#e0e0e0', fontSize: 15, flexShrink: 1 },
  chevron: { color: '#6b7280', fontSize: 18 },
  primary: {
    backgroundColor: '#0e639c',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
})
