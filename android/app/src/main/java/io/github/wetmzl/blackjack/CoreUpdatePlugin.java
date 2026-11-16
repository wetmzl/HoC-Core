package io.github.wetmzl.blackjack;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "CoreUpdate")
public class CoreUpdatePlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean();
    private CoreUpdateManager manager;
    @Override public void load() { manager = new CoreUpdateManager(getContext()); }
    interface Operation { void run() throws Exception; }
    private void run(PluginCall call, Operation operation) {
        if (!busy.compareAndSet(false, true)) { call.reject("更新操作正在进行，请稍候。"); return; }
        worker.execute(() -> {
            try { operation.run(); }
            catch (Exception error) {
                String message = error instanceof java.io.IOException ? error.getMessage() : "更新操作失败，请检查网络或存储空间后重试。";
                call.reject(message);
            } finally { busy.set(false); }
        });
    }
    @PluginMethod public void networkStatus(PluginCall call) {
        android.net.ConnectivityManager connectivity = (android.net.ConnectivityManager) getContext().getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
        android.net.NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(connectivity.getActiveNetwork());
        JSObject result = new JSObject();
        result.put("connected", capabilities != null && capabilities.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET));
        result.put("wifi", capabilities != null && capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)
            && !capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR));
        call.resolve(result);
    }
    @PluginMethod public void getStatus(PluginCall call) {
        try { call.resolve(JSObject.fromJSONObject(manager.status(CoreUpdateRelease.channel(call.getString("channel", "stable"))))); }
        catch (Exception error) { call.reject("无法读取应用版本。"); }
    }
    @PluginMethod public void check(PluginCall call) { run(call, () -> call.resolve(JSObject.fromJSONObject(manager.check(CoreUpdateRelease.channel(call.getString("channel", "stable")))))); }
    @PluginMethod public void releaseNotes(PluginCall call) {
        run(call, () -> { JSObject result = new JSObject(); result.put("feed", manager.releaseNotes()); call.resolve(result); });
    }
    @PluginMethod public void download(PluginCall call) {
        String tag = call.getString("tag", "");
        run(call, () -> call.resolve(JSObject.fromJSONObject(manager.download(tag, CoreUpdateRelease.channel(call.getString("channel", "stable")), (phase, completed, total) -> {
            JSObject event = new JSObject(); event.put("phase", phase); event.put("completedBytes", completed); event.put("totalBytes", total);
            notifyListeners("progress", event);
        }))));
    }
    @PluginMethod public void cancel(PluginCall call) { manager.cancel(); call.resolve(); }
    @PluginMethod public void install(PluginCall call) {
        run(call, () -> {
            File apk = manager.preparedApk(CoreUpdateRelease.channel(call.getString("channel", "stable")));
            getActivity().runOnUiThread(() -> {
                try {
                    JSObject result = new JSObject();
                    if (Build.VERSION.SDK_INT >= 26 && !manager.canInstall()) {
                        getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName())));
                        result.put("state", "permission");
                    } else {
                        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                        Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        getActivity().startActivity(intent);
                        result.put("state", "installer");
                    }
                    call.resolve(result);
                } catch (Exception error) { call.reject("无法打开系统安装器，请稍后重试。"); }
            });
        });
    }
    @Override protected void handleOnDestroy() { manager.cancel(); worker.shutdownNow(); }
}
