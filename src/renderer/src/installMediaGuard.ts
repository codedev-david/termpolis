// Imported first by main.tsx, so the media guard is in place before any other module runs.
import { installMediaGuard } from './lib/mediaGuard'

installMediaGuard(window as unknown as Parameters<typeof installMediaGuard>[0])
