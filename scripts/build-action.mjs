import { build } from "esbuild";
import { chmod } from "node:fs/promises";

await chmod("dist/cli.js", 0o755);

await build({
  entryPoints: ["src/action.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "action/dist/index.mjs",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
