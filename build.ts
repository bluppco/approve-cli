import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = import.meta.dir;
const output = resolve(root, "dist/bin.js");

await mkdir(resolve(root, "dist"), { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(root, "src/bin.ts")],
  outdir: resolve(root, "dist"),
  naming: "bin.js",
  target: "node",
  format: "esm",
  external: ["@loomup/client", "commander"],
  sourcemap: "external",
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
} else {
  await chmod(output, 0o755);
}
