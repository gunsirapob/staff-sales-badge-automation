const axios = require('axios');
const sharp = require('sharp');

const OUTPUT_SIZE = 1000;

// How much of the subject's total height counts as "head region" when
// isolating the head from the rest of the body (arms, torso, etc).
const HEAD_BAND_RATIO = 0.18;

// Final square crop size, expressed as a multiple of head height.
// Larger = more shoulders/chest visible around the head.
const HEAD_TO_SQUARE_RATIO = 5.5;

// Small margin above the top of the head so it isn't cropped flush to the edge.
const TOP_MARGIN_RATIO = 0.08;

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
    const { image, filename } = req.body;

    if (!image) {
      return res.status(400).json({ success: false, message: 'No image provided' });
    }

    const cleanBase64 = image.replace(/^data:image\/\w+;base64,/, '');
    const inputBuffer = Buffer.from(cleanBase64, 'base64');

    const removedBgBuffer = await removeBackground(inputBuffer);
    const croppedBuffer = await headAnchoredSquareCrop(removedBgBuffer);

    res.status(200).json({
      success: true,
      image: croppedBuffer.toString('base64'),
      width: OUTPUT_SIZE,
      height: OUTPUT_SIZE,
      filename: filename || null
    });
  } catch (err) {
    console.error('process-image error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

async function removeBackground(inputBuffer) {
  const base64Input = inputBuffer.toString('base64');

  const response = await axios.post(
    'https://api.remove.bg/v1.0/removebg',
    {
      image_file_b64: base64Input,
      size: 'auto',
      format: 'png'
    },
    {
      headers: {
        'X-Api-Key': process.env.REMOVE_BG_API_KEY,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer'
    }
  );

  return Buffer.from(response.data);
}

async function headAnchoredSquareCrop(pngBuffer) {
  const meta = await sharp(pngBuffer).metadata();

  // Step 1: find the full subject bounding box (whole body, incl. any
  // outstretched arms) via alpha trim.
  const { info: fullTrim } = await sharp(pngBuffer)
    .trim({ threshold: 10 })
    .toBuffer({ resolveWithObject: true });

  const fullLeft = Math.max(0, -fullTrim.trimOffsetLeft);
  const fullTop = Math.max(0, -fullTrim.trimOffsetTop);
  const fullWidth = fullTrim.width;
  const fullHeight = fullTrim.height;

  // Step 2: isolate just the head — a thin horizontal band at the very top
  // of the subject. Arms/hands rarely reach this high, so this band should
  // contain only the head (plus maybe hair), regardless of body pose.
  const headBandHeight = Math.max(1, Math.round(fullHeight * HEAD_BAND_RATIO));

  const headBandBuffer = await sharp(pngBuffer)
    .extract({ left: fullLeft, top: fullTop, width: fullWidth, height: headBandHeight })
    .toBuffer();

  const { info: headTrim } = await sharp(headBandBuffer)
    .trim({ threshold: 10 })
    .toBuffer({ resolveWithObject: true });

  const headLeftInBand = Math.max(0, -headTrim.trimOffsetLeft);
  const headWidth = headTrim.width;
  const headHeight = headTrim.height || headBandHeight;

  const headCenterX = fullLeft + headLeftInBand + headWidth / 2;
  const headTopAbs = fullTop;

  // Step 3: square crop size based on head size, not full-body size —
  // this is what makes the crop immune to wide poses / outstretched arms.
  let squareSide = Math.round(headHeight * HEAD_TO_SQUARE_RATIO);
  squareSide = Math.min(squareSide, meta.width, meta.height);

  // Step 4: position the square — small margin above the head, centered
  // horizontally on the head, extending downward to include shoulders/chest.
  const marginAboveHead = Math.round(squareSide * TOP_MARGIN_RATIO);
  let top = headTopAbs - marginAboveHead;
  let left = Math.round(headCenterX - squareSide / 2);

  top = Math.max(0, Math.min(top, meta.height - squareSide));
  left = Math.max(0, Math.min(left, meta.width - squareSide));

  const cropped = await sharp(pngBuffer)
    .extract({ left, top, width: squareSide, height: squareSide })
    .resize(OUTPUT_SIZE, OUTPUT_SIZE)
    .png()
    .toBuffer();

  return cropped;
}
