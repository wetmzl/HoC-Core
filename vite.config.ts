import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { imageBuildPlugin } from "./scripts/image-build.mjs";

export default defineConfig(({ mode }) => ({
  plugins: [
    imageBuildPlugin(),
    VitePWA({
      disable: mode === "capacitor" || mode === "electron",
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "favicon.svg", "icons/*.png"],
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectManifest: {
        // Installed package bodies live in the content repository. The launcher
        // still needs the embedded index and manifests when reopening offline.
        globPatterns: [
          "*.{js,css,html,svg,png,ico,txt}",
          "assets/**/*.{js,css}",
          "icons/*.png", "licenses/*.txt",
          "embedded/content.json", "embedded/offline.json", "embedded/default-playlist.json"
        ],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
      },
      manifest: {
        name: "命运牌桌",
        short_name: "命运牌桌",
        description: "在古堡中，与会者通过牌局、技能与轮盘规则展开对决。",
        theme_color: "#171421",
        background_color: "#171421",
        display: "standalone",
        orientation: "portrait",
        icons: [
          {
            src: "icons/app-icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "icons/app-icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "icons/app-icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable"
          }
        ]
      }
    })
  ],
  // Playwright traces contain HTML snapshots. Watching them would reload every
  // active browser page while another test is still running.
  server: { watch: { ignored: ["**/output/**"] } },
  worker: { format: "es" },
  build: { target: "es2022" }
}));
