// build-ui.mjs
import esbuild from "esbuild";
import { copyFile, mkdir, readdir, stat } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTDIR = path.join(__dirname, "public");
const SRC_DIR = path.join(__dirname, "ui-src");
const ENTRY = path.join(SRC_DIR, "index.jsx");
const INDEX_HTML = path.join(SRC_DIR, "index.html");
const WATCH = process.argv.includes("--watch");

async function copyIfExists(src, dest) {
  try {
    await copyFile(src, dest);
    console.log(`Copied: ${path.basename(src)} -> ${dest}`);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
}

async function copyRecursive(srcDir, destDir) {
  // ensure dest exists
  await mkdir(destDir, { recursive: true });
  const items = await readdir(srcDir);
  for (const item of items) {
    const srcPath = path.join(srcDir, item);
    const destPath = path.join(destDir, item);
    const s = await stat(srcPath);
    if (s.isDirectory()) {
      await copyRecursive(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

async function build() {
  await mkdir(OUTDIR, { recursive: true });

  await copyIfExists(INDEX_HTML, path.join(OUTDIR, "index.html"));

  const ASSETS_SRC = path.join(SRC_DIR, "assets");
  try {
    const s = await stat(ASSETS_SRC);
    if (s.isDirectory()) {
      await copyRecursive(ASSETS_SRC, path.join(OUTDIR, "assets"));
      console.log("Copied assets -> public/assets");
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const outFile = path.join(OUTDIR, "bundle.js");

  const ctx = await esbuild.context({
    entryPoints: [ENTRY],
    bundle: true,
    minify: process.env.NODE_ENV === "production",
    sourcemap: process.env.NODE_ENV !== "production",
    // outfile: outFile,
    outdir: OUTDIR,
    entryNames: "bundle",
    loader: {
      ".js": "jsx",
      ".jsx": "jsx",
      ".css": "css",
      ".png": "file",
      ".svg": "file",
      ".jpg": "file",
      ".jpeg": "file",
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        process.env.NODE_ENV || "development"
      ),
    },
    logLevel: "info",
  });

  if (WATCH) {
    await ctx.watch();
    console.log("Watching UI sources for changes...");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log(`Build complete -> ${outFile}`);
  }
}

build().catch((err) => {
  console.error("UI build failed:", err);
  process.exit(1);
});
