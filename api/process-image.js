const axios = require('axios');
const sharp = require('sharp');

const PADDING_FACTOR = 1.4;
const OUTPUT_SIZE = 1000;

module.exports = async (req, res) => {
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
    const croppedBuffer = await smartSquareCrop(removedBgBuffer);

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

async function smartSquareCrop(pngBuffer) {
  const original = sharp(pngBuffer);
  const meta = await original.metadata();

  const { info: trimInfo } = await sharp(pngBuffer)
    .trim({ threshold: 10 })
    .toBuffer({ resolveWithObject: true });

  const bboxLeft = Math.max(0, -trimInfo.trimOffsetLeft);
  const bboxTop = Math.max(0, -trimInfo.trimOffsetTop);
  const bboxWidth = trimInfo.width;
  const bboxHeight = trimInfo.height;

  const centerX = bboxLeft + bboxWidth / 2;
  const centerY = bboxTop + bboxHeight / 2;

  let squareSide = Math.round(Math.max(bboxWidth, bboxHeight) * PADDING_FACTOR);
  squareSide = Math.min(squareSide, meta.width, meta.height);

  let left = Math.round(centerX - squareSide / 2);
  let top = Math.round(centerY - squareSide / 2);

  left = Math.max(0, Math.min(left, meta.width - squareSide));
  top = Math.max(0, Math.min(top, meta.height - squareSide));

  const cropped = await sharp(pngBuffer)
    .extract({ left, top, width: squareSide, height: squareSide })
    .resize(OUTPUT_SIZE, OUTPUT_SIZE)
    .png()
    .toBuffer();

  return cropped;
}
