/**
 * AegisLayer — Background Service Worker
 *
 * Handles extension lifecycle events and logging.
 * The heavy processing (text extraction, PII detection) happens
 * in the content scripts and popup for Chrome MV3 compatibility.
 */

export {}

console.log("AegisLayer: Background Service Worker initialized.")

let creatingOffscreen: Promise<void> | null = null

async function setupOffscreenDocument() {
  const OFFSCREEN_DOCUMENT_PATH = 'tabs/offscreen.html'
  const url = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)
  
  // Check if it already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url]
  })
  
  if (existingContexts.length > 0) return

  if (creatingOffscreen) {
    await creatingOffscreen
    return
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: 'Run Tesseract OCR Worker securely outside of content script CSP'
  })

  await creatingOffscreen
  creatingOffscreen = null
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "PROCESS_INTERCEPTED_FILE") {
    console.log(
      "AegisLayer (Background): File intercepted ->",
      message.payload.name,
      `(${message.payload.size} bytes)`
    )
    sendResponse({ status: "acknowledged" })
    return false
  }
  
  if (message.action === "REQUEST_OCR") {
    console.log("AegisLayer (Background): Received OCR request, routing to offscreen...")
    
    const maxRetries = 5
    let attempt = 0
    
    const sendToOffscreen = () => {
      chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'PERFORM_OCR',
        payload: message.payload
      }, (response) => {
        if (chrome.runtime.lastError) {
          if (attempt < maxRetries) {
            attempt++
            console.log(`AegisLayer (Background): Offscreen not ready (attempt ${attempt}), retrying...`)
            setTimeout(sendToOffscreen, 500)
          } else {
            console.error("AegisLayer (Background): Routing error after retries:", chrome.runtime.lastError)
            sendResponse({ error: "Offscreen document unresponsive after multiple retries." })
          }
        } else if (!response && attempt < maxRetries) {
           // Sometimes sendMessage returns undefined if no listener responded
           attempt++
           console.log(`AegisLayer (Background): No response from offscreen (attempt ${attempt}), retrying...`)
           setTimeout(sendToOffscreen, 500)
        } else {
          sendResponse(response)
        }
      })
    }

    setupOffscreenDocument().then(() => {
      sendToOffscreen()
    }).catch(err => {
      console.error("AegisLayer (Background): Failed to setup offscreen doc:", err)
      sendResponse({ error: err.message })
    })
    
    return true // Keep channel open for async response
  }

  return false
})
