// Shared model-detection for real-embedding tests.
//
// The real bge-small model is present in two situations:
//   • dev machines that ran model prep → transformers.js download cache
//   • CI's package-verify job → downloaded to resources/models (the bundling
//     source dir that resolveAssetDir now also checks)
//
// Tests that need the REAL model gate on `hasBundledModel`: they RUN where it
// exists (dev + package-verify) and skip in the plain unit jobs that never
// download it. This is what un-gates semantic-recall coverage in CI.
import * as fs from 'fs'
import * as path from 'path'

const MODEL_DIR_NAME = 'bge-small-en-v1.5'

const candidates = [
  path.join(process.cwd(), 'resources', 'models', MODEL_DIR_NAME),
  path.join(process.cwd(), 'node_modules', '@huggingface', 'transformers', '.cache', 'Xenova', MODEL_DIR_NAME),
]

export const modelDir: string | undefined = candidates.find((c) =>
  fs.existsSync(path.join(c, 'tokenizer.json')),
)

export const hasBundledModel = modelDir !== undefined

/** The ms-marco cross-encoder (crossEncoderRerank.ts), fetched beside bge by scripts/download-embedding-model.sh. */
const rerankDir = path.join(process.cwd(), 'resources', 'models', 'ms-marco-MiniLM-L-6-v2')
export const hasRerankModel =
  fs.existsSync(path.join(rerankDir, 'tokenizer.json')) &&
  (fs.existsSync(path.join(rerankDir, 'model_quantized.onnx')) || fs.existsSync(path.join(rerankDir, 'onnx', 'model_quantized.onnx')))
