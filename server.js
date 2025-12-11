import express from "express";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

// Glide sends query-string params; body is usually empty.
// Keep JSON parser but small limit so we don't hit size issues.
app.use(express.json({ limit: "1mb" }));

// Node 18+ global fetch
const fetchFn = globalThis.fetch;

// --------------------------------------------------------
// ESM-compatible __dirname
// --------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------------------------------
// Optional Gill Sans font for scene headers
// Put fonts/GillSans.otf next to this file if you want it.
// --------------------------------------------------------
const GILL_SANS_PATH = path.join(__dirname, "fonts", "GillSans.otf");
const hasGillSans = fs.existsSync(GILL_SANS_PATH);

// --------------------------------------------------------
// Serve PDFs from /tmp/pdfs over HTTPS (Render-safe)
// --------------------------------------------------------
const pdfDir = process.env.PDF_DIR || path.join("/tmp", "pdfs");
fs.mkdirSync(pdfDir, { recursive: true });
app.use("/pdfs", express.static(pdfDir));

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------

// Split a joined list like "a|||b|||c" into ["a","b","c"]
function splitList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split("|||")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Safely get the minimum length across all arrays
function minLength(arrays) {
  return arrays.reduce(
    (min, arr) =>
      Math.min(min, Array.isArray(arr) ? arr.length : 0),
    Infinity
  );
}

// --------------------------------------------------------
// Main endpoint
// --------------------------------------------------------
app.post("/generate", async (req, res) => {
  try {
    console.log("Incoming query:", req.query);

    // Glide is sending these as query string parameters
    const imagesRaw = req.query.images ?? req.body.images;
    const scenesRaw = req.query.scene ?? req.body.scene;
    const sizesRaw = req.query.size ?? req.body.size;
    const descRaw = req.query.description ?? req.body.description;
    const namesRaw = req.query.name ?? req.body.name; // optional

    const images = splitList(imagesRaw);
    const scenes = splitList(scenesRaw);
    const sizes = splitList(sizesRaw);
    const descriptions = splitList(descRaw);
    const names = splitList(namesRaw); // may be empty or shorter

    const usableCount = minLength([
      images,
      scenes,
      sizes,
      descriptions,
    ]);

    console.log("Counts:", {
      images: images.length,
      scenes: scenes.length,
      sizes: sizes.length,
      descriptions: descriptions.length,
      names: names.length,
      usableCount,
    });

    if (!Number.isFinite(usableCount) || usableCount === 0) {
      return res.status(400).json({
        error: "no valid shots provided",
        details: {
          images: images.length,
          scenes: scenes.length,
          sizes: sizes.length,
          descriptions: descriptions.length,
        },
      });
    }

    // Build a clean shots array
    const shots = [];
    for (let i = 0; i < usableCount; i++) {
      shots.push({
        image: images[i] || "",
        scene: scenes[i] || "",
        size: sizes[i] || "",
        description: descriptions[i] || "",
        name: (names[i] || "").trim() || `Shot ${i + 1}`,
      });
    }

    console.log("Total shots:", shots.length);

    // ----------------------------------------------------
    // Create PDF
    // ----------------------------------------------------
    const doc = new PDFDocument({
      size: "A4",
      margin: 40,
      autoFirstPage: false,
    });

    const chunks = [];
    doc.on("data", (c) => chunks.push(c));

    const done = new Promise((resolve, reject) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });

    // ----------------------------------------------------
    // Layout: 2 columns x 4 rows.
    // Scenes share pages. Each new scene:
    //   - gets a header row with underline
    //   - does NOT force a new page
    // ----------------------------------------------------
    const COLS = 2;
    const ROWS = 4;
    const PER_PAGE = COLS * ROWS;

    let slotIndexOnPage = PER_PAGE; // force first ensurePage() to add a page
    let currentScene = null;

    function ensurePage() {
      if (!doc.page || slotIndexOnPage >= PER_PAGE) {
        doc.addPage();
        slotIndexOnPage = 0;
      }

      const usableWidth =
        doc.page.width -
        doc.page.margins.left -
        doc.page.margins.right;
      const usableHeight =
        doc.page.height -
        doc.page.margins.top -
        doc.page.margins.bottom;

      const cellWidth = usableWidth / COLS;
      const cellHeight = usableHeight / ROWS;

      return { usableWidth, usableHeight, cellWidth, cellHeight };
    }

    // Main loop through all shots, scene by scene, but
    // without forcing page breaks between scenes.
    for (let index = 0; index < shots.length; index++) {
      const shot = shots[index] ?? {};
      const sceneName = shot.scene || "";

      // ---------- Scene header when scene changes ----------
      if (index === 0 || sceneName !== currentScene) {
        currentScene = sceneName;

        // If we're mid-row, bump to the start of the next row
        if (slotIndexOnPage % COLS !== 0 && slotIndexOnPage < PER_PAGE) {
          slotIndexOnPage += COLS - (slotIndexOnPage % COLS);
        }

        const { usableWidth, cellHeight } = ensurePage();

        const headerRow = Math.floor(slotIndexOnPage / COLS);
        const headerX = doc.page.margins.left;
        const headerY = doc.page.margins.top + headerRow * cellHeight;

        // Header font: Gill Sans if present, else Helvetica-Bold
        doc
          .font(hasGillSans ? GILL_SANS_PATH : "Helvetica-Bold")
          .fontSize(18)
          .text(sceneName || "Scene", headerX, headerY, {
            width: usableWidth,
            align: "left",
          });

        // Horizontal line under header
        const lineY = headerY + 22; // tweak if needed
        doc
          .moveTo(doc.page.margins.left, lineY)
          .lineTo(
            doc.page.width - doc.page.margins.right,
            lineY
          )
          .lineWidth(0.5)
          .stroke();

        // Header consumes one whole row
        slotIndexOnPage += COLS;
      }

      // ---------- Draw the shot in the next grid slot ----------
      const { cellWidth, cellHeight } = ensurePage();

      const row = Math.floor(slotIndexOnPage / COLS);
      const col = slotIndexOnPage % COLS;

      const x = doc.page.margins.left + col * cellWidth;
      const y = doc.page.margins.top + row * cellHeight;

      const imageHeight = cellHeight * 0.55; // 55% image, 45% text
      const textX = x;
      const textWidth = cellWidth - 6;
      const textTop = y + imageHeight + 4;

      const imageUrl = shot.image || "";
      const sizeLabel = shot.size || "";
      const shotName = shot.name || "";
      const description = shot.description || "";

      // --- image ---
      try {
        if (imageUrl) {
          const resp = await fetchFn(imageUrl);
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer());
            const resized = await sharp(buf)
              .resize({
                width: 1200,
                withoutEnlargement: true,
              })
              .jpeg({ quality: 80 })
              .toBuffer();

            doc.image(resized, x, y, {
              fit: [cellWidth - 6, imageHeight],
              align: "center",
              valign: "center",
            });
          } else {
            console.warn("Image fetch not OK:", imageUrl, resp.status);
          }
        }
      } catch (e) {
        console.error("Image failed:", imageUrl, e);
      }

      // --- size (bold, small) ---
      doc
        .font("Helvetica-Bold")
        .fontSize(9)
        .text(sizeLabel, textX, textTop, {
          width: textWidth,
        });

      // --- name (next line, small) ---
      doc
        .font("Helvetica")
        .fontSize(9)
        .text(shotName, {
          width: textWidth,
        });

      // --- description (below, wrapped) ---
      doc
        .font("Helvetica")
        .fontSize(8)
        .text(description, {
          width: textWidth,
        });

      slotIndexOnPage++;
    }

    // Finish PDF
    doc.end();
    const pdfBuffer = await done;

    const filename = `shotlist-${Date.now()}.pdf`;
    const filePath = path.join(pdfDir, filename);
    console.log("Writing PDF to", filePath, "size", pdfBuffer.length);
    await fs.promises.writeFile(filePath, pdfBuffer);
    console.log("PDF written OK");

    const pdfUrl = `https://glide-pdf-service.onrender.com/pdfs/${filename}`;

    res.json({
      filename,
      pdfUrl,
    });
  } catch (err) {
    console.error("PDF error:", err);
    res.status(500).json({
      error: "PDF generation failed",
      message: err?.message || String(err),
      stack: err?.stack || null,
    });
  }
});

// --------------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`PDF service running on port ${PORT}`);
});
