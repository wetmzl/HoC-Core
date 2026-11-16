package io.github.wetmzl.blackjack;

import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.*;
import java.util.concurrent.atomic.AtomicBoolean;

@RunWith(AndroidJUnit4.class)
public class ContentIoTest {
    @Test public void reusesBatchBufferWithoutLeakingBytesOrDigestAcrossFilesAndFailures() throws Exception {
        byte[] buffer = new byte[ContentIoPlugin.BUFFER_BYTES];
        byte[] large = new byte[buffer.length + 11];
        java.util.Arrays.fill(large, (byte)0xff);
        ContentIoPlugin.transfer(new ByteArrayInputStream(large), new ByteArrayOutputStream(), new AtomicBoolean(), large.length, null, buffer);
        try {
            ContentIoPlugin.transfer(new ByteArrayInputStream(large), new ByteArrayOutputStream(), new AtomicBoolean(), 1, null, buffer);
            fail("must reject oversize data");
        } catch (IOException expected) { assertTrue(expected.getMessage().contains("限额")); }
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        com.getcapacitor.JSObject result = ContentIoPlugin.transfer(new ByteArrayInputStream(new byte[] {97, 98, 99}), output, new AtomicBoolean(), 3, null, buffer);
        assertArrayEquals(new byte[] {97, 98, 99}, output.toByteArray());
        assertEquals(3, result.getLong("bytes"));
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", result.getString("sha256"));
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ContentIoPlugin.transfer(new ByteArrayInputStream(new byte[0]), null, new AtomicBoolean(), 0, null, buffer).getString("sha256"));
    }
    @Test public void sharedBufferStillHonorsCancellationAndOutputFailures() throws Exception {
        byte[] buffer = new byte[ContentIoPlugin.BUFFER_BYTES];
        AtomicBoolean cancelled = new AtomicBoolean();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try {
            ContentIoPlugin.transfer(new ByteArrayInputStream(new byte[buffer.length * 2]), output, cancelled, Long.MAX_VALUE, n -> cancelled.set(true), buffer);
            fail("must cancel");
        } catch (IOException expected) { assertEquals(buffer.length, output.size()); }
        OutputStream full = new OutputStream() { @Override public void write(int value) throws IOException { throw new IOException("ENOSPC"); } };
        try {
            ContentIoPlugin.transfer(new ByteArrayInputStream(new byte[8]), full, new AtomicBoolean(), 8, null, buffer);
            fail("must propagate output failure");
        } catch (IOException expected) { assertEquals("ENOSPC", expected.getMessage()); }
        try {
            ContentIoPlugin.transfer(new ByteArrayInputStream(new byte[0]), null, new AtomicBoolean(), 0, null, new byte[0]);
            fail("must reject an empty buffer");
        } catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("缓冲区")); }
    }
    @Test public void reportsCorruptionMissingFilesAndFullDiskSeparately() {
        assertTrue(ContentIoPlugin.operationError(new java.util.zip.ZipException("zip END header not found")).contains("压缩包已损坏"));
        assertTrue(ContentIoPlugin.operationError(new EOFException()).contains("内容不完整"));
        net.lingala.zip4j.exception.ZipException wrong = new net.lingala.zip4j.exception.ZipException("wrong", net.lingala.zip4j.exception.ZipException.Type.WRONG_PASSWORD);
        assertEquals("ZIP_INVALID_PASSWORD", ContentIoPlugin.operationCode(wrong));
        assertTrue(ContentIoPlugin.operationError(wrong).contains("密码不匹配"));
        assertEquals("ZIP_PASSWORD_REQUIRED", ContentIoPlugin.operationCode(new ContentIoPlugin.ArchivePasswordException()));
        net.lingala.zip4j.exception.ZipException unsupported = new net.lingala.zip4j.exception.ZipException("unsupported", net.lingala.zip4j.exception.ZipException.Type.UNSUPPORTED_ENCRYPTION);
        assertEquals("CONTENT_IO_ERROR", ContentIoPlugin.operationCode(unsupported));
        assertTrue(ContentIoPlugin.operationError(unsupported).contains("不支持"));
        assertTrue(ContentIoPlugin.operationError(new FileNotFoundException("missing")).contains("重新选择"));
        assertTrue(ContentIoPlugin.operationError(new IOException("write failed: ENOSPC")).contains("存储空间不足"));
    }
    @Test public void readsOnlyRequestedRangeAndRejectsUnboundedReads() throws Exception {
        byte[] bytes = new byte[] {1, 2, 3, 4, 5};
        assertArrayEquals(new byte[] {3, 4}, ContentIoPlugin.readRange(new ByteArrayInputStream(bytes), 2, 2, new AtomicBoolean()));
        assertArrayEquals(new byte[] {5}, ContentIoPlugin.readRange(new ByteArrayInputStream(bytes), 4, 8, new AtomicBoolean()));
        assertArrayEquals(new byte[0], ContentIoPlugin.readRange(new ByteArrayInputStream(bytes), 9, 8, new AtomicBoolean()));
        try {
            ContentIoPlugin.readRange(new ByteArrayInputStream(bytes), 0, 2 * 1024 * 1024 + 1, new AtomicBoolean());
            fail("must reject unbounded read");
        } catch (IOException expected) { assertTrue(expected.getMessage().contains("限额")); }
        try {
            ContentIoPlugin.readRange(new ByteArrayInputStream(bytes), 0, 8, new AtomicBoolean(true));
            fail("must honor cancellation");
        } catch (IOException expected) { assertTrue(expected.getMessage().contains("取消")); }
    }
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
