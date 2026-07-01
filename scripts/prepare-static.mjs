import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const publicDir = path.join(rootDir, "public");
const sourceDataDir = path.join(rootDir, "Data");
const targetDataDir = path.join(publicDir, "Data");

await rm(publicDir, { recursive: true, force: true });
await mkdir(targetDataDir, { recursive: true });

await cp(path.join(rootDir, "index.html"), path.join(publicDir, "index.html"));
await cp(sourceDataDir, targetDataDir, { recursive: true });
