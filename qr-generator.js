import QRCode from 'qrcode';
import QRCodeStyling from 'qr-code-styling';
import { JSDOM } from 'jsdom';
import sharp from 'sharp';

const DEFAULT_DARK_COLOR = '#18181b';
const DEFAULT_LIGHT_COLOR = '#ffffff';

function normalizeColor(color, fallback) {
  const value = typeof color === 'string' ? color.trim() : '';

  if (!value) {
    return fallback;
  }

  if (/^#([0-9a-f]{3,8})$/i.test(value)) {
    return value;
  }

  if (/^rgba?\(/i.test(value)) {
    return value;
  }

  if (value === 'transparent') {
    return value;
  }

  return fallback;
}

function getBackgroundColor({ lightColor, backgroundTransparent, forLegacyRenderer = false }) {
  if (backgroundTransparent) {
    return forLegacyRenderer ? '#0000' : 'transparent';
  }

  return normalizeColor(lightColor, DEFAULT_LIGHT_COLOR);
}

function getLegacyQrOptions({
  size,
  margin,
  darkColor,
  lightColor,
  backgroundTransparent,
}) {
  return {
    errorCorrectionLevel: 'M',
    margin,
    width: size,
    color: {
      dark: normalizeColor(darkColor, DEFAULT_DARK_COLOR),
      light: getBackgroundColor({
        lightColor,
        backgroundTransparent,
        forLegacyRenderer: true,
      }),
    },
  };
}

async function generateStandardQrCode({
  data,
  size,
  darkColor,
  lightColor,
  margin,
  format,
  backgroundTransparent,
}) {
  const options = getLegacyQrOptions({
    size,
    margin,
    darkColor,
    lightColor,
    backgroundTransparent,
  });

  if (format === 'svg') {
    const svg = await QRCode.toString(data, {
      ...options,
      type: 'svg',
    });

    return {
      buffer: Buffer.from(svg),
      contentType: 'image/svg+xml',
    };
  }

  const buffer = await QRCode.toBuffer(data, {
    ...options,
    type: 'png',
  });

  return {
    buffer,
    contentType: 'image/png',
  };
}

async function generateRoundedQrCode({
  data,
  size,
  darkColor,
  lightColor,
  margin,
  format,
  backgroundTransparent,
}) {
  const qrCode = new QRCodeStyling({
    jsdom: JSDOM,
    type: 'svg',
    width: size,
    height: size,
    data,
    margin,
    qrOptions: {
      // `qrcode` allows colors but not rounded modules natively, so
      // `qr-code-styling` is used only when rounded rendering is requested.
      errorCorrectionLevel: 'Q',
    },
    dotsOptions: {
      color: normalizeColor(darkColor, DEFAULT_DARK_COLOR),
      type: 'rounded',
      roundSize: true,
    },
    cornersSquareOptions: {
      color: normalizeColor(darkColor, DEFAULT_DARK_COLOR),
      type: 'extra-rounded',
    },
    cornersDotOptions: {
      color: normalizeColor(darkColor, DEFAULT_DARK_COLOR),
      type: 'dot',
    },
    backgroundOptions: {
      color: getBackgroundColor({
        lightColor,
        backgroundTransparent,
      }),
    },
  });

  const svgBuffer = await qrCode.getRawData('svg');
  const normalizedSvgBuffer = Buffer.isBuffer(svgBuffer)
    ? svgBuffer
    : Buffer.from(await svgBuffer.arrayBuffer());

  if (format === 'svg') {
    return {
      buffer: normalizedSvgBuffer,
      contentType: 'image/svg+xml',
    };
  }

  const pngBuffer = await sharp(normalizedSvgBuffer).png().toBuffer();
  return {
    buffer: pngBuffer,
    contentType: 'image/png',
  };
}

export async function generateQrCode({
  data,
  size = 360,
  darkColor = DEFAULT_DARK_COLOR,
  lightColor = DEFAULT_LIGHT_COLOR,
  rounded = false,
  format = 'png',
  margin = 2,
  backgroundTransparent = false,
}) {
  const normalizedFormat = format === 'svg' ? 'svg' : 'png';
  const normalizedSize = Math.max(160, Math.min(1200, Math.round(size)));
  const normalizedMargin = Math.max(0, Math.min(12, Math.round(margin)));

  if (rounded) {
    return generateRoundedQrCode({
      data,
      size: normalizedSize,
      darkColor,
      lightColor,
      margin: normalizedMargin,
      format: normalizedFormat,
      backgroundTransparent,
    });
  }

  return generateStandardQrCode({
    data,
    size: normalizedSize,
    darkColor,
    lightColor,
    margin: normalizedMargin,
    format: normalizedFormat,
    backgroundTransparent,
  });
}
