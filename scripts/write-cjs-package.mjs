// The package root is "type": "module", so the CommonJS build needs its own
// package.json telling Node (and TypeScript) to read dist/cjs as CommonJS.
import { writeFileSync } from "node:fs";

writeFileSync(
  new URL("../dist/cjs/package.json", import.meta.url),
  JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
);
