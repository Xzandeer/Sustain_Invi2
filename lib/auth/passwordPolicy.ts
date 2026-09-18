// Password rules, applied wherever a password is chosen.
//
// The accounts here can write off stock, issue refunds and read every sale, so
// a six-character password was too weak to stand behind those permissions.
//
// Four character classes rather than three, and a length that puts the password
// beyond casual guessing. Kept in one place so the create-account form, the
// change-password form and the server all apply the same rule - a form can be
// bypassed, so the API checks it too.

export const PASSWORD_MIN_LENGTH = 8

export interface PasswordCheck {
  ok: boolean
  /** Human-readable reason, ready to show. Empty when ok. */
  reason: string
}

export function checkPassword(password: string): PasswordCheck {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, reason: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` }
  }

  const missing: string[] = []
  if (!/[A-Z]/.test(password)) missing.push('an uppercase letter')
  if (!/[a-z]/.test(password)) missing.push('a lowercase letter')
  if (!/[0-9]/.test(password)) missing.push('a number')
  if (!/[^A-Za-z0-9]/.test(password)) missing.push('a symbol')

  if (missing.length) {
    const list =
      missing.length === 1
        ? missing[0]
        : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`
    return { ok: false, reason: `Password must include ${list}.` }
  }

  return { ok: true, reason: '' }
}

/** Shown under the field so the rule is stated before the user is refused. */
export const PASSWORD_RULE_HINT =
  `At least ${PASSWORD_MIN_LENGTH} characters, with an uppercase letter, a lowercase letter, a number and a symbol.`
