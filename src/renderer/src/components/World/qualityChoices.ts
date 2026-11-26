// The toolbar's Quality menu (look spec §5.1), in a module of its own: a component file exports only components.
import type { WorldQuality } from '../../world/engine'

/**
 * The Quality menu's choices, in order (look spec §5.1).
 * PENDING SIGN-OFF (look A2): the menu's label, its four choices and its tooltip (the tooltip's wording from A2.1).
 */
export const QUALITY_CHOICES: { value: WorldQuality; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'high', label: 'High' },
  { value: 'low', label: 'Low' },
  { value: 'flat', label: 'Flat' },
]
/** Auto lowers the quality on slow frames and raises it at most once a session (qualityGovernor's MAX_RISES). */
export const QUALITY_TITLE = 'How much the 3D map draws. Auto lowers it when frames come too slowly, and can raise it once when they stay fast.'
