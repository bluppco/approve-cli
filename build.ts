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
  external: ["commander"],
  sourcemap: "external",
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
} else {
  for (const artifact of [output, `${output}.map`]) {
    const contents = await Bun.file(artifact).text();
    if (/tryloomup\.com|@loomup\/client|\.\.\/astro/i.test(contents)) throw new Error(`Private platform implementation leaked into ${artifact}.`);
  }
  await chmod(output, 0o755);
}
