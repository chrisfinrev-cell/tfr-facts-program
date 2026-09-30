import type { NextConfig } from 'next';

const expressOrigin = process.env.API_PROXY_URL || 'http://localhost:3000';

const nextConfig: NextConfig = {
  serverExternalPackages: ['@react-pdf/renderer'],
  async rewrites() {
    return {
      afterFiles: [
        { source: '/api/auth/:path*', destination: `${expressOrigin}/api/auth/:path*` },
        { source: '/api/engine/:path*', destination: `${expressOrigin}/api/engine/:path*` },
        { source: '/api/mod_plaid/:path*', destination: `${expressOrigin}/api/mod_plaid/:path*` },
        { source: '/api/nda/accept', destination: `${expressOrigin}/api/nda/accept` },
        { source: '/api/v1/nda/accept', destination: `${expressOrigin}/api/nda/accept` },
        { source: '/api/v1/plaid/:path*', destination: `${expressOrigin}/api/mod_plaid/:path*` }
      ]
    };
  }
};

export default nextConfig;
