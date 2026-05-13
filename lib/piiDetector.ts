/**
 * AegisLayer — PII Detection Engine
 *
 * Three detection paths:
 * 1. AI Mode: Send text to any supported API (Gemini/OpenAI/Claude/Grok/Ollama)
 * 2. Local Mode: Enhanced regex patterns for names, orgs, currency, dates, etc.
 * 3. Manual/Global: User types a word → ALL occurrences are found and redacted
 */

import type { PIIEntity } from "~store/uiState"
import type { ExtractedTextItem } from "./pdfTextExtract"
import { getProvider, PII_PROMPT, type AIProvider } from "./aiProviders"
import { performLocalNER } from "./ner"

// ─── AI-Powered Detection (any provider) ────────────────────────────────────
export async function detectPIIWithAI(
  fullText: string,
  textItems: ExtractedTextItem[],
  providerId: string,
  apiKey: string
): Promise<PIIEntity[]> {
  const provider = getProvider(providerId)
  console.log(`AegisLayer [PII]: Using ${provider.name} for detection...`)

  // Compress whitespace to save API tokens
  const compressedText = fullText.replace(/\s+/g, ' ').trim()
  const prompt = PII_PROMPT + compressedText.substring(0, 10000) + '\n"""'

  const url = provider.buildUrl(apiKey)
  const headers = provider.buildHeaders(apiKey)
  const body = provider.buildBody(prompt)

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`${provider.name} error (${response.status}): ${errText.substring(0, 200)}`)
  }

  const data = await response.json()
  const resultText = provider.parseResponse(data)

  // Parse JSON from AI response (handle markdown code blocks)
  let cleaned = resultText.trim()
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")
  }

  let aiEntities: Array<{ type: string; value: string }>
  try {
    aiEntities = JSON.parse(cleaned)
    if (!Array.isArray(aiEntities)) aiEntities = []
  } catch {
    console.warn("AegisLayer [PII]: Could not parse AI response:", cleaned.substring(0, 200))
    aiEntities = []
  }

  console.log(`AegisLayer [PII]: AI found ${aiEntities.length} PII entities`)
  return mapEntitiesToCoordinates(aiEntities, textItems)
}

// ─── Enhanced Local Detection (AegisLayer Model) ────────────────────────────
const LOCAL_PATTERNS: Array<{ type: string; regex: RegExp; minLen?: number }> = [
  // Emails
  { type: "EMAIL", regex: /[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/gi },
  // Phone numbers (International, Indian, US format) - improved boundary tracking
  { type: "PHONE", regex: /(?:\+?\d{1,3}[-\s]?)?\(?\d{2,4}\)?[-\s]?\d{3,4}[-\s]?\d{3,4}\b/g, minLen: 8 },
  // SSN (US)
  { type: "SSN", regex: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g },
  // Credit card numbers (highly robust)
  { type: "CREDIT_CARD", regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11})\b/g },
  // Common numeric separator variants of credit cards
  { type: "CREDIT_CARD", regex: /\b\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}\b/g },
  // Dates (various formats including dd-mm-yyyy, yyyy/mm/dd)
  { type: "DATE", regex: /\b\d{1,4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,4}\b/g },
  { type: "DATE", regex: /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[,\s]\s*\d{2,4}\b/gi },
  { type: "DATE", regex: /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?\s*\d{2,4}\b/gi },
  // Currency — Rupees / Dollars / Euros / Pounds
  { type: "CURRENCY", regex: /(?:₹|Rs\.?|INR|\$|€|£|USD|EUR|GBP)\s*[\d,]+(?:\.\d{1,2})?\b/gi },
  // Currency — generic number with currency suffix
  { type: "CURRENCY", regex: /\b[\d,]+(?:\.\d{1,2})?\s*(?:rupees|dollars|euros|pounds|lakhs?|crores?|million|billion)\b/gi },
  // IP addresses
  { type: "IP_ADDRESS", regex: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g },
  // Sensitive IDs - Aadhaar (India 12-digit exact match to avoid random 12 digit numbers where possible)
  { type: "AADHAAR", regex: /\b\d{4}\s\d{4}\s\d{4}\b/g },
  // PAN (India)
  { type: "PAN_CARD", regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  // Passport (Generic)
  { type: "PASSPORT", regex: /\b[A-Z]{1,2}[0-9]{7,8}\b/g },
  // Names with strict titles (Highly reliable)
  { type: "NAME_TITLED", regex: /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof|Sir|Smt|Shri|Kumari)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\b/g },
  // Organizations and Companies
  { type: "ORGANIZATION", regex: /\b[A-Z][a-zA-Z&\s]+(?:Ltd|LLC|Inc|Corp|Corporation|Foundation|University|Institute|College|School|Hospital|Bank|Trust|Society|Association|Pvt|Private|Limited|Co)\b/g },
  // Comprehensive Addresses
  { type: "ADDRESS", regex: /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,4}(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Circle|Cir|Apartments|Apt|Suite|Floor|Building|Bldg)\b/gi },
  // Indian Pincodes & Global Zips
  { type: "ZIP_CODE", regex: /\b\d{6}\b/g },
  { type: "ZIP_CODE", regex: /\b\d{5}(?:-\d{4})?\b/g },
]

export async function detectPIILocal(
  fullText: string,
  textItems: ExtractedTextItem[]
): Promise<PIIEntity[]> {
  console.log("AegisLayer [PII]: Using AegisLayer Local ADVANCED Heuristics & NER...")
  const found: Array<{ type: string; value: string }> = []
  const seen = new Set<string>()

  const addMatch = (type: string, value: string) => {
    const clean = value.trim()
    if (clean.length > 2 && !seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase())
      found.push({ type, value: clean })
    }
  }

  // Pass 1: Standard Regex sweeping
  for (const pattern of LOCAL_PATTERNS) {
    pattern.regex.lastIndex = 0
    const matches = [...fullText.matchAll(pattern.regex)]
    for (const match of matches) {
      addMatch(pattern.type, match[0])
    }
  }

  // Pass 2: Contextual Proximity Sweeping (High Precision Name & Number extraction)
  // Look for keywords like "Name:", "Account No:", "Email:" and grab the adjacent words
  const CONTEXT_TRIGGERS: Array<{ marker: RegExp, capture: RegExp, type: string }> = [
    // Personal identity
    { marker: /\b(?:Name|Applicant|Holder|Passenger|Client|Customer|Patient|Candidate)\s*[:-]/i, capture: /^\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/, type: "NAME_CONTEXT" },
    // Contact info
    { marker: /\b(?:Phone|Mobile|Cell|Tel|Contact|Fax)\s*(?:No\.?|Number|#)?\s*[:-]/i, capture: /^\s*([\d\s\-+()\/.]{7,20})/, type: "PHONE_CONTEXT" },
    // Online profiles (LinkedIn, GitHub, Portfolio, Website)
    { marker: /\b(?:LinkedIn|GitHub|Portfolio|Website|Blog|URL)\s*[:-]/i, capture: /^\s*(https?:\/\/[^\s,]{5,80}|[^\s,]{5,50})/, type: "PROFILE_URL" },
    // Date of birth
    { marker: /\b(?:DOB|Date\s*of\s*Birth|Born|Birthday)\s*[:-]/i, capture: /^\s*(\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4}|\d{1,2}\s+\w+\s+\d{2,4})/, type: "DOB" },
    // Employer / Company
    { marker: /\b(?:Company|Employer|Organization|Organisation|Firm|Corporation|Agency|at)\s*[:-]/i, capture: /^\s*([A-Z][A-Za-z\s&.,]{2,40})/, type: "COMPANY_CONTEXT" },
    // Role / Designation
    { marker: /\b(?:Role|Position|Designation|Title|Job\s*Title)\s*[:-]/i, capture: /^\s*([A-Za-z\s]+(?:Engineer|Developer|Manager|Analyst|Designer|Intern|Lead|Director|Officer|Consultant|Architect|Specialist|Associate|Executive|Administrator|Coordinator)[A-Za-z\s]*)/, type: "ROLE_CONTEXT" },
    // Account / Reference IDs
    { marker: /\b(?:Account|Acc|A\/C|Policy|Ref|Case|Tracking|License|Employee\s*ID|Emp\s*ID|ID)\s*(?:No\.?|Number|#)?\s*[:-]/i, capture: /^\s*([\w\d-]{4,20})/, type: "ID_ACCOUNT" },
    // Address / Location
    { marker: /\b(?:Address|Location|Residence|City|State|District)\s*[:-]/i, capture: /^\s*([\w\s,.\-#]{10,80})/, type: "LOC_CONTEXT" },
    // Father/Mother/Spouse name
    { marker: /\b(?:Father|Mother|Spouse|Guardian|Parent|S\/O|D\/O|W\/O|C\/O)\s*(?:'s)?\s*(?:Name)?\s*[:-]/i, capture: /^\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/, type: "RELATIVE_NAME" },
  ]

  for (const trigger of CONTEXT_TRIGGERS) {
    const splitSections = fullText.split(trigger.marker)
    if (splitSections.length > 1) {
      for (let i = 1; i < splitSections.length; i++) {
        const potentialExtract = splitSections[i]
        const captured = potentialExtract.match(trigger.capture)
        if (captured && captured[1]) {
          addMatch(trigger.type, captured[1])
        }
      }
    }
  }

  // Pass 3: Advanced N-Gram Proper Noun Sequence Tracking
  // Identifies floating full names that lacked titles or context markers
  const words = fullText.split(/\s+/)
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    
    // Skip if sequence broken by sentence-ending punctuation from previous word
    if (i > 0 && /[.!?]$/.test(words[i - 1])) continue
    
    // Core check: capitalized word not common in English
    if (/^[A-Z][a-z]{2,15}$/.test(word) && !COMMON_WORDS.has(word.toLowerCase())) {
      // Lookahead: is the NEXT word also capitalized and uncommon? (E.g. "John Smith")
      let sequence = word
      let j = i + 1
      while (j < words.length && /^[A-Z][a-z]{2,15}$/.test(words[j]) && !COMMON_WORDS.has(words[j].toLowerCase())) {
        sequence += ` ${words[j]}`
        j++
      }
      
      // If we found a proper sequence of 2-4 capitalized uncommon words, flag it as a NAME
      if (sequence.includes(" ") && sequence.split(" ").length <= 4) {
        addMatch("NAME_HEURISTIC", sequence)
        i = j - 1 // Skip processed words
      }
      // ALSO: A single standalone capitalized word that appears in the first 200 chars 
      // is very likely the person's name at the top of a resume/document
      else if (i < 15 && word.length >= 3 && !COMMON_WORDS.has(word.toLowerCase())) {
        addMatch("NAME_TOP", word)
      }
    }
  }

  console.log(`AegisLayer [PII]: Advanced Local heuristics found ${found.length} entities`)
  const regexMapped = mapEntitiesToCoordinates(found, textItems)
  
  // Pass 4: True Contextual AI (Local NER)
  const nerMapped = await performLocalNER(fullText, textItems)
  
  // Merge and deduplicate
  const combined = [...regexMapped, ...nerMapped]
  const unique = combined.filter((val, idx, arr) => 
    arr.findIndex(v => v.box?.x === val.box?.x && v.box?.y === val.box?.y) === idx
  )
  
  return unique
}

// Common English words to exclude from name detection
const COMMON_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "day", "get", "has", "him", "his",
  "how", "its", "may", "new", "now", "old", "see", "way", "who", "did",
  "got", "let", "say", "she", "too", "use", "this", "that", "with", "have",
  "from", "they", "been", "will", "each", "make", "like", "long", "very",
  "when", "what", "your", "some", "them", "than", "been", "many", "then",
  "into", "year", "most", "only", "over", "such", "also", "back", "after",
  "work", "first", "even", "give", "just", "because", "before", "between",
  "being", "under", "about", "could", "other", "which", "their", "there",
  "where", "would", "these", "should", "through", "while", "right", "still",
  "think", "every", "never", "start", "those", "using", "going", "great",
  "small", "large", "place", "again", "point", "world", "house", "below",
  "above", "along", "might", "close", "since", "found", "state", "given",
  "both", "made", "well", "same", "much", "left", "next", "took", "keep",
  "here", "take", "came", "from", "want", "show", "also", "good", "know",
  "come", "time", "upon", "does", "done", "last", "help", "need", "down",
  "must", "more", "less", "hand", "high", "open", "part", "turn", "real",
  "life", "line", "look", "page", "file", "data", "text", "type", "name",
  "form", "date", "case", "list", "rate", "area", "side", "note", "item",
  "size", "code", "base", "body", "head", "full", "free", "city", "thus",
  "Home", "Section", "Page", "Table", "Figure", "Chapter", "Part", "Article",
  "Document", "Report", "Summary", "Index", "Content", "Reference", "Note",
  "Subject", "Title", "Department", "Office", "Service", "General", "National",
  "Information", "Number", "Total", "Amount", "Description", "Address",
])

// ─── Map detected PII values to text item coordinates ───────────────────────
function mapEntitiesToCoordinates(
  detected: Array<{ type: string; value: string }>,
  textItems: ExtractedTextItem[]
): PIIEntity[] {
  const entities: PIIEntity[] = []
  let idCounter = 1

  for (const pii of detected) {
    const allMatches = findAllOccurrences(pii.value, textItems)

    if (allMatches.length > 0) {
      for (const match of allMatches) {
        entities.push({
          id: `pii-${idCounter++}`,
          type: pii.type,
          value: pii.value,
          shouldMask: true,
          box: {
            x: match.x,
            y: match.y,
            width: Math.max(match.width, pii.value.length * 5),
            height: match.height + 2,
            pageIndex: match.pageIndex,
          },
        })
      }
    } else {
      // No coordinate match — still include for reference
      entities.push({
        id: `pii-${idCounter++}`,
        type: pii.type,
        value: pii.value,
        shouldMask: true,
      })
    }
  }

  return entities
}

// ─── Find ALL occurrences of a text string across all pages ─────────────────
function findAllOccurrences(
  searchText: string,
  textItems: ExtractedTextItem[]
): ExtractedTextItem[] {
  const matches: ExtractedTextItem[] = []
  const searchLower = searchText.toLowerCase()

  // Single-item matches
  for (const item of textItems) {
    const itemText = item.text.toLowerCase()
    
    // Check if it's an exact match or a trailing space match
    if (itemText === searchLower || itemText.trim() === searchLower.trim()) {
      matches.push(item)
    } 
    // Check if it's a substring (we must fractionally slice the coordinates)
    else if (itemText.includes(searchLower)) {
      const matchIndex = itemText.indexOf(searchLower)
      const avgCharWidth = item.width / Math.max(1, item.text.length)
      
      const preciseXOffset = matchIndex * avgCharWidth
      const preciseWidth = searchLower.length * avgCharWidth

      matches.push({
        ...item,
        x: item.x + preciseXOffset,
        width: preciseWidth,
      })
    }
  }

  // Multi-item matches (text split across items)
  if (matches.length === 0) {
    for (let i = 0; i < textItems.length; i++) {
      let combined = ""
      const group: ExtractedTextItem[] = []
      for (let j = i; j < Math.min(i + 10, textItems.length); j++) {
        if (textItems[j].pageIndex !== textItems[i].pageIndex) break
        combined += textItems[j].text
        group.push(textItems[j])
        if (combined.toLowerCase().includes(searchLower) && group.length > 1) {
          // Return first item's coordinates with combined width
          const first = group[0]
          const last = group[group.length - 1]
          matches.push({
            ...first,
            width: last.x + last.width - first.x,
          })
          break
        }
      }
    }
  }

  return matches
}

// ─── Global Redaction: Find ALL occurrences of user-typed text ──────────────
export function addGlobalRedaction(
  searchText: string,
  textItems: ExtractedTextItem[]
): PIIEntity[] {
  const allMatches = findAllOccurrences(searchText, textItems)
  let counter = 0

  return allMatches.map((item) => ({
    id: `manual-${Date.now()}-${counter++}`,
    type: "MANUAL",
    value: searchText,
    shouldMask: true,
    box: {
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height + 2,
      pageIndex: item.pageIndex,
    },
  }))
}
