import { useState, useRef, useCallback } from 'react'
import { verifyAdminToken } from 'lib/api'

interface AuthBarProps {
  adminToken: string
  isAuthenticated: boolean
  onLogin: (token: string) => void
  onLogout: () => void
  onAuthError?: (message: string) => void
}

export function AuthBar({
  adminToken,
  isAuthenticated,
  onLogin,
  onLogout,
  onAuthError,
}: AuthBarProps) {
  const [inputToken, setInputToken] = useState('')
  const [isVerifying, setIsVerifying] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const debounceRef = useRef<number | null>(null)

  const handleAuth = useCallback(async () => {
    const token = inputToken.trim()
    if (!token || isVerifying) return

    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current)
    }

    debounceRef.current = window.setTimeout(async () => {
      setIsVerifying(true)
      try {
        const isValid = await verifyAdminToken(token)
        if (isValid) {
          onLogin(token)
          setInputToken('')
        } else {
          onAuthError?.('Invalid admin token')
        }
      } catch {
        onAuthError?.('Failed to verify token')
      } finally {
        setIsVerifying(false)
      }
    }, 300)
  }, [inputToken, isVerifying, onLogin, onAuthError])

  return (
    <div className="mb-8 p-4 border-2 border-gray-700 bg-gray-900/50">
      <div className="flex flex-col md:flex-row items-start md:items-center gap-4">
        <div className="flex items-center gap-2">
          <span
            className={`w-3 h-3 rounded-full ${isAuthenticated ? 'bg-green-500 animate-pulse' : 'bg-gray-600'}`}
          ></span>
          <span className="font-mono text-xs uppercase tracking-widest text-gray-500">
            {isAuthenticated ? 'AUTHENTICATED' : 'GUEST_MODE'}
          </span>
        </div>

        {!isAuthenticated ? (
          <div className="flex gap-2 flex-1 w-full md:w-auto">
            <div className="relative flex-1">
              <input
                type={showToken ? 'text' : 'password'}
                placeholder="ADMIN_TOKEN..."
                value={inputToken}
                onChange={(e) => setInputToken(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !isVerifying && handleAuth()}
                disabled={isVerifying}
                className="w-full bg-gray-800 border border-gray-700 px-4 py-2 pr-10 text-white font-mono text-sm focus:outline-none focus:border-acid transition-colors placeholder-gray-600 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white transition-colors"
              >
                {showToken ? (
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                  </svg>
                )}
              </button>
            </div>
            <button
              onClick={handleAuth}
              disabled={isVerifying}
              className="px-4 py-2 bg-neon-pink text-black font-bold font-mono text-sm uppercase hover:bg-white transition-colors shadow-hard-acid hover:shadow-none hover:translate-x-[2px] hover:translate-y-[2px] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isVerifying ? 'VERIFYING...' : 'AUTH'}
            </button>
          </div>
        ) : (
          <div className="flex gap-2 items-center">
            <span className="font-mono text-xs text-gray-400">
              TOKEN: ****{adminToken.slice(-4)}
            </span>
            <button
              onClick={onLogout}
              className="px-3 py-1 border border-gray-600 font-mono text-xs text-gray-400 hover:bg-gray-800 transition-colors"
            >
              LOGOUT
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
