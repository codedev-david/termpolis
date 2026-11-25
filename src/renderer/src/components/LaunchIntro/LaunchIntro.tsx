import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import logoSvg from '/logo-termpolis.svg?url'
import { INTRO_ART } from '../../assets/intro/introManifest'
import type { IntroImg } from '../../assets/intro/introManifest'
import { INTRO_HARD_CAP_MS, INTRO_RULE_WIDTH, INTRO_TOTAL_MS, NOT_PAINTED_MS, introEnabled, introScale, introSteps } from '../../lib/launchIntro'

// The two-second launch intro: pre-rendered lettering from the film's title cards, animated with the
// Web Animations API over the starting app. It is a non-interactive overlay: it never takes focus,
// never stops or prevents an event, and any key or click ends it at once.

const STAGE_W = 1920
const STAGE_H = 1080
// Film values (cards.html): the mark's left padding, and the gaps around the rule.
const MARK_PAD_LEFT = 34
const RULE_GAP_ABOVE = 34
const RULE_H = 2
const RULE_GAP_BELOW = 30
const LOGO_SIZE = 140
const LOGO_GAP = 30
const STAGE_BG = '#03050b'

const { pad } = INTRO_ART

interface Props {
  play?: boolean
  reducedMotion?: boolean
  now?: () => number
}

const defaultNow = (): number => performance.now()

const rootStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 9999,
  pointerEvents: 'none',
  overflow: 'hidden',
  background: STAGE_BG,
}

const vignetteStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,.65) 100%)',
}

// The glyphs sit at (pad, pad) inside each image, so an image goes `pad` up and left of its glyph box.
function imgStyle(img: IntroImg, glyphLeft: number, glyphTop: number): CSSProperties {
  return { position: 'absolute', left: glyphLeft - pad, top: glyphTop - pad, width: img.width, height: img.height }
}

const contentW = (img: IntroImg): number => img.width - 2 * pad

// Where the film's centred card puts each piece, in stage px.
const markH = INTRO_ART.termpolisMark.height - 2 * pad
const tagH = INTRO_ART.termpolisTag.height - 2 * pad
const markTop = (STAGE_H - (markH + RULE_GAP_ABOVE + RULE_H + RULE_GAP_BELOW + tagH)) / 2
const ruleTop = markTop + markH + RULE_GAP_ABOVE
const tagTop = ruleTop + RULE_H + RULE_GAP_BELOW
const centredLeft = (img: IntroImg): number => (STAGE_W - contentW(img)) / 2
const lastLetter = INTRO_ART.letters.length - 1
const lumoMarkW = MARK_PAD_LEFT + INTRO_ART.letterOffsets[lastLetter] + contentW(INTRO_ART.letters[lastLetter])
const lumoGlyphLeft = (STAGE_W - lumoMarkW) / 2 + MARK_PAD_LEFT

const srcSet = (img: IntroImg): string => `${img.src1x} 1x, ${img.src2x} 2x`

function Img({ img, style, imgRef }: { img: IntroImg; style: CSSProperties; imgRef?: (el: HTMLImageElement | null) => void }) {
  return <img ref={imgRef} src={img.src1x} srcSet={srcSet(img)} width={img.width} height={img.height} alt="" draggable={false} style={style} />
}

function canAnimate(): boolean {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function viewportScale(): number {
  return introScale({ width: window.innerWidth, height: window.innerHeight })
}

export function LaunchIntro({ play, reducedMotion, now = defaultNow }: Props) {
  // Decided once per mount: a late change of the setting never starts an intro half-way.
  const [active] = useState(() => (play ?? (window.termpolis?.launchIntro === true && introEnabled())) && canAnimate())
  const [reduced] = useState(() => reducedMotion ?? prefersReducedMotion())
  const [done, setDone] = useState(false)
  const [scale, setScale] = useState(viewportScale)

  const rootRef = useRef<HTMLDivElement>(null)
  const termpolisRef = useRef<HTMLDivElement>(null)
  const lumopolisRef = useRef<HTMLDivElement>(null)
  const ruleRef = useRef<HTMLDivElement>(null)
  const tagRef = useRef<HTMLImageElement | null>(null)
  const letterRefs = useRef<(HTMLImageElement | null)[]>([])

  // The overlay is in the page from mount: an opaque stage that covers the starting app from the very
  // first frame, with its cards transparent (opacity 0 inline, and each animation's first keyframe
  // while it waits to start). This layout effect runs before the first paint, so every animation
  // exists before any frame and all of them start together on the first frame the browser renders,
  // the first frame that shows the overlay. The 4.0 s clock is that start, read from the stage
  // animation, not mount: a busy launch that delays the first frame delays the intro, and never eats into it.
  useLayoutEffect(() => {
    if (!active || done) return undefined
    let disposed = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const end = (): void => {
      if (disposed) return
      disposed = true
      setDone(true)
    }
    // Any key or click ends it at once, from mount. Nothing here stops or alters an event.
    const opts = { capture: true, passive: true } as const
    window.addEventListener('keydown', end, opts)
    window.addEventListener('pointerdown', end, opts)
    const onResize = (): void => setScale(viewportScale())
    window.addEventListener('resize', onResize, { passive: true })

    const root = rootRef.current as HTMLDivElement
    // Ask for the artwork decoded now, and don't wait for it: waiting would hold an empty stage, or the
    // window, on screen longer; the images are local files already loading from mount, the Termpolis
    // card fades up from 0 over 150 ms, and the Lumopolis art isn't on screen before 1800 ms.
    root.querySelectorAll('img').forEach((img) => {
      if (typeof img.decode === 'function') img.decode().catch(() => { /* shown when it loads */ })
    })
    const elements = {
      stage: root,
      termpolis: termpolisRef.current as HTMLElement,
      lumopolis: lumopolisRef.current as HTMLElement,
      rule: ruleRef.current as HTMLElement,
      tag: tagRef.current as HTMLElement,
    }
    const animations = introSteps(reduced).map((step) => {
      const el = step.target === 'letter' ? (letterRefs.current[step.index as number] as HTMLElement) : elements[step.target]
      return el.animate(step.keyframes, { delay: step.delay, duration: step.duration, fill: 'both' })
    })

    // Every frame the page computes from mount has the overlay in it. The first one, the first frame
    // of the overlay, comes when the launch lets the page render; until then nothing counts down,
    // so a busy launch delays the intro and never eats into it. That first frame reaches the screen
    // when the stage animation starts. If it has not NOT_PAINTED_MS after the page computed it (a
    // compositor that is not drawing), the intro never shows: until the animation starts, no frame
    // with the overlay is on screen.
    const stage = animations[0]
    const frames: number[] = []
    let firstFrameAt: number | null = null
    let started = false
    const firstFrame = (at: number): void => {
      if (firstFrameAt !== null) return
      firstFrameAt = at
      timers.push(setTimeout(() => {
        if (started) return
        // Decided on the next frame, the first that can learn of a start the compositor has already
        // made while this page was busy (its start time is set before the frame's callbacks run).
        frames.push(requestAnimationFrame(() => { if (typeof stage.startTime !== 'number') end() }))
      }, NOT_PAINTED_MS))
      // Backstop: gone by the latest start that can play plus the timeline, whatever the clock reports.
      timers.push(setTimeout(end, INTRO_HARD_CAP_MS))
    }
    frames.push(requestAnimationFrame(() => firstFrame(now())))
    stage.ready.then((s) => {
      if (disposed) return
      const t = now()
      const startedAt = typeof s.startTime === 'number' ? s.startTime : t
      // A start can be reported before the first frame's own callback runs: that frame is on screen,
      // so the page computed it no later than the start.
      firstFrame(startedAt)
      started = true
      if (startedAt - (firstFrameAt as number) > NOT_PAINTED_MS) { end(); return }
      // The timeline shares performance.now()'s clock. It ends one frame inside 4000 ms, so this
      // removal lands by 4000 ms from the first frame even when the timer runs a frame late.
      timers.push(setTimeout(end, Math.max(0, INTRO_TOTAL_MS - (t - startedAt))))
    }).catch(() => { /* cancelled before it started */ })

    return () => {
      disposed = true
      window.removeEventListener('keydown', end, opts)
      window.removeEventListener('pointerdown', end, opts)
      window.removeEventListener('resize', onResize)
      for (const timer of timers) clearTimeout(timer)
      for (const f of frames) cancelAnimationFrame(f)
      for (const a of animations) a.cancel()
    }
  }, [active, done, reduced, now])

  if (!active || done) return null

  const hidden: CSSProperties = { opacity: 0 }
  return (
    <div ref={rootRef} data-testid="launch-intro" aria-hidden="true" style={rootStyle}>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: STAGE_W,
          height: STAGE_H,
          marginLeft: -STAGE_W / 2,
          marginTop: -STAGE_H / 2,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
        }}
      >
        <div ref={termpolisRef} data-testid="launch-intro-termpolis" style={hidden}>
          <img
            src={logoSvg}
            width={LOGO_SIZE}
            height={LOGO_SIZE}
            alt=""
            draggable={false}
            style={{ position: 'absolute', left: (STAGE_W - LOGO_SIZE) / 2, top: markTop - LOGO_GAP - LOGO_SIZE }}
          />
          <Img img={INTRO_ART.termpolisMark} style={imgStyle(INTRO_ART.termpolisMark, centredLeft(INTRO_ART.termpolisMark), markTop)} />
          <Img img={INTRO_ART.termpolisTag} style={imgStyle(INTRO_ART.termpolisTag, centredLeft(INTRO_ART.termpolisTag), tagTop)} />
        </div>
        <div ref={lumopolisRef} data-testid="launch-intro-lumopolis" style={hidden}>
          {INTRO_ART.letters.map((img, i) => (
            <Img
              key={i}
              img={img}
              imgRef={(el) => { letterRefs.current[i] = el }}
              style={{ ...imgStyle(img, lumoGlyphLeft + INTRO_ART.letterOffsets[i], markTop), opacity: 0 }}
            />
          ))}
          <div
            ref={ruleRef}
            style={{
              position: 'absolute',
              left: STAGE_W / 2,
              top: ruleTop,
              width: INTRO_RULE_WIDTH,
              height: RULE_H,
              transform: 'translateX(-50%)',
              opacity: 0,
              background: 'linear-gradient(90deg, transparent, #5fe3ff, #fff, #ffb45a, transparent)',
              boxShadow: '0 0 18px #5fe3ff',
            }}
          />
          <Img
            img={INTRO_ART.lumopolisTag}
            imgRef={(el) => { tagRef.current = el }}
            style={{ ...imgStyle(INTRO_ART.lumopolisTag, centredLeft(INTRO_ART.lumopolisTag), tagTop), opacity: 0 }}
          />
        </div>
      </div>
      <div style={vignetteStyle} />
    </div>
  )
}
