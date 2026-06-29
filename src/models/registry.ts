export interface RecommendedModel {
  name: string;
  size: "tiny" | "base" | "small" | "medium" | "large";
  language: "english" | "multilingual";
  fileNames: string[];
  notes: string;
}

export const recommendedModels: RecommendedModel[] = [
  {
    name: "tiny.en",
    size: "tiny",
    language: "english",
    fileNames: ["ggml-tiny.en.bin", "ggml-tiny.en.gguf"],
    notes: "Fastest English-only smoke test model.",
  },
  {
    name: "base.en",
    size: "base",
    language: "english",
    fileNames: ["ggml-base.en.bin", "ggml-base.en.gguf"],
    notes: "Good default for quick local English transcription.",
  },
  {
    name: "small.en",
    size: "small",
    language: "english",
    fileNames: ["ggml-small.en.bin", "ggml-small.en.gguf"],
    notes: "Better accuracy while still practical for local use.",
  },
  {
    name: "small",
    size: "small",
    language: "multilingual",
    fileNames: ["ggml-small.bin", "ggml-small.gguf"],
    notes: "Useful first multilingual model.",
  },
  {
    name: "medium",
    size: "medium",
    language: "multilingual",
    fileNames: ["ggml-medium.bin", "ggml-medium.gguf"],
    notes: "Higher accuracy with a larger CPU/GPU footprint.",
  },
];
