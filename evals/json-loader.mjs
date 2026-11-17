// Lets plain Node import the app's `import x from "./file.json"` (Next.js handles this in the app).
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
import { readFile } from "node:fs/promises";
export async function load(url, context, next) {
  if (url.endsWith(".json")) {
    const src = await readFile(new URL(url), "utf8");
    return { format: "module", source: "export default " + src + ";", shortCircuit: true };
  }
  return next(url, context);
}`));
