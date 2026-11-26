import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { saveFileToDownloads } from './nativeTrackingService';

const GPX_MIME_TYPE = 'application/gpx+xml';

export type GpxExportResult = {
  fileName: string;
  /**
   * `downloads` — public Download folder (native Android),
   * `share` — system share sheet (native fallback),
   * `browser` — regular browser download.
   */
  location: 'downloads' | 'share' | 'browser';
  /** Path shown to the user, e.g. `Download/ALLMOVA/rute.gpx`. */
  path: string;
};

/** Toast copy for a finished export, naming the file and its destination. */
export function gpxExportMessage(result: GpxExportResult): string {
  if (result.location === 'downloads') {
    return `GPX tersimpan di folder Download: ${result.path}`;
  }
  if (result.location === 'share') {
    return `GPX siap dibagikan: ${result.fileName}`;
  }
  return `GPX diunduh: ${result.fileName}`;
}

async function writeCacheCopy(fileName: string, contents: string): Promise<string> {
  const { uri } = await Filesystem.writeFile({
    path: fileName,
    data: contents,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
    recursive: true,
  });
  return uri;
}

function shareCachedFile(fileName: string, uri: string): Promise<void> {
  return Share.share({
    title: fileName,
    url: uri,
    dialogTitle: 'Simpan atau bagikan rute GPX',
  }).then(() => undefined);
}

function downloadInBrowser(fileName: string, contents: string): void {
  const blob = new Blob([contents], { type: GPX_MIME_TYPE });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoking straight away cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Delivers GPX content to the user.
 *
 * Android WebView blocks blob downloads from Capacitor's `https://localhost`
 * origin, so native builds write the file into the public Download folder
 * through the native MediaStore bridge and only fall back to the share sheet
 * when that bridge is unavailable.
 */
export async function exportGpxFile(
  fileName: string,
  contents: string,
): Promise<GpxExportResult> {
  if (Capacitor.isNativePlatform()) {
    const uri = await writeCacheCopy(fileName, contents);
    const saved = await saveFileToDownloads({
      filePath: uri,
      fileName,
      mimeType: GPX_MIME_TYPE,
    });

    if (saved.ok) {
      return { fileName, location: 'downloads', path: saved.path };
    }

    try {
      await shareCachedFile(fileName, uri);
      return { fileName, location: 'share', path: fileName };
    } catch (cause) {
      const shareError = cause instanceof Error ? cause.message : 'berbagi gagal';
      throw new Error(`Gagal menyimpan ke folder Download (${saved.error}); ${shareError}.`);
    }
  }

  downloadInBrowser(fileName, contents);
  return { fileName, location: 'browser', path: fileName };
}

/**
 * Shares an existing GPX through the system sheet (Strava, WhatsApp, …)
 * without touching the Download folder.
 *
 * Resolves `null` when the sheet handled the file, or the export result when
 * the web fallback downloaded it instead.
 */
export async function shareGpxFile(
  fileName: string,
  contents: string,
): Promise<GpxExportResult | null> {
  if (!Capacitor.isNativePlatform()) {
    return exportGpxFile(fileName, contents);
  }
  const uri = await writeCacheCopy(fileName, contents);
  await shareCachedFile(fileName, uri);
  return null;
}
