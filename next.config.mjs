/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Prevent firebase-admin (Node.js-only) from being bundled into client/edge bundles
  serverExternalPackages: ['firebase-admin', 'firebase-admin/app', 'firebase-admin/firestore'],
  // chart.js is a pure-ESM package with internal chunk splitting that Turbopack
  // cannot resolve correctly — transpiling it avoids the Turbopack panic
  transpilePackages: ['chart.js', 'react-chartjs-2'],
  turbopack: {
    // Force Turbopack to use chart.js CJS build (avoids ESM chunk-split panic)
    resolveAlias: {
      'chart.js': 'chart.js/dist/chart.cjs',
    },
  },
}

export default nextConfig
