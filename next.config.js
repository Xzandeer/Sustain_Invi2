/** @type {import('next').NextConfig} */
const nextConfig = {
  // In development React runs every page effect twice, which doubled each
  // Firestore read (and the free plan's daily read limit ran out quickly).
  // Production builds never do this; turning it off only affects `npm run dev`.
  reactStrictMode: false,
  turbopack: {},
  webpack: (config, { dev }) => {
    if (dev) {
      // Disable disk cache in dev to prevent ArrayBuffer allocation failures
      config.cache = { type: 'memory' }
    }
    return config
  },
}

module.exports = nextConfig
