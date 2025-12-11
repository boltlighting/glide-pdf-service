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
// Serve PDFs from /pdfs over HTTPS
// --------------------------------------------------------
const pdfDir = path.join(__dirname, "pdfs");
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
    // For debugging: log raw query keys (won't leak in Glide)
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

    // Trim all arrays to same usable length
    const shots = [];
    for (let i = 0; i < usableCount; i++) {
      shots.push({
        image: images[i],
        scene: scenes[i],
        size: sizes[i],
        description: descriptions[i],
        name: names[i] || `Shot ${i + 1}`,
      });
    }

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

    // Layout constants: 2 columns x 4 rows = 8 images per page
    const COLS = 2;
    const ROWS = 4;
    const PER_PAGE = COLS * ROWS;

    let i = 0;
    while (i < shots.length) {
      const sceneName = shots[i].scene || "";

      // collect contiguous shots for this scene
      const sceneShots = [];
      while (i < shots.length && shots[i].scene === sceneName) {
        sceneShots.push(shots[i]);
        i++;
      }

      // paginate this scene’s shots, 8 per page
      let offset = 0;
      while (offset < sceneShots.length) {
        const pageShots = sceneShots.slice(offset, offset + PER_PAGE);
        offset += PER_PAGE;

        doc.addPage();

        // Scene header at top of every page for this scene
        doc
          .font("Helvetica-Bold")
          .fontSize(18)
          .text(sceneName || "Scene", { align: "left" });
        doc.moveDown(0.5);

        const headerBottomY = doc.y;

        const usableWidth =
          doc.page.width -
          doc.page.margins.left -
          doc.page.margins.right;
        const usableHeight =
          doc.page.height -
          headerBottomY -
          doc.page.margins.bottom;

        const cellWidth = usableWidth / COLS;
        const cellHeight = usableHeight / ROWS;

        // If the math goes weird for some reason, skip drawing
        if (cellWidth <= 0 || cellHeight <= 0) {
          console.warn(
            "Invalid cell size",
            cellWidth,
            cellHeight
          );
          continue;
        }

        for (let idx = 0; idx < pageShots.length; idx++) {
          const shot = pageShots[idx];

          const row = Math.floor(idx / COLS);
          const col = idx % COLS;

          const x = doc.page.margins.left + col * cellWidth;
          const y = headerBottomY + row * cellHeight;

          const imageHeight = cellHeight * 0.55; // 55% image, 45% text
          const textX = x;
          const textWidth = cellWidth - 6;
          const textTop = y + imageHeight + 4;

          // --- image ---
          try {
            if (shot.image) {
              const resp = await fetchFn(shot.image);
              if (resp.ok) {
                const buf = Buffer.from(
                  await resp.arrayBuffer()
                );
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
                console.warn(
                  "Image fetch not OK:",
                  shot.image,
                  resp.status
                );
              }
            }
          } catch (e) {
            console.error("Image failed:", shot.image, e);
          }

          // --- size (bold, small) ---
          doc
            .font("Helvetica-Bold")
            .fontSize(9)
            .text(shot.size || "", textX, textTop, {
              width: textWidth,
            });

          // --- name (next line, small) ---
          doc
            .font("Helvetica")
            .fontSize(9)
            .text(shot.name || "", {
              width: textWidth,
            });

          // --- description (below, wrapped) ---
          doc
            .font("Helvetica")
            .fontSize(8)
            .text(shot.description || "", {
              width: textWidth,
            });
        }
      }
    }

    doc.end();
    const pdfBuffer = await done;

    const filename = `shotlist-${Date.now()}.pdf`;
    const filePath = path.join(pdfDir, filename);
    await fs.promises.writeFile(filePath, pdfBuffer);

    const pdfUrl = `https://glide-pdf-service.onrender.com/pdfs/${filename}`;

    res.json({
      filename,
      pdfUrl,
    });
  } catch (err) {
    console.error("PDF error:", err);
    // send the actual error back so we can see it in Glide
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
