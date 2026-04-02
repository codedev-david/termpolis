import React from 'react'

interface Props {
  isListening: boolean
  onClick: () => void
  supported: boolean
  className?: string
  size?: 'sm' | 'md'
  title?: string
}

export function MicButton({ isListening, onClick, supported, className = '', size = 'sm', title }: Props) {
  if (!supported) return null

  const sizeClasses = size === 'sm'
    ? 'w-5 h-5 text-[10px]'
    : 'w-6 h-6 text-[12px]'

  return (
    <button
      onClick={onClick}
      title={title ?? (isListening ? 'Stop listening' : 'Voice input')}
      className={`inline-flex items-center justify-center rounded transition-colors ${sizeClasses} ${
        isListening
          ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/40'
          : 'text-[#9ca3af] hover:text-white hover:bg-[#37373d] border border-transparent'
      } ${className}`}
    >
      <i className={`fa-solid ${isListening ? 'fa-stop' : 'fa-microphone'}`}></i>
      {isListening && (
        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
      )}
    </button>
  )
}
