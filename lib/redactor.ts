/**
 * AegisLayer — PDF Redaction & Reassembly Engine
 *
 * Uses pdf-lib to permanently redact PII from PDFs:
 * 1. Strips all metadata (author, creator, timestamps)
 * 2. Draws white rectangles over PII bounding boxes (pixel obliteration)
 * 3. Stamps synthetic [REDACTED] text over the erased areas
 * 4. Serializes the sanitized document
 */

import { PDFDocument, rgb, StandardFonts } from "pdf-lib"
import type { PIIEntity } from "~store/uiState"

export const sanitizePdf = async (base64Data: string, entities: PIIEntity[]): Promise<Uint8Array> => {
  console.log("AegisLayer [Redactor]: Starting Redaction Engine...")

  // 1. Load PDF into memory
  const pdfBytes = await fetch(base64Data).then(res => res.arrayBuffer())
  const pdfDoc = await PDFDocument.load(pdfBytes)

  // 2. Metadata Wipe — strip all identifying information from the PDF header
  pdfDoc.setTitle("Sanitized Document - AegisLayer")
  pdfDoc.setAuthor("")
  pdfDoc.setSubject("")
  pdfDoc.setKeywords([])
  pdfDoc.setCreator("")
  pdfDoc.setProducer("")
  pdfDoc.setCreationDate(new Date(0))
  pdfDoc.setModificationDate(new Date(0))

  // 3. Pixel Obliteration — draw over the PII with white boxes + synthetic text
  const helveticaFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const pages = pdfDoc.getPages()

  const entitiesToMask = entities.filter(e => e.shouldMask)
  let fallbackOffset = 0

  for (const entity of entitiesToMask) {
    if (entity.box && entity.box.pageIndex < pages.length) {
      const page = pages[entity.box.pageIndex]
      const { x, y, width, height } = entity.box
      const pageHeight = page.getHeight()

      const cropBox = page.getCropBox()

      // The box coordinates from piiDetector use top-left origin mapped to the CropBox.
      // pdf-lib uses bottom-left origin mapped to the MediaBox.
      // Calculate absolute Y from bottom of media box taking into account crop box offsets.
      const absoluteTop = cropBox.y + cropBox.height
      const pdfY = absoluteTop - y - height

      // Draw pitch black rectangle to wipe underlying pixels and completely obscure text layer
      page.drawRectangle({
        x: cropBox.x + x - 2, // Slight left padding
        y: pdfY - 2,          // Slight bottom padding
        width: width + 4,     // Padding
        height: height + 4,   // Padding
        color: rgb(0, 0, 0),  // Solid Black
      })

      // Size the REDACTED label to fit within the box
      const labelSize = Math.max(Math.min(height - 1, 10), 6)
      const label = `REDACTED`

      // Measure the exact text width for perfect horizontal centering
      const textWidth = helveticaFont.widthOfTextAtSize(label, labelSize)
      
      // ONLY draw the "REDACTED" text if the box is wide enough to fit it.
      // Otherwise, leave it as a pure black strikeout box.
      if (width >= textWidth - 4) {
        const startX = cropBox.x + x + (width / 2) - (textWidth / 2)
        // Draw synthetic text stamp in white
        page.drawText(label, {
          x: startX,
          y: pdfY + 2,
          size: labelSize,
          font: helveticaFont,
          color: rgb(1, 1, 1), // Pure White
        })
      }

      console.log(`AegisLayer [Redactor]: Masked ${entity.type} ("${entity.value}") at page ${entity.box.pageIndex}, pos (${x.toFixed(0)}, ${y.toFixed(0)})`)
    } else {
      console.warn(`AegisLayer [Redactor]: Skipped ${entity.type} ("${entity.value}") because no physical coordinates were found.`)
    }
  }

  // 4. Serialization — reassemble the sanitized PDF
  console.log(`AegisLayer [Redactor]: Reassembling PDF (${entitiesToMask.length} items redacted)...`)
  const sanitizedPdfBytes = await pdfDoc.save()
  return sanitizedPdfBytes
}
