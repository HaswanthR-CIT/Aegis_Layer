/** @type {import('tailwindcss').Config} */
module.exports = {
  mode: "jit",
  darkMode: "class",
  content: [
    "./popup.tsx",
    "./contents/**/*.tsx",
    "./contents/**/*.ts",
    "./lib/**/*.ts",
    "./store/**/*.ts",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
