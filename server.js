import express from "express";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

app.use(express.json({ limit: "1mb" }));

const fetchFn = globalThis.fetch;

// --------------------------------------------------------
// ESM-compatible __dirname
// --------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------------------------------
// Optional Gill Sans font for scene headers
// Make sure fonts/GillSans.otf is committed to the repo.
// --------------------------------------------------------
const GILL_SANS_PATH = path.join(__dirname, "fonts", "GillSans.otf");
const hasGillSans = fs.existsSync(GILL_SANS_PATH);
console.log("Gill Sans present:", hasGillSans, "at", GILL_SANS_PATH);

// --------------------------------------------------------
// Serve PDFs from /tmp/pdfs over HTTPS (Render-safe)
// --------------------------------------------------------
const pdfDir = process.env.PDF_DIR || path.join("/tmp", "pdfs");
fs.mkdirSync(pdfDir, { recursive: true });
app.use("/pdfs", express.static(pdfDir));

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------
function splitList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split("|||")
    .map((s) => s.trim())
    .filter(Boolean);
}

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

    const imagesRaw = req.query.images ?? req.body.images;
    const scenesRaw = req.query.scene ?? req.body.scene;
    const sizesRaw = req.query.size ?? req.body.size;
    const descRaw = req.query.description ?? req.body.description;
    const namesRaw = req.query.name ?? req.body.name; // optional

    const images = splitList(imagesRaw);
    const scenes = splitList(scenesRaw);
    const sizes = splitList(sizesRaw);
    const descriptions = splitList(descRaw);
    const names = splitList(namesRaw);

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

    // Layout constants (tuned for 2x~4 rows per page)
    const IMAGE_HEIGHT = 130;       // height for the image box
    const TEXT_BLOCK_HEIGHT = 60;   // enough for size + name + description
    const ROW_SPACING = 16;         // gap between rows
    const ROW_HEIGHT =
      IMAGE_HEIGHT + TEXT_BLOCK_HEIGHT + ROW_SPACING;

    const HEADER_HEIGHT = 30;       // visual space used by header + line

    function startNewPage() {
      doc.addPage();
      return {
        currentY: doc.page.margins.top,
        column: 0, // 0 = left, 1 = right
      };
    }

    function drawSceneHeader(sceneName, state) {
      const pageWidth = doc.page.width;
      const margins = doc.page.margins;
      const usableWidth =
        pageWidth - margins.left - margins.right;

      doc
        .font(hasGillSans ? GILL_SANS_PATH : "Helvetica-Bold")
        .fontSize(18)
        .text(sceneName || "Scene", margins.left, state.currentY, {
          width: usableWidth,
          align: "left",
        });

      const lineY = state.currentY + 22;
      doc
        .moveTo(margins.left, lineY)
        .lineTo(pageWidth - margins.right, lineY)
        .lineWidth(0.5)
        .stroke();

      state.currentY += HEADER_HEIGHT;
      state.column = 0; // start a fresh row after a header
    }

    function repeatHeaderIfNeeded(sceneName, state) {
      if (!sceneName) return;
      drawSceneHeader(sceneName, state);
    }

    // Start first page
    let state = startNewPage();
    const bottomLimit =
      () => doc.page.height - doc.page.margins.bottom;

    let currentScene = null;

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i] ?? {};
      const sceneName = shot.scene || "";

      const isNewScene = sceneName !== currentScene;
      currentScene = sceneName;

      // Scene header when the scene changes
      if (isNewScene) {
        // if not enough room for header + at least one row, new page
        if (
          state.currentY + HEADER_HEIGHT + ROW_HEIGHT >
          bottomLimit()
        ) {
          state = startNewPage();
        }
        drawSceneHeader(sceneName, state);
      }

      const margins = doc.page.margins;
      const pageWidth = doc.page.width;
      const usableWidth =
        pageWidth - margins.left - margins.right;
      const cellWidth = usableWidth / 2;

      // If starting a new row on this page, check for overflow
      if (state.column === 0) {
        if (state.currentY + ROW_HEIGHT > bottomLimit()) {
          // new page, repeat header for current scene
          state = startNewPage();
          repeatHeaderIfNeeded(sceneName, state);
        }
      }

      const x =
        margins.left + state.column * cellWidth;
      const y = state.currentY;

      const imageHeight = IMAGE_HEIGHT;
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

      // --- name ---
      doc
        .font("Helvetica")
        .fontSize(9)
        .text(shotName, {
          width: textWidth,
        });

      // --- description ---
      doc
        .font("Helvetica")
        .fontSize(8)
        .text(description, {
          width: textWidth,
        });

      // advance column / row
      if (state.column === 0) {
        state.column = 1; // move to right column, same row
      } else {
        state.column = 0;
        state.currentY += ROW_HEIGHT; // move to next row
      }
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

    res.json({ filename, pdfUrl });
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
