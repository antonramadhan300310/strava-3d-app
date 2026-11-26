package com.allmova.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import ee.forgr.capacitor_updater.CryptoCipher;
import java.io.File;
import java.io.FileOutputStream;
import java.security.MessageDigest;
import org.junit.Test;

/**
 * The OTA manifest publishes a SHA-256 produced by {@code sha256sum} in CI (and
 * derivable in the WebView with WebCrypto). capgo compares that string with
 * {@code CryptoCipher.calcChecksum} in {@code CapgoUpdater.finishDownload}, so
 * both sides must agree byte for byte: lowercase hex, no prefix, over the raw
 * zip bytes.
 */
public class OtaBundleChecksumTest {

    @Test
    public void pluginHasherMatchesStandardSha256Hex() throws Exception {
        final byte[] payload = new byte[64 * 1024];
        for (int index = 0; index < payload.length; index++) {
            payload[index] = (byte) (index * 31 + 7);
        }

        final File bundle = File.createTempFile("ota-bundle", ".zip");
        bundle.deleteOnExit();
        try (FileOutputStream out = new FileOutputStream(bundle)) {
            out.write(payload);
        }

        final String expected = sha256Hex(payload);
        final String actual = CryptoCipher.calcChecksum(bundle);

        assertEquals(expected, actual);
        assertEquals(64, actual.length());
        assertTrue(actual.matches("[0-9a-f]{64}"));
    }

    private static String sha256Hex(final byte[] payload) throws Exception {
        final byte[] digest = MessageDigest.getInstance("SHA-256").digest(payload);
        final StringBuilder hex = new StringBuilder(digest.length * 2);
        for (final byte value : digest) {
            hex.append(String.format("%02x", value));
        }
        return hex.toString();
    }
}
