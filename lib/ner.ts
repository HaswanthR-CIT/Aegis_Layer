import { pipeline, env } from "@xenova/transformers"
import type { ExtractedTextItem } from "./pdfTextExtract"
import type { PIIEntity } from "~store/uiState"

// Skip local model caching since extension environment handles it differently
env.allowLocalModels = false
env.useBrowserCache = true

let nerPipeline: any = null

export async function initNERPipeline() {
  if (nerPipeline) return nerPipeline
  console.log("AegisLayer [NER]: Downloading/Loading Xenova/bert-base-NER model...")
  nerPipeline = await pipeline("token-classification", "Xenova/bert-base-NER", {
    quantized: true, // Use int8 quantization to drastically reduce memory usage
  })
  return nerPipeline
}

/**
 * Groups raw subword tokens from the NER model into full entity strings.
 * E.g., ["Has", "##wan", "##th"] → "Haswanth"
 * And ["Info", "##sys"] → "Infosys"
 */
function groupSubwordTokens(
  rawOutput: Array<{ word: string; entity: string; entity_group: string; score: number; start: number; end: number }>
): Array<{ word: string; entity_group: string; score: number }> {
  const groups: Array<{ word: string; entity_group: string; score: number }> = []

  for (const token of rawOutput) {
    const tag = token.entity || token.entity_group || ""
    const isSubword = tag.startsWith("I-") || token.word.startsWith("##")

    if (isSubword && groups.length > 0) {
      // Continuation of previous entity — merge
      const last = groups[groups.length - 1]
      const cleanPart = token.word.replace(/^##/, "")
      last.word += cleanPart
      last.score = Math.max(last.score, token.score)
    } else {
      // New entity begins
      const entityType = tag.replace(/^[BI]-/, "")
      groups.push({
        word: token.word.replace(/^##/, ""),
        entity_group: entityType,
        score: token.score,
      })
    }
  }

  return groups
}

/**
 * Map grouped AI-detected words back to the physical PDF coordinates.
 * Uses fuzzy matching: finds ALL text items that contain the entity word.
 */
function mapEntitiesToCoordinates(
  aiEntities: Array<{ word: string; entity_group: string; score: number }>,
  textItems: ExtractedTextItem[]
): PIIEntity[] {
  const mapped: PIIEntity[] = []
  
  // Only map high-confidence entities with meaningful types
  const IMPORTANT_TYPES = new Set(["PER", "ORG", "LOC", "MISC"])

  for (const ent of aiEntities) {
    // Skip low-confidence junk
    if (ent.score < 0.5) continue
    // Skip non-important types
    if (!IMPORTANT_TYPES.has(ent.entity_group)) continue
    // Skip very short words (single char, punctuation)
    if (ent.word.length < 2) continue

    // Find ALL matching physical text items (not just the first)
    const matches = textItems.filter((item) =>
      item.text.toLowerCase().includes(ent.word.toLowerCase())
    )

    for (const match of matches) {
      mapped.push({
        id: `ai-ner-${Date.now()}-${Math.random()}`,
        type: ent.entity_group, // "PER", "ORG", "LOC"
        value: ent.word,
        shouldMask: true,
        box: {
          x: match.x,
          y: match.y,
          width: match.width,
          height: match.height,
          pageIndex: match.pageIndex,
        },
      })
    }
  }

  // Deduplicate overlapping boxes
  const unique = mapped.filter((val, idx, arr) =>
    arr.findIndex(v => v.box?.x === val.box?.x && v.box?.y === val.box?.y) === idx
  )
  
  return unique
}

export async function performLocalNER(
  fullText: string,
  textItems: ExtractedTextItem[]
): Promise<PIIEntity[]> {
  try {
    const pipe = await initNERPipeline()
    console.log("AegisLayer [NER]: Pipeline ready, running inference...")

    // Process the text in chunks of ~450 chars to stay under the 512 token limit
    // while covering MORE of the document than before (was only 2000 chars).
    const MAX_CHUNK = 450
    const allOutput: any[] = []
    const textToProcess = fullText.substring(0, 8000) // Process up to 8000 chars
    
    for (let i = 0; i < textToProcess.length; i += MAX_CHUNK) {
      const chunk = textToProcess.substring(i, i + MAX_CHUNK)
      try {
        const output = await pipe(chunk, { ignore_labels: ["O"] })
        allOutput.push(...output)
      } catch (chunkErr) {
        console.warn(`AegisLayer [NER]: Chunk at offset ${i} failed, skipping...`)
      }
    }
    
    console.log(`AegisLayer [NER]: Raw AI output: ${allOutput.length} subword tokens from ${Math.ceil(textToProcess.length / MAX_CHUNK)} chunks`)
    
    // Group subword tokens into full entity strings
    const grouped = groupSubwordTokens(allOutput)
    console.log(`AegisLayer [NER]: Grouped into ${grouped.length} entities:`, grouped.map(g => `${g.entity_group}: "${g.word}" (${(g.score * 100).toFixed(0)}%)`))
    
    return mapEntitiesToCoordinates(grouped, textItems)
  } catch (err) {
    console.error("AegisLayer [NER]: Pipeline failed:", err)
    return []
  }
}
