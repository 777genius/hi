export type PromptImageDraft = {
  id: string;
  mime: string;
  dataUrl: string;
  dataBase64: string;
  size: number;
};

const MB = 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = Math.floor(4.5 * MB);
const DEFAULT_MAX_INPUT_BYTES = 24 * MB;
const DEFAULT_MAX_LONG_EDGE = 1568;
const MIN_LONG_EDGE = 768;
const RESIZE_STEP = 0.82;
const JPEG_QUALITY_STEPS = [0.92, 0.86, 0.8, 0.74, 0.68, 0.62, 0.56];
const SUPPORTED_INPUT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const UNSUPPORTED_HEIC_MIME_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);
const HEIC_FILE_EXTENSION_RE = /\.(heic|heif)$/i;

type PromptImageDraftOptions = {
  maxBytes?: number;
  maxInputBytes?: number;
  maxLongEdge?: number;
  prefix?: string;
};

type ImageDimensions = {
  width: number;
  height: number;
};

type NormalizedPromptImage = {
  blob: Blob;
  mime: string;
};

export function createClientId(prefix: string): string {
  try {
    const uuid =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : null;
    if (uuid) return `${prefix}:${uuid}`;
  } catch {
    // ignore
  }
  return `${prefix}:${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function dataUrlToBase64(dataUrl: string): string {
  const s = String(dataUrl ?? '');
  const idx = s.indexOf(',');
  return idx >= 0 ? s.slice(idx + 1).trim() : '';
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('Не удалось прочитать изображение'));
    fr.onload = () => resolve(String(fr.result ?? ''));
    fr.readAsDataURL(blob);
  });
}

function normalizeMime(mime: string): string {
  const normalized = String(mime ?? '').trim().toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  return normalized;
}

function inferMimeFromFileName(name: string): string {
  const normalized = String(name ?? '').trim().toLowerCase();
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.webp')) return 'image/webp';
  if (normalized.endsWith('.gif')) return 'image/gif';
  if (normalized.endsWith('.heic')) return 'image/heic';
  if (normalized.endsWith('.heif')) return 'image/heif';
  return '';
}

function isUnsupportedHeicLikeFile(file: File, mime: string): boolean {
  return UNSUPPORTED_HEIC_MIME_TYPES.has(mime) || HEIC_FILE_EXTENSION_RE.test(file.name);
}

function unsupportedHeicMessage(): string {
  return 'Фото в HEIC/HEIF пока не поддерживается в веб-companion. На iPhone выбери JPEG/Most Compatible или отправь скриншот.';
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / MB).toFixed(bytes % MB === 0 ? 0 : 1)} MB`;
}

function fitImageWithinLongEdge(width: number, height: number, maxLongEdge: number): ImageDimensions {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const longEdge = Math.max(safeWidth, safeHeight);
  if (!Number.isFinite(longEdge) || longEdge <= maxLongEdge) {
    return { width: safeWidth, height: safeHeight };
  }

  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

function shrinkDimensions(width: number, height: number): ImageDimensions {
  return {
    width: Math.max(1, Math.round(width * RESIZE_STEP)),
    height: Math.max(1, Math.round(height * RESIZE_STEP)),
  };
}

function createCanvas(width: number, height: number, fillBackground: boolean): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Не удалось подготовить изображение для отправки');
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (fillBackground) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }

  return canvas;
}

async function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();

    const cleanup = (): void => {
      URL.revokeObjectURL(url);
    };

    img.onerror = () => {
      cleanup();
      reject(new Error('Не удалось обработать фото. Попробуй JPEG, PNG или WebP.'));
    };

    img.onload = () => {
      cleanup();
      resolve(img);
    };

    img.src = url;
  });
}

async function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mime, quality);
  });
}

function outputMimeCandidates(sourceMime: string): string[] {
  switch (sourceMime) {
    case 'image/png':
      return ['image/png', 'image/webp', 'image/jpeg'];
    case 'image/webp':
      return ['image/webp', 'image/jpeg', 'image/png'];
    case 'image/gif':
      return ['image/webp', 'image/jpeg', 'image/png'];
    case 'image/jpeg':
      return ['image/jpeg', 'image/webp'];
    default:
      return ['image/jpeg', 'image/webp', 'image/png'];
  }
}

async function encodeBestImageVariant(
  image: HTMLImageElement,
  dimensions: ImageDimensions,
  sourceMime: string,
  maxBytes: number,
): Promise<NormalizedPromptImage | null> {
  const transparentCanvas = createCanvas(dimensions.width, dimensions.height, false);
  const transparentCtx = transparentCanvas.getContext('2d');
  if (!transparentCtx) {
    throw new Error('Не удалось подготовить изображение для отправки');
  }
  transparentCtx.drawImage(image, 0, 0, dimensions.width, dimensions.height);

  const opaqueCanvas = createCanvas(dimensions.width, dimensions.height, true);
  const opaqueCtx = opaqueCanvas.getContext('2d');
  if (!opaqueCtx) {
    throw new Error('Не удалось подготовить изображение для отправки');
  }
  opaqueCtx.drawImage(image, 0, 0, dimensions.width, dimensions.height);

  let smallest: NormalizedPromptImage | null = null;

  for (const mime of outputMimeCandidates(sourceMime)) {
    const canvas = mime === 'image/jpeg' ? opaqueCanvas : transparentCanvas;
    const qualities = mime === 'image/png' ? [undefined] : JPEG_QUALITY_STEPS;

    for (const quality of qualities) {
      const blob = await canvasToBlob(canvas, mime, quality);
      if (!blob || blob.size === 0) continue;

      const normalizedMime = normalizeMime(blob.type) || mime;
      const candidate = { blob, mime: normalizedMime };

      if (!smallest || candidate.blob.size < smallest.blob.size) {
        smallest = candidate;
      }

      if (candidate.blob.size <= maxBytes) {
        return candidate;
      }
    }
  }

  return smallest;
}

async function normalizePromptImage(
  file: File,
  options: {
    maxBytes: number;
    maxLongEdge: number;
    sourceMime: string;
  },
): Promise<NormalizedPromptImage> {
  const image = await loadImageElement(file);
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;

  if (!naturalWidth || !naturalHeight) {
    throw new Error('Не удалось определить размер изображения');
  }

  let dimensions = fitImageWithinLongEdge(naturalWidth, naturalHeight, options.maxLongEdge);

  const canKeepOriginal =
    SUPPORTED_INPUT_MIME_TYPES.has(options.sourceMime) &&
    file.size <= options.maxBytes &&
    dimensions.width === naturalWidth &&
    dimensions.height === naturalHeight;

  if (canKeepOriginal) {
    return {
      blob: file,
      mime: options.sourceMime,
    };
  }

  let smallest: NormalizedPromptImage | null = null;

  for (;;) {
    const next = await encodeBestImageVariant(
      image,
      dimensions,
      options.sourceMime,
      options.maxBytes,
    );

    if (next && (!smallest || next.blob.size < smallest.blob.size)) {
      smallest = next;
    }

    if (next && next.blob.size <= options.maxBytes) {
      return next;
    }

    if (Math.max(dimensions.width, dimensions.height) <= MIN_LONG_EDGE) {
      break;
    }

    dimensions = shrinkDimensions(dimensions.width, dimensions.height);
  }

  if (smallest && smallest.blob.size <= options.maxBytes) {
    return smallest;
  }

  throw new Error(
    `Фото не удалось ужать до безопасного лимита ${formatMegabytes(options.maxBytes)}. Попробуй скриншот поменьше или обрежь изображение.`
  );
}

export async function createPromptImageDraft(
  file: File,
  options: PromptImageDraftOptions = {},
): Promise<PromptImageDraft | null> {
  const sourceMime = normalizeMime(file.type) || inferMimeFromFileName(file.name);
  if (isUnsupportedHeicLikeFile(file, sourceMime)) {
    throw new Error(unsupportedHeicMessage());
  }
  if (!sourceMime.startsWith('image/')) return null;

  const maxBytes = Number.isFinite(options.maxBytes) ? Number(options.maxBytes) : DEFAULT_MAX_IMAGE_BYTES;
  const maxInputBytes = Number.isFinite(options.maxInputBytes)
    ? Number(options.maxInputBytes)
    : DEFAULT_MAX_INPUT_BYTES;
  const maxLongEdge = Number.isFinite(options.maxLongEdge)
    ? Number(options.maxLongEdge)
    : DEFAULT_MAX_LONG_EDGE;

  if (Number.isFinite(file.size) && file.size > maxInputBytes) {
    throw new Error(
      `Фото слишком большое для обработки на устройстве. Выбери изображение до ${formatMegabytes(maxInputBytes)}.`
    );
  }

  const normalized = await normalizePromptImage(file, {
    maxBytes,
    maxLongEdge,
    sourceMime,
  });

  const dataUrl = await blobToDataUrl(normalized.blob);
  const dataBase64 = dataUrlToBase64(dataUrl);
  if (!dataBase64) {
    throw new Error('Не удалось подготовить фото к отправке');
  }

  return {
    id: createClientId(options.prefix ?? 'img'),
    mime: normalized.mime,
    dataUrl,
    dataBase64,
    size: Number(normalized.blob.size || 0),
  };
}
