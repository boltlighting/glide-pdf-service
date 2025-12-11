import express from "express";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "1mb" }));

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
fs.mkdirSync(pdfDir, { recursive: true });
app.use("/pdfs", express.static(pdfDir));

// --------------------------------------------------------
// Constants
// --------------------------------------------------------
const JOIN_SEP = "|||";
const GRID_COLS = 2;
const GRID_ROWS = 4;
const SHOTS_PER_PAGE = GRID_COLS * GRID_ROWS;

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------
function splitField(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return String(val)
    .split(JOIN_SEP)
    .map((s) => s.trim());
}

function groupByScene(shots) {
  const groups = [];
  let currentScene = null;
  let currentGroup = [];

  for (const shot of shots) {
    const scene = shot.scene || "";
    if (scene !== currentScene) {
      if (currentGroup.length > 0) {
        groups.push({ scene: currentScene, shots: currentGroup });
      }
      currentScene = scene;
      currentGroup = [];
    }
    currentGroup.push(shot);
  }

  if (currentGroup.length > 0) {
    groups.push({ scene: currentScene, shots: currentGroup });
  }

  return groups;
}

// --------------------------------------------------------
// Main endpoint
// --------------------------------------------------------
app.post("/generate", async (req, res) => {
  try {
    // Read from body or query
    const title =
      req.body?.title ??
      req.query.title ??
      "Shot List";

    const description =
      req.body?.description ??
      req.query.description ??
      "";

    const imagesRaw = req.body?.images ?? req.query.images;
    const sizesRaw = req.body?.sizes ?? req.query.sizes;
    const descsRaw = req.body?.descriptions ?? req.query.descriptions;
    const scenesRaw = req.body?.scenes ?? req.query.scenes;

    const imageList = splitField(imagesRaw);
    const sizeList = splitField(sizesRaw);
    const descList = splitField(descsRaw);
    const sceneList = splitField(scenesRaw);

    if (!imageList.length) {
      return res.status(400).json({ error: "no images provided" });
    }

    const shots = imageList.map((url, i) => ({
      url,
      size: sizeList[i] || "",
      desc: descList[i] || "",
      scene: sceneList[i] || "",
    }));

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

    // Intro page
    doc.addPage();
    doc.fontSize(22).text(title, { align: "center" });
    doc.moveDown();
    if (description) {
      doc.fontSize(12).text(description, { align: "center" });
    }

    // ----------------------------------------------------
    // Scene pages (2x4 grid)
    // ----------------------------------------------------
    for (const group of sceneGroups) {
      const sceneLabel = group.scene || "";
      const shotsInScene = group.shots;

      for (let i = 0; i < shotsInScene.length; i++) {
        const indexOnPage = i % SHOTS_PER_PAGE;

        if (indexOnPage === 0) {
          doc.addPage();

          if (sceneLabel) {
            doc.fontSize(18).text(sceneLabel, { align: "left" });
            doc.moveDown(0.5);
          }
        }

        const shot = shotsInScene[i];
        const page = doc.page;
        const margins = page.margins;

        const headerSpace = sceneLabel ? 30 : 0;

        const usableWidth = page.width - margins.left - margins.right;
        const usableHeight =
          page.height - margins.top - margins.bottom - headerSpace;

        const cellWidth = usableWidth / GRID_COLS;
        const cellHeight = usableHeight / GRID_ROWS;

        const row = Math.floor(indexOnPage / GRID_COLS);
        const col = indexOnPage % GRID_COLS;

        const x = margins.left + col * cellWidth;
        const y = margins.top + headerSpace + row * cellHeight;

        const imageBoxHeight = cellHeight - 30; // 30px for caption

        const sizeText = (shot.size || "").trim();
        const descText = (shot.desc || "").trim();

        const caption = [sizeText, descText].filter(Boolean).join(" – ");

        try {
          const resp = await fetchFn(shot.url);
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer());
            const resized = await sharp(buf)
              .resize({ width: 1200, withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toBuffer();

            doc.image(resized, x + 5, y + 5, {
              fit: [cellWidth - 10, imageBoxHeight - 10],
              align: "center",
              valign: "center",
            });
          }
        } catch (e) {
          console.error("Image load failed:", shot.url, e);
        }

        if (caption) {
          doc.fontSize(8).text(caption, x + 5, y + imageBoxHeight, {
            width: cellWidth - 10,
            align: "center",
          });
        }
      }
    }

    doc.end();
    const pdfBuffer = await done;

    // ----------------------------------------------------
    // Save & Respond
    // ----------------------------------------------------
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
    res.status(500).json({ error: "PDF generation failed" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`PDF service running on port ${PORT}`);
});
