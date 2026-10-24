package io.github.wetmzl.blackjack;
import org.junit.Test;
import static org.junit.Assert.*;
public class HapticWaveformTest {
    @Test public void prefixesDelayAndKeepsPauses() {
        assertArrayEquals(new long[] {0, 25, 75, 25, 75}, HapticWaveform.convert(new double[] {25, 75, 25, 75}));
    }
    @Test public void rejectsInvalidPatterns() {
        assertNull(HapticWaveform.convert(new double[] {}));
        assertNull(HapticWaveform.convert(new double[] {-1}));
        assertNull(HapticWaveform.convert(new double[] {1.5}));
        assertNull(HapticWaveform.convert(new double[] {Double.NaN}));
        assertNull(HapticWaveform.convert(new double[] {Double.POSITIVE_INFINITY}));
        assertNull(HapticWaveform.convert(new double[] {5000, 5001}));
        assertNull(HapticWaveform.convert(new double[65]));
        assertArrayEquals(new long[] {0, 10000}, HapticWaveform.convert(new double[] {10000}));
        assertArrayEquals(new long[] {0}, HapticWaveform.convert(new double[] {0, 0}));
    }
}
