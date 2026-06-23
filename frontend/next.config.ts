import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  // Point to the monorepo root so Next.js traces files correctly
  outputFileTracingRoot: path.join(__dirname, '..'),
};

export default nextConfig;
