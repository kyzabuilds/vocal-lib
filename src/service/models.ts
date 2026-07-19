import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { supportedModelExtensions, validateModelPath } from "../engine/whisper-process.js";
import { recommendedModels, type RecommendedModel } from "../models/registry.js";
import type { ResolvedVocalConfig } from "./config.js";

export interface ModelInfo {
  name: string;
  path: string;
  sizeBytes?: number;
  selected?: boolean;
}

export interface ModelListResult {
  defaultModelPath?: string;
  local: ModelInfo[];
  modelsDir: string;
  recommended: RecommendedModel[];
  selectedModelPath?: string;
  supportedExtensions: string[];
}

export interface ListModelsOptions {
  selectedModelPath?: string;
}

export async function listModels(config: ResolvedVocalConfig, options: ListModelsOptions = {}): Promise<ModelListResult> {
  const local = await listLocalModels(config);
  const selectedModelPath = options.selectedModelPath ?? config.defaultModelPath ?? preferredModel(local);

  return {
    defaultModelPath: config.defaultModelPath,
    local: local.map((model) => ({ ...model, selected: Boolean(selectedModelPath && model.path === selectedModelPath) })),
    modelsDir: config.paths.modelsDir,
    recommended: recommendedModels,
    selectedModelPath,
    supportedExtensions: supportedModelExtensions(),
  };
}

export async function resolveModelPath(config: ResolvedVocalConfig, requested?: string): Promise<string> {
  const modelPath = requested ?? config.defaultModelPath ?? preferredModel(await listLocalModels(config));
  if (!modelPath) {
    throw new Error(
      `No model specified and no local default model found. Pass modelPath or add a ${supportedModelExtensions().join("/")} file to ${config.paths.modelsDir}.`,
    );
  }

  return validateModelPath(modelPath);
}

async function listLocalModels(config: ResolvedVocalConfig): Promise<ModelInfo[]> {
  const extensions = new Set(supportedModelExtensions());
  const entries = await readdir(config.paths.modelsDir, { withFileTypes: true }).catch(() => []);

  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && extensions.has(extname(entry.name).toLowerCase()))
      .map(async (entry) => {
        const path = join(config.paths.modelsDir, entry.name);
        const sizeBytes = await stat(path).then((value) => value.size).catch(() => undefined);
        return { name: entry.name, path, sizeBytes };
      }),
  ).then((models) => models.sort((a, b) => a.path.localeCompare(b.path)));
}

function preferredModel(models: ModelInfo[]): string | undefined {
  if (models.length === 0) {
    return undefined;
  }

  const turboLargeV3 = models.find((model) => /(?:^|[-_])large-v3-turbo\.(?:bin|gguf)$/i.test(model.name));
  if (turboLargeV3) {
    return turboLargeV3.path;
  }

  return [...models].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))[0].path;
}
