const { Resvg } = require('@resvg/resvg-js');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const badgeTemplate = require('../templates/badge-template');
const volteFonts = require('../fonts/volte-fonts');

// The template's viewBox is 153.07 x 243.78 user units, authored at
// 72 units-per-inch — i.e. it maps 1:1 to PDF points. This equals a
// standard CR80 card: 54mm x 86mm (portrait).
const CARD_WIDTH_PT = 153.07;
const CARD_HEIGHT_PT = 243.78;

// Render resolution for the JPEG output. 600 DPI = 2x the previous 300 DPI.
const RENDER_DPI = 600;
const SCALE = RENDER_DPI / 72;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { name, nickname, role, email, tel, photoBase64 } = req.body;

    if (!name || !photoBase64) {
      return res.status(400).json({ success: false, message: 'Missing required fields: name and photoBase64' });
    }

    const filledSvg = fillTemplate({ name, nickname, role, email, tel, photoBase64 });

    const jpegBuffer = await renderSvgToJpeg(filledSvg);
    const pdfBuffer = await wrapJpegInPdf(jpegBuffer);

    res.status(200).json({
      success: true,
      jpeg: jpegBuffer.toString('base64'),
      pdf: pdfBuffer.toString('base64')
    });
  } catch (err) {
    console.error('batch-generate error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fillTemplate({ name, nickname, role, email, tel, photoBase64 }) {
  const cleanPhotoBase64 = photoBase64.replace(/^data:image\/\w+;base64,/, '');
  const photoDataUri = `data:image/png;base64,${cleanPhotoBase64}`;

  let svg = badgeTemplate;
  svg = svg.split('{{NAME}}').join(escapeXml(name));
  svg = svg.split('{{NICKNAME}}').join(escapeXml(nickname));
  svg = svg.split('{{ROLE_BLOCK}}').join(buildRoleBlock(role));
  svg = svg.split('{{EMAIL}}').join(escapeXml(email));
  svg = svg.split('{{TEL}}').join(escapeXml(tel));
  svg = svg.split('{{PHOTO_BASE64}}').join(photoDataUri);

  return svg;
}

// Google Sheets cells edited with CMD+ENTER (or ALT+ENTER on Windows)
// store an actual "\n" character for the manual line break. SVG's plain
// <text> collapses newlines into whitespace instead of breaking the line,
// so multi-line Role values must be split into separate <tspan> lines by
// hand, with the vertical position recalculated to stay centered no
// matter how many lines are present.
function buildRoleBlock(roleValue) {
  const centerX = 76.535;
  const baseY = 49.58;   // vertical position used for a single-line role
  const lineHeight = 12; // ~1.2 x font-size(10), matches the original design's line spacing

  const lines = String(roleValue || '')
    .split('\n')
    .map(line => escapeXml(line.trim()));

  const startY = baseY - ((lines.length - 1) * lineHeight) / 2;

  const tspans = lines
    .map((line, i) => `<tspan x="${centerX}" y="${startY + i * lineHeight}">${line}</tspan>`)
    .join('');

  return `<text text-anchor="middle" fill="#fff" font-family="Volte Semibold" font-size="10" font-weight="600">${tspans}</text>`;
}

// Renders the SVG using resvg-js, with the three Volte weights supplied
// directly as font buffers. This avoids relying on the SVG's own
// @font-face / data-URI font embedding, which is unreliable in headless
// Lambda environments that have no system fonts or fontconfig fallback —
// the exact issue that caused every character to render as a tofu box.
// fontBuffers (in-memory font data) is known to be unreliable on some
// serverless/Lambda environments with @resvg/resvg-js — it can silently
// fail to parse the font with no error thrown, causing all text to
// disappear entirely. Writing the fonts to /tmp (the one writable
// directory in Lambda) and using fontFiles instead is the more reliable
// approach. Files are written once per warm container and reused on
// subsequent invocations of the same instance.
function getFontFilePaths() {
  const tmpDir = os.tmpdir();
  const fontEntries = [
    { key: 'medium', filename: 'volte-medium.otf' },
    { key: 'semibold', filename: 'volte-semibold.otf' },
    { key: 'bold', filename: 'volte-bold.otf' }
  ];

  return fontEntries.map(({ key, filename }) => {
    const filePath = path.join(tmpDir, filename);
    if (!fs.existsSync(filePath)) {
      const buffer = Buffer.from(volteFonts[key], 'base64');
      fs.writeFileSync(filePath, buffer);
    }
    return filePath;
  });
}

function renderSvgToJpeg(svgString) {
  const fontFilePaths = getFontFilePaths();

  // NOTE: resvg-js has a quirk where supplying `font` and `fitTo` in the
  // same options object causes `fitTo` to be silently ignored. Workaround:
  // render at the SVG's native size (with fonts applied correctly), then
  // upscale separately via sharp to reach 300 DPI print resolution.
  const resvg = new Resvg(svgString, {
    font: {
      fontFiles: fontFilePaths,
      loadSystemFonts: false // don't waste time scanning for system fonts that don't exist here
    }
  });

  const pngData = resvg.render();
  const nativePngBuffer = pngData.asPng();

  const targetWidth = Math.round(CARD_WIDTH_PT * SCALE);
  const targetHeight = Math.round(CARD_HEIGHT_PT * SCALE);

  const sharp = require('sharp');
  return sharp(nativePngBuffer)
    .resize(targetWidth, targetHeight)
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 95 })
    .toBuffer();
}

async function wrapJpegInPdf(jpegBuffer) {
  const pdfDoc = await PDFDocument.create();

  const page = pdfDoc.addPage([CARD_WIDTH_PT, CARD_HEIGHT_PT]);
  const jpegImage = await pdfDoc.embedJpg(jpegBuffer);

  page.drawImage(jpegImage, {
    x: 0,
    y: 0,
    width: CARD_WIDTH_PT,
    height: CARD_HEIGHT_PT
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
