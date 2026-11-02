/** API is proxied so the browser talks to one origin (cookies/CORS simple). */
const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
export default {
  reactStrictMode: true,
  output: 'standalone',
  transpilePackages: ['@om/shared'],
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API}/api/v1/:path*` }, { source: '/media/:key', destination: `${API}/media/:key` }, { source: '/media/v/:key', destination: `${API}/media/v/:key` }];
  },
  async headers() {
    // Cabinets are never indexed (§22).
    return ['/partner/:path*', '/ops/:path*', '/admin/:path*', '/account/:path*', '/confirm/:path*', '/r/:path*'].map((source) => ({ source, headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] }));
  },
};
