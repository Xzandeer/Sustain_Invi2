// Prompt injection protection — strips dangerous patterns from user input

const BLOCKED_PATTERNS = [
  /ignore (all )?previous instructions/i,
  /you are now/i,
  /act as (a )?different/i,
  /system prompt/i,
  /jailbreak/i,
  /forget your instructions/i,
  /pretend you (are|have no)/i,
  /<script/i,
  /\{\{.*\}\}/,       // template injection
  /\$\{.*\}/,         // JS template literals
]

export function sanitizeInput(input: string): { safe: boolean; cleaned: string } {
  const cleaned = input
    .slice(0, 500)           // hard cap at 500 chars
    .replace(/[<>]/g, '')    // strip HTML brackets
    .trim()

  const safe = !BLOCKED_PATTERNS.some(p => p.test(cleaned))
  return { safe, cleaned }
}

export function sanitizeHistory(history: Array<{ role: string; content: string }>) {
  return history
    .slice(-6)   // only last 6 messages to control token usage
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 300) }))
}
