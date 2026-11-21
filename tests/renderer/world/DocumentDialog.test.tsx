import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { DocumentDialog } from '../../../src/renderer/src/components/World/DocumentDialog'
import { UI_FAILED } from '../../../src/renderer/src/components/World/worldTargets'

// The documentation dialog: a title (the project's name to start with), whether the city picture goes in, and
// Save…, which asks main to write the file where the person chooses. A saved file goes to onSaved (the pane's toast).

type Res<T> = { success: true; data: T } | { success: false; error: string }
const ok = <T,>(data: T): Res<T> => ({ success: true, data })
const fail = (error: string): Res<never> => ({ success: false, error })
const PNG = 'data:image/png;base64,iVBORw0KGgo='

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

type DocRes = Res<{ path: string; bytes: number } | { cancelled: true }>

function bridge(over: Record<string, unknown> = {}) {
  const api = {
    worldDocument: vi.fn(async (_req: unknown): Promise<DocRes> => ok({ path: 'C:/Users/me/Documents/termpolis documentation.html', bytes: 90_000 })),
    ...over,
  }
  ;(window as any).termpolis = api
  return api
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
}

function mount(props: Partial<{ root: string; designKey: string; picture: () => string | null }> = {}) {
  const onClose = vi.fn()
  const onSaved = vi.fn()
  const picture = props.picture ?? vi.fn(() => PNG)
  const utils = render(
    <DocumentDialog root={'designKey' in props ? undefined : props.root ?? '/repo'} designKey={props.designKey} projectName="termpolis" picture={picture} onClose={onClose} onSaved={onSaved} />,
  )
  return { ...utils, onClose, onSaved, picture }
}

const title = () => screen.getByLabelText('Title') as HTMLInputElement
const pictureBox = () => screen.getByLabelText('Include the city picture') as HTMLInputElement
const save = () => screen.getByRole('button', { name: /^Save…$|^Saving…$/ })

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup() })

describe('DocumentDialog', () => {
  it('starts with the project name as the title and the picture in, and Save… writes both', async () => {
    const api = bridge()
    const m = mount()
    const dialog = screen.getByRole('dialog', { name: 'Generate Lumopolis documentation' })
    expect(dialog).toHaveAttribute('data-testid', 'world-document-dialog')
    expect(title().value).toBe('termpolis')
    expect(pictureBox().checked).toBe(true)
    expect(pictureBox().disabled).toBe(false)
    expect(screen.queryByTestId('world-document-no-picture')).toBeNull()
    // The picture is taken once, when the dialog opens: the view the person asked from.
    expect(m.picture).toHaveBeenCalledTimes(1)
    fireEvent.change(title(), { target: { value: '  Termpolis guide  ' } })
    fireEvent.click(save())
    expect(save()).toHaveTextContent('Saving…')
    expect(save()).toBeDisabled()
    expect(api.worldDocument).toHaveBeenCalledWith({ root: '/repo', designKey: undefined, title: 'Termpolis guide', picturePng: PNG })
    await settle()
    expect(m.onSaved).toHaveBeenCalledWith({ path: 'C:/Users/me/Documents/termpolis documentation.html', bytes: 90_000 })
    expect(m.onClose).toHaveBeenCalledTimes(1)
  })

  it('unchecking the picture leaves it out, and a design is named by its key', async () => {
    const api = bridge()
    mount({ designKey: 'design:d1' })
    fireEvent.click(pictureBox())
    fireEvent.click(save())
    expect(api.worldDocument).toHaveBeenCalledWith({ root: undefined, designKey: 'design:d1', title: 'termpolis', picturePng: undefined })
  })

  it('with no picture to take the checkbox is off and disabled, and says why', () => {
    const api = bridge()
    mount({ picture: () => null })
    expect(pictureBox().checked).toBe(false)
    expect(pictureBox().disabled).toBe(true)
    expect(screen.getByTestId('world-document-no-picture')).toHaveTextContent('The city picture needs the 3D map on screen.')
    fireEvent.click(save())
    expect(api.worldDocument).toHaveBeenCalledWith(expect.objectContaining({ picturePng: undefined }))
  })

  it('a blank title turns Save… off', () => {
    bridge()
    mount()
    fireEvent.change(title(), { target: { value: '   ' } })
    expect(save()).toBeDisabled()
  })

  it('a closed save dialog returns to the dialog; an error shows its sentence; a thrown call says Lumopolis could not', async () => {
    const pending = deferred<DocRes>()
    const api = bridge({
      worldDocument: vi.fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(fail("Termpolis can't write to that folder. Choose another one."))
        .mockRejectedValueOnce(new Error('x')),
    })
    const m = mount()
    fireEvent.click(save())
    await act(async () => { pending.resolve(ok({ cancelled: true as const })) })
    expect(save()).toHaveTextContent('Save…')
    expect(save()).toBeEnabled()
    expect(m.onClose).not.toHaveBeenCalled()
    fireEvent.click(save())
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent("Termpolis can't write to that folder. Choose another one.")
    fireEvent.click(save())
    expect(screen.queryByRole('alert')).toBeNull()
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent(UI_FAILED)
    expect(api.worldDocument).toHaveBeenCalledTimes(3)
    expect(m.onSaved).not.toHaveBeenCalled()
    expect(m.onClose).not.toHaveBeenCalled()
  })

  it('Cancel closes', () => {
    bridge()
    const m = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(m.onClose).toHaveBeenCalledTimes(1)
  })
})
