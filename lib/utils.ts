// Shared className helper.
//
// cn() merges Tailwind classes and resolves conflicts, so a later class wins
// over an earlier one (cn('p-2', 'p-4') → 'p-4'). Used by every UI component.

import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
