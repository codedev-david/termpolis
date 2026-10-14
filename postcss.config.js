export default {
  plugins: {
    // optimize: false keeps Tailwind's output as written. With it on (the default whenever
    // NODE_ENV is production, i.e. every electron-vite build) Lightning CSS rewrites colours:
    // shadow alpha 0.1 becomes #0000001a (26/255) and color-mix() becomes oklab() literals.
    // electron-vite does not minify renderer CSS either, so this matches what v3 shipped.
    '@tailwindcss/postcss': { optimize: false },
  },
}
