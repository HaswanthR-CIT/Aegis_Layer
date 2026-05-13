/**
 * AegisLayer Overlay — Content Script UI (CSUI)
 *
 * Renders inside a Shadow DOM on top of any host webpage.
 * Receives intercepted PDF data via CustomEvent or from the Popup via message.
 */

import cssText from "data-text:~/style.css"
import type { PlasmoCSConfig } from "plasmo"
import { useState, useEffect, useRef, useCallback } from "react"
import {
  Shield, FileText, Loader2, Check, X, Eye, EyeOff,
  Plus, Undo2, Download, Search, AlertTriangle, Sparkles,
  MousePointer2, Type, ChevronDown, Upload
} from "lucide-react"

import type { PIIEntity } from "~store/uiState"
import { extractTextFromPdf, renderPdfPages, type ExtractedTextItem, type RenderedPage } from "~lib/pdfTextExtract"
import { detectPIIWithAI, detectPIILocal, addGlobalRedaction } from "~lib/piiDetector"
import { sanitizePdf } from "~lib/redactor"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  all_frames: true
}

export const getStyle = () => {
  const style = document.createElement("style")
  style.textContent = cssText
  return style
}

const RENDER_SCALE = 1.5

export default function AegisOverlay() {
  const [isOpen, setIsOpen] = useState(false)
  const [inputId, setInputId] = useState("") // from interceptor

  // === Data ===
  const [pdfBase64, setPdfBase64] = useState("")
  const [fileName, setFileName] = useState("")
  const [providerId, setProviderId] = useState("local")

  // === Processing ===
  const [phase, setPhase] = useState<"prompt" | "loading" | "extracting" | "detecting" | "ready" | "sanitizing" | "done" | "error">("loading")
  const [statusMsg, setStatusMsg] = useState("Loading PDF...")
  const [logs, setLogs] = useState<string[]>([])

  // === Pending payload (held during 'prompt' phase) ===
  const [pendingPayload, setPendingPayload] = useState<{ b64: string; name: string; apiProv: string; apiK: string; srcInputId: string } | null>(null)

  // === Extraction Results ===
  const [extractedItems, setExtractedItems] = useState<ExtractedTextItem[]>([])
  const [fullText, setFullText] = useState("")
  const [pageImages, setPageImages] = useState<RenderedPage[]>([])

  // === Entities ===
  const [entities, setEntities] = useState<PIIEntity[]>([])

  // === Drag-to-redact ===
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [dragCurrent, setDragCurrent] = useState({ x: 0, y: 0 })
  const [dragPageIdx, setDragPageIdx] = useState(0)

  // === Undo ===
  const [undoStack, setUndoStack] = useState<string[][]>([])

  // === Manual text ===
  const [manualText, setManualText] = useState("")

  // === Stats ===
  const maskedCount = entities.filter(e => e.shouldMask).length
  const totalCount = entities.length

  const addLog = (msg: string) => {
    setLogs(prev => [...prev, `${new Date().toLocaleTimeString()} — ${msg}`])
  }

  const closeOverlay = () => {
    setIsOpen(false)
    setPhase("loading")
    setLogs([])
    setPageImages([])
    setEntities([])
    setUndoStack([])
    setPendingPayload(null)
  }

  // Handle incoming data — show prompt if intercepted, go straight if from popup
  const handleIncomingPdf = async (b64: string, name: string, apiProv: string, apiK: string, srcInputId: string = "", showPrompt: boolean = false) => {
    setIsOpen(true)
    setPdfBase64(b64)
    setFileName(name)
    setProviderId(apiProv)
    setInputId(srcInputId)

    if (showPrompt) {
      // Hold the payload and let user choose
      setPendingPayload({ b64, name, apiProv, apiK, srcInputId })
      setPhase("prompt")
      return
    }

    addLog(`Loaded: ${name}`)
    setPhase("extracting")
    setStatusMsg("Extracting text from PDF...")

    try {
      const response = await fetch(b64)
      const arrayBuffer = await response.arrayBuffer()

      addLog("Extracting text with PDF.js...")
      
      const bufferForExtraction = arrayBuffer.slice(0)
      const extraction = await extractTextFromPdf(bufferForExtraction, (msg) => addLog(msg))
      setExtractedItems(extraction.items)
      setFullText(extraction.fullText)
      addLog(`✅ Extracted ${extraction.items.length} characters from ${extraction.numPages} pages`)

      addLog("Rendering PDF pages for preview...")
      const bufferForRender = arrayBuffer.slice(0)
      const rendered = await renderPdfPages(bufferForRender, RENDER_SCALE)
      setPageImages(rendered)
      addLog(`✅ Rendered ${rendered.length} page images`)

      setPhase("detecting")
      let detected: PIIEntity[] = []

      if (apiProv !== "local" && apiK) {
        setStatusMsg(`Analyzing with ${apiProv}...`)
        addLog(`🤖 Sending to ${apiProv} for PII detection...`)
        
        // Removed silent fallback to local. If the user selects an API and provides a key,
        // it MUST use the API. If it fails (invalid key, etc), it will throw to the main catch block.
        detected = await detectPIIWithAI(extraction.fullText, extraction.items, apiProv, apiK)
        addLog(`✅ AI found ${detected.length} PII entities`)
      } else {
        setStatusMsg("Running local PII detection...")
        addLog("🔍 Running AegisLayer Local detection (NER + Heuristics)...")
        detected = await detectPIILocal(extraction.fullText, extraction.items)
        addLog(`✅ Local detection found ${detected.length} entities`)
      }

      setEntities(detected)
      setPhase("ready")
      setStatusMsg("")
    } catch (err: any) {
      addLog(`❌ Error: ${err?.message || err}`)
      setPhase("error")
      setStatusMsg(err?.message || "Processing failed")
    }
  }

  // Listeners for Interceptor (CustomEvent) and Popup (Runtime Message)
  useEffect(() => {
    const handleIntercept = async (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (!detail) return
      const stored = await chrome.storage?.local?.get(["aegis_api_provider", "aegis_api_key"])
      const apiProvider = (stored?.aegis_api_provider as string) || "local"
      const apiKey = (stored?.aegis_api_key as string) || ""
      // showPrompt=true — intercepted upload, user must choose
      handleIncomingPdf(detail.targetData, detail.fileName, apiProvider, apiKey, detail.inputId, true)
    }

    const handleMessage = (request: any, sender: any, sendResponse: any) => {
      if (request.action === "aegis_open_overlay") {
        const { targetData, fileName, providerId, apiKey } = request.payload
        handleIncomingPdf(targetData, fileName, providerId, apiKey, "")
        sendResponse({ success: true })
      }
    }

    document.addEventListener("aegis-open-overlay", handleIntercept)
    chrome.runtime.onMessage.addListener(handleMessage)

    return () => {
      document.removeEventListener("aegis-open-overlay", handleIntercept)
      chrome.runtime.onMessage.removeListener(handleMessage)
    }
  }, [])

  // Keyboard shortcut for Undo (Ctrl+Z)
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault()
        handleUndo()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [isOpen, undoStack])

  // Drag-to-redact handlers
  const handleMouseDown = (e: React.MouseEvent, pageIdx: number) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setIsDragging(true)
    setDragPageIdx(pageIdx)
    const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    setDragStart(pos)
    setDragCurrent(pos)
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return
    const rect = e.currentTarget.getBoundingClientRect()
    setDragCurrent({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  const handleMouseUp = () => {
    if (!isDragging) return
    setIsDragging(false)

    const selBox = {
      x: Math.min(dragStart.x, dragCurrent.x) / RENDER_SCALE,
      y: Math.min(dragStart.y, dragCurrent.y) / RENDER_SCALE,
      width: Math.abs(dragCurrent.x - dragStart.x) / RENDER_SCALE,
      height: Math.abs(dragCurrent.y - dragStart.y) / RENDER_SCALE,
    }

    if (selBox.width < 5 || selBox.height < 5) return

    const overlapping = extractedItems.filter(item => {
      if (item.pageIndex !== dragPageIdx) return false
      return !(item.x + item.width < selBox.x || item.x > selBox.x + selBox.width ||
               item.y + item.height < selBox.y || item.y > selBox.y + selBox.height)
    })

    const newIds: string[] = []

    if (overlapping.length > 0) {
      const newEntities = overlapping.map((item, i) => {
        const id = `drag-${Date.now()}-${i}`
        newIds.push(id)

        // Exact visual intersection on the X-axis to prevent full-paragraph masking
        const iX = Math.max(item.x, selBox.x)
        const iWidth = Math.min(item.x + item.width, selBox.x + selBox.width) - iX

        return {
          id, type: "DRAG_SELECT", value: item.text, shouldMask: true,
          box: { x: iX, y: item.y, width: iWidth, height: item.height + 2, pageIndex: item.pageIndex }
        } as PIIEntity
      })
      setEntities(prev => [...prev, ...newEntities])
      addLog(`📌 Drag-selected minutely mapped area across ${overlapping.length} item subsets`)
    } else {
      const id = `drag-area-${Date.now()}`
      newIds.push(id)
      setEntities(prev => [...prev, {
        id, type: "AREA_SELECT", value: `Region on page ${dragPageIdx + 1}`, shouldMask: true,
        box: { ...selBox, pageIndex: dragPageIdx },
      }])
      addLog(`📌 Area selected on page ${dragPageIdx + 1}`)
    }

    setUndoStack(prev => [...prev, newIds])
  }

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return
    const lastGroup = undoStack[undoStack.length - 1]
    setEntities(prev => prev.filter(e => !lastGroup.includes(e.id)))
    setUndoStack(prev => prev.slice(0, -1))
    addLog("↩️ Undid last action")
  }, [undoStack])

  const toggleMask = (id: string) => {
    setEntities(prev => prev.map(e => e.id === id ? { ...e, shouldMask: !e.shouldMask } : e))
  }

  const removeEntity = (id: string) => {
    setEntities(prev => prev.filter(e => e.id !== id))
  }

  const handleAddManual = async () => {
    if (!manualText.trim()) return
    try {
      const newEntities = addGlobalRedaction(manualText.trim(), extractedItems)
      if (newEntities.length > 0) {
        const newIds = newEntities.map(e => e.id)
        setEntities(prev => [...prev, ...newEntities])
        setUndoStack(prev => [...prev, newIds])
        addLog(`✅ Redacting "${manualText.trim()}" — ${newEntities.length} found globally`)
        setManualText("")
      } else {
        addLog(`⚠️ "${manualText.trim()}" not found in extracted text`)
      }
    } catch (err: any) {
      addLog(`⚠️ Error: ${err?.message}`)
    }
  }

  const injectFileToDOM = async (bytes: Uint8Array, name: string) => {
    const arrayBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const blob = new Blob([arrayBuf], { type: "application/pdf" })
    
    // If interceptor used, inject into page input
    if (inputId) {
      const newFile = new globalThis.File([blob], name, { type: "application/pdf" })
      const targetInput = document.querySelector(`[data-aegis-id="${inputId}"]`) as HTMLInputElement | null
      if (targetInput) {
        const dt = new DataTransfer()
        dt.items.add(newFile)
        targetInput.files = dt.files
        targetInput.dataset.aegisSyntheticallyInjected = "true"
        targetInput.dispatchEvent(new Event("change", { bubbles: true }))
        addLog("✅ Sanitized file injected back to webpage.")
        return
      }
    }

    // Default download fallback
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = name.replace(".pdf", "-sanitized.pdf")
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    addLog("✅ Sanitized PDF downloaded!")
  }

  const handleSanitize = async () => {
    setPhase("sanitizing")
    setStatusMsg("Applying redactions...")
    addLog("🔒 Sanitizing PDF...")

    try {
      const sanitizedBytes = await sanitizePdf(pdfBase64, entities)
      await injectFileToDOM(sanitizedBytes, fileName)
      setPhase("done")
      setTimeout(closeOverlay, 2000)
    } catch (err: any) {
      addLog(`❌ Redaction error: ${err?.message}`)
      setPhase("ready")
    }
  }

  const handleBypass = async () => {
    try {
      const arrayBuffer = await fetch(pdfBase64).then(res => res.arrayBuffer())
      await injectFileToDOM(new Uint8Array(arrayBuffer), fileName)
      closeOverlay()
    } catch (err) {
      console.error("AegisLayer: Bypass error:", err)
      closeOverlay()
    }
  }

  // Called from prompt — user chose "Scan for PII"
  const handleStartScan = async () => {
    if (!pendingPayload) return
    const { b64, name, apiProv, apiK, srcInputId } = pendingPayload
    setPendingPayload(null)
    setPhase("extracting")
    setStatusMsg("Extracting text from PDF...")
    addLog(`Loaded: ${name}`)

    try {
      const response = await fetch(b64)
      const arrayBuffer = await response.arrayBuffer()

      addLog("Extracting text with PDF.js...")
      const bufferForExtraction = arrayBuffer.slice(0)
      const extraction = await extractTextFromPdf(bufferForExtraction)
      setExtractedItems(extraction.items)
      setFullText(extraction.fullText)
      addLog(`✅ Extracted ${extraction.items.length} characters from ${extraction.numPages} pages`)

      addLog("Rendering PDF pages for preview...")
      const bufferForRender = arrayBuffer.slice(0)
      const rendered = await renderPdfPages(bufferForRender, RENDER_SCALE)
      setPageImages(rendered)
      addLog(`✅ Rendered ${rendered.length} page images`)

      setPhase("detecting")
      let detected: PIIEntity[] = []

      if (apiProv !== "local" && apiK) {
        setStatusMsg(`Analyzing with ${apiProv}...`)
        addLog(`🤖 Sending to ${apiProv} for PII detection...`)
        try {
          detected = await detectPIIWithAI(extraction.fullText, extraction.items, apiProv, apiK)
          addLog(`✅ AI found ${detected.length} PII entities`)
        } catch (aiErr: any) {
          addLog(`⚠️ API error: ${aiErr?.message}. Falling back to local...`)
          detected = await detectPIILocal(extraction.fullText, extraction.items)
        }
      } else {
        setStatusMsg("Running local PII detection...")
        addLog("🔍 Running AegisLayer Local detection...")
        detected = await detectPIILocal(extraction.fullText, extraction.items)
        addLog(`✅ Local detection found ${detected.length} entities`)
      }

      setEntities(detected)
      setPhase("ready")
      setStatusMsg("")
    } catch (err: any) {
      addLog(`❌ Error: ${err?.message || err}`)
      setPhase("error")
      setStatusMsg(err?.message || "Processing failed")
    }
  }

  // Called from prompt — user chose "Upload Raw"
  const handleUploadRaw = async () => {
    setPendingPayload(null)
    await handleBypass()
  }

  if (!isOpen) return null

  // ── Interception Prompt (Glassmorphism) ─────────────────────────────────────
  if (phase === "prompt" && pendingPayload) {
    return (
      <div className="fixed inset-0 z-[999999] flex items-center justify-center font-sans animate-fade-in"
           style={{ fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif" }}>
        {/* Blurred backdrop */}
        <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-xl" />

        {/* Choice Card */}
        <div className="relative z-10 w-full max-w-xl mx-4 animate-scale-in">
          {/* Outer glow ring */}
          <div className="absolute -inset-1 bg-gradient-to-r from-blue-500/20 via-indigo-500/20 to-violet-500/20 rounded-[2rem] blur-xl" />

          <div className="relative bg-white/[0.07] backdrop-blur-3xl border border-white/[0.15] rounded-[2rem] shadow-[0_32px_128px_rgba(59,130,246,0.2)] p-10 text-white flex flex-col items-center gap-7 overflow-hidden">
            {/* Subtle shimmer overlay */}
            <div className="absolute inset-0 animate-shimmer pointer-events-none opacity-20" />

            {/* Shield Icon with pulse animation */}
            <div className="relative">
              <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-blue-500 to-indigo-600 blur-2xl opacity-40" />
              <div className="relative w-24 h-24 rounded-3xl bg-gradient-to-br from-blue-500 via-indigo-500 to-violet-600 flex items-center justify-center shadow-2xl glow-shield">
                <Shield className="w-12 h-12 text-white drop-shadow-lg animate-pulse" />
              </div>
            </div>

            {/* Heading */}
            <div className="text-center">
              <h2 className="text-2xl font-black tracking-tight bg-gradient-to-r from-white to-blue-100 bg-clip-text text-transparent">AegisLayer</h2>
              <p className="text-indigo-300 font-bold text-xs mt-1 uppercase tracking-[0.2em]">Document Sentinel</p>
            </div>

            {/* Gradient divider */}
            <div className="w-3/4 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />

            {/* Alert box */}
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl px-6 py-4 w-full flex items-start gap-4">
              <AlertTriangle className="w-6 h-6 text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-base font-bold text-amber-200 mb-1">PDF Upload Intercepted</p>
                <p className="text-sm text-amber-100/70 leading-relaxed">A document is being uploaded to this website. AegisLayer has paused the transfer to protect your privacy.</p>
              </div>
            </div>

            {/* File info */}
            <div className="bg-white/[0.08] border border-white/[0.12] rounded-2xl px-6 py-4 flex items-center gap-4 w-full">
              <div className="w-11 h-11 rounded-xl bg-red-500/15 border border-red-500/20 flex items-center justify-center flex-shrink-0">
                <FileText className="w-6 h-6 text-red-300" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-base font-bold text-white truncate">{pendingPayload.name}</p>
                <p className="text-sm text-slate-400 font-medium">PDF Document</p>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex flex-col w-full gap-3 mt-1">
              <button onClick={handleStartScan}
                className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 hover:from-blue-500 hover:via-indigo-500 hover:to-violet-500 text-white font-bold text-base shadow-xl shadow-indigo-600/40 flex items-center justify-center gap-3 transition-all duration-300 hover:scale-[1.02] active:scale-[0.97]">
                <Shield className="w-5 h-5" />
                Scan for PII
              </button>
              <button onClick={handleUploadRaw}
                className="w-full py-3.5 rounded-2xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.15] hover:border-white/[0.25] text-white/70 hover:text-white font-semibold text-sm flex items-center justify-center gap-3 transition-all duration-300">
                <Upload className="w-4 h-4" />
                Upload Raw (Skip Protection)
              </button>
            </div>

            {/* Dismiss */}
            <button onClick={closeOverlay} className="text-white/30 hover:text-white/60 text-sm transition-colors font-medium mt-1">
              Dismiss
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[999999] flex items-center justify-center p-2 bg-slate-900/70 backdrop-blur-md font-sans"
         style={{ fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif" }}>
      
      {/* Container matching full-screen tabs/review.tsx UI within an overlay bounds */}
      <div className="bg-slate-50 w-[95vw] max-w-none h-[95vh] rounded-2xl overflow-hidden flex flex-col shadow-[0_0_80px_rgba(59,130,246,0.2)] border border-slate-200/80">
        {(phase === "loading" || phase === "extracting" || phase === "detecting" || phase === "sanitizing" || phase === "done" || phase === "error") && (
          <div className="absolute inset-0 z-50 bg-slate-900/80 backdrop-blur-sm flex flex-col items-center justify-center text-white">
            {phase === "error" ? (
              <>
                <X className="w-16 h-16 text-red-500 mb-4" />
                <h2 className="text-2xl font-bold mb-2">Error Processing File</h2>
                <p className="text-red-300 text-sm mb-6">{statusMsg}</p>
                <div className="mt-4 bg-slate-800/80 rounded-xl p-4 w-full max-w-md max-h-40 overflow-y-auto border border-slate-700">
                  {logs.map((l, i) => <p key={i} className="text-[10px] text-slate-400 font-mono">{l}</p>)}
                </div>
                <button onClick={closeOverlay} className="mt-6 px-6 py-2.5 bg-slate-700 rounded-lg hover:bg-slate-600 text-sm font-medium">Close</button>
              </>
            ) : phase === "done" ? (
              <>
                <div className="w-16 h-16 rounded-full bg-emerald-500/20 flex items-center justify-center mb-4">
                  <Check className="w-8 h-8 text-emerald-400" />
                </div>
                <h2 className="text-xl font-bold text-emerald-400">Successfully Sanitized!</h2>
                <p className="text-slate-400 mt-2 text-sm">Closing workspace...</p>
              </>
            ) : (
              <>
                <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-2xl shadow-blue-500/40 mb-6">
                  <Shield className="w-10 h-10 text-white animate-pulse" />
                </div>
                <Loader2 className="w-12 h-12 animate-spin text-blue-400 mb-4" />
                <h2 className="text-2xl font-black mb-1">
                  {phase === "extracting" || phase === "detecting" ? "Sentinel is Scanning..." : statusMsg}
                </h2>
                <p className="text-base text-blue-300 font-medium mb-1">
                  {phase === "extracting" ? "Extracting text from document..." : phase === "detecting" ? "Detecting Personally Identifiable Information..." : statusMsg}
                </p>
                <p className="text-sm text-slate-400">{fileName}</p>
                <div className="mt-6 bg-slate-800/60 rounded-2xl p-5 w-full max-w-lg max-h-48 overflow-y-auto border border-slate-700/60">
                  {logs.map((l, i) => <p key={i} className="text-xs text-slate-400 font-mono leading-relaxed mb-0.5">{l}</p>)}
                </div>
              </>
            )}
          </div>
        )}

        {/* Top Bar */}
        <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm flex-shrink-0 relative z-30">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center shadow-md">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-slate-800">AegisLayer Review</h1>
              <p className="text-sm font-medium text-slate-500 truncate max-w-[300px] mt-0.5">{fileName}</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {totalCount > 0 && (
              <span className="text-sm bg-amber-100 text-amber-700 px-4 py-2 rounded-full font-bold flex items-center gap-2 shadow-sm">
                <AlertTriangle className="w-4 h-4" /> {maskedCount}/{totalCount} masked
              </span>
            )}
            <button onClick={handleUndo} disabled={undoStack.length === 0}
              className="px-4 py-2 bg-slate-100 hover:bg-slate-200 disabled:opacity-30 rounded-lg text-sm font-bold flex items-center gap-2 transition-colors shadow-sm">
              <Undo2 className="w-4 h-4" /> Undo
            </button>
            <button onClick={handleSanitize} disabled={phase !== "ready"}
              className="px-5 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 disabled:opacity-50 text-white rounded-lg text-sm font-bold flex items-center gap-2 shadow-md shadow-blue-500/30 transition-all">
              <Download className="w-4 h-4" /> Sanitize & Download
            </button>
            <button onClick={closeOverlay} className="p-2 ml-2 hover:bg-slate-100 rounded-full transition-colors text-slate-400 hover:text-slate-800">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Workspace */}
        <div className="flex-1 w-full flex overflow-hidden relative bg-slate-200">
          {/* Canvas Preview Area */}
          <div className="flex-1 h-full overflow-y-auto p-6 flex flex-col items-center gap-6 relative">
            <div className="text-base font-medium text-slate-700 flex items-center gap-3 mb-4 sticky top-0 bg-white/95 backdrop-blur-xl px-6 py-3 rounded-full z-20 shadow-md border border-slate-200">
              <MousePointer2 className="w-5 h-5" />
              Drag to select and redact content · <kbd className="bg-slate-100 px-3 py-1 rounded-md border border-slate-300 shadow-sm font-bold text-slate-800">Ctrl+Z</kbd> to undo
            </div>

            {pageImages.map((page, idx) => (
              <div key={idx} className="relative shadow-2xl rounded-lg overflow-hidden bg-white ring-1 ring-slate-900/5 my-2"
                style={{ width: page.width, height: page.height, flexShrink: 0 }}>
                <img src={page.dataUrl} alt={`Page ${idx + 1}`} className="w-full h-full select-none pointer-events-none block" draggable={false} />

                {entities.filter(e => e.shouldMask && e.box?.pageIndex === idx).map(entity => (
                  <div key={entity.id}
                    className="absolute bg-black backdrop-blur-none border border-slate-800 flex items-center justify-center overflow-hidden group shadow-md"
                    style={{ left: entity.box!.x * page.scale, top: entity.box!.y * page.scale, width: entity.box!.width * page.scale, height: entity.box!.height * page.scale }}>
                    <span className="text-[7px] font-bold text-white/90 bg-black/50 px-1 rounded tracking-widest uppercase opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">REDACTED</span>
                  </div>
                ))}

                {entities.filter(e => !e.shouldMask && e.box?.pageIndex === idx).map(entity => (
                  <div key={`vis-${entity.id}`}
                    className="absolute bg-emerald-400/20 border border-emerald-400 rounded-sm"
                    style={{ left: entity.box!.x * page.scale, top: entity.box!.y * page.scale, width: entity.box!.width * page.scale, height: entity.box!.height * page.scale }}
                  />
                ))}

                <div className="absolute inset-0 cursor-crosshair z-10" onMouseDown={(e) => handleMouseDown(e, idx)} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp}>
                  {isDragging && dragPageIdx === idx && (
                    <div className="absolute border-2 border-dashed border-blue-500 bg-blue-500/10 rounded pointer-events-none"
                      style={{
                        left: Math.min(dragStart.x, dragCurrent.x),
                        top: Math.min(dragStart.y, dragCurrent.y),
                        width: Math.abs(dragCurrent.x - dragStart.x),
                        height: Math.abs(dragCurrent.y - dragStart.y),
                      }}
                    />
                  )}
                </div>
                <div className="absolute bottom-2 right-2 z-20 bg-slate-800/70 text-white text-[9px] px-2 py-0.5 rounded-full backdrop-blur-sm shadow-sm">
                  Page {idx + 1}
                </div>
              </div>
            ))}
          </div>

          {/* Sidebar */}
          <div className="w-[360px] bg-white border-l h-full shrink-0 flex flex-col border-slate-200 shadow-[-5px_0_20px_rgba(0,0,0,0.03)] relative z-20 overflow-hidden">
            <div className="p-5 border-b border-slate-100 bg-gradient-to-b from-slate-50 to-white">
              <h3 className="font-bold text-base text-slate-800 flex items-center gap-2 mb-3">
                <Search className="w-5 h-5 text-blue-500" /> Analysis Summary
              </h3>
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-blue-50 rounded-xl p-4 text-center border border-blue-100/50">
                  <p className="text-2xl font-black text-blue-600">{extractedItems.length}</p>
                  <p className="text-[10px] text-blue-500 uppercase tracking-widest font-bold mt-1">Words</p>
                </div>
                <div className="bg-amber-50 rounded-xl p-4 text-center border border-amber-100/50">
                  <p className="text-2xl font-black text-amber-600">{totalCount}</p>
                  <p className="text-[10px] text-amber-500 uppercase tracking-widest font-bold mt-1">Detected</p>
                </div>
                <div className="bg-red-50 rounded-xl p-4 text-center border border-red-100/50">
                  <p className="text-2xl font-black text-red-600">{maskedCount}</p>
                  <p className="text-[10px] text-red-500 uppercase tracking-widest font-bold mt-1">Redacted</p>
                </div>
              </div>
              <div className="mt-4 text-xs font-semibold text-slate-500 flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-indigo-400" />
                {providerId === "local" ? "AegisLayer Local Engine" : `${providerId} AI Detection engine`}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50/50">
              {entities.length === 0 ? (
                <div className="text-center py-10 text-slate-400 text-sm font-medium">
                  <p>No entities detected.</p>
                  <p className="text-xs mt-1 text-slate-400">Drag on the preview to select areas.</p>
                </div>
              ) : (
                entities.map(entity => (
                  <div key={entity.id}
                    className={`p-3 rounded-xl border transition-all duration-150 group
                      ${entity.shouldMask ? 'border-red-200 bg-red-50/80 hover:bg-red-50' : 'border-slate-200 bg-white hover:bg-slate-50 relative'}`} >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded shadow-sm
                          ${entity.shouldMask ? 'bg-red-200 text-red-800' : 'bg-slate-200 text-slate-700'}`}>
                          {entity.type.replace('_', ' ')}
                        </span>
                        {entity.box && <span className="text-[10px] text-slate-500 font-bold bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">pg {(entity.box.pageIndex || 0) + 1}</span>}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => toggleMask(entity.id)} className={`p-1.5 rounded-lg transition-colors ${entity.shouldMask ? 'text-red-500 hover:bg-red-100' : 'text-emerald-500 hover:bg-emerald-100'}`}>
                          {entity.shouldMask ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                        <button onClick={() => removeEntity(entity.id)} className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <p className={`font-mono text-sm break-all leading-relaxed tracking-tight ${entity.shouldMask ? 'text-red-600 line-through decoration-red-400/50 decoration-2' : 'text-slate-700 font-medium'}`}>{entity.value}</p>
                  </div>
                ))
              )}
            </div>

            <div className="p-5 border-t border-slate-100 bg-white">
              <label className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-1.5 flex items-center gap-1.5 block">
                <Type className="w-3.5 h-3.5 text-blue-400" /> Global Text Redaction
              </label>
              <p className="text-[9px] text-slate-400 mb-2.5 leading-relaxed">Type a word — ALL occurrences across the entire file will be instantly redacted everywhere.</p>
              <div className="flex items-center gap-2">
                <input type="text" value={manualText} onChange={e => setManualText(e.target.value)} onKeyDown={e => e.key === "Enter" && handleAddManual()}
                  placeholder="e.g., John Smith, specific address..."
                  className="flex-1 bg-slate-50 border border-slate-200 text-slate-800 text-xs px-3 py-2.5 rounded-lg focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all font-medium" />
                <button onClick={handleAddManual} className="p-2.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors shadow-sm shadow-blue-500/20 active:scale-95" title="Redact all occurrences">
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="p-4 border-t border-slate-100 bg-slate-50/50">
              <div className="flex items-center justify-between gap-2">
                 <button onClick={handleBypass} className="flex-1 text-slate-500 hover:text-slate-800 text-xs font-medium py-2.5 rounded-xl hover:bg-slate-200 transition-colors">
                  Upload Raw (Bypass)
                </button>
                <button onClick={handleSanitize} disabled={phase !== "ready"} className="flex-1 bg-emerald-500 hover:bg-emerald-600 active:scale-95 text-white disabled:opacity-50 text-xs font-bold py-2.5 rounded-xl shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-1 transition-all">
                  <Check className="w-4 h-4" /> Approve
                </button>
              </div>
            </div>
            
            <details className="border-t border-slate-100 bg-slate-50 group">
              <summary className="px-5 py-3 text-[10px] text-slate-400 cursor-pointer hover:bg-slate-100 font-medium flex items-center justify-between">
                Debug Logs ({logs.length}) <ChevronDown className="w-3 h-3 group-open:rotate-180 transition-transform" />
              </summary>
              <div className="px-5 pb-4 max-h-40 overflow-y-auto">
                {logs.map((log, i) => <p key={i} className="text-[9px] text-slate-400 font-mono leading-relaxed mb-1">{log}</p>)}
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  )
}
