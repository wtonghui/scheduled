import createMDX from "@next/mdx";
import type { NextConfig } from "next";

const config: NextConfig = {
  // Worker code (undici, prisma raw queries) needs the Node.js runtime, not edge.
  reactStrictMode: true,
  // Allow .mdx pages (docs) next to .tsx pages.
  pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"],
  experimental: {
    serverActions: { bodySizeLimit: "1mb" },
  },
};

const withMDX = createMDX({
  options: {
    // Turbopack: plugins must be referenced by string name, not function.
    remarkPlugins: ["remark-gfm"],
    rehypePlugins: ["rehype-slug"],
  },
});

export default withMDX(config);
