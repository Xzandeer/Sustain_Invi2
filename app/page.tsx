// Root route. Always redirects to /login; the login page then sends signed-in
// users on to the dashboard.

import { redirect } from 'next/navigation'

export default function Home() {
  redirect('/login')
}
