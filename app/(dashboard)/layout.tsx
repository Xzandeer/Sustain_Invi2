import Sidebar from '@/components/layout/Sidebar'
import FloatingChatBot from '@/components/chatbot/FloatingChatBot'

export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <div className="flex min-h-screen">
      <div className="fixed left-0 top-0 h-screen w-56">
        <Sidebar />
      </div>
      <main className="ml-56 min-h-screen w-full overflow-y-auto bg-[#f5f6fa] px-0 py-0">
        {children}
      </main>
      <FloatingChatBot />
    </div>
  )
}
