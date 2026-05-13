/**
 * AegisLayer — AI Provider Abstraction Layer
 *
 * Supports multiple AI APIs for PII detection. Each provider has its own
 * endpoint format, auth mechanism, and response shape. The user selects
 * which provider to use from a dropdown in the popup.
 */

export interface AIProvider {
  id: string
  name: string
  placeholder: string        // API key input placeholder
  needsKey: boolean           // false for local/ollama modes
  buildUrl: (apiKey: string) => string
  buildHeaders: (apiKey: string) => Record<string, string>
  buildBody: (prompt: string) => any
  parseResponse: (data: any) => string  // Extracts text from response
}

export const PII_PROMPT = `You are an autonomous privacy redaction AI for AegisLayer.
Analyze the following document text and identify ANY private, sensitive, or contextually important information. Do not rely on a strict list of categories; if a piece of text represents an involved party (names, organizations), confidential numbers (accounts, IDs, amounts), contact points, locations, or any context-specific private data that should be redacted, extract it.

Return ONLY a valid JSON array. Each object MUST have:
- "type": A short uppercase string describing the type (e.g., "NAME", "ACCOUNT", "LOCATION", "CONFIDENTIAL")
- "value": the EXACT text string as it appears in the document (character-perfect match)

Example: [{"type":"NAME","value":"John Smith"},{"type":"ACCOUNT","value":"123-456-789"}]
If nothing found, return: []

Text to analyze:
"""
`

export const AI_PROVIDERS: AIProvider[] = [
  {
    id: "local",
    name: "AegisLayer Local (No API)",
    placeholder: "",
    needsKey: false,
    buildUrl: () => "",
    buildHeaders: () => ({}),
    buildBody: () => ({}),
    parseResponse: () => "[]",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    placeholder: "AIzaSy... (Gemini API Key)",
    needsKey: true,
    buildUrl: (key) =>
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
    buildHeaders: () => ({ "Content-Type": "application/json" }),
    buildBody: (prompt) => ({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
    }),
    parseResponse: (data) =>
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]",
  },
  {
    id: "openai",
    name: "OpenAI (GPT-4o Mini)",
    placeholder: "sk-... (OpenAI API Key)",
    needsKey: true,
    buildUrl: () => "https://api.openai.com/v1/chat/completions",
    buildHeaders: (key) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    }),
    buildBody: (prompt) => ({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 8192,
    }),
    parseResponse: (data) =>
      data?.choices?.[0]?.message?.content || "[]",
  },
  {
    id: "claude",
    name: "Anthropic Claude",
    placeholder: "sk-ant-... (Claude API Key)",
    needsKey: true,
    buildUrl: () => "https://api.anthropic.com/v1/messages",
    buildHeaders: (key) => ({
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    }),
    buildBody: (prompt) => ({
      model: "claude-3-haiku-20240307",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    }),
    parseResponse: (data) =>
      data?.content?.[0]?.text || "[]",
  },
  {
    id: "grok",
    name: "xAI Grok",
    placeholder: "xai-... (Grok API Key)",
    needsKey: true,
    buildUrl: () => "https://api.x.ai/v1/chat/completions",
    buildHeaders: (key) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    }),
    buildBody: (prompt) => ({
      model: "grok-2-latest",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    }),
    parseResponse: (data) =>
      data?.choices?.[0]?.message?.content || "[]",
  },

]

export function getProvider(id: string): AIProvider {
  return AI_PROVIDERS.find((p) => p.id === id) || AI_PROVIDERS[0]
}
