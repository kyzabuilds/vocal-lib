import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appPaths } from "../config/paths.js";
import type { Backend, WhisperPathConfig } from "../engine/types.js";
import {
  defaultOpenRouterBaseUrl,
  defaultOpenRouterModel,
  readOpenRouterConfig,
  type OpenRouterConfig,
} from "../llm/openrouter.js";

export interface VocalServiceConfigInput {
  defaults?: {
    backend?: Backend;
    modelPath?: string;
  };
  mock?: boolean;
  openRouter?: Partial<OpenRouterConfig>;
  paths?: {
    binDir?: string;
    defaultModelPath?: string;
    modelsDir?: string;
    rootDir?: string;
    runtimeDir?: string;
    whisperCliPath?: string;
    whisperCppDir?: string;
    whisperStreamPath?: string;
  };
}

export interface ResolvedVocalConfig {
  defaultBackend: Backend;
  defaultModelPath?: string;
  mock: boolean;
  openRouter: OpenRouterConfig;
  paths: Required<Omit<NonNullable<VocalServiceConfigInput["paths"]>, "defaultModelPath" | "whisperCliPath" | "whisperStreamPath">> & {
    defaultModelPath?: string;
    whisperCliPath?: string;
    whisperStreamPath?: string;
  };
}

export function resolveVocalConfig(input: VocalServiceConfigInput = {}, env: NodeJS.ProcessEnv = process.env): ResolvedVocalConfig {
  const rootDir = resolvePath(input.paths?.rootDir ?? cleanOptional(env.VOCAL_ROOT_DIR) ?? appPaths.root);
  const runtimeDir = resolvePath(
    input.paths?.runtimeDir ??
      cleanOptional(env.VOCAL_RUNTIME_DIR) ??
      join(cleanOptional(env.XDG_RUNTIME_DIR) ?? tmpdir(), "vocal"),
  );
  const envOpenRouter = readOpenRouterConfig(env);

  return {
    defaultBackend: input.defaults?.backend ?? parseBackendValue(cleanOptional(env.VOCAL_BACKEND)) ?? "vulkan",
    defaultModelPath: resolveOptionalPath(
      input.paths?.defaultModelPath ?? input.defaults?.modelPath ?? cleanOptional(env.VOCAL_MODEL),
    ),
    mock: input.mock ?? false,
    openRouter: {
      apiKey: input.openRouter?.apiKey ?? envOpenRouter.apiKey,
      baseUrl: input.openRouter?.baseUrl ?? envOpenRouter.baseUrl ?? defaultOpenRouterBaseUrl,
      model: input.openRouter?.model ?? envOpenRouter.model ?? defaultOpenRouterModel,
    },
    paths: {
      rootDir,
      binDir: resolvePath(input.paths?.binDir ?? cleanOptional(env.VOCAL_BIN_DIR) ?? join(rootDir, "bin")),
      modelsDir: resolvePath(input.paths?.modelsDir ?? cleanOptional(env.VOCAL_MODELS_DIR) ?? join(rootDir, "models")),
      runtimeDir,
      whisperCliPath: resolveOptionalPath(input.paths?.whisperCliPath ?? cleanOptional(env.VOCAL_WHISPER_CLI)),
      whisperCppDir: resolvePath(
        input.paths?.whisperCppDir ?? cleanOptional(env.VOCAL_WHISPER_CPP_DIR) ?? join(rootDir, "vendor", "whisper.cpp"),
      ),
      whisperStreamPath: resolveOptionalPath(input.paths?.whisperStreamPath ?? cleanOptional(env.VOCAL_WHISPER_STREAM)),
      defaultModelPath: resolveOptionalPath(
        input.paths?.defaultModelPath ?? input.defaults?.modelPath ?? cleanOptional(env.VOCAL_MODEL),
      ),
    },
  };
}

export function whisperPathConfig(config: ResolvedVocalConfig): WhisperPathConfig {
  return {
    binDir: config.paths.binDir,
    whisperCliPath: config.paths.whisperCliPath,
    whisperCppDir: config.paths.whisperCppDir,
    whisperStreamPath: config.paths.whisperStreamPath,
  };
}

export function defaultIpcEndpoint(config: ResolvedVocalConfig, env: NodeJS.ProcessEnv = process.env): string {
  return cleanOptional(env.VOCAL_IPC_ENDPOINT) ?? join(config.paths.runtimeDir, "vocal.sock");
}

function parseBackendValue(value: string | undefined): Backend | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "auto" || value === "cpu" || value === "vulkan" || value === "hip") {
    return value;
  }

  return undefined;
}

function resolveOptionalPath(value: string | undefined): string | undefined {
  return value ? resolveUserPath(value) : undefined;
}

function resolvePath(value: string): string {
  return resolveUserPath(value);
}

function resolveUserPath(value: string): string {
  if (value.startsWith("~/")) {
    return resolve(process.env.HOME ?? process.cwd(), value.slice(2));
  }

  return resolve(process.cwd(), value);
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}
