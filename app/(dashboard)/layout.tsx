import Sidebar from '@/components/Sidebar'

export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <div className="flex min-h-screen">
      <div className="fixed left-0 top-0 h-screen w-64">
        <Sidebar />
      </div>
      <main className="ml-64 w-full min-h-screen overflow-y-auto bg-slate-100 p-8">
        {children}
      </main>
    </div>
  )
}
