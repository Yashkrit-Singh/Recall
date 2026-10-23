import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Recall — your saved things, remembered',
  description: 'A quiet home for links you want to find again.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>
}
