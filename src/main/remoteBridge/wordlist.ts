/** The 256 words a safety number is spelled with.
 *
 *  Four invariants, each enforced by `tests/electron/remoteWordlist.test.ts`:
 *
 *  1. Exactly 256 entries. One digest byte indexes the list with no modulo, so
 *     every word carries exactly 8 bits and the mapping is uniform by
 *     construction rather than by argument. Any other length reintroduces bias.
 *  2. No duplicates, or two byte values collide and the phrase quietly loses
 *     entropy while still looking correct.
 *  3. Lowercase ASCII, three to eight letters -- readable aloud, and safe to
 *     compare across a phone screen and a desktop window.
 *  4. A unique three-letter prefix per word. Two words that start alike are one
 *     word over a bad connection, and a mishearing must produce a mismatch
 *     rather than a false confirmation.
 *
 *  Sorted alphabetically so a reviewer can scan it. Order does not affect the
 *  derivation -- index i is index i either way -- but the phone MUST ship this
 *  exact array in this exact order, which the golden vector in
 *  `remoteSealedChannel.test.ts` pins.
 */
export const SAFETY_WORDS: readonly string[] = [
  'acorn', 'admiral', 'agate', 'album', 'amber', 'anchor', 'antler', 'apricot',
  'arch', 'armor', 'ashen', 'atlas', 'autumn', 'avocado',
  'badger', 'bagel', 'balcony', 'bamboo', 'banjo', 'barley', 'basalt', 'beacon',
  'bedrock', 'beetle', 'bison', 'blanket', 'bobcat', 'bonfire', 'boulder', 'bracket',
  'cabin', 'cactus', 'camel', 'canyon', 'cargo', 'cashew', 'catfish', 'cedar',
  'cement', 'chalk', 'cider', 'cinder', 'clover', 'cobalt', 'comet', 'copper',
  'dagger', 'dahlia', 'daisy', 'dawn', 'decoy', 'delta', 'denim', 'desert',
  'diamond', 'dingo', 'dolphin', 'donkey', 'dragon', 'dune',
  'eagle', 'ebony', 'echo', 'eclipse', 'elbow', 'elder', 'elm', 'ember',
  'emerald', 'ermine',
  'fable', 'falcon', 'fathom', 'fawn', 'feather', 'fennel', 'fern', 'fiddle',
  'finch', 'fjord', 'flint', 'forest', 'fossil', 'fox',
  'gable', 'galaxy', 'garden', 'gavel', 'gazelle', 'gecko', 'ginger', 'glacier',
  'gopher', 'granite', 'grotto', 'gully',
  'halibut', 'hammer', 'harbor', 'hazel', 'heather', 'hedge', 'helm', 'heron',
  'hickory', 'hollow', 'hornet', 'hurdle',
  'iceberg', 'igloo', 'indigo', 'ingot', 'iris', 'ivory',
  'jackal', 'jade', 'jasmine', 'jetty', 'jigsaw', 'juniper',
  'kayak', 'kelp', 'kernel', 'kettle', 'kingdom', 'koala',
  'lagoon', 'lantern', 'lapel', 'larch', 'lattice', 'lavender', 'ledger', 'lemon',
  'lichen', 'lilac', 'lobster', 'lumber',
  'magnet', 'mahogany', 'mallard', 'mango', 'maple', 'marble', 'meadow', 'medal',
  'melon', 'mesa', 'mica', 'mimosa', 'mohair', 'mustard',
  'nectar', 'needle', 'nest', 'nickel', 'nimbus', 'noble', 'nomad', 'nutmeg',
  'oasis', 'obsidian', 'ocean', 'octave', 'olive', 'onyx', 'opal', 'orchard',
  'otter',
  'paddle', 'pagoda', 'palm', 'panther', 'parcel', 'pasture', 'peach', 'pebble',
  'pelican', 'pepper', 'pigeon', 'pillar', 'pine', 'pumice',
  'quartz', 'quiver', 'quorum',
  'rabbit', 'radish', 'rafter', 'rampart', 'ranch', 'raven', 'redwood', 'reef',
  'ribbon', 'ridge', 'ripple', 'roster',
  'saddle', 'saffron', 'sage', 'salmon', 'sandal', 'sapphire', 'scarlet', 'sequoia',
  'shale', 'sierra', 'silver', 'siphon', 'slate', 'sparrow', 'spruce', 'summit',
  'tabby', 'talon', 'tamarind', 'tandem', 'tapestry', 'tavern', 'teal', 'tempest',
  'thicket', 'thorn', 'timber', 'tinder', 'topaz', 'tundra',
  'umber', 'unicorn', 'upland', 'urchin',
  'valley', 'vanilla', 'velvet', 'vertex', 'vessel', 'viola', 'vulture',
  'waffle', 'walnut', 'warbler', 'wattle', 'weasel', 'whisker', 'willow', 'winter',
  'wombat', 'wren',
  'yarrow', 'yellow', 'yeoman', 'yonder',
  'zebra', 'zenith', 'zinnia',
]
