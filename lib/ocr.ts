import type { ExtractedTextItem } from "./pdfTextExtract"

export async function performOCR(
  imageDataUrl: string, 
  pageIndex: number, 
  pageWidth: number, 
  pageHeight: number
): Promise<ExtractedTextItem[]> {
  try {
    console.log(`AegisLayer [OCR Client]: Sending page ${pageIndex + 1} to offscreen worker...`)
    
    const response = await new Promise<any>((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'REQUEST_OCR',
        payload: { imageDataUrl, pageIndex, pageWidth, pageHeight }
      }, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
        } else if (res && res.error) {
          reject(new Error(res.error))
        } else {
          resolve(res)
        }
      })
    })
    
    const items = response?.items || []
    console.log(`AegisLayer [OCR Client]: ✅ Received ${items.length} words from offscreen worker for page ${pageIndex + 1}`)
    return items
  } catch (err) {
    console.error(`AegisLayer [OCR Client]: ❌ performOCR failed on page ${pageIndex + 1}:`, err)
    return []
  }
}
