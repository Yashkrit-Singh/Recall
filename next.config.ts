import type { NextConfig } from 'next'

const isDevelopment = process.env.NODE_ENV === 'development'

const nextConfig: NextConfig = {
  // Cloudflare's quick-tunnel hostname changes on restart. Next.js 16.4.2
  // supports a single-label wildcard here for its development-only endpoints.
  ...(isDevelopment ? { allowedDevOrigins: ['*.trycloudflare.com'] } : {}),
  // The tunnel's browser origin differs from the local origin forwarded to
  // Next.js. Keep this exception development-only so Server Actions accept
  // calls from the temporary public tunnel without changing production policy.
  ...(isDevelopment
    ? { experimental: { serverActions: { allowedOrigins: ['*.trycloudflare.com'] } } }
    : {}),
}

export default nextConfig
