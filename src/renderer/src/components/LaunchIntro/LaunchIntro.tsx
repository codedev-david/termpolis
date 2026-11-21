import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import logoSvg from '/logo-termpolis.svg?url'
import { INTRO_ART } from '../../assets/intro/introManifest'
import type { IntroImg } from '../../assets/intro/introManifest'
import { INTRO_RULE_WIDTH, INTRO_TOTAL_MS, NOT_PAINTED_MS, introEnabled, introScale, introSteps } from '../../lib/launchIntro'

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

type Phase = 'pending' | 'playing' | 'done'

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
  opacity: 0,
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
  const [phase, setPhase] = useState<Phase>('pending')
  const [scale, setScale] = useState(viewportScale)

  const rootRef = useRef<HTMLDivElement>(null)
  const termpolisRef = useRef<HTMLDivElement>(null)
  const lumopolisRef = useRef<HTMLDivElement>(null)
  const ruleRef = useRef<HTMLDivElement>(null)
  const tagRef = useRef<HTMLImageElement | null>(null)
  const letterRefs = useRef<(HTMLImageElement | null)[]>([])
  const paintedAt = useRef(0)
  const removalTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Wait for the first frame. Past NOT_PAINTED_MS (a hidden or minimised window) it never appears.
  useEffect(() => {
    if (!active) return undefined
    const mountedAt = now()
    let frame = 0
    const giveUp = (): void => {
      // Never appear after giving up, even if the frame arrives later.
      cancelAnimationFrame(frame)
      setPhase('done')
    }
    const giveUpTimer = setTimeout(giveUp, NOT_PAINTED_MS)
    frame = requestAnimationFrame(() => {
      clearTimeout(giveUpTimer)
      if (now() - mountedAt > NOT_PAINTED_MS) { giveUp(); return }
      // The 2.0 s budget runs from this first paint, and the removal timer starts here. The animations
      // would only start after React re-renders into 'playing', the next effect runs and the browser commits
      // a frame: measured at about 260 ms later in the real app, and longer when the main thread is busy at
      // launch. So the playing effect sets each animation's startTime to this paint time (a pending start is
      // not enough: it waits for a frame too). The animation clock and the timer then end together, the
      // closing fade completes before the overlay is removed, and the 2 s ceiling holds.
      paintedAt.current = now()
      removalTimer.current = setTimeout(giveUp, INTRO_TOTAL_MS)
      setPhase('playing')
    })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(giveUpTimer)
      clearTimeout(removalTimer.current)
    }
  }, [active, now])

  // Playing: animate, and end on any key or click. Nothing here stops or alters an event.
  useEffect(() => {
    if (phase !== 'playing') return undefined
    const end = (): void => {
      clearTimeout(removalTimer.current)
      setPhase('done')
    }
    const opts = { capture: true, passive: true } as const
    window.addEventListener('keydown', end, opts)
    window.addEventListener('pointerdown', end, opts)
    const onResize = (): void => setScale(viewportScale())
    window.addEventListener('resize', onResize, { passive: true })
    const elements = {
      stage: rootRef.current,
      termpolis: termpolisRef.current,
      lumopolis: lumopolisRef.current,
      rule: ruleRef.current,
      tag: tagRef.current,
    }
    const animations = introSteps(reduced).map((step) => {
      const el = step.target === 'letter' ? letterRefs.current[step.index as number] : elements[step.target]
      const animation = el?.animate(step.keyframes, { delay: step.delay, duration: step.duration, fill: 'both' })
      return animation && Object.assign(animation, { startTime: paintedAt.current })
    })
    return () => {
      window.removeEventListener('keydown', end, opts)
      window.removeEventListener('pointerdown', end, opts)
      window.removeEventListener('resize', onResize)
      for (const a of animations) a?.cancel()
    }
  }, [phase, reduced])

  if (!active || phase !== 'playing') return null

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
        <div ref={termpolisRef} data-testid="launch-intro-termpolis">
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
