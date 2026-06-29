import { appPaths } from "../config/paths.js";
import { recommendedModels } from "../models/registry.js";
import { listLocalModelPaths } from "./utils.js";
import { supportedModelExtensions } from "../engine/whisper-process.js";

export async function modelsCommand(): Promise<void> {
  const localModels = await listLocalModelPaths();

  console.log("Local models directory:");
  console.log(`  ${appPaths.modelsDir}`);
  console.log("");

  if (localModels.length === 0) {
    console.log("Local models:");
    console.log(`  No ${supportedModelExtensions().join(", ")} model files found.`);
    console.log("");
  } else {
    console.log("Local models:");
    for (const model of localModels) {
      console.log(`  ${model}`);
    }
    console.log("");
  }

  console.log("Recommended starter models:");
  for (const model of recommendedModels) {
    console.log(`  ${model.name.padEnd(10)} ${model.size.padEnd(6)} ${model.language.padEnd(12)} ${model.fileNames.join(" or ")}`);
    console.log(`    ${model.notes}`);
  }
}
