import React from 'react'

export function StatusBar() {
  return (
    <div className="flex items-center justify-between px-3 py-1 bg-[#1a1a1a] border-t border-[#3c3c3c] text-[#6b7280] text-xs select-none shrink-0">
      <span>&copy; {new Date().getFullYear()} Termpolis &middot; MIT License</span>
      <a
        href="https://github.com/codedev-david/termpolis"
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-[#4FC3F7] transition-colors"
        onClick={e => { e.preventDefault(); window.open('https://github.com/codedev-david/termpolis', '_blank') }}
      >Help / Support</a>
    </div>
  )
}
