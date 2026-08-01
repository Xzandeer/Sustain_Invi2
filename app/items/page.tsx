// Legacy /items URL. Redirects to /inventory so old bookmarks still work.

import { redirect } from 'next/navigation'

export default function ItemsRedirectPage() {
  redirect('/inventory')
}
