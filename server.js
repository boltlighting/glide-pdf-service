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
// Commit fonts/GillSans.otf into your repo.
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
    (min, arr) => Math.min(min, Array.isArray(arr) ? arr.length : 0),
    Infinity
  );
}

// Group contiguous shots by scene name
function groupByScene(shots) {
  const groups = [];
  let i = 0;
  while (i < shots.length) {
    const sceneName = shots[i].scene || "";
    const groupShots = [];
    while (i < shots.length && (shots[i].scene || "") === sceneName) {
      groupShots.push(shots[i]);
      i++;
    }
    groups.push({ sceneName, shots: groupShots });
  }
  return groups;
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

    const usableCount = minLength([images, scenes, sizes, descriptions]);

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

    const sceneGroups = groupByScene(shots);

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
    // Layout: y-cursor based (prevents big header gaps)
    // ----------------------------------------------------
    const COLS = 2;
    const IMAGE_HEIGHT = 135;
    const TEXT_BLOCK_HEIGHT = 70; // size + name + description
    const ROW_SPACING = 12;

    const HEADER_TEXT_SIZE = 18;
    const HEADER_LINE_GAP = 6;  // space between header text and line
    const HEADER_AFTER_GAP = 10; // space after line before first row
    const HEADER_HEIGHT = 22 + HEADER_LINE_GAP + 1 + HEADER_AFTER_GAP; // ~header box

    const SHOT_ROW_HEIGHT = IMAGE_HEIGHT + TEXT_BLOCK_HEIGHT + ROW_SPACING;

    function pageMetrics() {
      const page = doc.page;
      const margins = page.margins;
      const left = margins.left;
      const top = margins.top;
      const right = page.width - margins.right;
      const bottom = page.height - margins.bottom;
      const usableWidth = right - left;
      return { page, margins, left, top, right, bottom, usableWidth };
    }

    function newPage() {
      doc.addPage();
      const { top } = pageMetrics();
      return top;
    }

    function ensureSpace(y, neededHeight) {
      const { bottom } = pageMetrics();
      if (y + neededHeight > bottom) {
        y = newPage();
      }
      return y;
    }

    function drawSceneHeader(sceneName, y) {
      const { left, right, usableWidth } = pageMetrics();

      doc
        .font(hasGillSans ? GILL_SANS_PATH : "Helvetica-Bold")
        .fontSize(HEADER_TEXT_SIZE)
        .text(sceneName || "Scene", left, y, {
          width: usableWidth,
          align: "left",
        });

      const lineY = y + 22 + HEADER_LINE_GAP;
      doc
        .moveTo(left, lineY)
        .lineTo(right, lineY)
        .lineWidth(0.5)
        .stroke();

      return lineY + 1 + HEADER_AFTER_GAP;
    }

    async function drawShotRow(sceneShots, startIndex, y) {
      let i = startIndex;

      const { left, usableWidth } = pageMetrics();
      const cellWidth = usableWidth / COLS;

      for (let col = 0; col < COLS && i < sceneShots.length; col++, i++) {
        const shot = sceneShots[i] || {};
        const x = left + col * cellWidth;

        const textX = x;
        const textWidth = cellWidth - 6;
        const textTop = y + IMAGE_HEIGHT + 4;

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
                .resize({ width: 1200, withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer();

              doc.image(resized, x, y, {
                fit: [cellWidth - 6, IMAGE_HEIGHT],
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

        // --- size ---
        doc.font("Helvetica-Bold").fontSize(9).text(sizeLabel, textX, textTop, {
          width: textWidth,
        });

        // --- name ---
        doc.font("Helvetica").fontSize(9).text(shotName, {
          width: textWidth,
        });

        // --- description ---
        doc.font("Helvetica").fontSize(8).text(description, {
          width: textWidth,
        });
      }

      return i; // next shot index
    }

    // Start first page
    let y = newPage();

    for (const group of sceneGroups) {
      const sceneName = group.sceneName;
      const sceneShots = group.shots;
      let shotIndex = 0;

      // Put the header on this page only if there's room for:
      // header + at least 1 shot row
      y = ensureSpace(y, HEADER_HEIGHT + SHOT_ROW_HEIGHT);
      y = drawSceneHeader(sceneName, y);

      while (shotIndex < sceneShots.length) {
        // If the scene continues onto a new page, DO NOT repeat the header.
        y = ensureSpace(y, SHOT_ROW_HEIGHT);

        // Draw one row of up to 2 shots
        shotIndex = await drawShotRow(sceneShots, shotIndex, y);
        y += SHOT_ROW_HEIGHT;
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
