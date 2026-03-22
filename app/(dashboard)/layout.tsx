import Sidebar from '@/components/Sidebar'

export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <div className="flex min-h-screen">
      <div className="fixed left-0 top-0 h-screen w-48">
        <Sidebar />
      </div>
      <main className="ml-48 min-h-screen w-full overflow-y-auto bg-slate-100 px-2 py-2 lg:px-2.5">
        {children}
      </main>
    </div>
  )
}
