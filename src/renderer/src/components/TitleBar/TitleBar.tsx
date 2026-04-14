import React from 'react'
import logoSvg from '/logo-termpolis.svg?url'

const isMac = navigator.platform.startsWith('Mac') || navigator.platform === 'MacIntel'

export function TitleBar() {
  return (
    <div
      className="flex items-center justify-between bg-[#1a1a1a] border-b border-[#3c3c3c] select-none shrink-0"
      style={{ WebkitAppRegion: 'drag', height: 40 } as React.CSSProperties}
    >
      {/* On macOS, leave space for native traffic lights (70px) */}
      <div className={`flex items-center gap-2 ${isMac ? 'pl-20' : 'pl-3'}`}>
        <img src={logoSvg} alt="" className="w-5 h-5" />
        <span className="text-sm font-semibold tracking-wide text-[#e0e0e0]">Termpolis</span>
      </div>
      {/* Only show custom window controls on Windows/Linux — macOS has native traffic lights */}
      {!isMac && (
        <div className="flex" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={() => window.windowControls.minimize()}
            className="w-12 h-10 flex items-center justify-center text-[#999] hover:bg-[#333] hover:text-white transition-colors"
            aria-label="Minimize"
          >&#x2013;</button>
          <button
            onClick={() => window.windowControls.maximize()}
            className="w-12 h-10 flex items-center justify-center text-[#999] hover:bg-[#333] hover:text-white transition-colors"
            aria-label="Maximize"
          >&#x25A1;</button>
          <button
            onClick={() => window.windowControls.close()}
            className="w-12 h-10 flex items-center justify-center text-[#999] hover:bg-[#e81123] hover:text-white transition-colors"
            aria-label="Close"
          >&#x2715;</button>
        </div>
      )}
    </div>
  )
}
