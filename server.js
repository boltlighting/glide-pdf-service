import express from "express";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "10mb" }));

// If you ever use S3 later; safe to leave here.
const BUCKET = process.env.S3_BUCKET;

// Node 18+ fetch
const fetchFn = globalThis.fetch;

// --------------------------------------------------------
// ESM-compatible __dirname
// --------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------------------------------
// Serve PDFs from /pdfs over HTTPS
// --------------------------------------------------------
const pdfDir = path.join(__dirname, "pdfs");
// Make sure the folder exists (ok if it already does)
fs.mkdirSync(pdfDir, { recursive: true });

app.use("/pdfs", express.static(pdfDir));

// --------------------------------------------------------
// 🔥 FLEXIBLE GRID LOGIC
// --------------------------------------------------------
function chooseGrid(imagesLeft) {
  if (imagesLeft === 1) return { rows: 1, cols: 1 };
  if (imagesLeft === 2) return { rows: 1, cols: 2 };
  if (imagesLeft <= 3) return { rows: 1, cols: imagesLeft };
  if (imagesLeft <= 4) return { rows: 2, cols: 2 };
  if (imagesLeft <= 6) return { rows: 2, cols: 3 };
  if (imagesLeft <= 8) return { rows: 2, cols: 4 };
  if (imagesLeft <= 9) return { rows: 3, cols: 3 };
  if (imagesLeft <= 10) return { rows: 2, cols: 5 };
  if (imagesLeft <= 12) return { rows: 3, cols: 4 };

  // fallback for large sets (default 10 per page)
  return { rows: 2, cols: 5 };
}

// --------------------------------------------------------
// Main endpoint
// --------------------------------------------------------
app.post("/generate", async (req, res) => {
  try {
    // ✅ Read from body *or* query string (for Glide)
    let title = req.body?.title ?? req.query.title;
    let description = req.body?.description ?? req.query.description;
    let images = req.body?.images ?? req.query.images;

    // Support a single string (from query like ?images=URL)
    if (typeof images === "string") {
      images = images
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: "no images provided" });
    }

    // Create PDF
    const doc = new PDFDocument({
      size: "A4",
      margin: 40,
      autoFirstPage: false,
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    const done = new Promise((resolve, reject) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });

    // ---------------------------
    // Intro page
    // ---------------------------
    doc.addPage();
    doc.fontSize(22).text(title || "Shot List", { align: "center" });
    doc.moveDown();
    if (description) {
      doc.fontSize(12).text(description, { align: "center" });
    }

    // ---------------------------
    // Image Pages (dynamic grid)
    // ---------------------------
    let remaining = images.length;
    let index = 0;

    while (remaining > 0) {
      const { rows, cols } = chooseGrid(remaining);
      const perPage = rows * cols;

      doc.addPage();

      // Calculate area
      const usableWidth =
        doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const usableHeight =
        doc.page.height - doc.page.margins.top - doc.page.margins.bottom;

      const cellWidth = usableWidth / cols;
      const cellHeight = usableHeight / rows;

      // Fill this page
      for (let i = 0; i < perPage && index < images.length; i++, index++) {
        const url = images[index];

        try {
          const resp = await fetchFn(url);
          if (!resp.ok) continue;
          const buf = Buffer.from(await resp.arrayBuffer());

          // Resize + compress
          const resized = await sharp(buf)
            .resize({ width: 1200, withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();

          // Position
          const row = Math.floor(i / cols);
          const col = i % cols;

          const x = doc.page.margins.left + col * cellWidth;
          const y = doc.page.margins.top + row * cellHeight;

          doc.image(resized, x, y, {
            fit: [cellWidth - 10, cellHeight - 10],
            align: "center",
            valign: "center",
          });
        } catch (e) {
          console.error("Image failed:", url, e);
        }
      }

      remaining -= perPage;
    }

    doc.end();
    const pdfBuffer = await done;

    // ----------------------------------------------------
    // Turn PDF buffer into both base64 and a temporary URL
    // ----------------------------------------------------
    const pdfBase64 = pdfBuffer.toString("base64");

    // Unique-ish filename; could also use uuid() if you prefer
    const filename = `shotlist-${Date.now()}.pdf`;

    const filePath = path.join(pdfDir, filename);

    // Write PDF file to local /pdfs folder
    await fs.promises.writeFile(filePath, pdfBuffer);

    // Public URL that Render will serve via the static middleware above
    const pdfUrl = `https://glide-pdf-service.onrender.com/pdfs/${filename}`;

    // Return JSON for Glide
    res.json({
      filename,
      pdfBase64, // still available if you ever need it
      pdfUrl,    // <- use this in Glide Open Link
    });
  } catch (err) {
    console.error("PDF error:", err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`PDF service running on port ${PORT}`);
});
