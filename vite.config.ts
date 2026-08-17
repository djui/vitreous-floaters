import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/vitreous-floaters/",
  plugins: [react()],
  build: {
    target: "es2022",
  },
});
