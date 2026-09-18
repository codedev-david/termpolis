import React from 'react'
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'

import { useSubscription } from '../state/subscription'

/** Apple's standard EULA.
 *
 *  Required on the purchase screen itself by 3.1.2, alongside the privacy
 *  policy -- a subscription sold without both links in front of the customer is
 *  a rejection, and it is the single most common one. This app has no licence
 *  terms of its own, and Apple's standard agreement is what applies by default
 *  when none are supplied, so linking it is accurate rather than a placeholder. */
const TERMS_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/'

/** The same policy the App Store listing points at. One document, one URL: a
 *  second copy is a second thing to keep true. */
const PRIVACY_URL = 'https://termpolis.com/privacy.html'

/**
 * What relay access costs, and the two buttons Apple requires next to it.
 *
 * The whole screen, not a sheet over the app. Relay access IS the product --
 * the desktop is what runs the agents, and this phone's only job is reaching it
 * through the relay -- so there is no useful half of the app to leave visible
 * behind a dismissible overlay. A paywall you can swipe away from a working app
 * teaches people to swipe it away.
 *
 * Every figure on it comes from the store. `price` and `intro` are null until
 * the catalogue answers, and the copy has to read correctly while they are: a
 * paywall that flashes "then $0.00 a month" for half a second has told somebody
 * a price that is not true. So the button says "Subscribe" until there is a
 * number to put after it, and the terms below name the store rather than a
 * figure.
 *
 * Restore is not a courtesy. A customer who subscribed, deleted the app and
 * reinstalled it -- or who bought on one phone and opened another -- has no
 * other way back in, and 3.1.1 requires the control exist on this screen.
 */
export default function PaywallScreen(): React.JSX.Element {
  const price = useSubscription((s) => s.price)
  const intro = useSubscription((s) => s.intro)
  const busy = useSubscription((s) => s.busy)
  const error = useSubscription((s) => s.error)
  const buy = useSubscription((s) => s.buy)
  const restore = useSubscription((s) => s.restore)
  const clearError = useSubscription((s) => s.clearError)

  function onBuy(): void {
    // Swallowed for the same reason every other action here is: the store
    // records the failure on `error` and the banner reports it. A rejection
    // that escaped would take the only screen the app has down with it.
    void buy().catch(() => undefined)
  }

  function onRestore(): void {
    void restore().catch(() => undefined)
  }

  function open(url: string): void {
    // A phone with no browser is not a case worth branching on, but a promise
    // nobody catches is a crash on the ones that refuse.
    void Linking.openURL(url).catch(() => undefined)
  }

  return (
    <ScrollView testID="paywall-page" style={styles.page} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.label}>Termpolis Remote</Text>
        <Text style={styles.value}>Relay access</Text>
        <Text style={styles.body}>
          Your phone reaches your desktop through the Termpolis relay: an encrypted, pass-through
          connection that carries terminal output to this phone and your typing back. Nothing is
          stored on it and nothing is readable by it -- the keys are on your two devices only.
        </Text>
        <Text style={styles.hint}>
          The desktop app stays free. This covers running the relay the phone connects through.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Subscription</Text>
        {price === null ? (
          <Text testID="paywall-price" style={styles.value}>
            Monthly
          </Text>
        ) : (
          <Text testID="paywall-price" style={styles.value}>
            {price} a month
          </Text>
        )}
        {intro === null ? null : (
          <Text testID="paywall-intro" style={styles.intro}>
            {intro}
          </Text>
        )}
        <Text style={styles.hint}>
          One month at a time. Cancel whenever you like and it stops at the end of the month you
          have paid for.
        </Text>
      </View>

      {error === null ? null : (
        <Pressable
          testID="paywall-error"
          accessibilityRole="button"
          accessibilityLabel="Dismiss this message"
          style={styles.banner}
          onPress={clearError}
        >
          <Text style={styles.bannerText}>{error}</Text>
        </Pressable>
      )}

      <Pressable
        testID="paywall-buy"
        accessibilityRole="button"
        disabled={busy}
        style={busy ? styles.primaryQuiet : styles.primary}
        onPress={onBuy}
      >
        {busy ? (
          <ActivityIndicator testID="paywall-busy" color="#1e1e1e" />
        ) : (
          <Text style={styles.primaryText}>{intro === null ? 'Subscribe' : 'Start free week'}</Text>
        )}
      </Pressable>

      <Pressable
        testID="paywall-restore"
        accessibilityRole="button"
        disabled={busy}
        style={styles.secondary}
        onPress={onRestore}
      >
        <Text style={styles.secondaryText}>Restore purchases</Text>
      </Pressable>

      <View style={styles.card}>
        <Text style={styles.terms}>
          Payment is taken by the App Store when you confirm the purchase. The subscription renews
          each month unless you cancel it at least 24 hours before the month ends, and you can
          cancel it at any time in Settings &rsaquo; your name &rsaquo; Subscriptions on this phone.
        </Text>
        {intro === null ? null : (
          <Text testID="paywall-trial-terms" style={styles.terms}>
            The free period runs from the moment you subscribe. Cancelling before it ends costs
            nothing; any part of it you have not used is given up if you subscribe again later.
          </Text>
        )}
        <View style={styles.links}>
          <Pressable
            testID="paywall-terms"
            accessibilityRole="link"
            onPress={() => open(TERMS_URL)}
          >
            <Text style={styles.link}>Terms of Use</Text>
          </Pressable>
          <Pressable
            testID="paywall-privacy"
            accessibilityRole="link"
            onPress={() => open(PRIVACY_URL)}
          >
            <Text style={styles.link}>Privacy Policy</Text>
          </Pressable>
        </View>
      </View>
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
  body: { color: '#9ca3af', fontSize: 14, lineHeight: 20 },
  hint: { color: '#6b7280', fontSize: 12, lineHeight: 18 },
  intro: { color: '#4ec9b0', fontSize: 14, fontWeight: '600' },
  banner: {
    borderWidth: 1,
    borderColor: '#f14c4c',
    borderRadius: 8,
    padding: 12,
  },
  bannerText: { color: '#f14c4c', fontSize: 13, lineHeight: 18 },
  primary: {
    backgroundColor: '#0e9cd6',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryQuiet: {
    backgroundColor: '#0b7ba8',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryText: { color: '#1e1e1e', fontSize: 16, fontWeight: '700' },
  secondary: {
    borderWidth: 1,
    borderColor: '#3c3c3c',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryText: { color: '#e0e0e0', fontSize: 15, fontWeight: '600' },
  terms: { color: '#6b7280', fontSize: 11, lineHeight: 16 },
  links: { flexDirection: 'row', gap: 20, paddingTop: 4 },
  link: { color: '#0e9cd6', fontSize: 13 },
})
