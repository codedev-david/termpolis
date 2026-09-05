import { CameraView, useCameraPermissions } from 'expo-camera'
import React, { useCallback, useRef, useState } from 'react'
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import { useRemoteStore } from '../state/remoteStore'

/** What the desktop's device list will call this phone until it is renamed
 *  there. The phone has no way to read the hardware name without adding a
 *  native module, and a wrong-but-honest default beats a permission prompt. */
const DEVICE_LABEL = Platform.OS === 'ios' ? 'iPhone' : 'Android phone'

/**
 * Scan the code the desktop is showing, or -- when the camera is off for good
 * -- type it in.
 *
 * There are three states and deliberately no fourth: not yet granted, denied
 * for good, and scanning. A permission the hook has not resolved yet reads as
 * "not yet granted", which is what it is; a spinner state would only add a
 * flicker between two screens that say the same thing.
 */
export default function PairScreen(): React.JSX.Element {
  const [permission, requestPermission] = useCameraPermissions()
  const paired = useRemoteStore((s) => s.paired)
  const error = useRemoteStore((s) => s.error)
  const pairFromQr = useRemoteStore((s) => s.pairFromQr)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  // A ref, not the state: the scanner fires many times per second and re-renders
  // do not land between two frames.
  const busyRef = useRef(false)

  const pair = useCallback(
    (raw: string): void => {
      if (busyRef.current || paired !== null || raw.length === 0) return
      busyRef.current = true
      setBusy(true)
      void pairFromQr(raw, DEVICE_LABEL).finally(() => {
        busyRef.current = false
        setBusy(false)
      })
    },
    [paired, pairFromQr],
  )

  const onScan = useCallback(
    (event: { data?: string }): void => {
      // The code stays in frame for as long as the user holds the phone there,
      // and both platforms keep firing. Only the first one is a scan.
      if (typeof event.data === 'string') pair(event.data)
    },
    [pair],
  )

  const granted = permission?.granted === true
  // Android returns denied-but-askable after a single "Deny"; the prompt still
  // works there, so only a permission that can never be asked for again earns
  // the "go to Settings" copy.
  const blocked = permission != null && !permission.granted && !permission.canAskAgain

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Pair with your desktop</Text>

      {error !== null && (
        <Text testID="pair-error" style={styles.error}>
          {error}
        </Text>
      )}

      {granted ? (
        <View style={styles.scanner}>
          <Text style={styles.body}>
            In Termpolis on your desktop, open Settings, choose Remote, then Pair a device. Point
            the camera at the code. It works once, and only while the countdown is running.
          </Text>
          <View style={styles.frame}>
            <CameraView
              testID="camera-view"
              style={StyleSheet.absoluteFill}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={onScan}
            />
          </View>
          {busy && <Text style={styles.body}>Pairing…</Text>}
        </View>
      ) : blocked ? (
        <View style={styles.block}>
          <Text testID="pair-denied" style={styles.body}>
            Camera access is off for Termpolis Remote. Turn it on in your device settings, or type
            the code in by hand — the desktop shows it as text underneath the picture.
          </Text>
          <TextInput
            testID="pair-manual-input"
            style={styles.input}
            value={typed}
            onChangeText={setTyped}
            placeholder="Paste the pairing code"
            placeholderTextColor="#6b7280"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />
          <Pressable
            testID="pair-manual-submit"
            accessibilityRole="button"
            style={styles.button}
            onPress={() => pair(typed.trim())}
          >
            <Text style={styles.buttonText}>{busy ? 'Pairing…' : 'Pair'}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.block}>
          <Text testID="pair-rationale" style={styles.body}>
            Termpolis Remote uses the camera for one thing: reading the pairing code on your
            desktop. Nothing is recorded, and no image leaves this phone.
          </Text>
          <Pressable
            testID="pair-request-permission"
            accessibilityRole="button"
            style={styles.button}
            onPress={() => void requestPermission()}
          >
            <Text style={styles.buttonText}>Allow camera access</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#1e1e1e' },
  content: { padding: 20, gap: 16 },
  title: { color: '#e0e0e0', fontSize: 20, fontWeight: '600' },
  body: { color: '#9ca3af', fontSize: 14, lineHeight: 20 },
  error: { color: '#f14c4c', fontSize: 14, lineHeight: 20 },
  block: { gap: 16 },
  scanner: { gap: 16 },
  frame: {
    aspectRatio: 1,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000000',
    borderWidth: 1,
    borderColor: '#3c3c3c',
  },
  input: {
    minHeight: 96,
    color: '#d4d4d4',
    backgroundColor: '#252526',
    borderWidth: 1,
    borderColor: '#3c3c3c',
    borderRadius: 8,
    padding: 12,
    fontSize: 12,
    textAlignVertical: 'top',
  },
  button: {
    backgroundColor: '#0e639c',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
})
