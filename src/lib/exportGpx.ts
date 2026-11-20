import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/**
 * Delivers GPX content to the user.
 *
 * Android WebView blocks blob downloads from Capacitor's `https://localhost`
 * origin, so native builds write to the cache directory and hand off to the
 * system share sheet instead.
 */
export async function exportGpxFile(fileName: string, contents: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { uri } = await Filesystem.writeFile({
      path: fileName,
      data: contents,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });

    await Share.share({
      title: fileName,
      url: uri,
      dialogTitle: 'Simpan atau bagikan rute GPX',
    });
    return;
  }

  const blob = new Blob([contents], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
