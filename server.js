import express from "express";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "1mb" })); // body not heavily used now

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

// Fixed 2x4 grid: 2 columns x 4 rows = 8 images per page
const GRID_COLS = 2;
const GRID_ROWS = 4;
const SHOTS_PER_PAGE = GRID_COLS * GRID_ROWS;

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------

// Split a joined-list field (string) into an array using JOIN_SEP
function splitField(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return String(val)
    .split(JOIN_SEP)
    .map((s) => s.trim());
}

// Group shots by scene while preserving order
function groupByScene(shots) {
  const groups = [];
  let currentScene = null;
  let currentGroup = [];

  for (const shot of shots) {
    const scene = shot.scene || "";
    if (scene !== currentScene) {
      // start a new group
      if (currentGroup.length > 0) groups.push({ scene: currentScene, shots: currentGroup });
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
    // Read from body OR query (Glide is using query string)
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

    // Build an array of shot objects aligned by index
    const shots = imageList.map((url, i) => ({
      url,
      size: sizeList[i] || "",
      desc: descList[i] || "",
      scene: sceneList[i] || "",
    }));

    // Group shots by scene
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
    doc.on("data", (chunk) => chunks.push(chunk));
    const done = new Promise((resolve, reject) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });

    // Optional intro page with global title/description
    doc.addPage();
    doc.fontSize(22).text(title, { align: "center" });
    doc.moveDown();
    if (description) {
      doc.fontSize(12).text(description, {
        align: "center",
      });
    }

    // ----------------------------------------------------
    // Scene pages with 2x4 grid
    // ----------------------------------------------------
    for (const group of sceneGroups) {
      const sceneLabel = group.scene || "";

      const shotsInScene = group.shots;
      let pageIndex = 0;

      for (let i = 0; i < shotsInScene.length; i++) {
        // New page every SHOTS_PER_PAGE or at first shot in scene
        if (i % SHOTS_PER_PAGE === 0) {
          doc.addPage();

          // Scene header at top of each page for that scene
          if (sceneLabel) {
            doc.fontSize(18).text(sceneLabel, {
              align: "left",
            });
            doc.moveDown(0.5);
          }

          // You can optionally repeat global title smaller here if you want
          // doc.fontSize(10).text(title, { align: "right" });

          pageIndex++;
        }

        const shot = shotsInScene[i];

        // Layout calculations
        const page = doc.page;
        const margins = page.margins;

        const headerSpace = sceneLabel ? 30 : 0;

        const usableWidth = page.width - margins.left - margins.right;
        const usableHeight = page.height - margins.top - margins.bottom - headerSpace;

        const cellWidth = usableWidth / GRID_COLS;
        const cellHeight = usableHeight / GRID_ROWS;

        const indexOnPage = i % SHOTS_PER_PAGE;
        const cellRow = Math.floor(indexOnPage / GRID_COLS);
        const cellCol = indexOnPage % GRID_COLS;

        const x = margins.left + cellCol * cellWidth;
        const y = margins.top + headerSpace + cellRow * cellHeight;

        // Reserve some vertical space at bottom of cell for caption
        const imageBoxHeight = cellHeight - 30; // 30 px for caption

        // Build caption from size + description (no scene)
        const sizeText = (shot.size || "").trim();
        const descText = (shot.desc || "").trim();
        const captionParts = [];
        if (sizeText) captionParts.push(sizeText);
        if (descText) captionParts.push(descText);
        const caption = captionParts.join(" – ");

        // Fetch and draw image
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
          } else {
            console.error("Image fetch failed:", shot.url, resp.status);
          }
        } catch (e) {
          console.error("Image failed:", shot.url, e);
        }

        // Caption
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
    // Save PDF and return URL + base64
    // ----------------------------------------------------
    const filename = `shotlist-${Date.now()}.pdf`;
    const filePath = path.join(pdfDir, filename);
    await fs.promises.writeFile(filePath, pdfBuffer);

    const pdfUrl = `https://glide-pdf-service.onrender.com/pdfs/${filename}`;
    const pdfBase64 = pdfBuffer.toString("base64");

    res.json({
      filename,
      pdfUrl,
      pdfBase64,
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
