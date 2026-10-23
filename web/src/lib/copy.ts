import { toast } from '@/lib/toast'

/** The text a value copies as: strings unquoted, the rest as JSON (`42`, `true`, `null`, `{…}`). */
export const copyText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))

/** Copy to the clipboard with a "Copied <what>" toast (or say the clipboard is not available). */
export async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`Copied ${what}`)
  } catch {
    toast.error('Clipboard is not available here')
  }
}
