// What GPU switches to apply, as a PURE function of platform + env, so the policy is unit-testable
// rather than buried in module-load side effects.
//
// History: v1.11.30 fixed a Linux first-launch black window by baking `--disable-gpu` into the .deb
// launcher (executableArgs). That was a sledgehammer — it force-disabled the GPU for EVERY Linux
// user, permanently, so xterm fell back to its slow DOM renderer even on healthy hardware, and it
// made the app's own `TERMPOLIS_DISABLE_GPU=1` escape hatch dead code (you cannot opt into something
// already forced on). Meanwhile the main process had already added the SURGICAL fix for the same bug:
// disabling VAAPI video decode/encode, "the most-reported cause of a blank Electron window on Linux."
//
// So the policy is: on Linux, disable VAAPI by default (targeted, costs us nothing — we play no
// video), keep the GPU ON so the WebGL renderer works, and reserve the FULL GPU disable for the
// documented escape hatch. A user on genuinely broken drivers still falls all the way back with
// TERMPOLIS_DISABLE_GPU=1 — identical to the old forced behaviour, now opt-in instead of mandatory.

export interface GpuPolicy {
  /** Disable Chromium's VAAPI video features (the common Linux black-window cause). */
  disableVaapi: boolean
  /** app.disableHardwareAcceleration() — full software rendering. */
  disableHardwareAcceleration: boolean
  /** The --disable-gpu Chromium switch — the strongest fallback. */
  disableGpuSwitch: boolean
}

export function gpuPolicy(platform: string, env: NodeJS.ProcessEnv): GpuPolicy {
  if (platform !== 'linux') {
    // Off-Linux, honour the same escape hatch but do nothing by default.
    const off = env.TERMPOLIS_DISABLE_GPU === '1'
    return { disableVaapi: false, disableHardwareAcceleration: off, disableGpuSwitch: off }
  }
  const fullDisable = env.TERMPOLIS_DISABLE_GPU === '1'
  return {
    disableVaapi: true,                      // targeted default fix
    disableHardwareAcceleration: fullDisable, // escape hatch only
    disableGpuSwitch: fullDisable,            // escape hatch only
  }
}
