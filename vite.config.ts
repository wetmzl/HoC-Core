import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => ({
  plugins: [
    VitePWA({
      disable: mode === "capacitor",
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "favicon.svg", "icons/*.png"],
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,webp,jpg,jpeg,mp3,ogg,wav}"],
        globIgnores: ["characters/**"],
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
  build: { target: "es2022" }
}));
