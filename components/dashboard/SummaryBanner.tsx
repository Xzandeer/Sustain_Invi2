// One-line plain-language summary shown at the top of the dashboard.

interface SummaryBannerProps {
  message: string
}

export default function SummaryBanner({ message }: SummaryBannerProps) {
  return (
    <section className="rounded-xl bg-gray-100 p-4">
      <p className="text-sm text-gray-600">{message}</p>
    </section>
  )
}
