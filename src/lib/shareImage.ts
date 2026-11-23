import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { saveMediaToGallery } from './nativeTrackingService';

export type ShareImageOutcome = 'shared' | 'cancelled';

export type SaveImageOutcome = {
  /**
   * `gallery` is the Android MediaStore path (Pictures/ALLMOVA), `documents`
   * the public Documents fallback, `share-sheet` a hand-off to the system UI.
   */
  location: 'gallery' | 'documents' | 'share-sheet' | 'download';
  path: string;
};

function toBase64(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

async function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

/**
 * Writes the PNG to the cache directory and opens the Android share sheet.
 *
 * The WebView cannot hand a `blob:` URL to other apps, so the file has to exist
 * on disk and be passed as a `file://` URI.
 */
export async function shareCardImage(
  canvas: HTMLCanvasElement,
  fileName: string,
  title: string,
): Promise<ShareImageOutcome> {
  if (Capacitor.isNativePlatform()) {
    const { uri } = await Filesystem.writeFile({
      path: fileName,
      data: toBase64(canvas),
      directory: Directory.Cache,
    });

    await Share.share({
      title,
      text: title,
      files: [uri],
      dialogTitle: 'Bagikan kartu aktivitas',
    });
    return 'shared';
  }

  const blob = await toBlob(canvas);
  if (!blob) throw new Error('Gagal membuat berkas gambar.');

  const file = new File([blob], fileName, { type: 'image/png' });
  if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (error) {
      // AbortError means the user dismissed the sheet; anything else falls back.
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
    }
  }

  downloadBlob(blob, fileName);
  return 'shared';
}

/**
 * Saves the PNG into the Android gallery through MediaStore, or downloads it on
 * the web.
 *
 * The canvas is written to the app cache first because the native bridge copies
 * a real file into `Pictures/ALLMOVA`. Older devices without the MediaStore
 * bridge fall back to a Documents write and finally to the system share sheet.
 */
export async function saveCardImage(
  canvas: HTMLCanvasElement,
  fileName: string,
  title: string,
): Promise<SaveImageOutcome> {
  if (Capacitor.isNativePlatform()) {
    const { uri } = await Filesystem.writeFile({
      path: fileName,
      data: toBase64(canvas),
      directory: Directory.Cache,
    });

    const saved = await saveMediaToGallery({ filePath: uri, mimeType: 'image/png' });
    if (saved) return { location: 'gallery', path: saved.path };

    try {
      const documents = await Filesystem.writeFile({
        path: fileName,
        data: toBase64(canvas),
        directory: Directory.Documents,
        recursive: true,
      });
      return { location: 'documents', path: documents.uri };
    } catch (cause) {
      console.warn('Direct Documents write failed, falling back to the share sheet', cause);
      await shareCardImage(canvas, fileName, title);
      return { location: 'share-sheet', path: fileName };
    }
  }

  const blob = await toBlob(canvas);
  if (!blob) throw new Error('Gagal membuat berkas gambar.');
  downloadBlob(blob, fileName);
  return { location: 'download', path: fileName };
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
