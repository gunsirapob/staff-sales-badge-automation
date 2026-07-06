const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const badgeTemplate = require('../templates/badge-template');

// The template's viewBox is 153.07 x 243.78 user units, which was
// deliberately designed at 72 units-per-inch — i.e. it maps 1:1 to
// PDF points. This equals a standard CR80 card: 54mm x 86mm (portrait).
const CARD_WIDTH_PT = 153.07;
const CARD_HEIGHT_PT = 243.78;

// Render resolution for the JPEG output. 300 DPI is standard print quality.
const RENDER_DPI = 300;

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

// Escapes characters that would otherwise break the XML structure of the SVG
// (e.g. an email or name containing "&" would corrupt the file if inserted raw).
function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fillTemplate({ name, nickname, role, email, tel, photoBase64 }) {
  // Strip any data URL prefix the caller might have included, so we control
  // the mime type ourselves when re-embedding into the SVG <image> tag.
  const cleanPhotoBase64 = photoBase64.replace(/^data:image\/\w+;base64,/, '');
  const photoDataUri = `data:image/png;base64,${cleanPhotoBase64}`;

  let svg = badgeTemplate;
  svg = svg.split('{{NAME}}').join(escapeXml(name));
  svg = svg.split('{{NICKNAME}}').join(escapeXml(nickname));
  svg = svg.split('{{ROLE}}').join(escapeXml(role));
  svg = svg.split('{{EMAIL}}').join(escapeXml(email));
  svg = svg.split('{{TEL}}').join(escapeXml(tel));
  svg = svg.split('{{PHOTO_BASE64}}').join(photoDataUri);

  return svg;
}

async function renderSvgToJpeg(svgString) {
  const svgBuffer = Buffer.from(svgString, 'utf-8');

  // `density` tells sharp/librsvg how many pixels to render per the SVG's
  // native 72-units-per-inch — e.g. density 300 renders at 300 DPI.
  const jpeg = await sharp(svgBuffer, { density: RENDER_DPI })
    .flatten({ background: '#ffffff' }) // JPEG has no alpha channel, force white background
    .jpeg({ quality: 95 })
    .toBuffer();

  return jpeg;
}

async function wrapJpegInPdf(jpegBuffer) {
  const pdfDoc = await PDFDocument.create();

  // Page size in points == the card's real physical size (54mm x 86mm),
  // because the SVG viewBox was authored at 72 units/inch.
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
