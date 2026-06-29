import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));

export const projectRoot = resolve(moduleDir, "../..");

export const appPaths = {
  root: projectRoot,
  binDir: join(projectRoot, "bin"),
  modelsDir: join(projectRoot, "models"),
  vendorDir: join(projectRoot, "vendor"),
  whisperCppDir: join(projectRoot, "vendor", "whisper.cpp"),
} as const;

export function resolveFromRoot(path: string): string {
  return resolve(projectRoot, path);
}
