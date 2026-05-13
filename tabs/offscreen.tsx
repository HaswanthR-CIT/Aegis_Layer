import { useEffect } from "react"
import { createWorker } from "tesseract.js"

let ocrWorker: any = null

async function initOCRWorker() {
  if (ocrWorker) return ocrWorker
  console.log("AegisLayer [Offscreen OCR]: Initializing Tesseract Web Worker...")
  
  const workerPath = chrome.runtime.getURL("assets/tesseract-worker.min.js")
  const corePath = chrome.runtime.getURL("assets/")
  const langPath = chrome.runtime.getURL("assets/")
  
  ocrWorker = await createWorker('eng', 1, {
    workerPath,
    corePath,
    langPath,
    workerBlobURL: false,
    gzip: true,
    logger: (m: any) => console.log(`AegisLayer [Offscreen OCR-Worker]: ${m.status} (${Math.round((m.progress || 0) * 100)}%)`)
  })
  
  console.log("AegisLayer [Offscreen OCR]: ✅ Tesseract Worker initialized.")
  return ocrWorker
}

async function handleOCR({ imageDataUrl, pageIndex, pageWidth, pageHeight }: any) {
  const worker = await initOCRWorker()
  console.log(`AegisLayer [Offscreen OCR]: Scanning page ${pageIndex + 1}...`)
  
  const result = await worker.recognize(imageDataUrl)
  const data = result.data
  
  const items: any[] = []
  const words = data?.words || []
  
  const imgWidth = data?.imageWidth || (pageWidth * 2)
  const imgHeight = data?.imageHeight || (pageHeight * 2)
  const scaleX = pageWidth / imgWidth
  const scaleY = pageHeight / imgHeight
  
  for (const word of words) {
    if (!word.text || !word.text.trim()) continue
    
    const bbox = word.bbox
    if (!bbox) continue
    
    items.push({
      text: word.text,
      x: bbox.x0 * scaleX,
      y: bbox.y0 * scaleY,
      width: (bbox.x1 - bbox.x0) * scaleX,
      height: (bbox.y1 - bbox.y0) * scaleY,
      pageIndex,
      pageWidth,
      pageHeight
    })
  }
  
  console.log(`AegisLayer [Offscreen OCR]: ✅ Mapped ${items.length} words on page ${pageIndex + 1}`)
  return { items }
}

export default function OffscreenPage() {
  useEffect(() => {
    const listener = (message: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
      if (message.target !== 'offscreen') return false

      if (message.type === 'PERFORM_OCR') {
        handleOCR(message.payload).then(sendResponse).catch(err => {
          console.error("AegisLayer [Offscreen OCR]: OCR failed:", err)
          sendResponse({ error: err.message || String(err) })
        })
        return true // Keep channel open for async response
      }
    }

    chrome.runtime.onMessage.addListener(listener)
    
    return () => {
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [])

  return (
    <div style={{ padding: 20 }}>
      <h1>AegisLayer OCR Worker</h1>
      <p>This is a hidden offscreen document used for processing AI tasks securely.</p>
    </div>
  )
}
