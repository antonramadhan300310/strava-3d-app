import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        allmova: {
          charcoal: "#0D1112",
          surface: "#151B1D",
          olive: "#1E2E16",
          lime: "#B9F51E",
          "lime-hover": "#A5E012",
        },
      },
      fontFamily: {
        sans: [
          "var(--font-plus-jakarta)",
          "Plus Jakarta Sans",
          "Segoe UI",
          "Roboto",
          "system-ui",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
export default config;
