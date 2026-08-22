import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let hasTailwindPostcss = true;
try {
  require.resolve("@tailwindcss/postcss");
} catch {
  hasTailwindPostcss = false;
}

const tailwindCompat = {
  postcssPlugin: "tailwind-compat",
  Once(root) {
    if (hasTailwindPostcss) {
      root.walkAtRules("tailwind", (rule) => rule.remove());
      root.prepend({ name: "config", params: '"../tailwind.config.js"' });
      root.prepend({ name: "import", params: '"tailwindcss"' });
    }
  },
};

export default {
  plugins: [
    tailwindCompat,
    hasTailwindPostcss ? require("@tailwindcss/postcss") : require("tailwindcss"),
    require("autoprefixer"),
  ],
};
