/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["pg"],
  experimental: { serverActions: { bodySizeLimit: "200mb" } },
};
export default nextConfig;
