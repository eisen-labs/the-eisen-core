import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'www.eisenlabs.com' }],
        destination: 'https://eisenlabs.com/:path*',
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
