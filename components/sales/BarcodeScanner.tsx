'use client'

// Camera barcode scanner.
//
// Uses the browser's built-in BarcodeDetector API, so there is no library to
// install and nothing added to the bundle. Chrome and Edge support it; Safari
// and Firefox do not, which is why the caller checks isBarcodeScanSupported()
// and simply hides the button when it is unavailable. Typing the code always
// works as a fallback.
//
// Camera access requires a secure context. That means HTTPS in production, or
// localhost on the same machine - a phone pointed at http://<laptop-ip>:3000
// will be refused by the browser, not by this code.

import { useEffect, useRef, useState } from 'react'

// The API is not in TypeScript's DOM types yet, so describe the parts we use.
interface DetectedBarcode {
  rawValue: string
}
interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>
}
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike

const getDetectorCtor = (): BarcodeDetectorCtor | null => {
  if (typeof window === 'undefined') return null
  return (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null
}

/** True when this browser can scan with the camera at all. */
export const isBarcodeScanSupported = () =>
  typeof window !== 'undefined' &&
  !!getDetectorCtor() &&
  !!navigator.mediaDevices?.getUserMedia

interface BarcodeScannerProps {
  onDetected: (code: string) => void
  onClose: () => void
}

export default function BarcodeScanner({ onDetected, onClose }: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(true)

  useEffect(() => {
    const Detector = getDetectorCtor()
    if (!Detector) {
      setError('This browser cannot scan with the camera. Type the code instead.')
      setStarting(false)
      return
    }

    let stream: MediaStream | null = null
    let frame = 0
    let stopped = false
    // Guards against firing twice while the camera is still shutting down.
    let handled = false

    const detector = new Detector({
      formats: ['code_128', 'ean_13', 'ean_8', 'code_39', 'qr_code'],
    })

    const stop = () => {
      stopped = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach((t) => t.stop())
    }

    const scan = async () => {
      const video = videoRef.current
      if (stopped || !video || video.readyState !== video.HAVE_ENOUGH_DATA) {
        frame = requestAnimationFrame(scan)
        return
      }
      try {
        const found = await detector.detect(video)
        const code = found[0]?.rawValue?.replace(/\D/g, '')
        if (code && code.length >= 4 && !handled) {
          handled = true
          // Short vibration confirms the read without the user looking up.
          navigator.vibrate?.(60)
          stop()
          onDetected(code)
          return
        }
      } catch {
        // A single failed frame is normal while focusing - keep going.
      }
      frame = requestAnimationFrame(scan)
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        if (stopped) { s.getTracks().forEach((t) => t.stop()); return }
        stream = s
        if (videoRef.current) {
          videoRef.current.srcObject = s
          void videoRef.current.play()
        }
        setStarting(false)
        frame = requestAnimationFrame(scan)
      })
      .catch((err: unknown) => {
        const name = (err as { name?: string })?.name ?? ''
        setError(
          name === 'NotAllowedError'
            ? 'Camera permission was denied. Allow it in your browser settings, or type the code.'
            : 'Could not open the camera. Type the code instead.'
        )
        setStarting(false)
      })

    return stop
  }, [onDetected])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90">
      <div className="flex items-center justify-between px-4 py-3">
        <p className="text-sm font-semibold text-white">Scan a barcode</p>
        <button
          onClick={onClose}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-white/80 hover:bg-white/10"
        >
          Close
        </button>
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
          className="h-full w-full object-cover"
        />
        {/* Aiming guide - the detector reads the whole frame, but people aim
            better when there is a box to aim at. */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-28 w-72 rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
        </div>
      </div>

      <div className="px-4 py-4 text-center">
        {starting && !error ? (
          <p className="text-sm text-white/70">Starting camera…</p>
        ) : error ? (
          <p className="mx-auto max-w-sm text-sm text-rose-300">{error}</p>
        ) : (
          <p className="text-sm text-white/70">Hold the barcode inside the box</p>
        )}
      </div>
    </div>
  )
}
