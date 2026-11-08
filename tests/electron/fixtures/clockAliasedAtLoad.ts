/**
 * A module that takes its clock and its generator as ALIASES when it is first evaluated and reads them later, under
 * other names: the shape a counter installed after the module was imported cannot see, and a sweep for the call
 * `Date.now(` cannot see either. Only noNondeterministicCompressionRuntime.test.ts imports it, to show that its
 * counters are installed before the code under test is evaluated, so an alias taken at module scope is a counted one.
 * Nothing under src/ looks like this; it is here so that a guard which stops seeing it fails.
 */
const tick = Date.now
const Clock = Date
const roll = Math.random
const stopwatch = performance.now.bind(performance)

export const readAliasedClock = (): number => tick()
export const readAliasedDate = (): number => new Clock().getTime()
export const readAliasedRandom = (): number => roll()
export const readAliasedStopwatch = (): number => stopwatch()
