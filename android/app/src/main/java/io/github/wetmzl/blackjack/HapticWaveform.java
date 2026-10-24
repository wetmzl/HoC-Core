package io.github.wetmzl.blackjack;

/** Shared validation and Android's initial-delay conversion. No repetition is supported. */
public final class HapticWaveform {
    private HapticWaveform() {}
    public static long[] convert(double[] pattern) {
        if (pattern.length == 0 || pattern.length > 64) return null;
        long[] timings = new long[pattern.length + 1];
        long total = 0;
        for (int i = 0; i < pattern.length; i++) {
            double value = pattern[i];
            if (!Double.isFinite(value) || value < 0 || value != Math.floor(value) || value > 10000) return null;
            total += (long) value;
            if (total > 10000) return null;
            timings[i + 1] = (long) value;
        }
        return total == 0 ? new long[] {0} : timings;
    }
}
