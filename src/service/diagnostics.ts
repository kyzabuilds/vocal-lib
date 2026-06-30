import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import {
  candidateLabel,
  resolveConfiguredWhisperBinary,
  supportedModelExtensions,
} from "../engine/whisper-process.js";
import { defaultOpenRouterBaseUrl, defaultOpenRouterModel } from "../llm/openrouter.js";
import type { ResolvedVocalConfig } from "./config.js";
import { whisperPathConfig } from "./config.js";
import { listModels } from "./models.js";

export interface DiagnosticCheck {
  label: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export interface DoctorResult {
  checks: DiagnosticCheck[];
  nextStep?: string;
}

export interface DoctorOptions {
  includeTools?: boolean;
}

export async function doctor(config: ResolvedVocalConfig, options: DoctorOptions = {}): Promise<DoctorResult> {
  const checks: DiagnosticCheck[] = [];

  checks.push({ label: "Node", ok: true, detail: process.version });
  checks.push({ label: "Platform", ok: true, detail: `${process.platform} ${process.arch}` });

  for (const [label, path] of [
    ["Root directory", config.paths.rootDir],
    ["Binary directory", config.paths.binDir],
    ["Models directory", config.paths.modelsDir],
    ["Runtime directory", config.paths.runtimeDir],
    ["whisper.cpp directory", config.paths.whisperCppDir],
  ] as const) {
    checks.push({
      label,
      ok: await exists(path),
      detail: path,
      hint: `Create ${path} if it is missing.`,
    });
  }

  const binaryPaths = whisperPathConfig(config);
  const cliBinary = await resolveConfiguredWhisperBinary("cli", binaryPaths);
  checks.push({
    label: "whisper.cpp file binary",
    ok: cliBinary.found !== null,
    detail: cliBinary.found ? candidateLabel(cliBinary.found) : "not found",
    hint: `Set ${cliBinary.envVar}, configure whisperCliPath, or place whisper-cli in ${config.paths.binDir}.`,
  });

  const streamBinary = await resolveConfiguredWhisperBinary("stream", binaryPaths);
  checks.push({
    label: "whisper.cpp stream binary",
    ok: streamBinary.found !== null,
    detail: streamBinary.found ? candidateLabel(streamBinary.found) : "not found",
    hint: `Set ${streamBinary.envVar}, configure whisperStreamPath, or place whisper-stream in ${config.paths.binDir}.`,
  });

  const models = await listModels(config);
  checks.push({
    label: "Local models",
    ok: models.local.length > 0,
    detail: models.local.length > 0 ? `${models.local.length} model file(s) found` : "none found",
    hint: `Place a ${supportedModelExtensions().join(", ")} model in ${config.paths.modelsDir}.`,
  });

  checks.push({
    label: "Default backend",
    ok: true,
    detail: config.defaultBackend,
  });

  checks.push({
    label: "OpenRouter API key",
    ok: Boolean(config.openRouter.apiKey),
    detail: config.openRouter.apiKey ? "configured" : "not configured",
    hint: "Set VOCAL_OPENROUTER_API_KEY only if you want transcript polishing.",
  });
  checks.push({
    label: "OpenRouter base URL",
    ok: true,
    detail: config.openRouter.baseUrl === defaultOpenRouterBaseUrl ? `${config.openRouter.baseUrl} (default)` : config.openRouter.baseUrl,
  });
  checks.push({
    label: "OpenRouter model",
    ok: true,
    detail: config.openRouter.model === defaultOpenRouterModel ? `${config.openRouter.model} (default)` : config.openRouter.model,
  });

  if (options.includeTools ?? true) {
    for (const tool of ["ffmpeg", "arecord", "rocminfo", "vulkaninfo"]) {
      checks.push(await checkTool(tool));
    }
  }

  return {
    checks,
    nextStep: nextStep({ hasStream: Boolean(streamBinary.found), hasModels: models.local.length > 0 }),
  };
}

async function checkTool(command: string): Promise<DiagnosticCheck> {
  const available = await isCommandAvailable(command);
  const hints: Record<string, string> = {
    ffmpeg: "Install ffmpeg if you need audio conversion before transcription.",
    arecord: "Install ALSA tools if you want microphone capture on Linux.",
    rocminfo: "Install ROCm tools if you want to inspect AMD GPU support.",
    vulkaninfo: "Install Vulkan tools to inspect the Vulkan runtime for AMD GPU acceleration.",
  };

  return {
    label: command,
    ok: available,
    detail: available ? "available on PATH" : "not found on PATH",
    hint: hints[command],
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isCommandAvailable(command: string): Promise<boolean> {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];

  for (const dir of pathValue.split(delimiter)) {
    for (const extension of extensions) {
      try {
        await access(join(dir, `${command}${extension}`), constants.X_OK);
        return true;
      } catch {
        // Continue scanning PATH.
      }
    }
  }

  return false;
}

function nextStep(status: { hasStream: boolean; hasModels: boolean }): string {
  if (!status.hasStream) {
    return "build whisper.cpp with the stream example and copy or link whisper-stream into bin, or set VOCAL_WHISPER_STREAM.";
  }

  if (!status.hasModels) {
    return `add a ${supportedModelExtensions().join(", ")} model under the configured models directory.`;
  }

  return "start a live transcription session.";
}
