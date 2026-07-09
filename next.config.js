/** @type {import('next').NextConfig} */
const nextConfig = {
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
