import type { NextConfig } from "next";

/**
 * VOICE_SERVICE_URL —— ⚠️ 部署陷阱（务必读）：
 * Next.js 的 `rewrites()` 是**构建期（next build）求值**的，destination 会被写进
 * `.next/routes-manifest.json`；`next start` / standalone `node server.js` 运行时**不再**读取
 * 这个环境变量。也就是说运行时设 VOICE_SERVICE_URL 是无效的！
 *
 * 因此容器构建必须传 build arg：
 *   docker build --build-arg VOICE_SERVICE_URL=http://voice:8100 ...
 * 否则会烘焙成默认值 http://127.0.0.1:8100，在 web 容器内部指向 web 自己 → 示范音全部失败。
 *
 * 自检：grep -o '"destination":"[^"]*"' .next/routes-manifest.json
 * （服务端到 voice 的 API 调用不受影响，那些请求在运行时读取 VOICE_SERVICE_URL，见 src/lib/voice.ts。）
 */
const VOICE_SERVICE_URL = process.env.VOICE_SERVICE_URL ?? "http://127.0.0.1:8100";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // better-sqlite3 是原生模块，不能被打包
  serverExternalPackages: ["better-sqlite3"],
  // 禁止 next/font/google（构建期需联网取字体）；全站使用系统字体栈。
  experimental: {
    authInterrupts: true,
  },
  async rewrites() {
    return [
      // 浏览器不直连 voice：音频播放走 web 反向代理，见 docs/api-contract.md §0
      { source: "/voice/:path*", destination: `${VOICE_SERVICE_URL}/:path*` },
    ];
  },
};

export default nextConfig;
