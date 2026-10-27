import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Recall — your video memory',
  description: 'Save the videos worth remembering. Find them whenever you need them.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>
}
