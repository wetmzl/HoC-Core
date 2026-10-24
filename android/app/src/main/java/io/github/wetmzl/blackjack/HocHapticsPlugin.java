package io.github.wetmzl.blackjack;

import android.content.Context;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "HocHaptics")
public class HocHapticsPlugin extends Plugin {
    private boolean active = true;
    private Vibrator vibrator() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager manager = (VibratorManager) getContext().getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            return manager == null ? null : manager.getDefaultVibrator();
        }
        return (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
    }
    @PluginMethod
    @SuppressWarnings("deprecation")
    public synchronized void play(PluginCall call) {
        try {
            JSArray values = call.getArray("pattern");
            if (!active || values == null) { call.resolve(); return; }
            double[] pattern = new double[values.length()];
            for (int i = 0; i < values.length(); i++) {
                Object value = values.get(i);
                if (!(value instanceof Number)) { call.resolve(); return; }
                pattern[i] = ((Number) value).doubleValue();
            }
            long[] timings = HapticWaveform.convert(pattern);
            Vibrator device = vibrator();
            if (timings != null && device != null && device.hasVibrator()) {
                device.cancel();
                if (timings.length > 1) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) device.vibrate(VibrationEffect.createWaveform(timings, -1));
                    else device.vibrate(timings, -1);
                }
            }
        } catch (Exception ignored) { /* Unsupported hardware must not interrupt gameplay. */ }
        call.resolve();
    }
    private synchronized void stop() {
        try { Vibrator device = vibrator(); if (device != null) device.cancel(); }
        catch (Exception ignored) { }
    }
    @PluginMethod
    public void cancel(PluginCall call) { stop(); call.resolve(); }
    @Override protected synchronized void handleOnPause() { active = false; stop(); }
    @Override protected synchronized void handleOnResume() { active = true; }
    @Override protected synchronized void handleOnDestroy() { active = false; stop(); }
}
