import { useEffect, useState } from 'react'
import type { IpcResponse, LinkedAPI, LinkedEvent, LinkedGrants, LinkedStatusView } from '../../types'
import {
  LINKED_MACHINE_LIMIT,
  pendingConfirmations,
  reconcileAnnouncements,
  toggleGrant,
  withoutAnnouncement,
  type Announcements,
} from '../../lib/linkedMachines'
import { InfoTip } from './InfoTip'
import { LinkedCodeOffer, LinkedJoinForm, LinkedPendingCard } from './LinkedPairing'
import { LinkedActivityList, LinkedMachineRow } from './LinkedMachineList'

/** Run on, write off: the grant a user gives without thinking is the harmless one. */
const DEFAULT_GRANTS: LinkedGrants = { run: true, write: false }

function Notice({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <div className="settings-section" data-testid="linked-settings">
      <h2 className="text-sm font-semibold text-[#e0e0e0] mb-2">Linked machines</h2>
      {children}
    </div>
  )
}

function Unavailable({ message }: { message: string }): JSX.Element {
  return (
    <Notice>
      <p className="text-xs text-[#e5c07b]" data-testid="linked-unavailable">
        {message}
      </p>
    </Notice>
  )
}

/**
 * Settings ▸ Linked machines: the switch, pairing in both directions, the
 * safety-word check, one row per linked computer, and recent jobs.
 *
 * `window.linked` is optional -- only a preload that ships the feature defines
 * it -- so the pane checks once and says so instead of throwing. Everything
 * shown comes from `linked:status`, which main rebuilds field by field, so no
 * key, secret or relay room id can reach this component.
 */
export function LinkedMachinesSettings(): JSX.Element {
  const api = window.linked
  if (!api) return <Unavailable message="Linked machines is not available in this version of Termpolis." />
  return <LinkedMachinesPane api={api} />
}

function LinkedMachinesPane({ api }: { api: LinkedAPI }): JSX.Element {
  const [status, setStatus] = useState<LinkedStatusView | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Chosen BEFORE pairing, so a new link starts with the grants its owner meant
  // rather than a default to be corrected afterwards.
  const [newGrants, setNewGrants] = useState<LinkedGrants>(DEFAULT_GRANTS)
  const [joinGrants, setJoinGrants] = useState<LinkedGrants>(DEFAULT_GRANTS)
  const [joinCode, setJoinCode] = useState('')
  // True between asking for a code and the bridge producing one, which arrives
  // as a status push. Without it "no code yet" and "never asked" look the same.
  const [awaitingCode, setAwaitingCode] = useState(false)
  const [announced, setAnnounced] = useState<Announcements>({})
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let live = true
    void api.status().then((res) => {
      if (!live) return
      if (res.success) setStatus(res.data)
      else setUnavailable(res.error)
    })
    const offStatus = api.onStatus((next) => {
      setStatus(next)
      setUnavailable(null)
    })
    const offEvent = api.onEvent((event: LinkedEvent) => {
      if (event.kind === 'error') {
        setError(event.message)
        // Whatever failed, no code is coming from it.
        setAwaitingCode(false)
      } else if (event.kind === 'pending') {
        const { ref, phrase, suggestedName } = event
        setAnnounced((prev) => ({ ...prev, [ref]: { phrase, suggestedName, seen: false } }))
        // A 'link:' ref is one this computer joined, so the typed code is spent.
        if (ref.startsWith('link:')) setJoinCode('')
      } else if (event.kind === 'linked') {
        const { ref } = event
        setAnnounced((prev) => withoutAnnouncement(prev, ref))
      }
    })
    // Drives the relative times. Once a minute: they cannot show anything finer.
    const tick = setInterval(() => setNow(Date.now()), 60_000)
    return () => {
      live = false
      offStatus()
      offEvent()
      clearInterval(tick)
    }
  }, [api])

  // A code has arrived, or the switch went off: either way nothing is coming.
  useEffect(() => {
    if (status?.code || !status?.enabled) setAwaitingCode(false)
  }, [status?.code, status?.enabled])

  // A second-by-second clock, only while a code is out, for its countdown.
  const expiresAt = status?.code?.expiresAt
  useEffect(() => {
    if (expiresAt === undefined) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [expiresAt])

  // Retire announcements a status has overtaken. `announced` is a dependency
  // too, because the status that lists a link can arrive before its event.
  const machines = status?.machines
  useEffect(() => {
    if (machines) setAnnounced((prev) => reconcileAnnouncements(prev, machines))
  }, [machines, announced])

  const apply = (res: IpcResponse<LinkedStatusView>): boolean => {
    if (res.success) {
      setStatus(res.data)
      setError(null)
      return true
    }
    setError(res.error)
    return false
  }

  const toggleEnabled = async (enabled: boolean): Promise<void> => {
    apply(await api.setEnabled(enabled))
  }

  const createCode = async (): Promise<void> => {
    // Waits only on success: a refused request means no code is coming.
    if (apply(await api.createCode(newGrants))) setAwaitingCode(true)
  }

  const cancelCode = async (): Promise<void> => {
    setAwaitingCode(false)
    apply(await api.cancelCode())
  }

  const join = async (): Promise<void> => {
    // The code stays in the box until the link it makes is announced, so a
    // failed attempt can be retried without pasting it again.
    apply(await api.join(joinCode.trim(), joinGrants))
  }

  const cancelJoin = async (): Promise<void> => {
    apply(await api.cancelJoin())
  }

  const confirm = async (ref: string, name: string): Promise<void> => {
    if (apply(await api.confirm(ref, name))) setAnnounced((prev) => withoutAnnouncement(prev, ref))
  }

  const cancelPending = async (ref: string): Promise<void> => {
    // The status stays the judge: if the unlink fails, the machine is still
    // listed unconfirmed and its card comes straight back from that.
    setAnnounced((prev) => withoutAnnouncement(prev, ref))
    apply(await api.unlink(ref))
  }

  const rename = async (ref: string, name: string): Promise<void> => {
    apply(await api.rename(ref, name))
  }

  const setGrants = async (ref: string, grants: LinkedGrants): Promise<void> => {
    apply(await api.setGrants(ref, grants))
  }

  const unlink = async (ref: string): Promise<void> => {
    apply(await api.unlink(ref))
  }

  if (unavailable) return <Unavailable message={unavailable} />

  if (!status) {
    return (
      <Notice>
        <p className="text-xs text-[#9ca3af]">Loading…</p>
      </Notice>
    )
  }

  const atLimit = status.machines.length >= LINKED_MACHINE_LIMIT
  const pending = pendingConfirmations(status.machines, announced)

  return (
    <div className="settings-section" data-testid="linked-settings">
      <h2 className="text-sm font-semibold text-[#e0e0e0] mb-1 flex items-center">
        Linked machines
        <InfoTip label="What a linked computer can do" testId="linked-info" wide>
          A linked computer can do only what you allow it under its name below. With read-only, its
          agents can have an agent here read any file you can read and send it back. With edit, they
          can also change files and run commands here. Every job shows under Activity on both
          computers, and Unlink ends the link on both.
        </InfoTip>
      </h2>
      <p className="text-xs text-[#9ca3af] mb-4">
        Agents on a linked computer can ask agents on this one to do work behind the scenes and send
        back the answer, and agents here can do the same there. Both computers need Termpolis running.
        Everything between them is end-to-end encrypted through the relay below, which only ever
        carries sealed bytes.
      </p>

      {error && (
        <div
          data-testid="linked-error"
          className="text-xs text-[#f28b82] border border-[#5a2d2d] bg-[#2a1919] rounded px-3 py-2 mb-3"
        >
          {error}
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-[#d4d4d4] mb-3">
        <input
          type="checkbox"
          data-testid="linked-enable"
          checked={status.enabled}
          onChange={(e) => void toggleEnabled(e.target.checked)}
        />
        <span>Let this computer link with my other computers</span>
        <span className="text-xs text-[#9ca3af]" data-testid="linked-running">
          {status.enabled ? (status.running ? '(connected to the relay)' : '(not connected)') : ''}
        </span>
      </label>

      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs mb-1">
        <span className="text-[#9ca3af]">This computer</span>
        <span data-testid="linked-this-machine" className="text-[#e0e0e0]">
          {status.thisMachine}
        </span>
        <span className="text-[#9ca3af]">Relay</span>
        <span data-testid="linked-relay" className="font-mono text-[#d4d4d4] break-all">
          {status.relayUrl}
        </span>
      </div>
      <p className="text-xs text-[#6b7280] mb-4">Uses the Remote relay. Change it under Settings ▸ Remote.</p>

      {pending.map((item) => (
        <LinkedPendingCard
          key={item.ref}
          item={item}
          onConfirm={(ref, name) => void confirm(ref, name)}
          onCancel={(ref) => void cancelPending(ref)}
        />
      ))}

      {status.enabled ? (
        <>
          {atLimit && (
            <div
              data-testid="linked-limit"
              className="text-xs text-[#e5c07b] border border-[#5a4a2d] bg-[#2a2419] rounded px-3 py-2 mb-3"
            >
              This computer is linked with {LINKED_MACHINE_LIMIT} others, the most it can be. Unlink one
              before linking another.
            </div>
          )}
          <LinkedCodeOffer
            code={status.code}
            now={now}
            awaiting={awaitingCode}
            grants={newGrants}
            atLimit={atLimit}
            onToggleGrant={(key) => setNewGrants((g) => toggleGrant(g, key))}
            onCreate={() => void createCode()}
            onCancel={() => void cancelCode()}
          />
          <LinkedJoinForm
            code={joinCode}
            grants={joinGrants}
            joining={status.joining}
            atLimit={atLimit}
            onCodeChange={setJoinCode}
            onToggleGrant={(key) => setJoinGrants((g) => toggleGrant(g, key))}
            onJoin={() => void join()}
            onCancel={() => void cancelJoin()}
          />
        </>
      ) : (
        <p data-testid="linked-off-note" className="text-xs text-[#6b7280] mb-4">
          Turn this on to link a computer or to enter a code from one. While it is off, nothing connects
          anywhere.
        </p>
      )}

      <div className="text-xs text-[#9ca3af] mb-2">Linked computers</div>
      {status.machines.length === 0 ? (
        <p className="text-xs text-[#6b7280] mb-4" data-testid="linked-no-machines">
          No computers are linked with this one.
        </p>
      ) : (
        <div className="flex flex-col gap-3 mb-4">
          {status.machines.map((machine) => (
            <LinkedMachineRow
              key={machine.ref}
              machine={machine}
              now={now}
              onRename={rename}
              onSetGrants={(ref, grants) => void setGrants(ref, grants)}
              onUnlink={(ref) => void unlink(ref)}
            />
          ))}
        </div>
      )}

      <LinkedActivityList activity={status.activity} now={now} />
    </div>
  )
}
