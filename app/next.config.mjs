import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // the SDK is consumed as TypeScript source from the workspace
  transpilePackages: ["@terp/sdk"],
  webpack(config, { isServer, webpack }) {
    if (!isServer) {
      // Solana libraries and the SDK's Phoenix reader (`createHash` from "crypto") expect Node built-ins
      config.resolve.fallback = {
        ...config.resolve.fallback,
        crypto: require.resolve("crypto-browserify"),
        stream: require.resolve("stream-browserify"),
        buffer: require.resolve("buffer/"),
        fs: false,
        net: false,
        tls: false,
      };
      config.plugins.push(new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"] }));
    }
    // The wallets barrel re-exports the WalletConnect adapter. It is not used here, but resolving it
    // trips over an optional logger dependency and a dynamic require in its EVM dependency.
    config.externals.push("pino-pretty");
    config.ignoreWarnings = [...(config.ignoreWarnings ?? []), { module: /[\\/]ox[\\/]_esm[\\/]tempo[\\/]/ }];
    return config;
  },
};

export default nextConfig;
