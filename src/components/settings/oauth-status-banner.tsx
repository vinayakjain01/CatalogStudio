'use client'

import { useEffect, useState } from 'react'
import { CheckCircle, XCircle } from 'lucide-react'

const ERROR_MESSAGES: Record<string, string> = {
  missing_shop: 'No shop domain provided.',
  invalid_shop: 'Invalid shop domain format.',
  invalid_hmac: 'OAuth signature verification failed. Please try again.',
  invalid_state: 'OAuth state mismatch. Please try again.',
  token_exchange_failed: 'Could not exchange OAuth code. Please try again.',
  store_save_failed: 'Store connected but failed to save. Contact support.',
  missing_params: 'OAuth response was incomplete. Please try again.',
}

export function OAuthStatusBanner({
  success,
  error,
}: {
  success?: string
  error?: string
}) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    if (!success && !error) return
    const t = setTimeout(() => setVisible(false), 6000)
    return () => clearTimeout(t)
  }, [success, error])

  if (!visible || (!success && !error)) return null

  if (success === 'store_connected') {
    return (
      <div className="flex items-center gap-3 p-4 rounded-lg bg-green-50 border border-green-200 text-green-800">
        <CheckCircle className="h-5 w-5 flex-shrink-0" />
        <div>
          <p className="font-medium text-sm">Store connected successfully!</p>
          <p className="text-xs mt-0.5">Your products are being synced in the background.</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-3 p-4 rounded-lg bg-red-50 border border-red-200 text-red-800">
        <XCircle className="h-5 w-5 flex-shrink-0" />
        <div>
          <p className="font-medium text-sm">Connection failed</p>
          <p className="text-xs mt-0.5">{ERROR_MESSAGES[error] || 'Something went wrong. Please try again.'}</p>
        </div>
      </div>
    )
  }

  return null
}