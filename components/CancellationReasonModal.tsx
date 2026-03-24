'use client'

import { useState } from 'react'
import { AlertCircle, XCircle } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { CANCELLATION_REASONS, type CancellationReasonOption } from '@/lib/cancellationReasons'

interface CancellationReasonModalProps {
  isOpen: boolean
  customerName: string
  reservationNumber: string
  isLoading?: boolean
  onConfirm: (reason: CancellationReasonOption, customReason?: string) => void
  onCancel: () => void
}

export function CancellationReasonModal({
  isOpen,
  customerName,
  reservationNumber,
  isLoading = false,
  onConfirm,
  onCancel,
}: CancellationReasonModalProps) {
  const [selectedReason, setSelectedReason] = useState<CancellationReasonOption | null>(null)
  const [customReason, setCustomReason] = useState('')

  const handleConfirm = () => {
    if (!selectedReason) return

    if (selectedReason === 'Other' && !customReason.trim()) {
      return
    }

    onConfirm(selectedReason, selectedReason === 'Other' ? customReason.trim() : undefined)
    setSelectedReason(null)
    setCustomReason('')
  }

  const handleCancel = () => {
    setSelectedReason(null)
    setCustomReason('')
    onCancel()
  }

  const isConfirmDisabled =
    !selectedReason || (selectedReason === 'Other' && !customReason.trim()) || isLoading

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && handleCancel()}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-red-100 p-2.5">
              <XCircle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <AlertDialogTitle>Cancel Reservation</AlertDialogTitle>
              <AlertDialogDescription className="text-xs">
                Reservation {reservationNumber} for {customerName}
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>

        <div className="space-y-4 py-4">
          <div>
            <p className="mb-3 text-sm font-semibold text-slate-900">Select a cancellation reason:</p>
            <div className="space-y-2">
              {CANCELLATION_REASONS.map((reason) => (
                <label key={reason} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 cursor-pointer transition hover:border-slate-300 hover:bg-slate-50">
                  <input
                    type="radio"
                    name="cancellation-reason"
                    value={reason}
                    checked={selectedReason === reason}
                    onChange={(e) => setSelectedReason(e.target.value as CancellationReasonOption)}
                    disabled={isLoading}
                    className="h-4 w-4 cursor-pointer accent-slate-600"
                  />
                  <span className="text-sm font-medium text-slate-900">{reason}</span>
                </label>
              ))}
            </div>
          </div>

          {selectedReason === 'Other' && (
            <div className="rounded-lg border border-sky-200 bg-sky-50 p-3">
              <label className="block text-sm font-medium text-slate-900 mb-2">Please provide additional details:</label>
              <textarea
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                placeholder="Enter your cancellation reason..."
                disabled={isLoading}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 outline-none transition focus:border-slate-500 disabled:bg-slate-100"
                rows={3}
              />
              <p className="mt-2 text-xs text-sky-700 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>This reason will be saved to the reservation record and visible in the audit trail.</span>
              </p>
            </div>
          )}
        </div>

        <div className="flex gap-3">
          <AlertDialogCancel asChild>
            <Button variant="outline" disabled={isLoading}>
              Keep Reservation
            </Button>
          </AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={isConfirmDisabled}
            onClick={handleConfirm}
            className="flex-1"
          >
            Cancel Reservation
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
