import { render, screen } from '@testing-library/react-native'

import OutputView from '../src/components/OutputView'

/** The escape byte itself, built rather than typed so the source stays ASCII. */
const ESC = String.fromCharCode(27)

function tree(): string {
  return JSON.stringify(screen.toJSON())
}

describe('OutputView', () => {
  it('renders plain text as it arrived', async () => {
    await render(<OutputView text="hello world" />)
    expect(screen.getByText('hello world')).toBeTruthy()
  })

  it('renders nothing at all for empty scrollback', async () => {
    await render(<OutputView text="" />)
    expect(screen.getByTestId('output-view')).toBeTruthy()
    expect(screen.queryByTestId('output-segment-0')).toBeNull()
  })

  it('turns a colour sequence into a styled run, not into visible bytes', async () => {
    await render(<OutputView text={`${ESC}[31mred${ESC}[0m plain`} />)
    expect(tree()).not.toContain(ESC)
    expect(tree()).toContain('#cd3131')
    expect(screen.getByText('red')).toBeTruthy()
    expect(screen.getByText(' plain')).toBeTruthy()
  })

  it('keeps each run separate so a style cannot bleed past its reset', async () => {
    await render(<OutputView text={`${ESC}[31mred${ESC}[0m plain`} />)
    const red = screen.getByTestId('output-segment-0')
    const plain = screen.getByTestId('output-segment-1')
    expect(JSON.stringify(red.props.style)).toContain('#cd3131')
    expect(JSON.stringify(plain.props.style)).not.toContain('#cd3131')
  })

  it('carries bold and underline through as text style, not as markup', async () => {
    await render(<OutputView text={`${ESC}[1mbold${ESC}[0m${ESC}[4munder`} />)
    expect(JSON.stringify(screen.getByTestId('output-segment-0').props.style)).toContain('bold')
    expect(JSON.stringify(screen.getByTestId('output-segment-1').props.style)).toContain(
      'underline',
    )
  })

  it('drops a cursor move rather than approximating it', async () => {
    // The renderer is deliberately not an emulator: a phone view is a
    // scrollback, so there is no cell to address. What matters here is that the
    // sequence never reaches the screen as text.
    await render(<OutputView text={`${ESC}[2Jcleared`} />)
    expect(tree()).not.toContain(ESC)
    expect(tree()).not.toContain('[2J')
    expect(screen.getByText('cleared')).toBeTruthy()
  })

  it('is monospaced, because column alignment is most of what output means', async () => {
    await render(<OutputView text="a b" />)
    expect(JSON.stringify(screen.getByTestId('output-view').props.style)).toContain('monospace')
  })

  it('re-renders when the scrollback grows', async () => {
    const view = await render(<OutputView text="first" />)
    await view.rerender(<OutputView text="first second" />)
    expect(screen.getByText('first second')).toBeTruthy()
    expect(screen.queryByText('first')).toBeNull()
  })
})
