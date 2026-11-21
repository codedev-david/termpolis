import manifest from './manifest.json'

export interface IntroImg {
  src1x: string
  src2x: string
  width: number
  height: number
}

// Each URL is written out per file so Vite bundles every PNG.
export const INTRO_ART: {
  pad: number
  termpolisMark: IntroImg
  termpolisTag: IntroImg
  lumopolisTag: IntroImg
  letters: IntroImg[]
  letterOffsets: number[]
} = {
  pad: manifest.pad,
  termpolisMark: { src1x: new URL('./termpolis-mark@1x.png', import.meta.url).href, src2x: new URL('./termpolis-mark@2x.png', import.meta.url).href, width: manifest.images.termpolisMark.width, height: manifest.images.termpolisMark.height },
  termpolisTag: { src1x: new URL('./termpolis-tag@1x.png', import.meta.url).href, src2x: new URL('./termpolis-tag@2x.png', import.meta.url).href, width: manifest.images.termpolisTag.width, height: manifest.images.termpolisTag.height },
  lumopolisTag: { src1x: new URL('./lumopolis-tag@1x.png', import.meta.url).href, src2x: new URL('./lumopolis-tag@2x.png', import.meta.url).href, width: manifest.images.lumopolisTag.width, height: manifest.images.lumopolisTag.height },
  letters: [
    { src1x: new URL('./lumopolis-0@1x.png', import.meta.url).href, src2x: new URL('./lumopolis-0@2x.png', import.meta.url).href, width: manifest.images.letters[0].width, height: manifest.images.letters[0].height },
    { src1x: new URL('./lumopolis-1@1x.png', import.meta.url).href, src2x: new URL('./lumopolis-1@2x.png', import.meta.url).href, width: manifest.images.letters[1].width, height: manifest.images.letters[1].height },
    { src1x: new URL('./lumopolis-2@1x.png', import.meta.url).href, src2x: new URL('./lumopolis-2@2x.png', import.meta.url).href, width: manifest.images.letters[2].width, height: manifest.images.letters[2].height },
    { src1x: new URL('./lumopolis-3@1x.png', import.meta.url).href, src2x: new URL('./lumopolis-3@2x.png', import.meta.url).href, width: manifest.images.letters[3].width, height: manifest.images.letters[3].height },
    { src1x: new URL('./lumopolis-4@1x.png', import.meta.url).href, src2x: new URL('./lumopolis-4@2x.png', import.meta.url).href, width: manifest.images.letters[4].width, height: manifest.images.letters[4].height },
    { src1x: new URL('./lumopolis-5@1x.png', import.meta.url).href, src2x: new URL('./lumopolis-5@2x.png', import.meta.url).href, width: manifest.images.letters[5].width, height: manifest.images.letters[5].height },
    { src1x: new URL('./lumopolis-6@1x.png', import.meta.url).href, src2x: new URL('./lumopolis-6@2x.png', import.meta.url).href, width: manifest.images.letters[6].width, height: manifest.images.letters[6].height },
    { src1x: new URL('./lumopolis-7@1x.png', import.meta.url).href, src2x: new URL('./lumopolis-7@2x.png', import.meta.url).href, width: manifest.images.letters[7].width, height: manifest.images.letters[7].height },
    { src1x: new URL('./lumopolis-8@1x.png', import.meta.url).href, src2x: new URL('./lumopolis-8@2x.png', import.meta.url).href, width: manifest.images.letters[8].width, height: manifest.images.letters[8].height },
  ],
  letterOffsets: manifest.letterOffsets,
}
