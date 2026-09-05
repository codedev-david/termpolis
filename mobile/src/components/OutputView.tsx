import React from 'react'
import { StyleSheet, Text } from 'react-native'

import { renderAnsi } from '../ansi/render'

/**
 * Terminal scrollback, styled.
 *
 * One outer `Text` with a nested `Text` per styled run. React Native lays
 * nested text out inline, so the runs reflow as one paragraph rather than as a
 * column of boxes -- which is the whole reason not to reach for `View` here.
 *
 * The outer element carries the monospace family and the line height. Column
 * alignment is most of what terminal output means; a proportional font turns a
 * table into noise, and it turns a progress bar into a lie.
 */
export default function OutputView({ text }: { text: string }): React.JSX.Element {
  const segments = renderAnsi(text)

  return (
    <Text testID="output-view" style={styles.output} selectable>
      {segments.map((seg, index) => (
        <Text
          key={index}
          testID={`output-segment-${index}`}
          style={{
            color: seg.fg ?? '#e0e0e0',
            backgroundColor: seg.bg,
            fontWeight: seg.bold === true ? 'bold' : 'normal',
            fontStyle: seg.italic === true ? 'italic' : 'normal',
            textDecorationLine: seg.underline === true ? 'underline' : 'none',
            opacity: seg.dim === true ? 0.6 : 1,
          }}
        >
          {seg.text}
        </Text>
      ))}
    </Text>
  )
}

const styles = StyleSheet.create({
  output: {
    color: '#e0e0e0',
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 18,
  },
})
