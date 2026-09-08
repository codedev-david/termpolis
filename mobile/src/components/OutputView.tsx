import React from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'

import { renderAnsi, type Segment } from '../ansi/render'

/** One styled run, already cut to a single row of the desktop's grid. */
interface Span {
  seg: Segment
  text: string
  /** Position among the visible runs of the whole view, not of the row. */
  index: number
}

/** Cut the styled runs into the rows the desktop drew, keeping run boundaries.
 *
 *  A run can straddle a newline -- one colour often covers several lines -- so
 *  the split happens here rather than in the renderer, which has no idea what a
 *  row is. The trailing empty row that a final newline produces is dropped: a
 *  terminal ends its last line, it does not start a blank one. */
function toRows(segments: Segment[]): Span[][] {
  const rows: Span[][] = [[]]
  let current: Span[] = []
  rows[0] = current
  let index = 0
  for (const seg of segments) {
    let first = true
    for (const part of seg.text.split('\n')) {
      if (!first) {
        current = []
        rows.push(current)
      }
      first = false
      if (part === '') continue
      current.push({ seg, text: part, index })
      index += 1
    }
  }
  // A terminal ends its last line; it does not start a blank one.
  if (rows.length > 1 && current.length === 0) rows.pop()
  return rows
}

/**
 * Terminal scrollback, styled, one view row per row of the desktop's grid.
 *
 * The rows arrive already laid out. The desktop wrapped them at its own width
 * and whatever TUI is running drew its boxes to match, so re-wrapping them to
 * the phone's width is not a smaller version of the same screen -- it is a
 * different one. That is what turned a single input-box border into four ragged
 * rules and one status line into three. Each row is therefore rendered
 * unwrapped and the grid scrolls sideways instead.
 *
 * Monospace throughout, because column alignment is most of what terminal
 * output means: a proportional font turns a table into noise, and it turns a
 * progress bar into a lie.
 */
export default function OutputView({ text }: { text: string }): React.JSX.Element {
  const rows = toRows(renderAnsi(text))

  return (
    <ScrollView
      horizontal
      testID="output-scroll"
      showsHorizontalScrollIndicator={false}
      // The rows size themselves; the container must not stretch them to the
      // viewport or every row becomes as wide as the widest one.
      contentContainerStyle={styles.canvas}
    >
      <View testID="output-view" style={styles.grid}>
        {rows.map((spans, row) => (
          <Text
            key={row}
            testID={`output-row-${row}`}
            style={styles.row}
            // Nothing constrains the width inside a horizontal scroller, so this
            // is belt and braces: a row is a row even if something above it
            // gains a width later.
            numberOfLines={1}
            selectable
          >
            {spans.length === 0 ? ' ' : null}
            {spans.map((span) => (
              <Text
                key={span.index}
                testID={`output-segment-${span.index}`}
                style={{
                  color: span.seg.fg ?? '#e0e0e0',
                  backgroundColor: span.seg.bg,
                  fontWeight: span.seg.bold === true ? 'bold' : 'normal',
                  fontStyle: span.seg.italic === true ? 'italic' : 'normal',
                  textDecorationLine: span.seg.underline === true ? 'underline' : 'none',
                  opacity: span.seg.dim === true ? 0.6 : 1,
                }}
              >
                {span.text}
              </Text>
            ))}
          </Text>
        ))}
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  canvas: { flexGrow: 1 },
  grid: { alignItems: 'flex-start' },
  row: {
    color: '#e0e0e0',
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 18,
  },
})
