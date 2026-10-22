import { sileo } from 'sileo'

type Opts = { description?: string; duration?: number | null; button?: { title: string; onClick: () => void } }

/**
 * The one place the app raises toasts, so the library stays swappable and the
 * call sites read like before: `toast.success('Copied', { description })`.
 */
export const toast = {
  success: (title: string, o: Opts = {}) => sileo.success({ title, ...o }),
  error: (title: string, o: Opts = {}) => sileo.error({ title, ...o }),
  info: (title: string, o: Opts = {}) => sileo.info({ title, ...o }),
  warning: (title: string, o: Opts = {}) => sileo.warning({ title, ...o }),
  loading: (title: string, o: Opts = {}) => sileo.show({ title, type: 'loading', duration: null, ...o }),
  dismiss: (id: string) => sileo.dismiss(id),
}
