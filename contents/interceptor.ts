/**
 * AegisLayer Interceptor — Content Script
 *
 * Architecture: We use a SINGLE document-level capture-phase listener.
 * This is the ONLY reliable way to intercept file uploads because:
 * - Capture phase runs BEFORE bubble phase
 * - document-level capture fires before ANY element-level listener
 * - This guarantees we see the file BEFORE the website's handlers
 *
 * The per-element hijacking approach fails because websites attach
 * their listeners before our content script runs, making our
 * stopImmediatePropagation() call arrive too late.
 */

import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  all_frames: true,
  run_at: "document_start", // Inject as early as possible
}

// ─── Process a file and dispatch to overlay ─────────────────────────────────
function processAndDispatch(file: File, inputId: string): void {
  const reader = new FileReader()
  reader.onload = () => {
    const base64data = reader.result as string
    console.log("AegisLayer [Interceptor]: File read complete. Dispatching prompt to overlay...")

    // Notify background (optional, for logging)
    try {
      chrome.runtime.sendMessage({
        action: "PROCESS_INTERCEPTED_FILE",
        payload: { name: file.name, type: file.type, size: file.size }
      })
    } catch (err) {
      // Background may not be available — that's OK
    }

    // Dispatch to the overlay UI (overlay.tsx listens for this)
    document.dispatchEvent(new CustomEvent("aegis-open-overlay", {
      detail: {
        fileName: file.name,
        targetData: base64data,
        inputId: inputId,
      }
    }))
  }
  reader.readAsDataURL(file)
}

// ─── CORE: Document-level Capture Listener ──────────────────────────────────
// This runs in the CAPTURE phase (3rd argument = true), which means it fires
// BEFORE any event listener attached directly to the input element.
// This gives us guaranteed first-mover advantage over website code.
function setupCaptureInterceptor(): void {
  document.addEventListener("change", (e: Event) => {
    const target = e.target as HTMLInputElement

    // Only care about file inputs
    if (!target || target.tagName !== "INPUT" || target.type !== "file") return
    if (!target.files || target.files.length === 0) return

    // Phase 7 safety: ignore our own synthetic re-injections
    if (target.dataset.aegisSyntheticallyInjected === "true") {
      console.log("AegisLayer [Interceptor]: Synthetic injection — passing through.")
      target.dataset.aegisSyntheticallyInjected = "false"
      return
    }

    const file = target.files[0]

    // Only intercept PDFs
    const isPDF = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
    if (!isPDF) {
      console.log(`AegisLayer [Interceptor]: Non-PDF (${file.type}) — bypassing.`)
      return
    }

    console.log(`AegisLayer [Interceptor]: 🚨 PDF intercepted → "${file.name}" (${(file.size / 1024).toFixed(1)} KB)`)

    // STOP the event here — no other listener (website's or ours) will see it
    e.stopImmediatePropagation()
    e.preventDefault()

    // Capture the file reference BEFORE clearing
    const interceptedFile = new File([file], file.name, { type: file.type })

    // Tag with a unique ID so we can re-inject to the exact same input later
    const uniqueId = "aegis_" + Date.now() + "_" + Math.floor(Math.random() * 1000)
    target.dataset.aegisId = uniqueId

    // Defuse the input — the website sees nothing
    target.value = ""

    // Read and dispatch to the overlay
    processAndDispatch(interceptedFile, uniqueId)
  }, true) // <<< CRITICAL: true = capture phase

  console.log("AegisLayer [Interceptor]: ✅ Document-level capture interceptor armed.")
}

// ─── Drag-and-Drop Interception ─────────────────────────────────────────────
function setupDropInterception(): void {
  document.addEventListener("dragover", (e) => {
    e.preventDefault()
  }, true)

  document.addEventListener("drop", (e: DragEvent) => {
    if (!e.dataTransfer?.files?.length) return

    const file = e.dataTransfer.files[0]
    const isPDF = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
    if (!isPDF) return

    console.log("AegisLayer [Interceptor]: 🚨 PDF dropped via drag-and-drop. Intercepting...")
    e.preventDefault()
    e.stopImmediatePropagation()

    const uniqueId = "aegis_drop_" + Date.now()
    processAndDispatch(file, uniqueId)
  }, true)
}

// ─── Initialize ─────────────────────────────────────────────────────────────
function init(): void {
  console.log("AegisLayer [Interceptor]: Initializing on", window.location.href)
  setupCaptureInterceptor()
  setupDropInterception()
  console.log("AegisLayer [Interceptor]: ✅ Ready — capture interceptor + D&D active")
}

// document_start means body may not exist yet, but document does
// We just attach to document — no need to wait for body
init()
