#!/usr/bin/env node
import { dirname } from "node:path";
import { createVocalIpcServer } from "../ipc/server.js";
import type { Backend } from "../engine/types.js";

interface GatewayArgs {
  backend?: Backend;
  binDir?: string;
  defaultModelPath?: string;
  modelsDir?: string;
  mock?: boolean;
  rootDir?: string;
  runtimeDir?: string;
  socket?: string;
  stdio?: boolean;
  whisperCliPath?: string;
  whisperCppDir?: string;
  whisperStreamPath?: string;
}

const args = parseArgs(process.argv.slice(2));
const server = createVocalIpcServer({
  endpoint: args.socket,
  serviceConfig: {
    defaults: {
      backend: args.backend,
      modelPath: args.defaultModelPath,
    },
    mock: args.mock,
    paths: {
      binDir: args.binDir,
      defaultModelPath: args.defaultModelPath,
      modelsDir: args.modelsDir,
      rootDir: args.rootDir,
      runtimeDir: args.runtimeDir ?? (args.socket ? dirname(args.socket) : undefined),
      whisperCliPath: args.whisperCliPath,
      whisperCppDir: args.whisperCppDir,
      whisperStreamPath: args.whisperStreamPath,
    },
  },
});

const shutdown = async (): Promise<void> => {
  await server.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  if (args.stdio) {
    server.attachStdio();
  } else {
    const endpoint = await server.listen();
    process.stderr.write(`vocal-gateway listening on ${endpoint}\n`);
  }
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
}

function parseArgs(argv: string[]): GatewayArgs {
  const args: GatewayArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stdio") {
      args.stdio = true;
    } else if (arg === "--mock") {
      args.mock = true;
    } else if (arg === "--backend") {
      args.backend = parseBackend(requireValue(argv, ++index, "--backend"));
    } else if (arg === "--bin-dir") {
      args.binDir = requireValue(argv, ++index, "--bin-dir");
    } else if (arg === "--default-model" || arg === "--model") {
      args.defaultModelPath = requireValue(argv, ++index, arg);
    } else if (arg === "--models-dir") {
      args.modelsDir = requireValue(argv, ++index, "--models-dir");
    } else if (arg === "--root-dir") {
      args.rootDir = requireValue(argv, ++index, "--root-dir");
    } else if (arg === "--socket") {
      args.socket = requireValue(argv, ++index, "--socket");
    } else if (arg === "--runtime-dir") {
      args.runtimeDir = requireValue(argv, ++index, "--runtime-dir");
    } else if (arg === "--whisper-cli") {
      args.whisperCliPath = requireValue(argv, ++index, "--whisper-cli");
    } else if (arg === "--whisper-cpp-dir") {
      args.whisperCppDir = requireValue(argv, ++index, "--whisper-cpp-dir");
    } else if (arg === "--whisper-stream") {
      args.whisperStreamPath = requireValue(argv, ++index, "--whisper-stream");
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: vocal-gateway [--socket <path>] [--runtime-dir <path>] [--stdio] [--mock]",
          "                     [--root-dir <path>] [--models-dir <path>] [--bin-dir <path>]",
          "                     [--whisper-cpp-dir <path>] [--whisper-cli <path>] [--whisper-stream <path>]",
          "                     [--backend <auto|cpu|vulkan|hip>] [--default-model <path>]",
          "",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseBackend(value: string): Backend {
  if (value === "auto" || value === "cpu" || value === "vulkan" || value === "hip") {
    return value;
  }

  throw new Error(`Invalid --backend value: ${value}`);
}
