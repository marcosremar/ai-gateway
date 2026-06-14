/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== 'production';
const gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:4000';

const nextConfig = {
  // Static export for production builds; omit in dev mode for HMR/Fast Refresh
  ...(isDev ? {} : { output: 'export' }),
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  // Tree-shake the large named-import lists (the ~30-icon `lucide-react` imports
  // across sections) so unused icons/modules don't ship in the bundle (#960).
  experimental: {
    optimizePackageImports: ['lucide-react', '@xyflow/react'],
  },
  // In dev mode, proxy API calls to the gateway server
  ...(isDev ? {
    async rewrites() {
      return [
        { source: '/v1/:path*', destination: `${gatewayUrl}/v1/:path*` },
        { source: '/api/:path*', destination: `${gatewayUrl}/api/:path*` },
        { source: '/health', destination: `${gatewayUrl}/health` },
        { source: '/metrics', destination: `${gatewayUrl}/metrics` },
      ];
    },
  } : {}),
};

export default nextConfig;
