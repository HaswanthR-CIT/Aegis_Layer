/**
 * AegisLayer — PDF Text Extraction Engine
 *
 * Uses pdfjs-dist (Mozilla PDF.js) with the OFFICIAL worker setup
 * from their webpack.mjs entry point. This extracts every word in the
 * PDF along with its EXACT page coordinates (bounding box).
 *
 * These coordinates are what makes redaction accurate — we know exactly
 * where each word sits on the page, so when we draw a white rectangle
 * over it, it covers precisely the right pixels.
 */

// ─── Import pdfjs-dist using the OFFICIAL legacy webpack entry ──────────────
// This entry point automatically:
// 1. Imports from the legacy build (compatible with extension CSP)
// 2. Creates a Worker using the correct URL pattern
// 3. Sets GlobalWorkerOptions.workerPort (not workerSrc)
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs"
import { performOCR } from "./ocr"

// Set up the worker using Parcel's new URL(import.meta.url) pattern.
// Parcel will copy the worker file to the build output automatically
// and rewrite this URL to point to the output file.
try {
  if (typeof window !== "undefined" && "Worker" in window) {
    GlobalWorkerOptions.workerPort = new Worker(
      new URL(
        "pdfjs-dist/legacy/build/pdf.worker.mjs",
        import.meta.url
      ),
      { type: "module" }
    )
    console.log("AegisLayer [Extract]: PDF.js worker initialized successfully")
  }
} catch (err) {
  console.warn("AegisLayer [Extract]: Worker init failed, will use main thread:", err)
}

// ─── Types ──────────────────────────────────────────────────────────────────
export interface ExtractedTextItem {
  text: string
  x: number          // PDF units, from left edge of page
  y: number          // Converted to top-origin (y=0 at top of page)
  width: number      // Width in PDF units
  height: number     // Height in PDF units (approx font size)
  pageIndex: number  // 0-based page number
  pageHeight: number
  pageWidth: number
}

export interface ExtractionResult {
  items: ExtractedTextItem[]
  fullText: string
  numPages: number
  pageHeight: number
  pageWidth: number
}

// ─── Main Extraction Function ───────────────────────────────────────────────
export async function extractTextFromPdf(
  pdfData: ArrayBuffer, 
  onProgress?: (msg: string) => void
): Promise<ExtractionResult> {
  console.log("AegisLayer [Extract]: Starting PDF text extraction...")
  if (onProgress) onProgress("Initializing PDF extraction...")

  const loadingTask = getDocument({
    data: new Uint8Array(pdfData) as any,
    isEvalSupported: false,   // Prevent eval() — blocked by Chrome extension CSP
    useSystemFonts: true,
  })
  const doc = await loadingTask.promise

  console.log(`AegisLayer [Extract]: Loaded PDF with ${doc.numPages} pages`)
  if (onProgress) onProgress(`PDF loaded (${doc.numPages} pages). Starting text processing...`)

  const allItems: ExtractedTextItem[] = []
  let fullText = ""
  let firstPageHeight = 792
  let firstPageWidth = 612

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    if (onProgress) onProgress(`Processing page ${pageNum} of ${doc.numPages}...`)
    const page = await doc.getPage(pageNum)
    const viewport = page.getViewport({ scale: 1.0 })

    if (pageNum === 1) {
      firstPageHeight = viewport.height
      firstPageWidth = viewport.width
    }

    const textContent = await page.getTextContent()

    let pageItems = textContent.items
      .filter((i): i is import("pdfjs-dist/types/src/display/api").TextItem => "str" in i && i.str.trim().length > 0)

    // Count total extracted characters on this page
    const pageCharCount = pageItems.reduce((sum, i) => sum + i.str.length, 0)

    // Run OCR if the page has very few text items or very little text content.
    // This catches image-heavy PDFs that have some minimal text overlay but
    // the real content is embedded in images (e.g., scanned resumes, infographics).
    const SPARSE_THRESHOLD = 30  // fewer than 30 text items
    const CHAR_THRESHOLD = 200   // fewer than 200 characters
    const needsOCR = pageItems.length < SPARSE_THRESHOLD || pageCharCount < CHAR_THRESHOLD

    if (needsOCR) {
      console.log(`AegisLayer [Extract]: Page ${pageNum} appears image-heavy (${pageItems.length} items, ${pageCharCount} chars). Running OCR...`)
      const canvas = document.createElement("canvas")
      const ocrScale = 2.0 
      const ocrViewport = page.getViewport({ scale: ocrScale })
      canvas.width = ocrViewport.width
      canvas.height = ocrViewport.height
      const ctx = canvas.getContext("2d")!
      
      await page.render({ canvasContext: ctx, viewport: ocrViewport, canvas }).promise
      const imageDataUrl = canvas.toDataURL("image/png")
      
      if (onProgress) onProgress(`Running OCR on page ${pageNum}... (this may take a few seconds)`)
      const ocrResults = await performOCR(imageDataUrl, pageNum - 1, viewport.width, viewport.height)
      console.log(`AegisLayer [Extract]: OCR found ${ocrResults.length} additional words on page ${pageNum}`)
      
      // If text layer was completely empty, use OCR results directly
      if (pageItems.length === 0) {
        allItems.push(...ocrResults)
        fullText += ocrResults.map(i => i.text).join(" ") + "\n\n"
        continue
      }
      
      // Otherwise MERGE: keep existing text items and add OCR items that don't overlap
      const existingTexts = new Set(pageItems.map(i => i.str.toLowerCase().trim()))
      for (const ocrItem of ocrResults) {
        if (!existingTexts.has(ocrItem.text.toLowerCase().trim())) {
          allItems.push(ocrItem)
          fullText += ocrItem.text + " "
        }
      }
    }

    for (const item of pageItems) {
      // item.transform = [scaleX, skewX, skewY, scaleY, translateX, translateY]
      const transform = item.transform
      const fontSize = Math.abs(transform[3]) || Math.abs(transform[0]) || 12
      const pdfX = transform[4]
      const pdfY = transform[5]

      // Convert from PDF coordinate space (bottom-left origin) to
      // top-left origin (web/display convention) for our overlay UI
      const topOriginY = viewport.height - pdfY - fontSize

      // Width: pdfjs-dist provides item.width in viewport units
      const textWidth = item.width != null && item.width > 0
        ? item.width
        : item.str.length * fontSize * 0.5

      allItems.push({
        text: item.str,
        x: pdfX,
        y: topOriginY,
        width: textWidth,
        height: fontSize,
        pageIndex: pageNum - 1,
        pageHeight: viewport.height,
        pageWidth: viewport.width,
      })

      fullText += item.str + " "
    }

    fullText += "\n"
  }

  await loadingTask.destroy()

  console.log(`AegisLayer [Extract]: Extracted ${allItems.length} text items, ${fullText.length} chars total`)

  return {
    items: allItems,
    fullText: fullText.trim(),
    numPages: doc.numPages,
    pageHeight: firstPageHeight,
    pageWidth: firstPageWidth,
  }
}

// ─── Render PDF Pages to Images (for visual preview) ────────────────────────
export interface RenderedPage {
  dataUrl: string
  width: number       // Display width (scaled)
  height: number      // Display height (scaled)
  pdfWidth: number    // Original PDF width
  pdfHeight: number   // Original PDF height
  pageIndex: number
  scale: number
}

export async function renderPdfPages(
  pdfData: ArrayBuffer,
  scale: number = 1.5
): Promise<RenderedPage[]> {
  console.log(`AegisLayer [Render]: Rendering PDF pages at ${scale}x...`)

  const loadingTask = getDocument({
    data: new Uint8Array(pdfData) as any,
    isEvalSupported: false,
    useSystemFonts: true,
  })
  const doc = await loadingTask.promise

  const renderedPages: RenderedPage[] = []

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement("canvas")
    canvas.width = viewport.width
    canvas.height = viewport.height
    const ctx = canvas.getContext("2d")!

    await page.render({ canvasContext: ctx, viewport, canvas }).promise

    renderedPages.push({
      dataUrl: canvas.toDataURL("image/png"),
      width: viewport.width,
      height: viewport.height,
      pdfWidth: viewport.width / scale,
      pdfHeight: viewport.height / scale,
      pageIndex: i - 1,
      scale,
    })
  }

  await loadingTask.destroy()
  console.log(`AegisLayer [Render]: Rendered ${renderedPages.length} pages`)
  return renderedPages
}
