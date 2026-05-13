/**
 * AegisLayer Popup — Upload & Configure
 *
 * The extension popup provides:
 * 1. AI provider selection (local or cloud)
 * 2. API key management
 * 3. Manual PDF upload → opens the full review workspace
 */

import "~style.css"

import { useState, useRef, useEffect } from "react"
import { Shield, Upload, Settings, ChevronDown, FileText, Sparkles, Key, Zap, Lock } from "lucide-react"
import { AI_PROVIDERS } from "~lib/aiProviders"

function IndexPopup() {
  const [providerId, setProviderId] = useState("local")
  const [apiKey, setApiKey] = useState("")
  const [showSettings, setShowSettings] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)

  const provider = AI_PROVIDERS.find(p => p.id === providerId) || AI_PROVIDERS[0]

  // Load saved settings
  useEffect(() => {
    chrome.storage?.local?.get(["aegis_api_provider", "aegis_api_key"], (result) => {
      if (result?.aegis_api_provider) setProviderId(result.aegis_api_provider as string)
      if (result?.aegis_api_key) setApiKey(result.aegis_api_key as string)
    })
  }, [])

  const updateProvider = (id: string) => {
    setProviderId(id)
    setApiKey("")
    chrome.storage?.local?.set({ aegis_api_provider: id, aegis_api_key: "" })
  }

  const updateApiKey = (key: string) => {
    setApiKey(key)
    chrome.storage?.local?.set({ aegis_api_key: key })
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError("")

    if (!file.type.includes("pdf") && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("Please upload a PDF file.")
      return
    }

    if (file.size > 8 * 1024 * 1024) {
      setError("File too large (max 8 MB).")
      return
    }

    setUploading(true)

    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(new Error("Read failed"))
        reader.readAsDataURL(file)
      })

      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tabs.length > 0 && tabs[0].id) {
        try {
          await chrome.tabs.sendMessage(tabs[0].id, {
            action: "aegis_open_overlay",
            payload: { targetData: b64, fileName: file.name, providerId, apiKey }
          })
          window.close()
        } catch {
          setError("Refresh this page first so the AegisLayer overlay can inject.")
          setUploading(false)
        }
      } else {
        setError("No active tab found.")
        setUploading(false)
      }
    } catch (err: any) {
      setError(err?.message || "Upload failed")
      setUploading(false)
    }
  }

  return (
    <div className="w-[420px] flex flex-col bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 text-white font-sans overflow-hidden"
         style={{ fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif" }}>

      {/* ── Header ─────────────────────────────────── */}
      <div className="px-7 pt-7 pb-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 via-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/40 glow-shield">
              <Shield className="w-7 h-7 text-white drop-shadow-md" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight leading-none">AegisLayer</h1>
              <p className="text-xs text-indigo-300 font-semibold tracking-widest uppercase mt-0.5">Document Sentinel</p>
            </div>
          </div>
          <button onClick={() => setShowSettings(!showSettings)}
            className={`p-2.5 rounded-xl transition-all duration-200 ${showSettings ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/30 rotate-45' : 'hover:bg-white/10 text-slate-400 hover:text-white'}`}>
            <Settings className="w-5 h-5 transition-transform duration-300" />
          </button>
        </div>
      </div>

      {/* ── AI Provider Settings (collapsible) ────── */}
      {showSettings && (
        <div className="px-7 pb-5 animate-in space-y-4">
          <div className="h-px bg-gradient-to-r from-transparent via-slate-700 to-transparent mb-1" />
          <div>
            <label className="text-xs text-slate-400 uppercase tracking-widest font-bold mb-2 block">Detection Engine</label>
            <div className="relative">
              <select value={providerId} onChange={(e) => updateProvider(e.target.value)}
                className="w-full bg-slate-800/80 border border-slate-600/50 text-white text-base px-4 py-3.5 rounded-2xl appearance-none cursor-pointer focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all shadow-inner">
                {AI_PROVIDERS.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <ChevronDown className="w-5 h-5 absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            </div>
          </div>

          {provider.needsKey && (
            <div>
              <label className="text-xs text-slate-400 uppercase tracking-widest font-bold mb-2 flex items-center gap-1.5 block">
                <Key className="w-4 h-4 text-indigo-400" /> API Key
              </label>
              <input type="password" value={apiKey} onChange={(e) => updateApiKey(e.target.value)}
                placeholder={provider.placeholder}
                className="w-full bg-slate-800/80 border border-slate-600/50 text-white text-sm px-4 py-3.5 rounded-2xl focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all placeholder:text-slate-600" />
            </div>
          )}

          <div className="flex items-center gap-2.5 bg-slate-800/40 rounded-2xl px-4 py-3 border border-slate-700/40">
            <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${providerId === "local" ? "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.7)]" : apiKey ? "bg-blue-400 animate-pulse shadow-[0_0_10px_rgba(96,165,250,0.7)]" : "bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.7)]"}`} />
            <span className="text-sm text-slate-300 font-medium">
              {providerId === "local"
                ? "Offline regex + heuristic detection"
                : apiKey
                  ? `${provider.name} connected`
                  : `API key required`}
            </span>
          </div>
        </div>
      )}

      {/* ── Upload Section ────────────────────────── */}
      <div className="px-7 pb-5">
        <div className="bg-gradient-to-br from-slate-800/60 to-slate-800/30 rounded-3xl p-7 text-center border border-slate-700/40 shadow-inner relative overflow-hidden">
          {/* Decorative shimmer */}
          <div className="absolute inset-0 animate-shimmer pointer-events-none opacity-30" />

          <div className="relative z-10">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500/20 to-indigo-500/20 border border-blue-500/20 flex items-center justify-center mx-auto mb-4">
              <FileText className="w-7 h-7 text-blue-300" />
            </div>
            <p className="font-bold text-lg text-white mb-1">Scan & Sanitize PDF</p>
            <p className="text-sm text-slate-400 mb-6 leading-relaxed">
              Upload a document to open the full review workspace
            </p>

            <input ref={fileInputRef} type="file" accept=".pdf,application/pdf"
              onChange={handleFileSelect} className="hidden" />

            <button onClick={() => fileInputRef.current?.click()}
              disabled={uploading || (provider.needsKey && !apiKey && providerId !== "local")}
              className="w-full bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 hover:from-blue-500 hover:via-indigo-500 hover:to-violet-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-300 font-bold py-4 px-6 rounded-2xl shadow-xl shadow-indigo-600/30 flex items-center justify-center gap-3 text-lg active:scale-[0.98]">
              {uploading ? (
                <><span className="animate-spin text-lg">⏳</span> Opening workspace...</>
              ) : (
                <><Upload className="w-6 h-6" /> Upload PDF</>
              )}
            </button>

            {error && (
              <p className="text-sm text-red-400 mt-4 font-semibold bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2">{error}</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Footer ────────────────────────────────── */}
      <div className="px-7 pb-6 space-y-4">

        {/* Active status */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-emerald-400">
            <div className="w-2.5 h-2.5 bg-emerald-400 rounded-full shadow-[0_0_10px_rgba(52,211,153,0.8)] animate-pulse" />
            Interceptor Active
          </div>
          <span className="text-xs text-slate-600 font-bold tracking-wider">v1.1.0</span>
        </div>
      </div>
    </div>
  )
}

export default IndexPopup
