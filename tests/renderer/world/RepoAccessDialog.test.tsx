import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { RepoAccessDialog, TOKEN_PAGE_URL } from '../../../src/renderer/src/components/World/RepoAccessDialog'
import { signInLabel } from '../../../src/renderer/src/components/World/worldTargets'
import { TOKEN_FORMAT_MESSAGE, TOKEN_EMPTY_MESSAGE } from '../../../src/shared/world/repoAccess'

const openExternal = vi.fn(async () => ({ success: true }))
afterEach(() => { cleanup(); vi.clearAllMocks(); delete (window as any).termpolis })

function mount(over: Partial<React.ComponentProps<typeof RepoAccessDialog>> = {}) {
  ;(window as any).termpolis = { openExternal }
  const props = { host: 'github.com', busy: false, error: null as string | null, onSubmit: vi.fn(), onCancel: vi.fn(), ...over }
  const utils = render(<RepoAccessDialog {...props} />)
  return { props, utils }
}
const input = () => screen.getByTestId('world-repo-access-input') as HTMLInputElement
const submit = () => screen.getByRole('button', { name: 'Use this token' })

describe('RepoAccessDialog', () => {
  it('signInLabel names GitHub only for github.com', () => {
    expect(signInLabel('github.com')).toBe('Sign in to GitHub')
    expect(signInLabel('gitlab.example.com')).toBe('Sign in')
  })

  it('is a password field with the plain explanation', () => {
    mount()
    expect(screen.getByTestId('world-repo-access')).toBeInTheDocument()
    expect(input().type).toBe('password')
    expect(input().autocomplete).toBe('off')
    expect(input().getAttribute('spellcheck')).toBe('false')
    expect(screen.getByTestId('world-repo-access')).toHaveTextContent("A token is a key you make on GitHub that lets Lumopolis read this one repository. Lumopolis uses it once and doesn't keep it.")
  })

  it('trims a pasted token and submits it, clearing the field', () => {
    const { props } = mount()
    fireEvent.change(input(), { target: { value: '  ghp_x \n' } })
    fireEvent.click(submit())
    expect(props.onSubmit).toHaveBeenCalledWith('ghp_x')
    expect(input().value).toBe('')
  })

  it('Enter submits too', () => {
    const { props } = mount()
    fireEvent.change(input(), { target: { value: 'ghp_x' } })
    fireEvent.keyDown(input(), { key: 'a' })
    expect(props.onSubmit).not.toHaveBeenCalled()
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(props.onSubmit).toHaveBeenCalledWith('ghp_x')
  })

  it('refuses a token with a space inside, without submitting', () => {
    const { props } = mount()
    fireEvent.change(input(), { target: { value: 'ghp_ x' } })
    fireEvent.click(submit())
    expect(screen.getByRole('alert')).toHaveTextContent(TOKEN_FORMAT_MESSAGE)
    expect(props.onSubmit).not.toHaveBeenCalled()
    // Typing again clears the refusal.
    fireEvent.change(input(), { target: { value: 'ghp_' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('refuses an empty paste', () => {
    const { props } = mount()
    fireEvent.click(submit())
    expect(screen.getByRole('alert')).toHaveTextContent(TOKEN_EMPTY_MESSAGE)
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('shows the error main sent back and stays open', () => {
    mount({ error: 'That token did not open it.' })
    expect(screen.getByRole('alert')).toHaveTextContent('That token did not open it.')
  })

  it('Cancel clears the field and closes', () => {
    const { props } = mount()
    fireEvent.change(input(), { target: { value: 'ghp_x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(input().value).toBe('')
    expect(props.onCancel).toHaveBeenCalled()
  })

  it('the field is emptied when the dialog unmounts', () => {
    const { utils } = mount()
    fireEvent.change(input(), { target: { value: 'ghp_x' } })
    const el = input()
    utils.unmount()
    expect(el.value).toBe('')
  })

  it('while busy, the submit button is disabled', () => {
    const { props } = mount({ busy: true })
    fireEvent.change(input(), { target: { value: 'ghp_x' } })
    expect(submit()).toBeDisabled()
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  // WP-SRC N2: the dialog keeps Tab in itself wherever it is opened (the home, or the world view's notice), going round
  // its own controls, and the key goes no further, so a trap around it never steps a second time.
  it('Tab and Shift+Tab go round its own controls and stop there', () => {
    const outer = vi.fn()
    render(
      <div onKeyDown={outer}>
        <button type="button">outside</button>
        <RepoAccessDialog host="github.com" busy={false} error={null} onSubmit={vi.fn()} onCancel={vi.fn()} />
      </div>
    )
    const dialog = screen.getByTestId('world-repo-access')
    const order = [screen.getByRole('button', { name: 'Make a token on GitHub' }), input(), screen.getByRole('button', { name: 'Cancel' }), submit()]
    input().focus()
    fireEvent.keyDown(input(), { key: 'Tab' })
    expect(document.activeElement).toBe(order[2])
    fireEvent.keyDown(order[2], { key: 'Tab' })
    fireEvent.keyDown(order[3], { key: 'Tab' })
    // past the last control: the first one, never the button outside
    expect(document.activeElement).toBe(order[0])
    fireEvent.keyDown(order[0], { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(order[3])
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(outer).not.toHaveBeenCalled()
    // Any other key goes on as before.
    fireEvent.keyDown(order[3], { key: 'a' })
    expect(outer).toHaveBeenCalledTimes(1)
  })

  it('while busy, Tab passes over the greyed Use this token', () => {
    mount({ busy: true })
    screen.getByRole('button', { name: 'Cancel' }).focus()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Make a token on GitHub' }))
  })

  it('the GitHub link opens the token page', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Make a token on GitHub' }))
    expect(openExternal).toHaveBeenCalledWith(TOKEN_PAGE_URL)
  })

  it('hides the GitHub link for another host', () => {
    mount({ host: 'gitlab.example.com' })
    expect(screen.queryByRole('button', { name: 'Make a token on GitHub' })).toBeNull()
  })

  it('names the host the token is made on when it is not GitHub', () => {
    mount({ host: 'gitlab.example.com' })
    const dialog = screen.getByTestId('world-repo-access')
    expect(dialog).toHaveTextContent("A token is a key you make on gitlab.example.com that lets Lumopolis read this one repository. Lumopolis uses it once and doesn't keep it.")
    expect(dialog).not.toHaveTextContent('GitHub')
  })
})
