package io.github.wetmzl.blackjack;

import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.*;
import java.util.concurrent.atomic.AtomicBoolean;

@RunWith(AndroidJUnit4.class)
public class ContentIoTest {
    @Test public void copiesAcrossBufferBoundariesAndReturnsKnownDigest() throws Exception {
        byte[] bytes = new byte[ContentIoPlugin.BUFFER_BYTES * 2 + 7];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte)(i % 251);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        com.getcapacitor.JSObject result = ContentIoPlugin.transfer(new ByteArrayInputStream(bytes), output, new AtomicBoolean(), bytes.length, null);
        assertArrayEquals(bytes, output.toByteArray());
        assertEquals(bytes.length, result.getLong("bytes"));
        assertEquals("ddd4b87dd6d7d4f27b2525432e9c90d25f3b9b53cfd039e6bb49d57ad8fb4a3d", result.getString("sha256"));
    }
    @Test public void emptyFileHasSha256Digest() throws Exception {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", ContentIoPlugin.transfer(new ByteArrayInputStream(new byte[0]), null, new AtomicBoolean(), 0, null).getString("sha256"));
    }
    @Test public void cancelsBeforeWritingNextChunk() throws Exception {
        AtomicBoolean cancelled = new AtomicBoolean();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try {
            ContentIoPlugin.transfer(new ByteArrayInputStream(new byte[ContentIoPlugin.BUFFER_BYTES * 3]), output, cancelled, Long.MAX_VALUE, n -> cancelled.set(true));
            fail("must cancel");
        } catch (IOException expected) { assertEquals(ContentIoPlugin.BUFFER_BYTES, output.size()); }
    }
    @Test public void rejectsOversizedStreamAndPropagatesFullDiskFailure() throws Exception {
        try {
            ContentIoPlugin.transfer(new ByteArrayInputStream(new byte[8]), new ByteArrayOutputStream(), new AtomicBoolean(), 7, null);
            fail("must reject limit");
        } catch (IOException expected) { assertTrue(expected.getMessage().contains("限额")); }
        OutputStream full = new OutputStream() { @Override public void write(int value) throws IOException { throw new IOException("ENOSPC"); } };
        try {
            ContentIoPlugin.transfer(new ByteArrayInputStream(new byte[8]), full, new AtomicBoolean(), 8, null);
            fail("must propagate IO failure");
        } catch (IOException expected) { assertEquals("ENOSPC", expected.getMessage()); }
    }
}
