import { access } from "node:fs/promises";
import { appPaths } from "../config/paths.js";
import {
  candidateLabel,
  resolveWhisperBinary,
  supportedModelExtensions,
} from "../engine/whisper-process.js";
import { defaultOpenRouterBaseUrl, defaultOpenRouterModel, readOpenRouterConfig } from "../llm/openrouter.js";
import { isCommandAvailable, listLocalModelPaths } from "./utils.js";

interface Check {
  label: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export async function doctorCommand(): Promise<void> {
  const checks: Check[] = [];

  checks.push({
    label: "Node",
    ok: true,
    detail: `${process.version}`,
  });

  checks.push({
    label: "Platform",
    ok: true,
    detail: `${process.platform} ${process.arch}`,
  });

  for (const [label, path] of [
    ["Project root", appPaths.root],
    ["Binary directory", appPaths.binDir],
    ["Models directory", appPaths.modelsDir],
    ["Vendor directory", appPaths.vendorDir],
  ] as const) {
    checks.push({
      label,
      ok: await exists(path),
      detail: path,
      hint: `Create ${path} if it is missing.`,
    });
  }

  const cliBinary = await resolveWhisperBinary("cli");
  checks.push({
    label: "whisper.cpp file binary",
    ok: cliBinary.found !== null,
    detail: cliBinary.found ? candidateLabel(cliBinary.found) : "not found",
    hint: `Set ${cliBinary.envVar} or place whisper-cli in ${appPaths.binDir}.`,
  });

  const streamBinary = await resolveWhisperBinary("stream");
  checks.push({
    label: "whisper.cpp stream binary",
    ok: streamBinary.found !== null,
    detail: streamBinary.found ? candidateLabel(streamBinary.found) : "not found",
    hint: `Set ${streamBinary.envVar} or place whisper-stream in ${appPaths.binDir}.`,
  });

  const localModels = await listLocalModelPaths();
  checks.push({
    label: "Local models",
    ok: localModels.length > 0,
    detail: localModels.length > 0 ? `${localModels.length} model file(s) found` : "none found",
    hint: `Place a ${supportedModelExtensions().join(", ")} model in ${appPaths.modelsDir}.`,
  });

  const openRouter = readOpenRouterConfig();
  checks.push({
    label: "OpenRouter API key",
    ok: Boolean(openRouter.apiKey),
    detail: openRouter.apiKey ? "configured via VOCAL_OPENROUTER_API_KEY" : "not configured",
    hint: "Set VOCAL_OPENROUTER_API_KEY only if you want to use --polish.",
  });
  checks.push({
    label: "OpenRouter base URL",
    ok: true,
    detail: openRouter.baseUrl === defaultOpenRouterBaseUrl ? `${openRouter.baseUrl} (default)` : openRouter.baseUrl,
  });
  checks.push({
    label: "OpenRouter model",
    ok: true,
    detail: openRouter.model === defaultOpenRouterModel ? `${openRouter.model} (default)` : openRouter.model,
  });

  for (const tool of ["ffmpeg", "arecord", "rocminfo", "vulkaninfo"]) {
    checks.push(await checkTool(tool));
  }

  console.log("Vocal doctor");
  console.log("");

  for (const check of checks) {
    const mark = check.ok ? "ok" : "missing";
    console.log(`${mark.padEnd(8)} ${check.label}: ${check.detail}`);
    if (!check.ok && check.hint) {
      console.log(`         hint: ${check.hint}`);
    }
  }

  console.log("");
  if (!streamBinary.found) {
    console.log("Next step: build whisper.cpp with the stream example and copy or link whisper-stream into ./bin, or set VOCAL_WHISPER_STREAM.");
  } else if (localModels.length === 0) {
    console.log(`Next step: add a ${supportedModelExtensions().join(", ")} model under ./models.`);
  } else {
    console.log("Next step: run vocal --model <model-path> and start speaking into your microphone.");
  }
}

async function checkTool(command: string): Promise<Check> {
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
