import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { appPaths } from "../config/paths.js";
import { validateModelPath, supportedModelExtensions } from "../engine/whisper-process.js";

export async function findDefaultModelPath(): Promise<string | null> {
  if (process.env.VOCAL_MODEL && process.env.VOCAL_MODEL.trim().length > 0) {
    return process.env.VOCAL_MODEL.trim();
  }

  const localModels = await listLocalModelPaths();
  return await mostAccurateModel(localModels);
}

// whisper ggml models grow monotonically with accuracy, so the largest file on
// disk is the most accurate available. Fall back to the first if a stat fails.
async function mostAccurateModel(paths: string[]): Promise<string | null> {
  if (paths.length === 0) {
    return null;
  }

  const sized = await Promise.all(
    paths.map(async (path) => ({ path, size: await stat(path).then((s) => s.size).catch(() => 0) })),
  );
  sized.sort((a, b) => b.size - a.size);
  return sized[0].path;
}

export async function listLocalModelPaths(): Promise<string[]> {
  const extensions = new Set(supportedModelExtensions());
  const entries = await readdir(appPaths.modelsDir, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isFile() && extensions.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(appPaths.modelsDir, entry.name))
    .sort();
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];

  for (const dir of pathValue.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        return true;
      } catch {
        // Continue scanning PATH.
      }
    }
  }

  return false;
}

export async function validateSelectedModelPath(model: string | undefined): Promise<string> {
  const selectedModel = model ?? (await findDefaultModelPath());
  if (!selectedModel) {
    throw new Error("No model specified and no local default model found. Pass --model <path> or add a .bin/.gguf file to ./models.");
  }

  return validateModelPath(selectedModel);
}

export function formatBackendHint(backend: string, binaryLabel: string): string | null {
  if (backend === "cpu") {
    return `Backend requested: cpu. Vocal will pass --no-gpu to ${binaryLabel}.`;
  }

  if (backend === "vulkan") {
    return `Backend requested: vulkan. Vocal will use ${binaryLabel} as built; ensure it was compiled with Vulkan support.`;
  }

  if (backend === "hip") {
    return `Backend requested: hip. Vocal will use ${binaryLabel} as built; ensure it was compiled with HIP/ROCm support.`;
  }

  return null;
}
